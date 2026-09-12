# DE Research Dashboard Backend — Implementation Plan

Status: **APPROVED by the human at the STEP 2 gate — feature plans written in `docs/plans/` await feature-plan approval.**

Source of truth for the remaining work on this repo. Reconciles the existing
`docs/PRD.md` (moved from repo root) against the code actually built (head
`6e3937b` on `main`) and plans **only** what is left. Planning history and
decisions are logged at the bottom of this file.

- Repo: `DE-website-backend` (Express 5 / MongoDB / SQS backend **only**).
- The React SPA lives in a separate repo (`DE-dashboard-frontend`) and is
  intentionally out of scope for this plan.

---

## 1. Reconciliation summary (STEP 1, approved)

All 12 PRD user stories and every Implementation/Testing decision are **DONE**
against current code. Evidence per item is recorded in the STEP 1 gate write-up
(see `docs/plans/004-documentation-baseline-refresh.md` for where the refreshed
PRD/context claims land).

| PRD area | Status |
|---|---|
| 12 user stories (auth, simulation, results, admin, docker) | DONE |
| Implementation decisions (auth system, simulation model, admin endpoints, deployment) | DONE |
| Testing decisions (jest + supertest, MVC-mirrored suites) | DONE — 99 tests by inventory |
| S3 profile-picture upload (PRD §6 listed it out-of-scope) | DONE beyond PRD (PRD drift) |
| Rate limiting, email verification, CI/CD, Secrets Manager | NOT STARTED — out of scope by PRD |

Remaining work is therefore not feature work — it is **repo health, auth
hardening, API error semantics, and documentation baseline**:

| ID | Feature | Why it remains |
|---|---|---|
| 001 | Repo health baseline | `docker-compose.yml:11` is invalid YAML; `.gitignore` ignores `package.json`/`package-lock.json`; container-name inconsistency; test suite unverifiable without replica-set Mongo |
| 002 | Refresh-token hardening (backend only) | Refresh tokens stored plaintext in DB; not cleared on suspension or password change |
| 003 | API error-semantics fix | `errorHandler.js` maps every generic `Error` to HTTP 400 (ownership → 400 instead of 403, missing → 400 instead of 404, conflicts → 400 instead of 409) |
| 004 | Documentation baseline refresh | PRD/context/docs carry drift (58 tests, out-of-date auth/cancel/error claims) |

## 2. Order & session rule

Strict order — **001 → 002 → 003 → 004**. Each feature is independently
implementable in a fresh agent session; each plan in `docs/plans/` is
self-contained (no conversation memory required). Each feature leaves the repo
green and records its exact verify command. 004 must be last so it documents
the final post-001/002/003 state.

## 3. Non-negotiable conventions (all features)

- CommonJS (`require`/`module.exports`), Express 5, API mounted at `/api/v1`.
- MVC: data logic lives in model statics; controllers are thin
  (`try/catch → next(err)`).
- Zod validation via `validate(schema)` middleware; `@openapi` JSDoc in route
  files feed Swagger.
- Tests colocated in `tests/*.test.js` with `tests/setup.js` (mocks
  `@aws-sdk/client-sqs`; requires replica-set MongoDB).
- **No new npm dependencies** (002 uses `node:crypto`, built-in).
- Env-read-at-require-time convention (`config/s3.js`, `config/sqs.js`).

## 4. Verification legend

```bash
docker compose up -d mongo   # starts the replica-set test/dev Mongo (needs Docker daemon running)
npm test                     # full suite (NODE_ENV=test, jest + supertest)
docker compose config        # validates compose YAML (feature 001)
```

If Docker daemon is unavailable, feature 001 documents the alternative
(`mongodb/mongodb-atlas-local` container from `start-dev.bat`) and the agent
must say explicitly which environment the verify command ran in.

## 5. Explicitly out of scope (recorded, not planned)

- Frontend silent-refresh wiring and the mock-data button (both live in
  `DE-dashboard-frontend`; the mock-data button was decided frontend-only).
- Rate limiting, email verification (`isVerified`), CI/CD, AWS Secrets Manager.
- Refresh-token reuse-detection (jti blacklist) — documented as future work.
- Data migration for legacy plaintext `refreshToken` rows — stale values simply
  stop matching after 002; no migration required.
- Anything beyond the four features above (no unrelated features).

## 6. Decisions log

| Date | Decision |
|---|---|
| Planning gate 1 | Target repo is **this backend** (`DE-website-backend`), backend only; the frontend is a separate repo |
| Planning gate 1 | Docs layout **(a)**: full `docs/` convention — move `PRD.md`/`context.md` into `docs/`, add `docs/IMPLEMENTATION_PLAN.md` + `docs/plans/NNN-*.md`; existing lowercase docs kept |
| Planning gate 1 | **Refresh token in scope** — backend hardening only |
| Planning gate 1 | **Mock-data button**: frontend-only — explicitly out of scope for this backend plan |
| Planning gate 1 | **Error-semantics fix in scope**, accepting test churn |
| STEP 2 gate | **Master plan approved (001–004)** |

## 7. Next step

Implement **001 — Repo health baseline** (`docs/plans/001-repo-health-baseline.md`).
It has no dependencies and restores the ability to verify every later feature.