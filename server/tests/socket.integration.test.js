const request = require("supertest");
const { io: createClient } = require("socket.io-client");
const { createRuntime } = require("../src/index");
const {
  users,
  waitingByDifficulty,
  activeRooms,
} = require("../src/repository");

function resetInMemoryState() {
  users.length = 0;
  waitingByDifficulty.easy = [];
  waitingByDifficulty.medium = [];
  waitingByDifficulty.hard = [];
  activeRooms.clear();
}

function waitForEvent(socket, event, timeoutMs = 6_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function waitForEventMatch(socket, event, predicate, timeoutMs = 6_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for matching ${event}`));
    }, timeoutMs);

    const handler = (payload) => {
      if (!predicate(payload)) {
        return;
      }

      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };

    socket.on(event, handler);
  });
}

async function registerUser(app, username) {
  const response = await request(app)
    .post("/auth/register")
    .send({ username, password: "password123" });

  if (response.status !== 201 || !response.body?.token) {
    throw new Error(
      `Failed to register user ${username}: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  return {
    token: response.body.token,
    user: response.body.user,
  };
}

function testUsername(prefix, suffix) {
  const normalizedPrefix = String(prefix || "u").replace(/[^a-z0-9]/gi, "");
  const normalizedSuffix = String(suffix || "").replace(/[^a-z0-9]/gi, "");
  const raw = `${normalizedPrefix}${normalizedSuffix}`.toLowerCase();
  return raw.slice(0, 24);
}

async function connectSocket(baseUrl, token) {
  const socket = createClient(baseUrl, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });

  await waitForEvent(socket, "connect", 4_000);
  return socket;
}

async function createMatchedPair({ runtime, baseUrl, suffix, options = {} }) {
  const playerA = await registerUser(runtime.app, testUsername("ua", suffix));
  const playerB = await registerUser(runtime.app, testUsername("ub", suffix));

  const socketA = await connectSocket(baseUrl, playerA.token);
  const socketB = await connectSocket(baseUrl, playerB.token);

  socketA.emit("queue:join", { difficulty: options.difficulty || "easy" });
  await waitForEventMatch(
    socketA,
    "queue:status",
    (payload) => payload?.status === "waiting",
  );

  socketB.emit("queue:join", { difficulty: options.difficulty || "easy" });
  const [readyA, readyB] = await Promise.all([
    waitForEvent(socketA, "battle:ready"),
    waitForEvent(socketB, "battle:ready"),
  ]);

  return {
    playerA,
    playerB,
    socketA,
    socketB,
    roomId: readyA.roomId,
    readyA,
    readyB,
  };
}

function closeSockets(...sockets) {
  for (const socket of sockets) {
    if (socket && socket.connected) {
      socket.disconnect();
    }
  }
}

function waitMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("socket integration", () => {
  let runtime;
  let baseUrl;

  beforeEach(async () => {
    resetInMemoryState();
    runtime = createRuntime({
      port: 0,
      battleDurationSeconds: 2,
      disconnectGraceMs: 2_000,
      chatRateLimitWindowMs: 2_000,
      chatRateLimitMax: 2,
      submitRateLimitWindowMs: 2_000,
      submitRateLimitMax: 2,
    });
    await runtime.start();
    const actualPort = runtime.server.address().port;
    baseUrl = `http://127.0.0.1:${actualPort}`;
  });

  afterEach(async () => {
    for (const socket of runtime.io.sockets.sockets.values()) {
      socket.disconnect(true);
    }
    await runtime.stop();
    resetInMemoryState();
  });

  test("queue join, leave, and deterministic match creation", async () => {
    const userA = await registerUser(
      runtime.app,
      testUsername("qa", Date.now()),
    );
    const userB = await registerUser(
      runtime.app,
      testUsername("qb", Date.now()),
    );

    const socketA = await connectSocket(baseUrl, userA.token);
    const socketB = await connectSocket(baseUrl, userB.token);

    socketA.emit("queue:join", { difficulty: "easy" });
    const waiting = await waitForEventMatch(
      socketA,
      "queue:status",
      (payload) => payload?.status === "waiting",
    );
    expect(waiting.status).toBe("waiting");

    socketA.emit("queue:leave");
    const idle = await waitForEventMatch(
      socketA,
      "queue:status",
      (payload) => payload?.status === "idle",
    );
    expect(idle.status).toBe("idle");

    socketA.emit("queue:join", { difficulty: "easy" });
    await waitForEventMatch(
      socketA,
      "queue:status",
      (payload) => payload?.status === "waiting",
    );
    socketB.emit("queue:join", { difficulty: "easy" });

    const [readyA, readyB] = await Promise.all([
      waitForEvent(socketA, "battle:ready"),
      waitForEvent(socketB, "battle:ready"),
    ]);

    expect(readyA.roomId).toBeTruthy();
    expect(readyA.roomId).toBe(readyB.roomId);

    closeSockets(socketA, socketB);
  });

  test("reconnect recovers battle state", async () => {
    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_reconnect`,
    });

    match.socketA.disconnect();

    const recoveredSocket = createClient(baseUrl, {
      auth: { token: match.playerA.token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      autoConnect: false,
    });

    const connectPromise = waitForEvent(recoveredSocket, "connect", 4_000);
    const readyPromise = waitForEvent(recoveredSocket, "battle:ready");
    const statePromise = waitForEvent(recoveredSocket, "battle:state");
    recoveredSocket.connect();

    const [ready, state] = await Promise.all([
      readyPromise,
      statePromise,
      connectPromise,
    ]);

    expect(ready.roomId).toBe(match.roomId);
    expect(state.roomId).toBe(match.roomId);
    expect(Array.isArray(state.players)).toBe(true);

    closeSockets(recoveredSocket, match.socketB);
  }, 15_000);

  test("disconnect grace finalizes forfeit consistently", async () => {
    await runtime.stop();
    runtime = createRuntime({
      port: 0,
      battleDurationSeconds: 2,
      disconnectGraceMs: 300,
    });
    await runtime.start();
    baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;

    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_forfeit`,
    });

    match.socketB.disconnect();

    const finished = await waitForEvent(
      match.socketA,
      "battle:finished",
      5_000,
    );
    expect(finished.reason).toBe("disconnect-timeout");
    expect(finished.winnerId).toBe(match.playerA.user.id);

    closeSockets(match.socketA);
  });

  test("no-solution timer expiry resolves to deterministic draw", async () => {
    await runtime.stop();
    runtime = createRuntime({
      port: 0,
      battleDurationSeconds: 1,
      disconnectGraceMs: 2_000,
    });
    await runtime.start();
    baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;

    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_draw`,
    });

    const finished = await waitForEvent(
      match.socketA,
      "battle:finished",
      5_000,
    );
    expect(finished.reason).toBe("timer-expired");
    expect(finished.winnerId).toBeNull();

    const meA = await request(runtime.app)
      .get("/users/me")
      .set("Authorization", `Bearer ${match.playerA.token}`);
    const meB = await request(runtime.app)
      .get("/users/me")
      .set("Authorization", `Bearer ${match.playerB.token}`);

    expect(meA.body.rating).toBe(1200);
    expect(meB.body.rating).toBe(1200);

    closeSockets(match.socketA, match.socketB);
  });

  test("language mismatch emits explicit non-accepted verdict", async () => {
    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_lang_mismatch`,
    });

    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      language: "javascript",
      code: "def solve(input):\n  return input",
    });

    const result = await waitForEventMatch(
      match.socketA,
      "battle:submission-result",
      (payload) => payload?.userId === match.playerA.user.id,
    );

    expect(result.passed).toBe(false);
    expect([
      "compile-error",
      "invalid-language",
      "wrong-answer",
      "runtime-error",
    ]).toContain(result.verdict);

    closeSockets(match.socketA, match.socketB);
  });

  test("output mismatch returns wrong-answer and matching output returns accepted", async () => {
    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_execution_verdicts`,
    });

    const wrongCode =
      "function solve(input){ return 'definitely-wrong-output'; }";
    const acceptedCode = `function solve(input){ return ${JSON.stringify(match.readyA.problem.sampleOutput)}; }`;

    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      language: "javascript",
      code: wrongCode,
    });

    const wrongResult = await waitForEventMatch(
      match.socketA,
      "battle:submission-result",
      (payload) =>
        payload?.userId === match.playerA.user.id &&
        payload?.verdict === "wrong-answer",
    );
    expect(wrongResult.passed).toBe(false);

    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      language: "javascript",
      code: acceptedCode,
    });

    const acceptedResult = await waitForEventMatch(
      match.socketA,
      "battle:submission-result",
      (payload) =>
        payload?.userId === match.playerA.user.id &&
        payload?.verdict === "accepted",
    );
    expect(acceptedResult.passed).toBe(true);

    closeSockets(match.socketA, match.socketB);
  });

  test("all submitted without accepted result finalizes deterministically", async () => {
    await runtime.stop();
    runtime = createRuntime({
      port: 0,
      fairnessPolicy: "timer-only",
      battleDurationSeconds: 5,
      disconnectGraceMs: 2_000,
    });
    await runtime.start();
    baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;

    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_all_submitted_no_solution`,
    });

    const wrongCode = "function solve(input){ return 'nope'; }";

    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      language: "javascript",
      code: wrongCode,
    });

    match.socketB.emit("battle:submit", {
      roomId: match.roomId,
      language: "javascript",
      code: wrongCode,
    });

    const finished = await waitForEvent(
      match.socketA,
      "battle:finished",
      5_000,
    );
    expect(finished.reason).toBe("all-submitted-no-solution");
    expect(finished.winnerId).toBeNull();

    closeSockets(match.socketA, match.socketB);
  });

  test("early-finish policy finalizes immediately on first accepted", async () => {
    await runtime.stop();
    runtime = createRuntime({
      port: 0,
      fairnessPolicy: "early-finish",
      battleDurationSeconds: 5,
      disconnectGraceMs: 2_000,
    });
    await runtime.start();
    baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;

    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_early_finish`,
    });

    const acceptedCode = `function solve(input){ return ${JSON.stringify(match.readyA.problem.sampleOutput)}; }`;
    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      language: "javascript",
      code: acceptedCode,
    });

    const finished = await waitForEvent(
      match.socketA,
      "battle:finished",
      4_000,
    );
    expect(finished.reason).toBe("early-accepted");
    expect(finished.winnerId).toBe(match.playerA.user.id);

    closeSockets(match.socketA, match.socketB);
  });

  test("timer-only policy preserves timer-based accepted winner resolution", async () => {
    await runtime.stop();
    runtime = createRuntime({
      port: 0,
      fairnessPolicy: "timer-only",
      battleDurationSeconds: 2,
      disconnectGraceMs: 2_000,
    });
    await runtime.start();
    baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;

    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_timer_only_policy`,
    });

    const acceptedCode = `function solve(input){ return ${JSON.stringify(match.readyA.problem.sampleOutput)}; }`;
    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      language: "javascript",
      code: acceptedCode,
    });

    let finishedEarly = false;
    const earlyListener = () => {
      finishedEarly = true;
    };
    match.socketA.once("battle:finished", earlyListener);
    await waitMs(700);
    expect(finishedEarly).toBe(false);

    const finished = await waitForEvent(
      match.socketA,
      "battle:finished",
      5_000,
    );
    expect(finished.reason).toBe("timer-expired");
    expect(finished.winnerId).toBe(match.playerA.user.id);

    closeSockets(match.socketA, match.socketB);
  });

  test("finalize emits once and ratings update once", async () => {
    await runtime.stop();
    runtime = createRuntime({
      port: 0,
      fairnessPolicy: "early-finish",
      battleDurationSeconds: 2,
      disconnectGraceMs: 2_000,
    });
    await runtime.start();
    baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;

    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_finalize_once`,
    });

    const acceptedCode = `function solve(input){ return ${JSON.stringify(match.readyA.problem.sampleOutput)}; }`;
    let finishedEvents = 0;
    match.socketA.on("battle:finished", () => {
      finishedEvents += 1;
    });

    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      language: "javascript",
      code: acceptedCode,
    });
    match.socketB.emit("battle:submit", {
      roomId: match.roomId,
      language: "javascript",
      code: acceptedCode,
    });

    await waitForEvent(match.socketA, "battle:finished", 5_000);
    await waitMs(1_200);

    expect(finishedEvents).toBe(1);

    const meA = await request(runtime.app)
      .get("/users/me")
      .set("Authorization", `Bearer ${match.playerA.token}`);
    const meB = await request(runtime.app)
      .get("/users/me")
      .set("Authorization", `Bearer ${match.playerB.token}`);

    expect(Array.isArray(meA.body.recentMatches)).toBe(true);
    expect(Array.isArray(meB.body.recentMatches)).toBe(true);
    expect(meA.body.recentMatches.length).toBe(1);
    expect(meB.body.recentMatches.length).toBe(1);

    closeSockets(match.socketA, match.socketB);
  });

  test("chat and submit throttling blocks abuse and keeps normal flow", async () => {
    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_throttle`,
    });

    const chatReceived = waitForEvent(match.socketB, "battle:chat");
    match.socketA.emit("battle:chat", {
      roomId: match.roomId,
      message: "first",
    });
    await chatReceived;

    match.socketA.emit("battle:chat", {
      roomId: match.roomId,
      message: "second",
    });
    match.socketA.emit("battle:chat", {
      roomId: match.roomId,
      message: "third",
    });

    const chatRateLimitError = await waitForEventMatch(
      match.socketA,
      "battle:error",
      (payload) => payload?.code === "CHAT_RATE_LIMITED",
    );
    expect(chatRateLimitError.retryable).toBe(true);

    const validCode =
      "function solve(input){ const stack=[]; for (let i=0;i<1;i++){ stack.push(i);} return stack; }";

    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      code: validCode,
      language: "javascript",
    });
    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      code: validCode,
      language: "javascript",
    });
    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      code: validCode,
      language: "javascript",
    });

    const submitRateLimitError = await waitForEventMatch(
      match.socketA,
      "battle:error",
      (payload) => payload?.code === "SUBMIT_RATE_LIMITED",
    );
    expect(submitRateLimitError.retryable).toBe(true);

    closeSockets(match.socketA, match.socketB);
  });

  test("socket error payloads are standardized for queue and battle failures", async () => {
    const player = await registerUser(
      runtime.app,
      testUsername("err", Date.now()),
    );
    const socket = await connectSocket(baseUrl, player.token);

    socket.emit("queue:join", { difficulty: "invalid" });
    const queueError = await waitForEvent(socket, "queue:error");

    expect(typeof queueError.code).toBe("string");
    expect(typeof queueError.message).toBe("string");
    expect(typeof queueError.retryable).toBe("boolean");

    socket.emit("battle:submit", { invalid: true });
    const battleError = await waitForEvent(socket, "battle:error");

    expect(typeof battleError.code).toBe("string");
    expect(typeof battleError.message).toBe("string");
    expect(typeof battleError.retryable).toBe("boolean");

    closeSockets(socket);
  });

  test("ratings and recent matches update after resolved battle", async () => {
    await runtime.stop();
    runtime = createRuntime({
      port: 0,
      battleDurationSeconds: 1,
      disconnectGraceMs: 2_000,
    });
    await runtime.start();
    baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;

    const match = await createMatchedPair({
      runtime,
      baseUrl,
      suffix: `${Date.now()}_ratings`,
    });

    const winningCode = `function solve(input){ return ${JSON.stringify(match.readyA.problem.sampleOutput)}; }`;

    match.socketA.emit("battle:submit", {
      roomId: match.roomId,
      code: winningCode,
      language: "javascript",
    });

    const finished = await waitForEvent(
      match.socketA,
      "battle:finished",
      6_000,
    );
    expect(finished.winnerId).toBe(match.playerA.user.id);

    const meA = await request(runtime.app)
      .get("/users/me")
      .set("Authorization", `Bearer ${match.playerA.token}`);
    const meB = await request(runtime.app)
      .get("/users/me")
      .set("Authorization", `Bearer ${match.playerB.token}`);

    expect(meA.body.rating).toBeGreaterThan(1200);
    expect(meB.body.rating).toBeLessThan(1200);
    expect(Array.isArray(meA.body.recentMatches)).toBe(true);
    expect(Array.isArray(meB.body.recentMatches)).toBe(true);
    expect(meA.body.recentMatches[0].result).toBe("win");
    expect(meB.body.recentMatches[0].result).toBe("loss");

    closeSockets(match.socketA, match.socketB);
  });

  test("prelaunch load check validates queue latency and completion", async () => {
    await runtime.stop();
    runtime = createRuntime({
      port: 0,
      battleDurationSeconds: 1,
      disconnectGraceMs: 1_000,
    });
    await runtime.start();
    baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;

    const players = [];
    for (let index = 0; index < 6; index += 1) {
      const account = await registerUser(
        runtime.app,
        testUsername(`ld${index}`, Date.now()),
      );
      const socket = await connectSocket(baseUrl, account.token);
      players.push({ account, socket });
    }

    const queueJoinAt = new Map();
    const readyLatencies = [];
    const finishedRooms = new Set();

    const readyPromises = players.map(({ account, socket }) =>
      waitForEvent(socket, "battle:ready", 8_000).then((payload) => {
        const joinedAt = queueJoinAt.get(account.user.id);
        readyLatencies.push(Date.now() - joinedAt);
        return payload;
      }),
    );

    const finishPromises = players.map(({ socket }) =>
      waitForEvent(socket, "battle:finished", 8_000).then((payload) => {
        finishedRooms.add(payload.roomId);
        return payload;
      }),
    );

    for (const { account, socket } of players) {
      queueJoinAt.set(account.user.id, Date.now());
      socket.emit("queue:join", { difficulty: "easy" });
    }

    await Promise.all(readyPromises);
    await Promise.all(finishPromises);

    readyLatencies.sort((a, b) => a - b);
    const latencyMedian =
      readyLatencies[Math.floor(readyLatencies.length / 2)] || 0;
    const completionRate = finishedRooms.size / 3;

    expect(latencyMedian).toBeLessThanOrEqual(30_000);
    expect(completionRate).toBe(1);

    closeSockets(...players.map((entry) => entry.socket));
  });
});
