# context.md — DE Research Dashboard Backend

Living context document for this repo. Read this first, then `README.md`, `docs/PRD.md`, and the rest of `docs/` for depth. Every claim here was verified against the code at the time of writing — re-verify with `git grep` before relying on a specific line, and update this file when behavior changes.

## What this project is

Backend API for a **Differential Evolution (DE) research dashboard**. Researchers configure experiments — benchmark fitness functions (1–10), mutation schemes (1–10), crossover operators (1–4), selection methods (1–2) — and the backend computes the Cartesian product of models, tracks progress, and stores the lowest fitness value per (model × function) so variants can be compared.

- **Frontend is a separate repo** (`DE-website` SPA) that consumes this API.
- Per PRD, heavy computation is meant to run on **EC2 workers** polled from **AWS SQS**; this repo is the API + data layer only.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 (CommonJS, `require`/`module.exports` — no ESM) |
| Framework | Express `^5.2.1` (mounts at `/api/v1`) |
| DB | MongoDB 7 via Mongoose `^9.1.2` |
| Auth | `jsonwebtoken` + `bcrypt` (salt rounds 10); refresh tokens SHA-256 hashed at rest |
| Validation | Zod `^4.4.3` (middleware `validate()`) |
| Logging | Winston + Morgan (`config/logger.js`, writes `logs/*.log`) |
| Security | Helmet, CORS, httpOnly cookies |
| API docs | swagger-jsdoc + swagger-ui-express at `/api/v1/docs` (annotations live in `routes/*.js`) |
| Testing | Jest 30 + Supertest 7 (6 suites, **107/107 passing**) |
| Containers | Multi-stage `Dockerfile`, `Dockerfile.dev`, `docker-compose.yml` (MongoDB atlas-local + backend) |

## Layout

```
app.js                 # Express app: helmet/json/cookie/cors/morgan → routes → swagger → notFound → errorHandler
server.js              # Entry: connectDB + listen(PORT||3000); SIGTERM → closeDB
config/database.js     # mongoose.connect(MONGODB_URI, { dbName: DB_NAME }); connectDB/closeDB
config/logger.js       # winston: console + logs/error.log + logs/combined.log
config/s3.js           # S3 client + profileImageKey/buildPublicObjectUrl helpers (env read at require time)
config/sqs.js          # SQS client + sendSimulationJob/getQueueStatus helpers (env read at require time, same convention)
utils/importParser.js  # pure parser for the .txt data-import format (contract: import-format.md at monorepo root)
utils/errors.js        # HttpError + BadRequest/Unauthorized/Forbidden/NotFound/Conflict (statusCode honored by errorHandler)
models/user.js         # "users" collection; statics login/register/hashRefreshToken; methods generateJwtToken/generateRefreshToken/saveRefreshToken/clearRefreshToken
models/simulation.js   # "simulations" collection; statics createSimulation/importSimulation/getSimulation/getSimulationById/deleteSimulation/cancelSimulation; DE params np/f/cr/gen/dim; status includes "running"
controllers/           # authController(verify,refresh,logout) loginController registerController userController simulationController adminController healthController
routes/index.js        # /health; /simulation (auth); /admin (auth+admin); /user (auth); / (auth routes: login/register/verify/refresh/logout)
validators/            # authValidators.js, simulationValidators.js (Zod schemas)
middleware/            # authMiddleware, adminMiddleware, validate, errorHandler, notFound
docs/                  # README, setup, architecture, authentication, api-reference, models, middleware, testing, swagger.js
tests/                 # setup.js + auth/simulation/admin/user/import/importParser.test.js
Dockerfile, Dockerfile.dev, docker-compose.yml, start-dev.bat (Windows dev bootstrap)
```

## Data models (summary)

**User** (`models/user.js`, collection `users`, timestamps):
`username` (3–50), `email` (unique, lowercase, regex), `password` (`select:false`, hashed pre-save), `isVerified` (unused, default false), `role` (`user`|`admin`, default `user`), `isActive` (default true), `refreshTokenHash` (`select:false`, SHA-256 hex of the current refresh token), `profilePicture` (S3 URL, in use), `affiliation`, `simulationCount` (unused).

