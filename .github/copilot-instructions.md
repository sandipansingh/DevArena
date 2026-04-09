# Copilot Instructions for DevArena

## Build, test, and lint commands

Run commands from the repository root unless noted.

- Install dependencies (clean/CI style): `npm ci && npm ci --prefix server && npm ci --prefix client`
- Start both apps in dev mode: `npm run dev`
- Build frontend: `npm run build`
- Build frontend + production server deps: `npm run build:all`
- Run all tests: `npm run test`
- Run server tests only: `npm run test --prefix server`
- Run client tests only: `npm run test --prefix client`
- Run a single server test file: `npm run test --prefix server -- tests/api.test.js`
- Run a single client test file: `npm run test --prefix client -- src/api.test.ts`
- Run a single test by name (Vitest): `npm run test --prefix server -- -t "health endpoint responds"`
- Lint frontend: `npm run lint --prefix client`

CI (`.github/workflows/ci.yml`) uses Node 20 and runs server tests, client tests, and client build.

## High-level architecture

DevArena is a two-app repo:

1. **Server (`server/src/index.js`)**: one runtime hosts both Express REST APIs and Socket.IO realtime events.
2. **Client (`client/src/App.tsx`)**: one React app controls auth, queue, battle, and results as a phase/state machine.

Core server flow spans multiple modules:

- `index.js` wires HTTP endpoints (`/auth/*`, `/users/me`, `/leaderboard`, `/problems`, `/tournaments`) and all socket events (`queue:*`, `battle:*`, `spectator:*`).
- `repository.js` is the data boundary for users and ratings. It switches between MongoDB and in-memory users based on `MONGODB_URI`.
- Realtime queue/room state (`waitingByDifficulty`, `activeRooms`) is always in-memory and shared from `repository.js`.
- Match problems come from `ai.js` (if enabled) or `problems.js` fallback.
- Code execution uses `execution.js`: Judge0 when configured, otherwise local validator fallback.
- End-of-battle logic runs on a timer in `index.js`, updates ratings via repository functions, and emits final battle results (optionally AI insights).

Client flow:

- `App.tsx` maps internal phases to routes and manages one authenticated socket connection during queue/battle.
- `api.ts` is the single HTTP client layer and shared payload typing source for auth, profile, leaderboard, tournaments, and battle payloads.

## Key conventions specific to this codebase

- **Use `repository.js` for persistence and shared runtime state.** `store.js` exists but is not wired into the running server.
- **JWT is the single auth mechanism for both REST and sockets.** Socket auth expects `handshake.auth.token`, using the same token returned by `/auth/login` and `/auth/register`.
- **Configuration and request validation use Zod.** Env is validated at startup (`config.js`) and auth payloads are validated in route handlers.
- **Battle continuity is fail-open for external services.** If OpenAI/Judge0 is unavailable, gameplay continues with deterministic fallbacks (problem library + local validator).
- **Client error handling expects `{ message }` API responses.** `api.ts` converts non-2xx responses into thrown `Error(message)`.
- **Tests use runtime construction rather than spawning the server process.** Server tests call `createRuntime({ port: 0, battleDurationSeconds: 5 })`, then hit `runtime.app` via Supertest.
- **Demo account is seeded in startup/repository flows** (`demo` / `password123`) and is used in local docs/UI hints.
