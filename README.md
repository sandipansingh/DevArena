# DevArena Production Baseline

This repository now contains a production-hardened full-stack baseline:
- client: React + Vite + Monaco editor
- server: Express + Socket.io + JWT auth
- optional Judge0 execution integration with resilient fallback
- local and containerized production run paths

## Local Development

1. Install dependencies

	npm install

2. Start both apps

	npm run dev

3. Open

	Frontend: http://localhost:5173
	Backend: http://localhost:4000

Demo account:
- username: demo
- password: password123

## Environment Files

Create these files for local overrides:
- client/.env from client/.env.example
- server/.env from server/.env.example

Key variables:
- VITE_API_BASE_URL
- PORT
- CLIENT_ORIGIN (comma-separated allowed)
- JWT_SECRET (must be at least 16 chars)
- RATE_LIMIT_WINDOW_MS
- RATE_LIMIT_MAX_REQUESTS
- JUDGE0_URL (optional)
- JUDGE0_KEY (optional)

## Production Hardening Included

- Helmet security headers
- Compression middleware
- Global API rate limiting
- CORS allowlist from env
- request body size limit
- graceful shutdown on SIGINT/SIGTERM
- consistent production error responses
- Mongo-ready persistence layer (enabled when MONGODB_URI is set)

## AI Match Mode

When AI is enabled (`AI_ENABLED=true` with `OPENAI_API_KEY`):

- AI generates contest problems based on player ELO and selected difficulty.
- AI compares both contestants' submissions at battle end and provides winner analysis.
- AI returns per-player feedback with strengths, weaknesses, and improvement suggestions.

If AI is disabled/unavailable, the platform falls back to the standard problem library and deterministic scoring.

## Automated Testing

Run all tests:

1. npm run test

Run individually:

1. npm run test:server
2. npm run test:client

CI:

- GitHub Actions workflow at .github/workflows/ci.yml runs server tests, client tests, and client build.

## Production Deployment (Docker)

Build and run:

1. npm run prod:up
2. Open client at http://localhost:8080
3. API remains on http://localhost:4000

Stop:

1. npm run prod:down

Important: update JWT_SECRET in docker-compose.prod.yml before real deployment.

## API Summary

- GET /health
- GET /problems
- GET /leaderboard
- POST /auth/register
- POST /auth/login
- GET /users/me

## Known Scope

- queue/battle room state remains in-memory for low-latency realtime handling
- when MONGODB_URI is not set, user persistence falls back to in-memory mode