**Simulation** (`models/simulation.js`, collection `simulations`, timestamps):
`userId` (ObjectId, indexed, ownership check basis), `functions`/`methods.{mutation,crossover,selection}` (validated int arrays, ranged 1–10/1–4/1–2), DE algorithm params `np` (10–40, default 15), `f` (0.1–2.0, default 0.5), `cr` (0.01–1.0, default 0.9), `gen` (≥1, default 1000), `dim` (1–30 — matches de.cpp limit, default 30), `totalModels` (Cartesian product at creation), `completedModels` (default 0), `progress` (0–100), `status` (`pending|running|completed|failed|cancelled`, default `pending`, indexed — workers set `running`), `simulationData` (array of `{functionId, mutationId, crossoverId, selectionId, lowestFitness}` — the results grid, written by the **EC2 worker** (`DE-forEC2/spawner.js`, Task 2) and served back via `GET /simulation/get/:id/results`). Imported data (`importSimulation` static) is created directly as `completed` with `progress: 100` — no SQS enqueue.

## API surface (`/api/v1`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | — | DB readyState, uptime |
| POST | `/login` | — | Zod; sets `refreshToken` httpOnly cookie (7d, sameSite strict); 401 bad credentials, 403 suspended |
| POST | `/register` | — | Zod; password 6–12 chars; 409 on duplicate email |
| POST | `/verify` | — | Manual token check; invalid/expired → 401 |
| POST | `/refresh` | — | Rotates refresh token; hash must match; 401 if suspended |
| POST | `/logout` | — | Clears cookie + stored hash |
| GET | `/user/profile` | Bearer | excludes password + refresh-token hash |
| GET | `/user/profile/presign` | Bearer | `?contentType=` → presigned S3 PUT URL (5 min); 400 on unsupported type |
| POST | `/user/profile/picture` | Bearer | Zod `{versionId?}`; stores the public object URL after the client's PUT |
| PATCH | `/user/profile` | Bearer | username/email/affiliation; 409 if email taken |
| PATCH | `/user/password` | Bearer | currentPassword + newPassword (≤12 chars); 401 if current wrong; clears the stored session |
| POST | `/simulation/create` | Bearer | Zod (optional np/f/cr/gen/dim); computes `totalModels`; **enqueues one SQS job per simulation** (worker contract: simulationId, bf, mutation, crossover, selection, cr, f, np, gen, dim) |
| POST | `/simulation/import` | Bearer | JSON `{content, filename?}`; parses a `.txt` results file (contract: `import-format.md` at monorepo root) into a `completed` simulation; **400 returns line-numbered `errors[]`**; never touches SQS |
| GET | `/simulation/get` | Bearer | `?page=&limit=&status=`; limit 0 = unpaginated |
| GET | `/simulation/get/:id/results` | Bearer | progress + `simulationData`; 403 cross-user, 404 unknown |
| GET | `/simulation/get/:id` | Bearer | ownership check (403 cross-user, 404 unknown) |
| DELETE | `/simulation/delete/:id` | Bearer | ownership check (403 cross-user, 404 unknown) |
| POST | `/simulation/cancel/:id` | Bearer | sets status `cancelled`; 409 if already terminal |
| GET | `/admin/users` | Bearer+admin | paginated, excludes the refresh-token hash |
| GET | `/admin/users/:id` | Bearer+admin | |
| PATCH | `/admin/users/:id/suspend` | Bearer+admin | toggles isActive; suspension clears the session; cannot suspend admins (400) |
| GET | `/admin/simulations` | Bearer+admin | optional `?userId=` filter |
| DELETE | `/admin/simulations/:id` | Bearer+admin | |
| GET | `/admin/queue` | Bearer+admin | real SQS metrics: ApproximateNumberOfMessages / NotVisible / Delayed + OldestMessageAge (503 if SQS_QUEUE_URL missing) |
| GET | `/docs` | — | Swagger UI |

## Auth flow

- Access token: JWT `{userId}` signed `JWT_SECRET`, 1h, sent `Authorization: Bearer`.
- Refresh token: JWT `{userId, jti}` signed `JWT_REFRESH_SECRET`, 7d, httpOnly cookie; the DB stores only `sha256(token)` in `users.refreshTokenHash` (`select:false`), compared with `crypto.timingSafeEqual`. Rotation on each `/refresh`. `/refresh` also rejects `isActive: false` users. The hash is cleared on logout, suspension and password change.
- `authMiddleware`: verifies token, loads user (`_id username role isActive`), 401 no/invalid token, 403 suspended. Sets `req.userId`, `req.user`.
- `adminMiddleware`: `req.user.role === "admin"` else 403.
- Ownership: controllers compare `simulation.userId.toString() === req.userId`.
- Password max length 12 — intentional app-wide rule (Zod + model + changePassword).

## Environment variables

