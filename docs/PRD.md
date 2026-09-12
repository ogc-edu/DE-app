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
- Refresh token: long-lived (7d), stored in an httpOnly cookie and exchanged at
  `/api/v1/refresh` without the user re-entering credentials. **Built as:** only the
  SHA-256 digest is persisted (`users.refreshTokenHash`), compared in constant time;
  rotated on every refresh; cleared on logout, suspension and password change.
- Roles: `user` (researcher) and `admin` — enforced at route level via middleware
- All routes are versioned under `/api/v1` (this section's unversioned paths predate that decision)

### Simulation Model (**resolved** — schema refined as specified)

- Input: arrays of `functions` (1–10), `mutation` (1–10), `crossover` (1–4), `selection` (1–2)
- Output: `simulationData` stores the concrete results grid as a structured subdocument
  array of `{ functionId, mutationId, crossoverId, selectionId, lowestFitness }`
- Progress: `completedModels / totalModels` → percentage, written by the EC2 worker
- **Also built:** the DE knobs `np` / `f` / `cr` / `gen` / `dim` are Zod-validated,
  persisted with defaults, and shipped in the SQS job; `running` was added to the
  status enum; `cancelSimulation` refuses terminal statuses (409)

### Job Queue (built)

- `POST /api/v1/simulation/create` enqueues one SQS job per simulation
  (`config/sqs.js`). If the enqueue fails the simulation is marked `failed` and the
  201 response carries `queued: false`, so nothing hangs in `pending`.

### Data Import (built, beyond the original PRD)

- `POST /api/v1/simulation/import` accepts a `.txt` results file and stores it as an
  already-`completed` simulation; parse failures return `400` with line-numbered
  `errors[]`.

### Profile Pictures (built, beyond the original PRD)

- `GET /api/v1/user/profile/presign` issues a presigned S3 PUT URL; the client uploads
  directly to S3 and confirms via `POST /api/v1/user/profile/picture`.

### API Error Semantics (built)

- Domain errors carry typed status codes (401/403/404/409) via `utils/errors.js`; see
  the matrix in `docs/middleware.md`.

### Admin Endpoints (new)

- `GET /api/v1/admin/users` — list all users (paginated)
- `GET /api/v1/admin/users/:id` — single user
- `PATCH /api/v1/admin/users/:id/suspend` — toggle user active status (also ends the user's session)
- `GET /api/v1/admin/simulations` — list any user's simulations
- `DELETE /api/v1/admin/simulations/:id` — delete any simulation
- `GET /api/v1/admin/queue` — real SQS queue attributes (depth, in-flight, delayed, oldest message age)

### Deployment

- `Dockerfile` multi-stage (Node 20 slim) + `.dockerignore`
- Env vars injected at runtime via EC2 task definition or `docker run -e`
- No Secrets Manager (env vars suffice for v1). S3 **is** used, for profile pictures.

## 5. Testing Decisions

A good test validates behavior visible at the API boundary:

- Auth: register → login returns token → verified endpoint succeeds without token returns 401
- Simulation: create with valid params returns 201 → `GET /api/simulation/get` returns it → delete removes it
- Admin: user with `role: "user"` cannot access admin endpoints; `role: "admin"` can
- Refresh: expired access token + valid refresh cookie returns new access token

**Prior art:** No existing tests in repo — this was greenfield. `jest` + `supertest` are
dev dependencies and the structure mirrors the MVC layout. **Built:** 107 tests across 6
suites — `tests/auth.test.js`, `tests/user.test.js`, `tests/simulation.test.js`,
`tests/admin.test.js`, `tests/import.test.js`, `tests/importParser.test.js`.
See [Testing](./testing.md).

## 6. Out of Scope

- Frontend SPA (separate repo, consumes this API)
- AWS Secrets Manager (env vars suffice for v1)
- Email verification flow (`isVerified` field deferred)
- Worker/EC2-side code (this repo is the backend API only — the worker lives in `DE-forEC2`)
- CI/CD pipeline
- Rate limiting
- Refresh-token reuse detection (`jti` blacklist)
- WebSocket/polling strategy (frontend concern)
