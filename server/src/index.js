require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const { z } = require("zod");
const { v4: uuidv4 } = require("uuid");

const { signToken, authMiddleware, verifySocketToken } = require("./auth");
const { problems, randomProblem } = require("./problems");
const { executeSubmission } = require("./execution");
const { AI_ENABLED, generateProblemForMatch, judgeBattleAndCoach } = require("./ai");
const { config, getCorsOrigins } = require("./config");
const {
  connectDb,
  disconnectDb,
  seedUsers,
  findUserByUsername,
  getUserById,
  addUser,
  listLeaderboard,
  updateMatchOutcome,
  getUsersByIds,
  waitingByDifficulty,
  activeRooms,
} = require("./repository");

const authSchema = z.object({
  username: z.string().min(3).max(24),
  password: z.string().min(6).max(72),
});

function adjustRating(winner, loser) {
  const k = 24;
  const expectedWinner = 1 / (1 + 10 ** ((loser.rating - winner.rating) / 400));
  const expectedLoser = 1 - expectedWinner;

  return {
    winner: {
      ...winner,
      rating: Math.round(winner.rating + k * (1 - expectedWinner)),
      wins: winner.wins + 1,
      matchesPlayed: winner.matchesPlayed + 1,
    },
    loser: {
      ...loser,
      rating: Math.round(loser.rating + k * (0 - expectedLoser)),
      losses: loser.losses + 1,
      matchesPlayed: loser.matchesPlayed + 1,
    },
  };
}

function clearQueueForUser(userId) {
  for (const key of Object.keys(waitingByDifficulty)) {
    const entry = waitingByDifficulty[key];
    if (entry && entry.userId === userId) {
      waitingByDifficulty[key] = null;
    }
  }
}

async function createRoom(playerA, playerB, difficulty, battleDurationSeconds) {
  const roomId = uuidv4();
  const aiProblem = await generateProblemForMatch({
    difficulty,
    players: [playerA, playerB],
  });
  const problem = aiProblem || randomProblem(difficulty);
  const startedAt = Date.now();

  const room = {
    roomId,
    difficulty,
    problem,
    startedAt,
    endsAt: startedAt + battleDurationSeconds * 1000,
    submissions: {},
    chats: [],
    spectators: new Set(),
    winnerId: null,
    players: [
      {
        userId: playerA.userId,
        socketId: playerA.socketId,
        username: playerA.username,
        rating: playerA.rating || 1200,
      },
      {
        userId: playerB.userId,
        socketId: playerB.socketId,
        username: playerB.username,
        rating: playerB.rating || 1200,
      },
    ],
    ai: {
      enabled: AI_ENABLED,
      generatedProblem: Boolean(aiProblem),
    },
  };

  activeRooms.set(roomId, room);
  return room;
}

function emitRoomReady(io, room) {
  for (const player of room.players) {
    io.to(player.socketId).emit("battle:ready", {
      roomId: room.roomId,
      difficulty: room.difficulty,
      startedAt: room.startedAt,
      endsAt: room.endsAt,
      problem: {
        id: room.problem.id,
        title: room.problem.title,
        difficulty: room.problem.difficulty,
        description: room.problem.description,
        constraints: room.problem.constraints,
        sampleInput: room.problem.sampleInput,
        sampleOutput: room.problem.sampleOutput,
        source: room.problem.source || "library",
      },
      players: room.players,
    });
  }
}

async function finalizeRoom(io, room, winnerId, reason, aiInsight = null) {
  if (room.winnerId) {
    return;
  }

  room.winnerId = winnerId;

  const playerIds = room.players.map((p) => p.userId);
  const [winner, loser] = await Promise.all([
    getUserById(winnerId),
    getUsersByIds(playerIds).then((list) => list.find((u) => u.id !== winnerId) || null),
  ]);

  if (winner && loser) {
    const ratings = adjustRating(winner, loser);
    await updateMatchOutcome(winner.id, loser.id, ratings);
  }

  const latestPlayers = await getUsersByIds(playerIds);

  io.to(room.roomId).emit("battle:finished", {
    roomId: room.roomId,
    reason,
    winnerId,
    ai: aiInsight,
    players: room.players.map((p) => {
      const user = latestPlayers.find((u) => u.id === p.userId);
      return {
        userId: p.userId,
        username: p.username,
        rating: user ? user.rating : 1200,
      };
    }),
  });

  setTimeout(() => {
    activeRooms.delete(room.roomId);
  }, 30_000);
}

