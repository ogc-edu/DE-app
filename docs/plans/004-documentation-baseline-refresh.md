# 004 — Documentation baseline refresh

## Objective

Make every claim in the repo's documentation match the post-001/002/003
codebase: correct test counts and suite list, current auth/session semantics,
the typed error-status matrix, the `/api/v1` contract, S3 upload being in
scope, the cancel guard, and the `de-db` container name. Remove all stale
"Gotcha" items that are now fixed.

## Context

The docs were moved into `docs/` before this feature (root `PRD.md` →
`docs/PRD.md`, `context.md` → `docs/context.md`; see
`docs/IMPLEMENTATION_PLAN.md`). Known stale claims (verified at STEP 1):

- `README.md` + `docs/testing.md` say **58 tests** across 4 suites; the actual
  inventory is **≈99 across 6 suites** (`auth`, `user`, `simulation`, `admin`,
  `import`, `importParser`) — and 002/003 will change the number again, so the
  count must be re-read from a live `npm test` run, not copied from this plan.
- `docs/PRD.md` (moved, unrefreshed): §6 lists S3/profile upload as
  out-of-scope although it is implemented; endpoint contract unversioned
  (`/api/login`, `/api/simulations`) while reality is `/api/v1/*`; §4
  "Simulation model … needs refinement" is resolved.
- `docs/context.md` (moved, unrefreshed): Gotcha #4 ("cancel has no status
  guard") is fixed; container name mismatch (`atlas-mongo` vs `de-db`);
  plaintext refresh-token note (now hashed after 002); error-semantics note
  (now typed after 003); test count/verification claims predate the final
  state; header still claims a specific commit verification.
- `docs/authentication.md` will need the new session semantics (hashes at
  rest, suspension/password-change invalidation) and the "future enhancement"
  line about clearing tokens on suspension removed.
- `docs/middleware.md` documents the old 400-for-generic-error behavior.
- `docs/api-reference.md` documents response codes per endpoint (refresh per
  the 003 matrix) and may miss newer endpoints (`/simulation/import`,
  `/simulation/cancel/:id`, `/admin/users/:id`,
  `/admin/simulations/:id`, `/user/profile/presign`, `/user/profile/picture`).
- PRD linkage: closes the PRD/context drift identified at STEP 1. No PRD user
  story is open.

## Requirements

1. No factual claim in README/docs contradicts the current HEAD codebase.
2. Test counts/suite tables equal a **fresh** `npm test` run (and
   `test:coverage` output where coverage is mentioned).
3. All four features are reflected: 001 (compose/gitignore/de-db/verify
   path), 002 (session semantics), 003 (error matrix).
4. Docs index (`docs/README.md`) links every planning artifact
   (`docs/PRD.md`, `docs/context.md`, `docs/IMPLEMENTATION_PLAN.md`,
   `docs/plans/`).

## Technical design

Work top-down; verify each claim against code with `git grep`.

1. **`docs/testing.md`** — rebuild the Test Files table from the live suite:
   - suites: `auth`, `user`, `simulation`, `admin`, `import`, `importParser`;
   - counts from current `npm test` summary line;
   - add the error-matrix note pointing at `docs/IMPLEMENTATION_PLAN.md` /
     `docs/plans/003` outcomes.
