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
const {
  AI_ENABLED,
  generateProblemForMatch,
  judgeBattleAndCoach,
} = require("./ai");
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
  isDbReady,
  getRuntimeStats,
  waitingByDifficulty,
  activeRooms,
} = require("./repository");

const authSchema = z.object({
  username: z.string().min(3).max(24),
  password: z.string().min(6).max(72),
});

const queueJoinSchema = z.object({
  difficulty: z.enum(["easy", "medium", "hard"]).default("easy"),
});

const spectatorJoinSchema = z.object({
  roomId: z.string().min(1).max(128),
});

const typingSchema = z.object({
  roomId: z.string().min(1).max(128),
  chars: z.coerce.number().int().min(0).max(50_000),
});

const chatSchema = z.object({
  roomId: z.string().min(1).max(128),
  message: z.string().max(220),
});

const submitSchema = z.object({
  roomId: z.string().min(1).max(128),
  code: z.string().max(50_000),
  language: z.enum(["javascript", "python", "java"]).default("javascript"),
});

const MATCHMAKING_BASE_TOLERANCE = 100;
const MATCHMAKING_STEP_SECONDS = 10;
const MATCHMAKING_STEP_TOLERANCE = 50;
const MATCHMAKING_MAX_TOLERANCE = 450;

function buildSocketErrorPayload(code, message, retryable = false, details) {
  return {
    code,
    message,
    retryable,
    ...(details ? { details } : {}),
  };
}

function emitSocketError(
  socket,
  channel,
  code,
  message,
  retryable = false,
  details,
) {
  socket.emit(
    channel,
    buildSocketErrorPayload(code, message, retryable, details),
  );
}

function isRateLimited(map, userId, max, windowMs, now = Date.now()) {
  const current = Array.isArray(map.get(userId)) ? map.get(userId) : [];
  const windowStart = now - windowMs;
  const recent = current.filter((timestamp) => timestamp >= windowStart);

  if (recent.length >= max) {
    map.set(userId, recent);
    return true;
  }

  recent.push(now);
  map.set(userId, recent);
  return false;
}

function adjustRating(winner, loser) {
  const k = 24;
  const expectedWinner = 1 / (1 + 10 ** ((loser.rating - winner.rating) / 400));
  const expectedLoser = 1 - expectedWinner;

  return {
    winner: {
      ...winner,
      ratingBefore: winner.rating,
      rating: Math.round(winner.rating + k * (1 - expectedWinner)),
      wins: winner.wins + 1,
      matchesPlayed: winner.matchesPlayed + 1,
    },
    loser: {
      ...loser,
      ratingBefore: loser.rating,
      rating: Math.round(loser.rating + k * (0 - expectedLoser)),
      losses: loser.losses + 1,
      matchesPlayed: loser.matchesPlayed + 1,
    },
  };
}

function clearQueueForUser(userId) {
  for (const key of Object.keys(waitingByDifficulty)) {
    const queue = waitingByDifficulty[key];
    if (Array.isArray(queue)) {
      waitingByDifficulty[key] = queue.filter(
        (entry) => entry.userId !== userId,
      );
      continue;
    }

    const entry = waitingByDifficulty[key];
    if (entry?.userId === userId) {
      waitingByDifficulty[key] = [];
    }
  }
}

function ensureQueue(difficulty) {
  if (!Array.isArray(waitingByDifficulty[difficulty])) {
    waitingByDifficulty[difficulty] = [];
  }

  return waitingByDifficulty[difficulty];
}

function getToleranceForEntry(entry, now = Date.now()) {
  const waitSeconds = Math.max(
    0,
    Math.floor((now - (entry.enqueuedAt || now)) / 1000),
  );
  const bonusSteps = Math.floor(waitSeconds / MATCHMAKING_STEP_SECONDS);
  return Math.min(
    MATCHMAKING_MAX_TOLERANCE,
    MATCHMAKING_BASE_TOLERANCE + bonusSteps * MATCHMAKING_STEP_TOLERANCE,
  );
}