function buildExpressApp(corsOrigins) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || corsOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error("CORS blocked"));
      },
    }),
  );

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(compression());
  app.use(
    rateLimit({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      max: config.RATE_LIMIT_MAX_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan(config.NODE_ENV === "production" ? "combined" : "dev"));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), env: config.NODE_ENV });
  });

  app.post("/auth/register", async (req, res) => {
    const parsed = authSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid payload", errors: parsed.error.issues });
    }

    const { username, password } = parsed.data;
    const existing = await findUserByUsername(username);
    if (existing) {
      return res.status(409).json({ message: "Username already exists" });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const user = await addUser({ username, passwordHash });
    const token = signToken(user);

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        rating: user.rating,
        wins: user.wins,
        losses: user.losses,
        matchesPlayed: user.matchesPlayed,
      },
    });
  });

  app.post("/auth/login", async (req, res) => {
    const parsed = authSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid payload", errors: parsed.error.issues });
    }

    const { username, password } = parsed.data;
    const user = await findUserByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = signToken(user);
    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        rating: user.rating,
        wins: user.wins,
        losses: user.losses,
        matchesPlayed: user.matchesPlayed,
      },
    });
  });

  app.get("/users/me", authMiddleware, async (req, res) => {
    const user = await getUserById(req.user.sub);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      id: user.id,
      username: user.username,
      rating: user.rating,
      wins: user.wins,
      losses: user.losses,
      matchesPlayed: user.matchesPlayed,
    });
  });

  app.get("/leaderboard", async (_req, res) => {
    const leaderboard = await listLeaderboard(20);
    return res.json(
      leaderboard.map((u) => ({
        id: u.id,
        username: u.username,
        rating: u.rating,
        wins: u.wins,
        losses: u.losses,
      })),
    );
  });

  app.get("/problems", (_req, res) => {
    const data = problems.map((problem) => ({
      id: problem.id,
      title: problem.title,
      difficulty: problem.difficulty,
      description: problem.description,
      constraints: problem.constraints,
      sampleInput: problem.sampleInput,
      sampleOutput: problem.sampleOutput,
    }));

    return res.json(data);
  });

  app.get("/tournaments", (_req, res) => {
    return res.json([
      { id: "weekly-sprint", name: "Weekly Sprint", status: "upcoming", players: 16 },
      { id: "night-battle", name: "Night Battle", status: "live", players: 8 },
    ]);
  });

  app.use((error, _req, res, _next) => {
    const message = config.NODE_ENV === "production" ? "Internal server error" : error.message;
    res.status(500).json({ message });
  });

  return app;
}