2. **`docs/context.md`** — resync the "Progress check", "Gotchas", and
   "Local dev/test environment" sections; record the verified state:
   - refresh tokens stored as SHA-256 hashes; invalidated on suspend +
     password change (002);
   - typed error matrix implemented (003);
   - compose healthcheck fixed, `de-db` canonical, `.gitignore` clean (001);
   - cancel guard already present (remove stale Gotcha #4);
   - replace the "verified as of commit …" header claim with a note that
     claims are verified against HEAD at write time.
3. **`docs/PRD.md`** — refresh Implementation Decisions (add S3 avatar flow,
   import endpoint, SQS producer, cancel guard; `/api/v1` contract) and §6
   Out of Scope (remove S3 — it is built; keep rate limiting, email
   verification, CI/CD, Secrets Manager). Do not rewrite the product/user-story
   sections (they remain accurate).
4. **`docs/authentication.md`** — update the refresh section: store digest,
   timing-safe comparison, rotation, invalidation on suspension/password
   change, defense-in-depth `isActive` check; remove the "future enhancement"
   line about clearing on suspension.
5. **`docs/middleware.md`** — replace the generic-`Error`→400 description with
   the typed flow (`err.statusCode` first, then name-based mappings) plus the
   matrix summary.
6. **`docs/api-reference.md`** — verify every endpoint exists with its actual
   status codes (use `routes/*.js` + `controllers/*.js` + the 003 matrix);
   add any missing newer endpoints; fix `/login` etc. to their `/api/v1`
   versions if unversioned paths appear.
7. **`docs/models.md`** — rename `refreshToken` → `refreshTokenHash` in the
   User schema table; add `affiliation` if absent; note unused
   `simulationCount` / `isVerified`.
8. **`README.md`** — fix the stale "58 tests" figure; ensure the
   `Documentation` table links `docs/PRD.md`, `docs/IMPLEMENTATION_PLAN.md`,
   and `docs/plans/`; keep the 001-added verification note.
9. **`docs/README.md`** — add rows for PRD, context, implementation plan,
   and feature plans; describe how to propose new plans.

## Files

**Touches (existing):**
- `README.md`
- `docs/README.md`, `docs/PRD.md`, `docs/context.md`, `docs/testing.md`,
  `docs/architecture.md` (spot-check for stale endpoint/flow claims),
  `docs/authentication.md`, `docs/middleware.md`, `docs/api-reference.md`,
  `docs/models.md`, `docs/setup.md` (test prerequisites already partly in 001;
  align wording)

**Creates:** none (plans already exist in `docs/plans/` from this planning
effort — if they are missing, restore them from git history; do not rewrite
plans here).

## API / database changes

None — documentation only.

## Dependencies

001, 002, 003 merged (this feature documents their final state). If any of
them is not merged, do not start 004.

## Edge cases

- Test counts must come from a live run **after** 002/003 — do not reuse the
  numbers in these plans.
- If `npm test` cannot run (no Docker), stop and report — do not write
  guessed counts; document the blocked verification explicitly.
- Keep PRD product/user-story text untouched; only Implementation/Testing/
  Out-of-scope sections are refreshed.
- Swagger/JSDoc in routes already adjusted by 003; api-reference must match
  the route annotations.

## Security considerations

Documentation must not introduce new secrets or leak `.env` contents;
`docs/setup.md` should keep referencing `.env.example` (committed) rather than
real values.

## Tests

No new tests. Verification is grep-based plus a documentation "compile" pass:

```bash
docker compose up -d mongo && npm test      # capture exact counts
git grep -n "atlas-mongo"         # expect empty
git grep -n "58 tests"            # expect empty
git grep -rn "refreshToken" docs/  # only refreshTokenHash / prose about the hash
git grep -rn "user id not authorized to access this simulation.*400" docs/ || true
```

Read `docs/api-reference.md` endpoints against `routes/*.js` (one pass).

## Verify command (exact)

```bash
docker compose up -d mongo && npm test && git grep -n "58 tests\|atlas-mongo" README.md docs/ || echo "no stale claims found"
```

## Acceptance criteria

1. Every doc claim cross-checks against current code (sample of ≥5 claims per
   document visited, recorded in the PR description).
2. Test counts and suite tables match the live `npm test` summary.
3. `git grep "58 tests"` and `git grep "atlas-mongo"` return nothing.
4. `docs/README.md` lists PRD, context, implementation plan, and all plan
   files.
5. `docs/authentication.md` documents hashes-at-rest + invalidation semantics;
   `docs/middleware.md` documents the typed error matrix.
6. `docs/PRD.md` §6 no longer lists S3 as out-of-scope.
7. Docs moved at planning time (`docs/PRD.md`, `docs/context.md`,
   `docs/IMPLEMENTATION_PLAN.md`, `docs/plans/*.md`) are committed.

## Out of scope

- Writing new documentation sections beyond factual refresh.
- Restructuring `docs/architecture.md` or renaming existing doc files.
- Anything not factual: no new features, no opinion content, no redesign.