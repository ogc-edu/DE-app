# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Express 5 + MongoDB backend for a **Differential Evolution (DE) research dashboard**. Researchers submit experiment configs (benchmark functions 1–10 × mutation schemes 1–10 × crossover operators 1–4 × selection methods 1–2 — up to 80 models × 10 functions as a Cartesian product). This repo is the **API + data layer only**: it enqueues one SQS job per simulation; the actual computation runs in a separate repo (`DE-forEC2/spawner.js`) on EC2 workers, which write `status`, `progress`, `completedModels`, and `simulationData` **directly to MongoDB**. The React SPA is also a separate repo.

Consequence: simulation progress/results are not produced by any code here. If results look wrong, the worker repo or the DB is the place to look — not the controllers.

## Commands

```bash
npm run dev                 # nodemon server.js (port 3000)
npm start                   # node server.js
npm test                    # cross-env NODE_ENV=test jest
npm run test:watch
npm run test:coverage
docker-compose up --build   # mongo (atlas-local) + backend via Dockerfile.dev

# Single test file / single test
npx cross-env NODE_ENV=test npx jest tests/simulation.test.js
npx cross-env NODE_ENV=test npx jest -t "creates a simulation"
```

**Tests need a running MongoDB Atlas Local container** (replica set), not a plain `mongod`:

```bash
docker compose up -d mongo   # container de-db, port 27017
```

`tests/setup.js` connects to `mongodb://root:password123@localhost:27017/Dashboard-Test-Database?directConnection=true&authSource=admin` (override with `MONGODB_URI_TEST`), wipes every collection after each test, and **mocks `@aws-sdk/client-sqs`** so tests never hit real AWS. The mock exposes `__sqsSendMock` — require it to assert on the enqueued message body.

Copy `.env.example` → `.env` before running. `JWT_SECRET` and `JWT_REFRESH_SECRET` have no defaults.

## Architecture

Layered MVC, CommonJS throughout (no ESM anywhere):

- `app.js` builds the Express app (helmet → json → urlencoded → cookieParser → cors → morgan→winston → `/api/v1` routes → swagger → notFound → errorHandler); `server.js` connects the DB, listens, and closes on SIGTERM. **Keep them separate** — tests `require("./app")` without starting a server.
- `routes/index.js` is where auth applies: `/simulation` and `/user` are mounted behind `authMiddleware`, `/admin` behind `authMiddleware + adminMiddleware`. Individual route files assume the user is already authenticated.
- **Mongoose statics own the data logic** (`users.login()`, `simulations.createSimulation()`, `importSimulation`, `getSimulation`, `cancelSimulation`…). Controllers stay thin: destructure, call a static, respond, `catch (err) → next(err)`. Don't inline queries in controllers.
- **Ownership checks live in controllers/models**, comparing `simulation.userId.toString() === req.userId` — not in middleware.
- Validation is Zod schemas in `validators/`, applied via the `validate(schema)` middleware factory, which replaces `req.body` with the parsed (trimmed/coerced) data.
- `config/s3.js` and `config/sqs.js` read env vars **at require time**. Anything that sets them (notably `tests/setup.js`) must do so before those modules are imported.
- Swagger is generated from `@openapi` JSDoc annotations **in the route files**; new endpoints need annotations there or they vanish from `/api/v1/docs`.

## Conventions and traps

- **`errorHandler` maps any generic `new Error(...)` to HTTP 400.** So ownership failures, missing resources, and conflicts all surface as 400 today, and the test suite deliberately asserts 400. Fixing the semantics is planned work (`docs/plans/003-api-error-semantics-fix.md`) — changing it ripples through many tests, so don't do it incidentally.
- Password max length is **12 characters**, enforced in three places (Zod validator, user model, change-password flow). Keep them in sync.
- `POST /simulation/create` must never 500 when SQS is down: the record exists, so it logs, marks the simulation `failed`, and returns 201 with `queued: false`.
- `POST /simulation/import` bypasses SQS entirely and stores a `completed` simulation. Parsing lives in the pure, unit-tested `utils/importParser.js`; failures return `400 { errors: [{line, message}] }` — line numbers are a product requirement, keep them.
- Route ordering matters in `simulationRoutes.js`: `/get/:simulationId/results` is registered before `/get/:simulationId`.
- Refresh tokens are stored **plaintext** in `users.refreshToken` (`select: false`), single-token, rotated on `/refresh` — concurrent sessions overwrite each other. Hardening is planned (`docs/plans/002-refresh-token-hardening.md`).
- `cancelSimulation` guards terminal statuses; `simulationData` subdocuments require all four model IDs, so partial result writes are rejected by Mongoose.

## Documentation

`docs/context.md` is the living, maintained description of this repo — **read it first** and update it when behavior changes. `docs/IMPLEMENTATION_PLAN.md` plus `docs/plans/001`–`004` describe approved remaining work. `docs/PRD.md`, `docs/architecture.md`, `docs/api-reference.md`, `docs/models.md`, `docs/authentication.md`, `docs/middleware.md`, `docs/testing.md` cover depth.

`REASONIX.md` at the repo root is **stale** (describes `/api` routes, claims there is no test suite). Prefer `docs/context.md` over it.