function createRuntime({ port = config.PORT, battleDurationSeconds = 300 } = {}) {
  const corsOrigins = getCorsOrigins();
  const app = buildExpressApp(corsOrigins);
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: corsOrigins,
      credentials: false,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Missing auth token"));
    }

    try {
      const payload = verifySocketToken(token);
      socket.data.user = {
        userId: payload.sub,
        username: payload.username,
      };
      return next();
    } catch (_error) {
      return next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.on("queue:join", async ({ difficulty = "easy" }) => {
      const normalizedDifficulty = ["easy", "medium", "hard"].includes(difficulty)
        ? difficulty
        : "easy";

      clearQueueForUser(socket.data.user.userId);

      const waiting = waitingByDifficulty[normalizedDifficulty];
      if (!waiting || waiting.userId === socket.data.user.userId) {
        const currentUser = await getUserById(socket.data.user.userId);
        waitingByDifficulty[normalizedDifficulty] = {
          userId: socket.data.user.userId,
          username: socket.data.user.username,
          socketId: socket.id,
          rating: currentUser?.rating || 1200,
        };

        socket.emit("queue:status", { status: "waiting", difficulty: normalizedDifficulty });
        return;
      }

      waitingByDifficulty[normalizedDifficulty] = null;

      const currentUser = await getUserById(socket.data.user.userId);
      const room = await createRoom(
        waiting,
        {
          userId: socket.data.user.userId,
          username: socket.data.user.username,
          socketId: socket.id,
          rating: currentUser?.rating || 1200,
        },
        normalizedDifficulty,
        battleDurationSeconds,
      );

      for (const player of room.players) {
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (playerSocket) {
          playerSocket.join(room.roomId);
        }
      }

      emitRoomReady(io, room);
    });

    socket.on("queue:leave", () => {
      clearQueueForUser(socket.data.user.userId);
      socket.emit("queue:status", { status: "idle" });
    });

    socket.on("spectator:join", ({ roomId }) => {
      const room = activeRooms.get(roomId);
      if (!room) {
        socket.emit("spectator:error", { message: "Room not found" });
        return;
      }

      socket.join(roomId);
      room.spectators.add(socket.id);
      socket.emit("spectator:state", {
        roomId,
        players: room.players,
        problem: {
          id: room.problem.id,
          title: room.problem.title,
          difficulty: room.problem.difficulty,
        },
      });
    });

    socket.on("battle:typing", ({ roomId, chars }) => {
      const room = activeRooms.get(roomId);
      if (!room || room.winnerId) {
        return;
      }

      socket.to(roomId).emit("battle:opponent-typing", {
        chars: Number(chars || 0),
        userId: socket.data.user.userId,
      });
    });

    socket.on("battle:chat", ({ roomId, message }) => {
      const room = activeRooms.get(roomId);
      if (!room || room.winnerId) {
        return;
      }

      const safeMessage = String(message || "").trim().slice(0, 220);
      if (!safeMessage) {
        return;
      }

      const payload = {
        userId: socket.data.user.userId,
        username: socket.data.user.username,
        message: safeMessage,
        timestamp: Date.now(),
      };

      room.chats.push(payload);
      io.to(roomId).emit("battle:chat", payload);
    });

    socket.on("battle:submit", async ({ roomId, code, language = "javascript" }) => {
      const room = activeRooms.get(roomId);
      if (!room || room.winnerId) {
        return;
      }

      const isPlayer = room.players.some((p) => p.userId === socket.data.user.userId);
      if (!isPlayer) {
        return;
      }

      let execution;
      try {
        execution = await executeSubmission({
          code: String(code || ""),
          language,
          room,
        });
      } catch (_error) {
        execution = {
          passed: false,
          engine: "internal-error",
          status: "Execution Error",
          stderr: "Execution failed",
        };
      }

      const passed = execution.passed;
      room.submissions[socket.data.user.userId] = {
        passed,
        submittedAt: Date.now(),
        chars: String(code || "").length,
        engine: execution.engine,
        status: execution.status,
        code: String(code || ""),
        language,
      };

      io.to(roomId).emit("battle:submission-result", {
        userId: socket.data.user.userId,
        passed,
        engine: execution.engine,
        status: execution.status,
        stderr: execution.stderr,
      });

      // Winner is finalized at timer end for fair head-to-head evaluation of both contestants.
    });

    socket.on("disconnect", async () => {
      clearQueueForUser(socket.data.user.userId);

      for (const room of activeRooms.values()) {
        if (room.winnerId) {
          continue;
        }

        const inRoom = room.players.some((p) => p.userId === socket.data.user.userId);
        if (inRoom) {
          const opponent = room.players.find((p) => p.userId !== socket.data.user.userId);
          if (opponent) {
            await finalizeRoom(io, room, opponent.userId, "opponent-disconnected");
          }
        }
      }
    });
  });

  const interval = setInterval(async () => {
    const now = Date.now();
    for (const room of activeRooms.values()) {
      if (!room.winnerId && now >= room.endsAt) {
        const playerIds = room.players.map((p) => p.userId);
        const submissions = Object.entries(room.submissions)
          .filter(([, data]) => data.passed)
          .sort((a, b) => a[1].submittedAt - b[1].submittedAt);

        let winnerId;

        if (submissions.length > 0) {
          winnerId = submissions[0][0];
        } else {
          const fallbackWinner = room.players[Math.floor(Math.random() * room.players.length)];
          winnerId = fallbackWinner.userId;
        }

        const aiInsight = await judgeBattleAndCoach({
          problem: room.problem,
          players: room.players.map((p) => ({
            userId: p.userId,
            username: p.username,
            rating: p.rating,
          })),
          submissions: playerIds.map((id) => ({
            userId: id,
            ...(room.submissions[id] || {
              status: "No submission",
              code: "",
              language: "javascript",
              passed: false,
            }),
          })),
          winnerId,
        });

        await finalizeRoom(
          io,
          room,
          winnerId,
          submissions.length > 0 ? "timer-expired" : "timer-expired-no-solution",
          aiInsight,
        );
      }
    }
  }, 1000);

  function start() {
    return new Promise((resolve) => {
      server.listen(port, () => {
        resolve();
      });
    });
  }

  async function stop() {
    clearInterval(interval);
    await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  }

  return {
    app,
    io,
    server,
    start,
    stop,
    port,
  };
}

async function bootstrap() {
  await connectDb();
  await seedUsers();

  const runtime = createRuntime();
  await runtime.start();
  console.log(`DevArena server running on http://localhost:${runtime.port}`);

  async function shutdown(signal) {
    console.log(`Received ${signal}, shutting down gracefully...`);
    await runtime.stop();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error("Server bootstrap failed", error);
    process.exit(1);
  });
}

module.exports = {
  createRuntime,
  bootstrap,
  adjustRating,
};
