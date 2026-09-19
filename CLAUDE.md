# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Express 5 + DynamoDB backend for a **Differential Evolution (DE) research dashboard**. Researchers
submit experiment configs (benchmark functions 1–10 × mutation schemes 1–10 × crossover operators
1–4 × selection methods 1–2 — up to 80 models × 10 functions as a Cartesian product). This repo is
the **API + data layer only**: it enqueues one SQS job per simulation; the actual computation runs
in a separate repo (`DE-forEC2/spawner.js`) on EC2 workers, which write `status`, `progress`,
`completedModels`, and result rows **directly to the same DynamoDB tables this repo reads**. The
React SPA is also a separate repo.

Consequence: simulation progress/results are not produced by any code here. If results look wrong,
the worker repo or the tables themselves are the place to look — not the controllers.

## Commands

```bash
npm run dev                     # nodemon server.js (port 3000)
npm start                       # node server.js
npm test                        # cross-env NODE_ENV=test jest --runInBand
npm run test:watch
npm run test:coverage
docker-compose up --build       # DynamoDB Local + backend via Dockerfile.dev

# Single test file / single test
npx cross-env NODE_ENV=test npx jest tests/simulation.test.js
npx cross-env NODE_ENV=test npx jest -t "creates a simulation"
```

**Tests need a running DynamoDB Local container**, not MongoDB — the MongoDB/Mongoose layer this
repo used to have was fully replaced by DynamoDB (see `git log --oneline | grep -i dynamodb`):

```bash
docker compose up -d dynamodb      # container de-dynamodb, port 8000, -sharedDb
npm run db:create                  # creates the dev tables (idempotent)
npm run db:create:test             # creates the -test tables; refuses to run against real AWS
```

`tests/setup.js` sets `DYNAMODB_ENDPOINT`/table-name env vars **before requiring any app module**
(`config/database.js` reads `TABLES` at require time), ensures the `-test` tables exist, wipes
them between tests via `Scan` + batched `DeleteRequest`s, and **mocks `@aws-sdk/client-sqs`** so
tests never hit real AWS. The mock exposes `__sqsSendMock` — require it to assert on the enqueued
message body.

Copy `.env.example` → `.env` before running. `JWT_SECRET` and `JWT_REFRESH_SECRET` have no defaults.

## Persistence: DynamoDB, no ODM

There is no connection string, no schema layer, and no `connectDB` work to do —
`config/database.js` exports a `ddb` `DynamoDBDocumentClient` plus a `TABLES` map resolved from
env at require time, and no-op `connectDB`/`closeDB` shims kept only so `server.js` and
`tests/setup.js` don't need restructuring.

Four tables (names come from `USERS_TABLE`/`SIMULATIONS_TABLE`/`RESULTS_TABLE`/`UNIQUENESS_TABLE`,
defaults in `scripts/create-tables.js`):

- **`de-users`** (PK `userId`, UUID) + GSI `email-index` (PK `email`) for login/duplicate lookup.
  DynamoDB has no `select: false` — `passwordHash` and `refreshTokenHash` must be **stripped
  explicitly** (see `toSafeUser` in `models/user.js`) before anything reaches a client.
- **`de-simulations`** (PK `simulationId`) — metadata/progress only, **never** an inline result
  list (400 KB item cap). GSIs: `user-createdAt-index` (used by `getSimulation`),
  `status-createdAt-index` (currently **unused by any query** — see Known issues).
- **`de-simulation-results`** (PK `simulationId`, SK `modelKey`) — one item per model × function
  row. `modelKey` is zero-padded `"{mutationId}#{crossoverId}#{selectionId}#{functionId}"` (e.g.
  `"01#02#01#10"`) and is duplicated (not imported) in `DE-forEC2/db.js` — **keep both in sync**.
  Written via `BatchWriteItem` (25/batch, retries `UnprocessedItems` with a short fixed delay).
- **`de-uniqueness`** (PK `lockKey`) — DynamoDB has no unique secondary index, so email uniqueness
  is enforced with a conditional-put lock item (`attribute_not_exists(lockKey)`) written in the
  same transaction as the user item. Registration and email changes must keep the lock and the
  user item in sync (see `models/user.js`).

`GET /simulation/get` uses **cursor pagination**: `nextCursor` is a base64-encoded
`LastEvaluatedKey`, not an offset — `encodeCursor`/`decodeCursor` in `models/simulation.js`. An
invalid cursor throws `BadRequestError`, not a DynamoDB error.

DynamoDB Local runs with `-sharedDb`, so **tests use dedicated `-test`-suffixed tables** — never
point `MONGODB`-style dev env at the test tables or vice versa.

## Architecture

CommonJS throughout (no ESM anywhere):

- `app.js` builds the Express app (helmet → json → urlencoded → cookieParser → cors →
  morgan→winston → `/api/v1` routes → swagger → notFound → errorHandler); `server.js` connects the
  DB (no-op today), listens, and closes on SIGTERM. **Keep them separate** — tests `require("./app")`
  without starting a server.