Required at runtime: `JWT_SECRET`, `JWT_REFRESH_SECRET` (no defaults → must set). Optional: `MONGODB_URI` (default `mongodb://localhost:27017`), `DB_NAME` (default `Dashboard-Database`), `PORT` (3000), `CORS_ORIGIN` (comma-separated; default `true` = reflect any), `LOG_LEVEL` (info), `NODE_ENV` (switches cookie `secure`, winston format), `MONGODB_URI_TEST` (tests; default `mongodb://root:password123@localhost:27017/Dashboard-Test-Database?directConnection=true&authSource=admin`). AWS: `AWS_REGION`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (empty → default credential chain / EC2 IAM role), `S3_BUCKET_NAME` (profile pics), `SQS_QUEUE_URL` (full queue URL, e.g. `https://sqs.ap-southeast-1.amazonaws.com/727974229118/DE-Queue`; without it simulation create still returns 201 but `queued: false` + sim marked failed, and `/admin/queue` returns 503).

> `.env.example` is **committed** (includes AWS + `SQS_QUEUE_URL`); local `.env` is gitignored. Copy `.env.example` → `.env` and fill secrets before running.

## Commands

```bash
npm install            # deps (already installed on dev machine)
npm start              # node server.js
npm run dev            # nodemon server.js
npm test               # NODE_ENV=test jest (needs Mongo with replica set!)
npm run test:watch / test:coverage
docker compose up -d mongo  # just the DB (container de-db) — the test prerequisite
docker compose up --build   # mongo (atlas-local, replica set "replicaset") + backend
./start-dev.bat        # Windows: starts de-db container + npm run dev
```

**MongoDB for tests/dev**: both `docker-compose.yml` and `tests/setup.js` require a **replica set**, and the container must create the `root:password123` user the connection strings authenticate as (compose sets `MONGODB_INITDB_ROOT_USERNAME/PASSWORD`). The canonical way to start it is `docker compose up -d mongo` (container `de-db`); `notes.txt` records the standalone `docker run` fallback under the same name. Plain local `mongod` without a replica set will fail the test connection.

## Progress check (as of now)

**Done ✅**
- Full auth: register/login/verify/refresh-rotation/logout, RBAC (user/admin), suspension.
- User profile: get/update/change-password (Zod-validated).
- Simulation: create (Cartesian `totalModels`), list (pagination + status filter), single, results, delete, cancel — all ownership-checked.
- Admin: users list/get/suspend, simulations list/delete, **real queue metrics** (GetQueueAttributes).
- Validation (Zod), structured error handling, winston logging, Swagger docs.
- Docker multi-stage + compose; docs/ suite; 6 Jest/Supertest suites — **107/107 passing** (verified against the `de-db` container). **Docker image build + container smoke test verified** (health 200, login works, real SQS metrics via `GET /admin/queue`).
- `.env.example` committed (Task 1); local `.env` created (gitignored).
- Quick-win bug fixes: `/verify` invalid/expired token → 401 (was 500); removed dead `User.modifyEmail`; fixed `password` schema `require:`→`required:` typo.

**Done ✅ (SQS producer)**
- `config/sqs.js` (NEW): `SQSClient` (region from `AWS_REGION`) + `SQS_QUEUE_URL` (env, read at require time like `config/s3.js`), plus `sendSimulationJob(simulation)` (builds the exact worker contract body, comma-joined arrays) and `getQueueStatus()` (GetQueueAttributes → parsed metrics).
- `POST /simulation/create` now **enqueues one SQS job per simulation** after the DB insert. On SQS failure the sim is marked `failed` and the 201 response includes `queued: false` (never silently stuck in pending).
- Simulation model: DE params `np/f/cr/gen/dim` persisted (Zod-validated, defaults applied); `running` added to the status enum.
- `GET /admin/queue` returns real metrics (depth, in-flight, delayed, oldest message age); 503 when `SQS_QUEUE_URL` is unset.
- Tests: +8 (SQS contract body, param persistence/defaults, 400 ranges, running status, enqueue-failure → failed, queue metrics, 503); live smoke test against a real queue (`DE-Queue` in ap-southeast-1) verified message body + metrics.

**Done ✅ (EC2 worker — Task 2, separate repo `DE-forEC2`)**
- `spawner.js` polls SQS, runs `de.exe`, writes `status` (pending→running→completed|failed), throttled `progress` + `completedModels`, and `simulationData` entries `{functionId, mutationId, crossoverId, selectionId, lowestFitness}` straight to MongoDB; deletes messages only after a successful save; live-verified (success/cancel/failure/SIGTERM/progress).