function pickBestQueueMatch(queue, contender, now = Date.now()) {
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (!candidate || candidate.userId === contender.userId) {
      continue;
    }

    const ratingDistance = Math.abs(
      (candidate.rating || 1200) - (contender.rating || 1200),
    );
    const candidateTolerance = getToleranceForEntry(candidate, now);
    if (ratingDistance > candidateTolerance) {
      continue;
    }

    const score = ratingDistance * 1_000_000 + (candidate.enqueuedAt || now);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function sanitizePlayers(room) {
  return room.players.map((player) => ({
    userId: player.userId,
    username: player.username,
    rating: player.rating || 1200,
    connected: player.connected !== false,
  }));
}

function buildBattleState(room) {
  return {
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
    players: sanitizePlayers(room),
    chats: room.chats.slice(-20),
    submissions: Object.entries(room.submissions).map(
      ([userId, submission]) => ({
        userId,
        passed: Boolean(submission.passed),
        engine: submission.engine,
        status: submission.status,
        stderr: submission.stderr,
        runtime: submission.runtime,
        memory: submission.memory,
        submittedAt: submission.submittedAt,
      }),
    ),
  };
}

function findActiveRoomForUser(userId) {
  for (const room of activeRooms.values()) {
    if (room.winnerId) {
      continue;
    }

    if (room.players.some((player) => player.userId === userId)) {
      return room;
    }
  }

  return null;
}

function clearDisconnectTimer(room, userId) {
  if (!room.disconnectTimers || !room.disconnectTimers[userId]) {
    return;
  }

  clearTimeout(room.disconnectTimers[userId]);
  delete room.disconnectTimers[userId];
}

function scheduleDisconnectForfeit(
  io,
  room,
  disconnectedUserId,
  disconnectGraceMs,
) {
  room.disconnectTimers = room.disconnectTimers || {};
  clearDisconnectTimer(room, disconnectedUserId);

  room.disconnectTimers[disconnectedUserId] = setTimeout(async () => {
    const liveRoom = activeRooms.get(room.roomId);
    if (!liveRoom || liveRoom.winnerId) {
      return;
    }

    const disconnected = liveRoom.players.find(
      (player) => player.userId === disconnectedUserId,
    );
    if (!disconnected || disconnected.connected) {
      return;
    }

    const opponent = liveRoom.players.find(
      (player) => player.userId !== disconnectedUserId,
    );
    if (opponent) {
      await finalizeRoom(
        io,
        liveRoom,
        opponent.userId,
        "opponent-disconnected-timeout",
      );
    }
  }, disconnectGraceMs);
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
        connected: true,
        disconnectedAt: null,
      },
      {
        userId: playerB.userId,
        socketId: playerB.socketId,
        username: playerB.username,
        rating: playerB.rating || 1200,
        connected: true,
        disconnectedAt: null,
      },
    ],
    ai: {
      enabled: AI_ENABLED,
      generatedProblem: Boolean(aiProblem),
    },
    disconnectTimers: {},
    rateLimitState: {
      chat: new Map(),
      submit: new Map(),
    },
  };

  activeRooms.set(roomId, room);
  return room;
}

function emitRoomReadyToSocket(io, socketId, room) {
  io.to(socketId).emit("battle:ready", {
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
    players: sanitizePlayers(room),
  });
}

function emitRoomReady(io, room) {
  for (const player of room.players) {
    emitRoomReadyToSocket(io, player.socketId, room);
  }
}