- `routes/index.js` is where auth applies: `/simulation` and `/user` are mounted behind
  `authMiddleware`, `/admin` behind `authMiddleware + adminMiddleware`. Individual route files
  assume the user is already authenticated.
- **The model modules own the data logic** (`models/user.js`, `models/simulation.js`) — plain
  object facades over DynamoDB commands (`login()`, `createSimulation()`, `importSimulation`,
  `getSimulation`, `cancelSimulation`…), not Mongoose schemas. Controllers stay thin: destructure,
  call a model function, respond, `catch (err) → next(err)`. Don't inline DynamoDB commands in
  controllers.
- **Ownership checks live in controllers/models**, comparing `simulation.userId === req.userId` —
  not in middleware.
- Validation is Zod schemas in `validators/`, applied via the `validate(schema)` middleware
  factory, which replaces `req.body` with the parsed (trimmed/coerced) data.
- `config/database.js`, `config/s3.js` and `config/sqs.js` all read env vars **at require time**.
  Anything that sets them (notably `tests/setup.js`) must do so before those modules are imported.
- Swagger is generated from `@openapi` JSDoc annotations **in the route files**; new endpoints
  need annotations there or they vanish from `/api/v1/docs`.

## Conventions and traps

- **`errorHandler` (`middleware/errorHandler.js`) honors typed status codes first**: `err.statusCode`
  from the `HttpError` subclasses in `utils/errors.js` (`BadRequestError`/`UnauthorizedError`/
  `ForbiddenError`/`NotFoundError`/`ConflictError`) wins; then CastError→404, duplicate key
  (code `11000`)→400, Mongoose-style `ValidationError`→400, JWT errors→401; an **untyped `Error`
  falls through to HTTP 500**. Throw the typed errors (not bare `new Error(...)`) for anything the
  client caused — ownership failures should be `ForbiddenError`, missing resources
  `NotFoundError`, terminal-state conflicts `ConflictError`. There is no `ServiceUnavailableError`
  (503) yet for DynamoDB throttling — see Known issues.
- Password max length is **12 characters**, enforced in three places (Zod validator, user model,
  change-password flow). Keep them in sync.
- `POST /simulation/create` must never 500 when SQS is down: the record exists, so it logs, marks
  the simulation `failed`, and returns 201 with `queued: false`.
- `POST /simulation/import` bypasses SQS entirely and stores a `completed` simulation. Parsing
  lives in the pure, unit-tested `utils/importParser.js`; failures return
  `400 { errors: [{line, message}] }` — line numbers are a product requirement, keep them.
- Route ordering matters in `simulationRoutes.js`: `/get/:simulationId/results` is registered
  before `/get/:simulationId`.
- **Refresh tokens are hashed at rest**: only `sha256(token)` is stored in `users.refreshTokenHash`
  (never the raw JWT), compared with `crypto.timingSafeEqual`, rotated on every `/refresh`, and
  cleared on logout, suspension, and password change.
- `cancelSimulation` guards terminal statuses (`completed`/`failed`/`cancelled` can't be
  re-cancelled) — throws `ConflictError`, not a silent no-op.

## Known issues (active, unfixed — see `../dynamodb-remediation.md`)

The DynamoDB migration's acceptance gate only ran a tiny (1–20 model) job; real workloads
(80–800 models) hit throttling that the current write paths don't handle correctly:

- `batchWrite`/`deleteResults` in `models/simulation.js` retry `UnprocessedItems` with a short
  fixed delay (5 attempts, no exponential backoff/jitter) and **do not distinguish or specially
  handle `ProvisionedThroughputExceededException`** — a throttled cascade-delete of a large
  simulation can surface as a bare 500 instead of a retryable status.
- The write-capacity split (`scripts/create-tables.js`: flat 5/5 RCU/WCU per table) under-serves
  the results table, which absorbs `BatchWriteItem` bursts of 25 on every progress update.
- `status-createdAt-index` on `de-simulations` is currently **unused by any query** (`getSimulation`
  uses `user-createdAt-index` + a filter; admin `listAll` uses `Scan`) — a planned removal, not yet
  done.

Don't assume the backoff/503-mapping/capacity-rebalance behavior described in
`dynamodb-remediation.md` exists yet; it's a fix plan, not a description of current code.

## Documentation

`docs/context.md` is nominally the living description of this repo, but **its tech-stack section
(and most of `docs/*.md`) still describes MongoDB/Mongoose** — it was written before the DynamoDB
migration commit and hasn't been refreshed since. Trust this file and the code over it on
persistence specifics; the rest of its content (routing, auth flow, conventions) is still broadly
accurate. `docs/IMPLEMENTATION_PLAN.md` plus `docs/plans/001`–`004` describe already-completed
past work (repo health, refresh-token hardening, error-semantics fix, docs baseline — all merged,
see git log). `docs/PRD.md`, `docs/architecture.md`, `docs/api-reference.md`, `docs/models.md`,
`docs/authentication.md`, `docs/middleware.md`, `docs/testing.md` cover depth but share the same
pre-migration Mongo-era staleness.

`REASONIX.md` at the repo root is **stale** (describes `/api` routes, claims there is no test
suite). Prefer `docs/context.md` (with the caveat above) or the code over it.
