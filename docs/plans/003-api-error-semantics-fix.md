# 003 — API error-semantics fix

## Objective

Replace the current catch-all mapping of every generic `Error` to HTTP 400
with correct, typed status codes: ownership violations → 403, missing
resources → 404, state conflicts → 409, credential failures → 401, suspended
account → 403. Update the tests that currently assert the wrong codes.

## Context

- `middleware/errorHandler.js` ends with `if (err.name === "Error") { error.statusCode = 400; }` —
  so any domain error thrown as `new Error(...)` becomes an HTTP 400:
  - `models/simulation.js`: "Unauthorized" / "user id not authorized to access this simulation" (cross-user access) → 400 (should be 403)
  - `models/simulation.js`: "Simulation not found" / "already deleted" / cancel on terminal status → 400 (should be 404 / 404 / 409)
  - `models/user.js:login`: "Invalid email or password" → 400 (should be 401); "Account has been suspended" → 400 (should be 403)
  - `models/user.js:register`: duplicate → 400 (should be 409)
  - `controllers/userController.js`: "Email already in use" → 400 (should be 409); "Current password is incorrect" → 400 (should be 401)
- Tests deliberately assert these 400s (documented in `docs/context.md` Gotcha #3); the fix therefore ripples through `tests/*.test.js`.
- PRD linkage: closes the PRD §5 testing-decision acceptance ("a good test validates behavior visible at the API boundary") and removes a documented latent bug. No PRD user story is open.
- Frontend impact: the SPA branches on `err.response?.status` only for admin queue (403/503) and surfaces `err.response?.data?.message` text elsewhere — none of the changed codes is used for flow control client-side, so this fix is backward compatible for the frontend.
- Feature 001 must be merged first (verifiable tests).

## Requirements

1. Introduce a typed base error (`HttpError` with `statusCode`) and a small set
   of subclasses.
2. `errorHandler` honors `err.statusCode` before name-based mappings; the
   generic-`Error` → 400 fallback remains only for genuinely untyped errors.
3. Convert every *domain* throw to a typed error per the status matrix below.
4. Update every test that asserts a code the matrix now overrides.
5. Keep all existing **error message strings** identical (the frontend shows
   them verbatim).
6. Keep Zod validation errors → 400, import parse errors → 400 with
   `errors[]`, Queue 503, and duplicate-key/validation/JWT mappings unchanged.

## Status matrix (authoritative)

| Situation | Old | New | Source (current code) |
|---|---|---|---|
| Login: invalid credentials / unknown email | 400 | **401** | `models/user.js:login` |
| Login: suspended account | 400 | **403** | `models/user.js:login` |
| Register: email already exists | 400 | **409** | `models/user.js:register` |
| Cross-user simulation access (get/delete/cancel/results) | 400 | **403** | `models/simulation.js:getSingleSimulation/deleteSimulation/cancelSimulation` + `controllers/simulationController.js` duplicate throws |
| Simulation not found (get/results/delete/cancel) | 400 | **404** | `models/simulation.js` |
| Cancel a terminal simulation | 400 | **409** | `models/simulation.js:cancelSimulation` |
| Profile: email already in use | 400 | **409** | `controllers/userController.js:updateProfile` |
| Password change: current password wrong | 400 | **401** | `controllers/userController.js:changePassword` |
| Admin: cannot suspend an admin | 400 | **400** (keep) | `controllers/adminController.js:toggleSuspendUser` — invalid target, not a permission denial |
| "Simulation delete failed" / "cancel failed" | 400 | **500 (fallback)** | controllers — unexpected failure, not client error |
| Zod validation, unsupported content type, password length, import parse | 400 | 400 (unchanged) | validators / import parser |
| Duplicate key (11000), CastError, JWT invalid/expired | unchanged | unchanged | `middleware/errorHandler.js` |
| Suspended user hits protected route | 403 | 403 (unchanged) | `middleware/authMiddleware.js` |

## Technical design

### 1. New file `utils/errors.js`

```js
// Typed HTTP errors so models/controllers can throw precise status codes.
// errorHandler reads err.statusCode before its name-based mappings.
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}
class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") { super(401, message); }
}
class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") { super(403, message); }
}
class NotFoundError extends HttpError {
  constructor(message = "Not found") { super(404, message); }
}
class ConflictError extends HttpError {
  constructor(message = "Conflict") { super(409, message); }
}

module.exports = { HttpError, UnauthorizedError, ForbiddenError, NotFoundError, ConflictError };
```

### 2. `middleware/errorHandler.js`

Add **before** the name-based chain (right after the `{ ...err }` copy):

```js
if (typeof err.statusCode === "number") {
  error = { statusCode: err.statusCode, message: err.message };
} else if (err.name === "CastError") {
  ...
}
```

Keep every existing mapping and the final generic fallback. Do not change
messages emitted by the existing named branches.

### 3. Model/controller conversions (message strings preserved exactly)

- `models/user.js`: `throw new UnauthorizedError("Invalid email or password")`
  (both branches); `throw new ForbiddenError("Account has been suspended")`;
  register duplicate → `throw new ConflictError("User already exists")`.
  The static `register` password-length check stays a plain `Error` (400; belt
  and braces under the Zod schema).
- `models/simulation.js`:
  - not found (delete/get/cancel): `throw new NotFoundError("Simulation not found")`;
    delete's second not-found: `new NotFoundError("Simulation not found or already deleted")`.
  - ownership: `throw new ForbiddenError("Unauthorized")` (delete/cancel) and
    the get/results path keeps its message but as `ForbiddenError("user id not authorized to access this simulation")`.
  - cancel on terminal state: `throw new ConflictError('Cannot cancel a simulation in "${simulation.status}" status')`.
- `controllers/simulationController.js`: its *duplicate* not-found /
  not-authorized throws inside `getSingleSimulation`/`getSimulationResults`
  become `NotFoundError`/`ForbiddenError` (the results endpoint's ownership
  check duplicates the model one). Leave `"Simulation delete failed"` /
  `"Simulation cancel failed"` as plain `Error` (falls through to 500).
- `controllers/userController.js`: `"Email already in use"` → `ConflictError`;
  `"Current password is incorrect"` → `UnauthorizedError`. Inline `res.status(404)`
  returns for missing users stay as-is.
- `controllers/loginController.js` / `registerController.js` — unchanged
  (they delegate to model statics).

### 4. Swagger annotations

`routes/simulationRoutes.js` / `routes/userRoutes.js` / `routes/authRoutes.js`
may describe the 400 responses for these paths; adjust the `@openapi`
`responses` to include the corrected codes (optional but cheap). Full doc
refresh happens in 004.

## Files

**Touches (existing):**
- `middleware/errorHandler.js`
- `models/user.js`
- `models/simulation.js`
- `controllers/simulationController.js`
- `controllers/userController.js`
- `routes/simulationRoutes.js`, `routes/userRoutes.js`, `routes/authRoutes.js` (JSDoc response codes, optional)
- `tests/auth.test.js`, `tests/simulation.test.js`, `tests/user.test.js`, `tests/admin.test.js` (assertions per matrix)

**Creates:**
- `utils/errors.js`

## API / database changes

- Response **status codes** change per the matrix (message bodies unchanged).
- No path/body/cookie/schema changes.

## Dependencies

001 (verifiable tests). No dependency on 002; if merged in either order,
`changePassword` keeps both the session-invalidation line (002) and the 401
error (003) — do not drop one for the other.

## Edge cases

- `CastError` (bad ObjectId in URL) stays 404 — already handled *before* the
  typed check? Order matters: put the `err.statusCode` branch first; CastError
  never has `statusCode`, so precedence is safe.
- Zod/validation errors never set `statusCode` → still 400.
- Untyped `new Error` from genuine server faults now yields 500 instead of 400
  — intended hardening; assert in tests where a path was previously 400.
- Frontend (separate repo) relies on message text for most flows; codes changed
  are not flow-control signals except admin 403/503 (unchanged).

## Security considerations

- Proper 401/403/404/409 semantics prevent information leaks (e.g., not-found
  vs not-authorized distinction) and give clients correct retry behavior.
- Ensure the "Simulation not found" 404 on cross-user requests does **not**
  leak existence: the ownership check currently runs after the existence check,
  so a 404 vs 403 can reveal that an id exists. **Decide deliberately**:
  keep the current order (404 first) and document that the id space is
  unguessable ObjectIds; do not change ordering in this feature.

## Tests

Update, per file:

- `tests/auth.test.js`:
  - "should not login with invalid password" → expect **401**
  - "should not login with non-existent email" → expect **401**
  - "should not login if account is suspended" → expect **403**
  - "should not register a duplicate user" → expect **409**
- `tests/user.test.js`:
  - "should not update to an email already in use" → expect **409**
  - "should not change password with incorrect current password" → expect **401**
- `tests/simulation.test.js`:
  - "should not allow access to another user's simulation" → expect **403**
  - "should not delete another user's simulation" → expect **403**
  - "should reject cancelling a completed simulation" → expect **409**
  - add: `GET /simulation/get/:id` and `/results` with a **non-existent** id → expect **404** (new positive assertions)
- `tests/admin.test.js`: verify the suspend-admin still 400 (no change); no
  other assertion changes expected — review any that assert 400 on these paths.

Then run the whole suite and reconcile every failure against the matrix —
grep `expect(res.status).toBe(400)` in `tests/` and confirm each remaining 400
is a validation/import/unsupported-type case.

## Verify command (exact)

```bash
docker compose up -d mongo && npm test
```

## Acceptance criteria

1. Every situation in the status matrix returns the code in the "New" column
   (verified by updated/new tests).
2. All error message strings are unchanged from before this feature.
3. No code path in models/controllers throws a generic `Error` where the matrix
   prescribes a typed code.
4. Full suite passes; report the exact count in the commit message.
5. No npm dependency changes.

## Out of scope

- Changing error **message strings**.
- Reordering existence-vs-ownership checks (documented decision, see Security).
- Rate-limit semantics (PRD out-of-scope).
- Frontend changes.