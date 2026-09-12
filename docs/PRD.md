# PRD: DE Research Dashboard Backend

## 1. Problem Statement

Researchers need to compare the performance of Differential Evolution algorithm variants across benchmark fitness functions to determine optimal parameter combinations. Manually configuring and running 80+ model variations across 10 functions is impractical. The current backend lacks job queueing, live progress tracking, admin oversight, and production deployment infrastructure.

## 2. Solution

A Dockerized Express 5 backend that accepts simulation parameter sets from researchers, queues them to AWS SQS for processing by EC2 workers, and stores results (per-model-per-function lowest fitness values) directly to MongoDB with real-time progress updates. Admin role provides cross-user visibility and queue monitoring. JWT auth with refresh token rotation prevents session expiry during long simulations.

## 3. User Stories

1. *As a researcher, I want to register and log in, so that my simulations are private to my account.*
2. *As a researcher, I want to configure which benchmark functions (1-10), mutation schemes (1-10), crossover operators (1-4), and selection methods (1-2) to run, so that I can define my experiment.*
3. *As a researcher, I want the system to compute all model combinations as a Cartesian product of my inputs, so that I can compare every variant.*
4. *As a researcher, I want the backend to push my simulation configuration to SQS, so that EC2 workers can process it asynchronously.*
5. *As a researcher, I want to view real-time progress (X/Y models complete, %) on my active simulation, so that I know when results are ready.*
6. *As a researcher, I want to see the final results as a grid of (model × function → lowest fitness value), so that I can compare performance across variants.*
7. *As a researcher, I want to view my simulation history with status and timestamps, so that I can revisit past experiments.*
8. *As a researcher, I want my access token to refresh silently via a refresh token, so that I am not logged out mid-experiment.*
9. *As an admin, I want to view all users and their simulations, so that I can monitor system usage.*
10. *As an admin, I want to suspend or manage user accounts, so that I can enforce policy.*
11. *As an admin, I want to view the current SQS queue depth, so that I can gauge worker load.*
12. *As a developer, I want the backend packaged as a Docker image, so that it deploys consistently anywhere.*

## 4. Implementation Decisions

### Architecture

```
Researcher (React SPA, separate repo)
    ↓ HTTP (JWT)
Express 5 Backend (Dockerized)
    ↓ Simulation job
AWS SQS Queue
    ↓ Poll
EC2 Workers (autoscaling)
    ↓ Write
MongoDB (progress + results)
    ↑ Read
Backend (serves results to frontend)
```

### Auth System

- Access token: JWT, 1-hour expiry, sent via `Authorization: Bearer` header
- Refresh token: long-lived, stored in httpOnly cookie, exchanged at `/api/refresh` without user re-entering credentials
- Roles: `user` (researcher) and `admin` — enforced at route level via middleware

### Simulation Model (existing schema, needs refinement)

- Input: arrays of `functions` (1–10), `mutation` (1–10), `crossover` (1–4), `selection` (1–2)
- Output: `simulationData` to store concrete results grid — replace current `type: []` with structured schema: array of `{ functionId, mutationId, crossoverId, selectionId, lowestFitness }`
- Progress: `completedModels / totalModels` → percentage, written by EC2 worker

### Admin Endpoints (new)

- `GET /api/admin/users` — list all users
- `PATCH /api/admin/users/:id/suspend` — toggle user active status
- `GET /api/admin/simulations` — list any user's simulations
- `GET /api/admin/queue` — SQS queue attributes (depth, approximate age)

### Deployment

- `Dockerfile` multi-stage (Node 20 slim) + `.dockerignore`
- Env vars injected at runtime via EC2 task definition or `docker run -e`
- No Secrets Manager, no S3 (v1)

## 5. Testing Decisions

A good test validates behavior visible at the API boundary:

- Auth: register → login returns token → verified endpoint succeeds without token returns 401
- Simulation: create with valid params returns 201 → `GET /api/simulation/get` returns it → delete removes it
- Admin: user with `role: "user"` cannot access admin endpoints; `role: "admin"` can
- Refresh: expired access token + valid refresh cookie returns new access token

**Prior art:** No existing tests in repo — this is greenfield. Add `jest` + `supertest` as dev dependencies. Test structure mirrors MVC layout: `tests/auth.test.js`, `tests/simulation.test.js`, `tests/admin.test.js`.

## 6. Out of Scope

- Frontend SPA (separate repo, consumes this API)
- S3/profile picture upload
- AWS Secrets Manager (env vars suffice for v1)
- Email verification flow (`isVerified` field deferred)
- Worker/EC2-side code (this repo is the backend API only)
- CI/CD pipeline
- Rate limiting
- WebSocket/polling strategy (frontend concern)
