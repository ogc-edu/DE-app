# 001 — Repo health baseline

## Objective

Restore the repo's verifiability: fix the broken `docker-compose.yml`, remove
the `.gitignore` footguns, standardize the dev DB container name, and make the
test-verification path explicit so every later feature can be verified.

## Context

- `docker-compose.yml:11` contains a YAML parse error:
  `test: mongosh --eval "..." --quiet` — a plain scalar containing `: ` makes
  `docker compose config` fail (`go-yaml load error … at L11.C77`), so
  `docker compose up` is broken regardless of the Docker daemon.
- `.gitignore` at repo root ignores `package.json` and `package-lock.json`
  (lines 2–3). Both files are already tracked so nothing is broken *today*, but
  any rename/re-add would silently drop them from version control.
- Container-name inconsistency: `docker-compose.yml` + `start-dev.bat` use
  `de-db`; `notes.txt` uses `atlas-mongo` with a pinned image tag.
- `npm test` cannot run without a replica-set MongoDB. The known-good path is
  the `mongodb/mongodb-atlas-local` image (compose service `mongo`, container
  `de-db`, port 27017, auth `root:password123` with `authSource=admin`).
  `tests/setup.js` connects to `Dashboard-Test-Database` via
  `MONGODB_URI_TEST` or the default
  `mongodb://root:password123@localhost:27017/Dashboard-Test-Database?directConnection=true&authSource=admin`.
- PRD linkage: closes the testing-decision drift — the suite exists but is
  currently not runnable via the documented path. No PRD user story is open.

## Requirements

1. `docker compose config` parses and the `mongo` service starts a healthy
   replica-set‑capable database (`mongosh` connectivity on 27017).
2. `.gitignore` no longer ignores `package.json` / `package-lock.json`.
3. One canonical dev-DB container name (`de-db`) across compose, scripts, and
   notes.
4. README documents the exact verification command for tests.
5. No application code changes (this is ops/repo hygiene only).

## Technical design

### 1. `docker-compose.yml` — fix the healthcheck (line 11)

Replace the unquoted plain scalar with a `CMD-SHELL` array form (valid YAML,
no quoting pitfalls):

```yaml
    healthcheck:
      test: ["CMD-SHELL", "mongosh --quiet --eval 'try { rs.status() } catch(e) { rs.initiate({ _id: \"replicaset\", members: [{ _id: 0, host: \"localhost:27017\" }] }) }'"]
      interval: 10s
      timeout: 10s
      retries: 10
```

Do **not** change the `version: "3.9"` key (obsolete but harmless; keep the
diff minimal).

Sanity-check the resulting flow:
- `docker compose config` → exits 0.
- `docker compose up -d mongo` → container `de-db` starts, healthcheck passes.
- `npm test` → suite connects to `Dashboard-Test-Database` on 27017.

### 2. `.gitignore` — drop the package-manifest lines

Current content (3-line file):

```
.env
package.json
package-lock.json
node_modules
logs/
```

Remove the `package.json` and `package-lock.json` lines. Result:

```
.env
node_modules
logs/
```

### 3. `notes.txt` — align container naming

Replace the raw `docker run` line (which references `atlas-mongo` and a pinned
dated image tag) with the canonical path:

```
# Dev/test MongoDB (replica set via mongodb/mongodb-atlas-local, container: de-db)
# Option A: docker compose up -d mongo
# Option B: docker start de-db || docker run -d -p 27017:27017 --name de-db mongodb/mongodb-atlas-local:8.0.0
```

### 4. `README.md` — document the verification command

In the `npm Scripts` block, add a prerequisite line for `npm test`:

```
npm test               # Run all tests — requires replica-set MongoDB:
                       #   docker compose up -d mongo   (container de-db, port 27017)
```

Do not renumber any test counts here — the count refresh belongs to feature 004.

## Files

**Touches (existing):**
- `docker-compose.yml` (healthcheck fix only)
- `.gitignore` (remove 2 lines)
- `notes.txt` (container-naming alignment)
- `README.md` (`npm Scripts` verification note only)

**Creates:** none.

## API / database changes

None. Endpoints, schemas, and data shapes are untouched.

## Dependencies

None. This is the first feature in the order (001).

## Edge cases

- Docker daemon not running on the implementer's machine → `docker compose`
  commands fail with a daemon-connect error; the implementer must either start
  Docker Desktop or use the `docker run` fallback from `notes.txt`, and must
  state in the PR/report which environment the verify command ran in.
- The healthcheck's `rs.initiate` runs only if `rs.status()` throws, so it is
  idempotent across container restarts (named volume `mongo-data` persists).
- If a stale `atlas-mongo` container exists on the machine, `de-db` is a
  different name — no conflict; no action needed.

## Security considerations

None. No credentials, secrets, or auth paths touched. `.env` remains
gitignored; `.env.example` remains tracked.

## Tests

No new tests. The acceptance of this feature is the restored ability to run
the existing suite:

```bash
docker compose config              # must exit 0
docker compose up -d mongo         # mongo healthy
npm test                           # full suite passes (baseline ≈ 99 tests)
```

## Verify command (exact)

```bash
docker compose config && docker compose up -d mongo && npm test
```

## Acceptance criteria

1. `docker compose config` exits 0 (no YAML errors).
2. `docker compose up -d mongo` reaches healthy with no error output of
   substance; `mongosh mongodb://root:password123@localhost:27017/Dashboard-Test-Database?directConnection=true&authSource=admin --eval "db.runCommand({ping:1})"` returns `{ ok: 1 }`.
3. `npm test` completes with the full suite passing; report the exact suite
   count in the commit message.
4. `.gitignore` does **not** contain `package.json` or `package-lock.json`.
5. `git grep -n "atlas-mongo"` returns nothing.
6. README `npm Scripts` block documents the `docker compose up -d mongo`
   prerequisite for `npm test`.
7. `git status` after the change shows only the intended files (plus the
   already-staged docs moves).

## Out of scope

- Refreshing stale test counts / claims in the docs (feature 004).
- Any application code change.
- CI/CD setup.