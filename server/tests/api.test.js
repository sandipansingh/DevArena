const request = require("supertest");
const { createRuntime } = require("../src/index");
const { seedUsers } = require("../src/repository");

describe("DevArena API", () => {
  let runtime;

  beforeAll(async () => {
    runtime = createRuntime({ port: 0, battleDurationSeconds: 5 });
    await seedUsers();
    await runtime.start();
  });

  afterAll(async () => {
    await runtime.stop();
  });

  test("health endpoint responds", async () => {
    const res = await request(runtime.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const readyRes = await request(runtime.app).get("/health/ready");
    expect(readyRes.status).toBe(200);
    expect(readyRes.body.ok).toBe(true);
    expect(readyRes.body.runtime).toBeTruthy();
  });

  test("register, login, and me flow", async () => {
    const username = `tester_${Date.now()}`;

    const registerRes = await request(runtime.app)
      .post("/auth/register")
      .send({ username, password: "password123" });

    expect(registerRes.status).toBe(201);
    expect(registerRes.body.token).toBeTruthy();

    const loginRes = await request(runtime.app)
      .post("/auth/login")
      .send({ username, password: "password123" });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.username).toBe(username);
    expect(loginRes.body.user.role).toBe("developer");

    const meRes = await request(runtime.app)
      .get("/users/me")
      .set("Authorization", `Bearer ${loginRes.body.token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.username).toBe(username);
    expect(meRes.body.role).toBe("developer");
    expect(Array.isArray(meRes.body.recentMatches)).toBe(true);

    const feedbackRes = await request(runtime.app)
      .get("/users/me/ai-feedback")
      .set("Authorization", `Bearer ${loginRes.body.token}`);

    expect(feedbackRes.status).toBe(200);
    expect(Array.isArray(feedbackRes.body)).toBe(true);
  });

  test("leaderboard and problems endpoints", async () => {
    const leaderboardRes = await request(runtime.app).get("/leaderboard");
    expect(leaderboardRes.status).toBe(200);
    expect(Array.isArray(leaderboardRes.body)).toBe(true);

    const problemsRes = await request(runtime.app).get("/problems");
    expect(problemsRes.status).toBe(200);
    expect(Array.isArray(problemsRes.body)).toBe(true);
    expect(problemsRes.body.length).toBeGreaterThan(0);
  });

  test("tournaments endpoint returns baseline data", async () => {
    const res = await request(runtime.app).get("/tournaments");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty("id");
  });

  test("recruiter candidates endpoint enforces role access", async () => {
    const recruiterName = `recruiter_${Date.now()}`;
    const devName = `dev_${Date.now()}`;

    const recruiterRes = await request(runtime.app)
      .post("/auth/register")
      .send({
        username: recruiterName,
        password: "password123",
        role: "recruiter",
      });

    const devRes = await request(runtime.app)
      .post("/auth/register")
      .send({
        username: devName,
        password: "password123",
        primaryLanguages: ["javascript", "python"],
      });

    expect(recruiterRes.status).toBe(201);
    expect(recruiterRes.body.user.role).toBe("recruiter");
    expect(devRes.status).toBe(201);

    const forbidden = await request(runtime.app)
      .get("/recruiter/candidates")
      .set("Authorization", `Bearer ${devRes.body.token}`);
    expect(forbidden.status).toBe(403);

    const allowed = await request(runtime.app)
      .get("/recruiter/candidates?language=javascript&limit=10")
      .set("Authorization", `Bearer ${recruiterRes.body.token}`);
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body)).toBe(true);
    expect(
      allowed.body.every((candidate) => candidate.username !== recruiterName),
    ).toBe(true);
  });
});