async function finalizeRoom(io, room, winnerId, reason, aiInsight = null) {
  if (room.winnerId) {
    return;
  }

  room.winnerId = winnerId;

  if (room.disconnectTimers) {
    for (const timerId of Object.values(room.disconnectTimers)) {
      clearTimeout(timerId);
    }
    room.disconnectTimers = {};
  }

  const playerIds = room.players.map((p) => p.userId);
  const [winner, loser] = winnerId
    ? await Promise.all([
        getUserById(winnerId),
        getUsersByIds(playerIds).then(
          (list) => list.find((u) => u.id !== winnerId) || null,
        ),
      ])
    : [null, null];

  if (winner && loser && winnerId) {
    const ratings = adjustRating(winner, loser);
    const winnerPlayer = room.players.find(
      (player) => player.userId === winnerId,
    );
    const loserPlayer = room.players.find(
      (player) => player.userId !== winnerId,
    );

    await updateMatchOutcome(winner.id, loser.id, ratings, {
      roomId: room.roomId,
      reason,
      endedAt: new Date().toISOString(),
      winnerUsername: winnerPlayer?.username || winner.username,
      loserUsername: loserPlayer?.username || loser.username,
    });
  }

  const latestPlayers = await getUsersByIds(playerIds);

  io.to(room.roomId).emit("battle:finished", {
    roomId: room.roomId,
    reason,
    winnerId,
    ai: aiInsight,
    players: sanitizePlayers(room).map((p) => {
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
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.NODE_ENV === "test" ? 1_000 : 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many auth requests, try again later." },
  });

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

  app.get("/health/ready", (_req, res) => {
    const runtimeStats = getRuntimeStats();
    const dbReady = isDbReady();
    const ready = dbReady;

    res.status(ready ? 200 : 503).json({
      ok: ready,
      checks: {
        db: dbReady ? "up" : "down",
      },
      runtime: runtimeStats,
      timestamp: Date.now(),
    });
  });

  app.post("/auth/register", authLimiter, async (req, res) => {
    const parsed = authSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: "Invalid payload", errors: parsed.error.issues });
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

  app.post("/auth/login", authLimiter, async (req, res) => {
    const parsed = authSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: "Invalid payload", errors: parsed.error.issues });
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
      recentMatches: Array.isArray(user.recentMatches)
        ? user.recentMatches.slice(0, 5).map((entry) => ({
            roomId: entry.roomId,
            opponentId: entry.opponentId,
            opponentUsername: entry.opponentUsername,
            result: entry.result,
            reason: entry.reason,
            ratingBefore: entry.ratingBefore,
            ratingAfter: entry.ratingAfter,
            ratingDelta: entry.ratingDelta,
            endedAt:
              entry.endedAt instanceof Date
                ? entry.endedAt.toISOString()
                : new Date(entry.endedAt).toISOString(),
          }))
        : [],
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
      {
        id: "weekly-sprint",
        name: "Weekly Sprint",
        status: "upcoming",
        players: 16,
      },
      { id: "night-battle", name: "Night Battle", status: "live", players: 8 },
      {
        id: "spring-open",
        name: "Spring Open",
        status: "completed",
        players: 32,
      },
    ]);
  });

  app.use((error, _req, res, _next) => {
    const message =
      config.NODE_ENV === "production"
        ? "Internal server error"
        : error.message;
    res.status(500).json({ message });
  });

  return app;
}

