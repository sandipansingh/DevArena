# DevArena Technical Architecture Blueprint

## 1. System Architecture

The DevArena platform utilizes a decoupled, event-driven architecture designed to isolate low-latency real-time operations from high-latency code execution and AI inference.

- **Client Layer**: React SPA (built with Vite). Maintains a persistent Socket.IO connection during matchmaking and active battles.
- **API & WebSocket Gateway**: Node.js/Express instances. Handles resting routing, authentication, and upgrades to Socket.IO connections.
- **State & Message Bus**: Redis cluster. Maintains the matchmaking queue, caches leaderboards, and routes real-time IDE keystrokes via Pub/Sub between Express nodes via Socket.IO adapter.
- **Async Processing Engine**: Node.js background workers (e.g., using BullMQ) or isolated asynchronous handlers consuming from Redis.
  - _Execution Worker_: Submits user code to the isolated Judge0 cluster, polls for results, and pushes battle state updates.
  - _AI Worker_: Packages code and prompt templates, queries the OpenAI API, evaluates time/space complexity, and generates actionable feedback.
- **Persistence Layer**: PostgreSQL cluster storing canonical state (users, submissions, ELO ratings, historical matches).
- **Code Sandbox**: Judge0 cluster deployed on isolated infrastructure strictly sandboxing untrusted Remote Code Execution (RCE).

## 2. Services

- **WebApp Service (`client`)**: React application delivering the UI, user dashboard, recruiter portal, and Monaco-based collaborative IDE.
- **Core API Service (`server`)**: Central Express backend processing REST requests and managing all Socket.IO room lifecycle events.
- **Matchmaking Service (Internal)**: A dedicated async loop evaluating the Redis matchmaking queue, creating match records in PostgreSQL, and emitting "Match Found" events via Socket.IO.
- **Code Execution (`execution.js`)**: Interfaces securely with Judge0 cluster or local execution fallbacks.
- **AI Coach (`ai.js`)**: Interfaces with OpenAI API. Emits results back to the Socket.IO channel.

## 3. Database Schema (PostgreSQL)

```sql
-- Users and Auth
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR UNIQUE NOT NULL,
    password_hash VARCHAR NOT NULL,
    role VARCHAR NOT NULL, -- 'developer', 'recruiter', 'admin'
    created_at TIMESTAMP DEFAULT NOW()
);

-- Developer Profiles
CREATE TABLE profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    handle VARCHAR UNIQUE NOT NULL,
    elo_rating INT DEFAULT 1200,
    tier VARCHAR DEFAULT 'Bronze', -- Bronze, Silver, Gold, Platinum
    bio TEXT,
    primary_languages VARCHAR[]
);

-- Problems / Challenges
CREATE TABLE problems (
    id UUID PRIMARY KEY,
    title VARCHAR NOT NULL,
    description TEXT NOT NULL,
    difficulty VARCHAR NOT NULL, -- Easy, Medium, Hard
    test_cases JSONB NOT NULL -- [{input: "...", expected: "..."}]
);

-- Matches / Battles
CREATE TABLE matches (
    id UUID PRIMARY KEY,
    problem_id UUID REFERENCES problems(id),
    mode VARCHAR NOT NULL, -- '1v1', '2v2', '4v4', 'practice'
    status VARCHAR NOT NULL, -- 'queued', 'active', 'completed'
    started_at TIMESTAMP,
    ended_at TIMESTAMP
);

-- Match Participants
CREATE TABLE match_participants (
    match_id UUID REFERENCES matches(id),
    user_id UUID REFERENCES users(id),
    team_id INT, -- For 2v2/4v4 configurations
    elo_change INT,
    PRIMARY KEY (match_id, user_id)
);

-- Submissions
CREATE TABLE submissions (
    id UUID PRIMARY KEY,
    match_id UUID REFERENCES matches(id),
    user_id UUID REFERENCES users(id),
    code TEXT NOT NULL,
    language VARCHAR NOT NULL,
    status VARCHAR NOT NULL, -- 'pending', 'passed', 'failed', 'error'
    runtime_ms INT,
    memory_kb INT,
    submitted_at TIMESTAMP DEFAULT NOW()
);

-- AI Coaching Feedback
CREATE TABLE ai_feedback (
    id UUID PRIMARY KEY,
    submission_id UUID REFERENCES submissions(id),
    time_complexity VARCHAR,
    space_complexity VARCHAR,
    suggestions TEXT,
    generated_at TIMESTAMP DEFAULT NOW()
);
```

## 4. APIs

**REST API (Express)**

- `POST /auth/register` | `POST /auth/login` (Returns JWT)
- `GET /users/me` (Profile representation)
- `GET /leaderboard` (Cached list of top players)
- `GET /tournaments` (Scheduled tournament data)
- `GET /problems` (Problem catalog)

**WebSocket API (Socket.IO)**

- **Client -> Server (`emit`)**:
  - `queue:join` (`{ mode: '1v1', difficulty: 'medium' }`)
  - `battle:sync` (`{ deltas: [...] }` for editor CRDT)
  - `battle:submit_code` (`{ code: "...", language: "javascript" }`)
- **Server -> Client (`on`)**:
  - `queue:matched` (`{ room_id: "...", opponent: "...", problem: {...} }`)
  - `battle:update` (`{ deltas: [...] }`)
  - `battle:execution_result` (`{ status: "failed", stdout: "...", tests_passed: 2 }`)
  - `battle:ai_feedback` (`{ time_complexity: "O(N^2)", suggestions: "..." }`)

## 5. Folder Structure

```text
/
├── .github/                      # CI/CD workflows
├── client/                       # React/Vite Application
│   ├── public/
│   ├── src/
│   │   ├── api.ts                # HTTP client layer
│   │   ├── appFlow.ts            # Phase/state machine
│   │   ├── App.tsx               # Main application component routing
│   │   ├── main.tsx
│   │   ├── App.css
│   │   └── index.css
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── server/                       # Node.js/Express Application
│   ├── src/
│   │   ├── index.js              # Express REST router & Socket.IO wiring
│   │   ├── auth.js               # Auth handlers & JWT logic
│   │   ├── repository.js         # PostgreSQL/Memory data boundary
│   │   ├── config.js             # Zod env validation
│   │   ├── execution.js          # Code execution triggers (Judge0/Local)
│   │   ├── ai.js                 # OpenAI integration logic
│   │   ├── problems.js           # Problem definitions/fetching
│   │   └── store.js
│   ├── tests/                    # Integration and unit tests
│   ├── package.json
│   └── vitest.config.js
└── docker-compose.prod.yml       # Production infrastructure mapping
```

## 6. Deployment Architecture

- **Frontend Deployment**: Static hosting CDN (e.g., Vercel, AWS CloudFront, or Netlify). React SPA is built via `npm run build` and served as static HTML/JS/CSS.
- **Backend Compute**: AWS ECS (Elastic Container Service) or Elastic Beanstalk.
  - _Express/Socket.IO Pods_: Scaled horizontally based on CPU and WebSocket connection count. Sticky sessions enabled at the Load Balancer level for Socket.IO polling fallback, or fully utilizing WebSocket endpoints with a Redis adapter.
- **Database**: AWS RDS for PostgreSQL (Multi-AZ for high availability).
- **Caching & Message Bus**: AWS ElastiCache for Redis. Connects to the Socket.IO Redis Adapter to broadcast events to users connected across different Express server instances.
- **Secure Code Execution**: Judge0 sandbox deployed on isolated EC2 instances with strict resource limits (execution time, memory, network calls disabled for the sandboxed code).
