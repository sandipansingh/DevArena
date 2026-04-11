# Developer Tasks: DevArena Rollout
**Based on PRD v2.0 & Phase 1-4 Architecture Plan**

---

## Phase 1: Core Infrastructure and 1v1 Battles

### Task 1.1: Provision canonical PostgreSQL schema
**Description:** Build the initial SQL migrations for the core domain entities: `users`, `profiles`, `problems`, `matches`, and `submissions`.
**Files affected:** `server/src/repository.js`, `server/db/migrations/001_initial_schema.sql`
**Dependencies:** None

### Task 1.2: Authentication and JWT Session Binding
**Description:** Implement robust REST authentication (`/auth/login`, `/auth/register`) mapping user credentials and binding the JWT check into the Express router and the `handshake.auth.token` parameter of the Socket.IO handler.
**Files affected:** `server/src/auth.js`, `server/src/index.js`
**Dependencies:** Task 1.1

### Task 1.3: Redis Matchmaking Queue
**Description:** Develop an async loop to hold players seeking a match inside a Redis Set partitioned by ranking tier. Emit a `queue:matched` Socket.IO event when opponents are found.
**Files affected:** `server/src/index.js`, `server/src/matchmaking.js` (new)
**Dependencies:** Task 1.2

### Task 1.4: React Real-Time Collaborative Editor
**Description:** Integrate Monaco Editor in the React App. Wire `battle:sync` and `battle:update` socket events to enable dual-user concurrent editing via Operational Transformation or simpler CRDT updates.
**Files affected:** `client/src/App.tsx`, `client/src/components/Editor.tsx` (new)
**Dependencies:** Task 1.3

### Task 1.5: Secure Remote Code Execution Integration
**Description:** Build the interaction service layer mapping to Judge0. Send user code from the active battle room and return standardized `battle:execution_result` event payloads. Add deterministic local execution fallback logic.
**Files affected:** `server/src/execution.js`, `server/src/index.js`
**Dependencies:** Task 1.4

### Task 1.6: End-of-Match & ELO Processing
**Description:** Build the post-battle evaluation logic triggered by Judge0's final test suite pass. Modify `users.elo_rating` utilizing standard ELO adjustments based on the initial ranking gap between opponents.
**Files affected:** `server/src/index.js`, `server/src/repository.js`
**Dependencies:** Task 1.5

---

## Phase 2: AI Integration and Practice Arena

### Task 2.1: LLM Assistant Worker Service
**Description:** Setup OpenAI integrations mapping finalized code inputs sent on match-end to prompt templates asking for Space/Time Big O notations and concrete improvement points.
**Files affected:** `server/src/ai.js`, `server/src/config.js`
**Dependencies:** Task 1.6

### Task 2.2: Store & Fetch Coaching Analytics
**Description:** Build API controllers necessary for users to fetch their past `ai_feedback` objects. Extend repository layer bindings for the `ai_feedback` SQL table.
**Files affected:** `server/src/repository.js`, `server/src/index.js`
**Dependencies:** Task 2.1

### Task 2.3: Interactive Practice Arena UI
**Description:** Construct a single-player mock routing flow inside the React app where users face synthetic problems backed by backend OpenAI challenge generation prompts instead of human opponents.
**Files affected:** `client/src/App.tsx`, `client/src/appFlow.ts`
**Dependencies:** Task 2.2

---

## Phase 3: Team Battles and Tournaments

### Task 3.1: Multi-Client Socket Orchestration
**Description:** Expand the Socket.IO `battle:sync` routing context to handle arrays of concurrent deltas preventing complete overwrite collision between 4 players editing identical room channels.
**Files affected:** `server/src/index.js`
**Dependencies:** Task 1.4

### Task 3.2: Tournament Registration & Tracking
**Description:** Setup REST endpoints for `/tournaments` listing active seasonal scheduled brackets. Construct Redis mapping allowing massive concurrent queue injections routing into multiple segregated battle rooms.
**Files affected:** `server/src/index.js`, `server/src/repository.js`
**Dependencies:** Task 3.1

### Task 3.3: Dynamic Leaderboard Dashboard
**Description:** Map the live query fetching high Elo profiles via `/leaderboard`. Refine UI rendering for conditional ranking badges (Bronze -> Platinum).
**Files affected:** `client/src/api.ts`, `client/src/components/Leaderboard.tsx`
**Dependencies:** Task 3.2

---

## Phase 4: Recruiter Dashboard and Talent Discovery

### Task 4.1: Role-Based Platform Navigation
**Description:** Restrict enterprise endpoint access strictly to JWT tokens embedded with the `role: recruiter` tag. Modify standard app routing flows to divert successfully authenticated recruiters gracefully to their specific dashboard.
**Files affected:** `server/src/auth.js`, `client/src/appFlow.ts`, `client/src/App.tsx`
**Dependencies:** Task 1.2

### Task 4.2: Developer Metric Aggregation API
**Description:** Construct specialized indexing searches linking `profiles`, `matches`, and past `ai_feedback` for rapid JSON array construction returning qualified candidates filtered by selected parameters.
**Files affected:** `server/src/repository.js`, `server/src/index.js`
**Dependencies:** Task 4.1

### Task 4.3: Recruiter Portal Interface
**Description:** Build out the React views executing the tiered queries, displaying actionable analytics breakdowns alongside candidates' historical execution graphs.
**Files affected:** `client/src/api.ts`, `client/src/pages/RecruiterPortal.tsx` (new)
**Dependencies:** Task 4.2

### Task 4.4: Talent Connection Funnel
**Description:** Build mutual opt-in messaging endpoints. Allow recruiters to initiate direct chat intents triggering alerts inside targeted developer's account notifications channel via WebSockets.
**Files affected:** `server/src/index.js`, `client/src/components/Notifications.tsx` (new)
**Dependencies:** Task 4.3