**Done ✅ (data import — this feature)**
- `POST /simulation/import` accepts a `.txt` results file as JSON `{content, filename?}` and stores it as a `completed` simulation (no SQS). The format contract lives at the monorepo root `import-format.md`; the pure parser is `utils/importParser.js` (unit-tested), plus endpoint tests in `tests/import.test.js`.
- Parser handles an optional `# key=value` metadata block (np/f/cr/gen/dim), a required `model<TAB>benchmark<TAB>lowestFitness` header, and one row per (model × benchmark). Models are parsed right-to-left from the canonical `<mutation>/<crossover>/<selection>` string; benchmark is 1–10; `lowestFitness` is a finite number.
- Failures return `400 { success:false, message:"Import failed", errors:[{line,message}] }` so the frontend can show line-numbered, actionable messages.
- Tests: 19 parser + 6 endpoint.

**Not started ❌ (mostly PRD out-of-scope / future)**
- Email verification (`isVerified`), rate limiting, CI/CD, AWS Secrets Manager, production deployment to the staging EC2 (`DE-fullStack-staging`, currently stopped). Note: S3 profile pictures **are done** (feature earlier in this repo); EC2 worker **is done** (Task 2).

## Repo health work (features 001-004)

- **001 — repo health**: `docker-compose.yml` healthcheck rewritten in `CMD-SHELL` array form (the old plain scalar contained `": "` and made `docker compose config` fail outright); the `mongo` service now creates the `root:password123` user the connection strings expect; `.gitignore` no longer ignores `package.json`/`package-lock.json`; `de-db` is the canonical container name everywhere.
- **002 — refresh-token hardening**: hashes at rest, timing-safe comparison, session invalidation on suspend and password change, `isActive` guard on `/refresh`.
- **003 — error semantics**: typed errors in `utils/errors.js`, honored by `errorHandler` ahead of its name-based mappings.
- **004 — this documentation refresh.**

Plans live in `docs/plans/`; `docs/IMPLEMENTATION_PLAN.md` is the master plan and decisions log.

## Gotchas / latent bugs (verified by reading code)

1. ✅ **FIXED** — `POST /verify` with invalid/expired token now returns 401 (`errorHandler` maps `JsonWebTokenError`/`TokenExpiredError`). Note there is no test covering this at the API boundary.
2. ✅ **FIXED** — dead buggy `User.modifyEmail` removed; `password` schema `require:`→`required:` typo fixed.
3. ✅ **FIXED (003)** — domain errors now carry typed status codes (401/403/404/409); see the matrix in `docs/middleware.md`. An **untyped** `new Error(...)` is now a 500, not a 400 — throw a `utils/errors.js` class for anything client-facing.
4. ✅ **FIXED** — `cancelSimulation` guards terminal statuses and returns 409.
5. ✅ **FIXED (002)** — refresh tokens are SHA-256 hashed at rest. Still single-token, so concurrent sessions overwrite each other (a second device logging in kills the first); reuse-detection via `jti` remains unimplemented.
6. `simulationData` subdocs use `required: true` on their fields — fine, but note Mongoose will reject partial result writes until populated with all four ids.
7. `sameSite: "strict"` cookie may complicate cross-site frontend dev if frontend is served from a different origin than the API.
8. `logs/`, `.env`, `node_modules` are gitignored.
9. Existence is checked **before** ownership, so another user's simulation id returns 403 while an unknown id returns 404 — a deliberate trade-off documented in `docs/middleware.md` (ids are unguessable ObjectIds).
10. `"Email already in use"` and `"Current password is incorrect"` now throw, so those two responses carry `errorHandler`'s `{success, error}` shape rather than `{message}`. The SPA reads `err.response?.data?.message` — it needs to read `.error` for these two.

## Local dev/test environment (verified working)

- MongoDB: `de-db` docker container (root:password123, auth enforced, RS name = container hostname). Connection string used in `.env`/`.env.example`/`tests/setup.js`: `mongodb://root:password123@localhost:27017/<db>?directConnection=true&authSource=admin` — no `replicaSet` param (name is hostname, changes per recreate; app/tests don't use transactions).
- `npm test` (**107/107**, re-verified) and `npm run dev` both work against it. Node v26.5.1 / npm 11.17.0 available on the dev machine.

## Conventions

- MVC: models own data logic (statics), controllers are thin (try/catch → `next(err)`), routes map URLs.
- CommonJS throughout; controllers named `xController.js`; validators in `validators/`; Zod via `validate(schema)` middleware.
- Ownership & role checks in models/controllers, not middleware (except auth/admin middleware).
- API versioned `/api/v1`; JSDoc `@openapi` annotations in route files feed Swagger.
- All timestamps via `{ timestamps: true }`.