function createRuntime({
  port = config.PORT,
  battleDurationSeconds = 300,
  disconnectGraceMs = config.DISCONNECT_GRACE_MS,
  chatRateLimitWindowMs = config.CHAT_RATE_LIMIT_WINDOW_MS,
  chatRateLimitMax = config.CHAT_RATE_LIMIT_MAX,
  submitRateLimitWindowMs = config.SUBMIT_RATE_LIMIT_WINDOW_MS,
  submitRateLimitMax = config.SUBMIT_RATE_LIMIT_MAX,
} = {}) {
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
    const recoveringRoom = findActiveRoomForUser(socket.data.user.userId);
    if (recoveringRoom) {
      const player = recoveringRoom.players.find(
        (entry) => entry.userId === socket.data.user.userId,
      );
      if (player) {
        player.socketId = socket.id;
        player.connected = true;
        player.disconnectedAt = null;
      }

      clearDisconnectTimer(recoveringRoom, socket.data.user.userId);
      socket.join(recoveringRoom.roomId);
      emitRoomReadyToSocket(io, socket.id, recoveringRoom);
      socket.emit("battle:state", buildBattleState(recoveringRoom));
      io.to(recoveringRoom.roomId).emit("battle:presence", {
        userId: socket.data.user.userId,
        connected: true,
      });
    }

    socket.on("queue:join", async (payload = {}) => {
      const parsed = queueJoinSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("queue:status", { status: "idle" });
        emitSocketError(
          socket,
          "queue:error",
          "INVALID_QUEUE_REQUEST",
          "Invalid queue join payload",
          false,
        );
        return;
      }

      const inActiveRoom = findActiveRoomForUser(socket.data.user.userId);
      if (inActiveRoom) {
        socket.join(inActiveRoom.roomId);
        emitRoomReadyToSocket(io, socket.id, inActiveRoom);
        socket.emit("battle:state", buildBattleState(inActiveRoom));
        return;
      }

      const normalizedDifficulty = parsed.data.difficulty;

      clearQueueForUser(socket.data.user.userId);

      const currentUser = await getUserById(socket.data.user.userId);
      const contender = {
        userId: socket.data.user.userId,
        username: socket.data.user.username,
        socketId: socket.id,
        rating: currentUser?.rating || 1200,
        enqueuedAt: Date.now(),
      };

      const queue = ensureQueue(normalizedDifficulty).filter((entry) => {
        if (!entry || entry.userId === contender.userId) {
          return false;
        }
        const queuedSocket = io.sockets.sockets.get(entry.socketId);
        return Boolean(queuedSocket && queuedSocket.connected);
      });

      const matchIndex = pickBestQueueMatch(
        queue,
        contender,
        contender.enqueuedAt,
      );

      if (matchIndex === -1) {
        queue.push(contender);
        waitingByDifficulty[normalizedDifficulty] = queue;
        socket.emit("queue:status", {
          status: "waiting",
          difficulty: normalizedDifficulty,
          queueSize: queue.length,
        });
        return;
      }

      const opponent = queue.splice(matchIndex, 1)[0];
      waitingByDifficulty[normalizedDifficulty] = queue;

      const room = await createRoom(
        opponent,
        contender,
        normalizedDifficulty,
        battleDurationSeconds,
      );

      for (const playerEntry of room.players) {
        const playerSocket = io.sockets.sockets.get(playerEntry.socketId);
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

    socket.on("spectator:join", (payload = {}) => {
      const parsed = spectatorJoinSchema.safeParse(payload);
      if (!parsed.success) {
        emitSocketError(
          socket,
          "spectator:error",
          "INVALID_ROOM_ID",
          "Invalid room id",
          false,
        );
        return;
      }

      const { roomId } = parsed.data;
      const room = activeRooms.get(roomId);
      if (!room) {
        emitSocketError(
          socket,
          "spectator:error",
          "ROOM_NOT_FOUND",
          "Room not found",
          false,
        );
        return;
      }

      socket.join(roomId);
      room.spectators.add(socket.id);
      socket.emit("spectator:state", {
        roomId,
        players: sanitizePlayers(room),
        problem: {
          id: room.problem.id,
          title: room.problem.title,
          difficulty: room.problem.difficulty,
        },
        startedAt: room.startedAt,
        endsAt: room.endsAt,
      });
    });

    socket.on("battle:typing", (payload = {}) => {
      const parsed = typingSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }

      const { roomId, chars } = parsed.data;
      const room = activeRooms.get(roomId);
      if (!room || room.winnerId) {
        return;
      }

      const isPlayer = room.players.some(
        (player) => player.userId === socket.data.user.userId,
      );
      if (!isPlayer) {
        return;
      }

      socket.to(roomId).emit("battle:opponent-typing", {
        chars,
        userId: socket.data.user.userId,
      });
    });

    socket.on("battle:chat", (payload = {}) => {
      const parsed = chatSchema.safeParse(payload);
      if (!parsed.success) {
        emitSocketError(
          socket,
          "battle:error",
          "INVALID_CHAT_PAYLOAD",
          "Invalid chat payload",
          false,
        );
        return;
      }

      const { roomId, message } = parsed.data;
      const room = activeRooms.get(roomId);
      if (!room || room.winnerId) {
        emitSocketError(
          socket,
          "battle:error",
          "ROOM_NOT_ACTIVE",
          "Battle room is not active",
          false,
        );
        return;
      }

      const isPlayer = room.players.some(
        (player) => player.userId === socket.data.user.userId,
      );
      if (!isPlayer) {
        emitSocketError(
          socket,
          "battle:error",
          "PLAYER_NOT_IN_ROOM",
          "Only active players can send battle chat",
          false,
        );
        return;
      }

      if (
        isRateLimited(
          room.rateLimitState.chat,
          socket.data.user.userId,
          chatRateLimitMax,
          chatRateLimitWindowMs,
        )
      ) {
        emitSocketError(
          socket,
          "battle:error",
          "CHAT_RATE_LIMITED",
          "Too many chat messages. Slow down.",
          true,
        );
        return;
      }

      const safeMessage = String(message || "")
        .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
        .trim()
        .slice(0, 220);
      if (!safeMessage) {
        return;
      }

      const chatPayload = {
        userId: socket.data.user.userId,
        username: socket.data.user.username,
        message: safeMessage,
        timestamp: Date.now(),
      };

      room.chats.push(chatPayload);
      io.to(roomId).emit("battle:chat", chatPayload);
    });

    socket.on("battle:submit", async (payload = {}) => {
      const parsed = submitSchema.safeParse(payload);
      if (!parsed.success) {
        emitSocketError(
          socket,
          "battle:error",
          "INVALID_SUBMISSION_PAYLOAD",
          "Invalid submission payload",
          false,
        );
        return;
      }

      const { roomId, code, language } = parsed.data;
      const room = activeRooms.get(roomId);
      if (!room || room.winnerId) {
        emitSocketError(
          socket,
          "battle:error",
          "ROOM_NOT_ACTIVE",
          "Battle room is not active",
          false,
        );
        return;
      }

      const isPlayer = room.players.some(
        (p) => p.userId === socket.data.user.userId,
      );
      if (!isPlayer) {
        emitSocketError(
          socket,
          "battle:error",
          "PLAYER_NOT_IN_ROOM",
          "Only active players can submit code",
          false,
        );
        return;
      }

      if (
        isRateLimited(
          room.rateLimitState.submit,
          socket.data.user.userId,
          submitRateLimitMax,
          submitRateLimitWindowMs,
        )
      ) {
        emitSocketError(
          socket,
          "battle:error",
          "SUBMIT_RATE_LIMITED",
          "Too many submissions in a short time. Slow down.",
          true,
        );
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
          runtime: null,
          memory: null,
        };
      }

      const passed = execution.passed;
      room.submissions[socket.data.user.userId] = {
        passed,
        submittedAt: Date.now(),
        chars: code.length,
        engine: execution.engine,
        status: execution.status,
        stderr: execution.stderr,
        runtime: execution.runtime,
        memory: execution.memory,
        code,
        language,
      };

      io.to(roomId).emit("battle:submission-result", {
        userId: socket.data.user.userId,
        passed,
        engine: execution.engine,
        status: execution.status,
        stderr: execution.stderr,
        runtime: execution.runtime,
        memory: execution.memory,
      });

      // Winner is finalized at timer end for fair head-to-head evaluation of both contestants.
    });

    socket.on("disconnect", async () => {
      clearQueueForUser(socket.data.user.userId);

      for (const room of activeRooms.values()) {
        if (room.winnerId) {
          continue;
        }

        const inRoom = room.players.some(
          (p) => p.userId === socket.data.user.userId,
        );
        if (inRoom) {
          const disconnectedPlayer = room.players.find(
            (p) => p.userId === socket.data.user.userId,
          );
          if (disconnectedPlayer) {
            disconnectedPlayer.connected = false;
            disconnectedPlayer.disconnectedAt = Date.now();
            io.to(room.roomId).emit("battle:presence", {
              userId: socket.data.user.userId,
              connected: false,
            });
            scheduleDisconnectForfeit(
              io,
              room,
              socket.data.user.userId,
              disconnectGraceMs,
            );
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
        let endReason;

        if (submissions.length > 0) {
          winnerId = submissions[0][0];
          endReason = "timer-expired";
        } else {
          // Deterministic fairness policy: if nobody solved it, the match is a draw.
          winnerId = null;
          endReason = "timer-expired-no-solution-draw";
        }

        const aiInsight = winnerId
          ? await judgeBattleAndCoach({
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
            })
          : null;

        await finalizeRoom(io, room, winnerId, endReason, aiInsight);
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
