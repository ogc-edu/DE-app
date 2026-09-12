# 002 — Refresh-token hardening (backend only)

## Objective

Stop storing refresh tokens in plaintext; invalidate sessions (refresh tokens)
when an account is suspended and when a password is changed; keep the existing
rotation behavior and add a defense-in-depth `isActive` check on `/refresh`.
No frontend changes — the frontend is a separate repo.

## Context

- Current behavior (verified at `controllers/authController.js:refresh`,
  `controllers/loginController.js`, `models/user.js`):
  - `users.refreshToken` stores the raw JWT string (`select:false`).
  - `POST /refresh` compares the cookie token to the stored raw string,
    rotates, and issues a new access token.
  - Suspension (`controllers/adminController.js:toggleSuspendUser`) only
    flips `isActive` — the stored refresh token survives (documented as a
    "future enhancement" in `docs/authentication.md`).
  - `PATCH /user/password` (`controllers/userController.js:changePassword`)
    does not invalidate existing refresh tokens.
- PRD linkage: PRD §4 auth decision ("refresh token rotation … no user
  re-entering credentials") is implemented; this feature hardens the security
  intent of that decision. No PRD user story is open.
- Feature 001 must be merged first so `npm test` is verifiable.
- Conventions: CommonJS; no new npm dependencies (`node:crypto` is built-in);
  tests in `tests/*.test.js`.

## Requirements

1. The refresh token is **never** stored in plaintext — only a SHA-256 digest
   is persisted.
2. Suspending a user clears their stored refresh-token hash (session ends on
   suspend; reactivation requires re-login).
3. Changing the password clears the stored refresh-token hash (all existing
   sessions end).
4. Rotation semantics preserved: each successful `/refresh` invalidates the
   previous refresh token.
5. `POST /refresh` refuses to mint tokens for suspended users even if a valid
   hash somehow survived.
6. API surface (paths, bodies, cookies, response shapes) unchanged — the
   frontend keeps working untouched.

## Technical design

### 1. `models/user.js`

- Add `const crypto = require("node:crypto");` at the top.
- Rename the schema field `refreshToken` → `refreshTokenHash`
  (`{ type: String, select: false, default: null }`), with a comment noting
  the field stores `sha256(rawToken)`, never the token itself.
- Add a module-level helper and wire it into the methods:

```js
const hashRefreshToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

userSchema.methods.saveRefreshToken = async function (token) {
  this.refreshTokenHash = hashRefreshToken(token);
  return await this.save();
};

userSchema.methods.clearRefreshToken = async function () {
  this.refreshTokenHash = null;
  return await this.save();
};

// exported for the controller's constant-time comparison
userSchema.statics.hashRefreshToken = hashRefreshToken;
```

Keep `generateRefreshToken` untouched (jti claim, 7d expiry, `JWT_REFRESH_SECRET`).

### 2. `controllers/authController.js` — `refresh`

Replace the compare + select logic:

```js
const User = require("../models/user");
const crypto = require("node:crypto");

const user = await User.findById(decoded.userId).select("+refreshTokenHash +isActive");
if (!user) return res.status(401).json({ message: "User not found" });
// Defense-in-depth: suspended users must not refresh even if a stale hash lingers.
if (!user.isActive) return res.status(401).json({ message: "Account has been suspended" });

const presented = Buffer.from(User.hashRefreshToken(refreshToken), "hex");
const stored = Buffer.from(user.refreshTokenHash || "", "hex");
if (
  user.refreshTokenHash == null ||
  presented.length !== stored.length ||
  !crypto.timingSafeEqual(presented, stored)
) {
  return res.status(401).json({ message: "Refresh token does not match" });
}
```

Then rotate exactly as today (new access token, new refresh token,
`saveRefreshToken(newRefreshToken)`, set cookie, respond). `logout` and
`verify` are unchanged except `logout` keeps using `clearRefreshToken()`.

### 3. `controllers/adminController.js` — `toggleSuspendUser`

When the operation **suspends** the user (was active, now inactive), clear the
session before saving:

```js
if (user.isActive) {
  user.refreshTokenHash = null; // end existing sessions on suspension
}
user.isActive = !user.isActive;
await user.save();
```

(Equivalently: `if (user.isActive) await user.clearRefreshToken();` before the
`user.isActive = !user.isActive; await user.save();` — but avoid two saves.)

### 4. `controllers/userController.js` — `changePassword`

After a successful password update, invalidate all sessions:

```js
user.password = newPassword;
user.refreshTokenHash = null; // end all sessions; user must re-login
await user.save();
```

The existing pre-save hook hashes `password` when modified; one save covers both fields.

## Files

**Touches (existing):**
- `models/user.js`
- `controllers/authController.js`
- `controllers/adminController.js`
- `controllers/userController.js`
- `tests/auth.test.js` (extend/enhance refresh tests)
- `tests/user.test.js` (add password-change invalidation test)
- `tests/admin.test.js` (add suspend-invalidation test)

**Creates:** none.

## API changes

None: `POST /login`, `POST /refresh`, `POST /logout`,
`PATCH /admin/users/:id/suspend`, `PATCH /user/password` keep their paths,
bodies, cookies, and response shapes. Status codes unchanged (401 messages stay
client-facing the same).

## Database changes

- Field rename: `users.refreshToken` → `users.refreshTokenHash` (same
  `select:false` behavior).
- **No migration required**: legacy documents carrying a plaintext
  `refreshToken` value simply never match a hash comparison; those users
  re-login once. Optionally run
  `db.users.updateMany({ refreshToken: { $exists: true } }, { $unset: { refreshToken: 1 } })`
  as a manual cleanup in the deploy notes, but it is not blocking.
- New index: none (no queries filter on the hash).

## Dependencies

001 (green, runnable test baseline). No library additions.

## Edge cases

- Legacy plaintext row + valid old cookie → hash mismatch → 401; client re-logins (expected, documented).
- Empty/missing cookie → existing 401 path (unchanged).
- Timing-safe compare: both buffers are SHA-256 hex digests (64 bytes) — the
  length guard is defensive only; hashing the presented token normalizes any
  weird input.
- Suspend → reactivate: hash stays null; user re-logins. Message text on
  `/refresh` stays "Account has been suspended" / "Refresh token does not match"
  as applicable.
- Password change with wrong current password → still 400/401 per feature 003's
  matrix (feature 003 may land before or after; both touch `changePassword` — if
  merging in either order, keep this feature's session-invalidation line intact).
- Two concurrent tabs both refreshing: rotation means the second tab's older
  cookie is rejected after the first rotates — pre-existing behavior, unchanged.

## Security considerations

- SHA-256 of a high-entropy 7‑day JWT is adequate at rest; bcrypt is not needed
  (it is for low-entropy passwords and would slow every /refresh).
- `crypto.timingSafeEqual` avoids user-enumerable hash comparison.
- Document in `docs/authentication.md` via feature 004: hashes at rest,
  invalidation on suspend/password change.
- Out of scope (explicit): jti reuse-detection blacklist (theft-lockout
  detection) — leave as documented future work.

## Tests

In `tests/auth.test.js`:
1. Extend the refresh tests to assert the DB stores a 64-char hex digest, not
   the raw cookie token:
   - login via HTTP → capture `set-cookie` raw refresh token → `User.findById(...).select("+refreshTokenHash")` → assert `refreshTokenHash.length === 64`, `refreshTokenHash !== rawToken`, and `crypto.createHash("sha256").update(rawToken).digest("hex") === refreshTokenHash`.
2. Keep/verify "should rotate the refresh token" — after rotation the **old**
   cookie must return 401.
3. Add: "refresh fails after the user is suspended" — login, suspend via
   `PATCH /api/v1/admin/users/:id/suspend` (admin token), then
   `POST /refresh` with the pre-suspend cookie → 401.

In `tests/user.test.js`:
4. Add: "password change invalidates the refresh token" — login, change
   password, `POST /refresh` with the original cookie → 401.

In `tests/admin.test.js` (if not covered by 3):
5. Assert the suspended user's stored hash is null
   (`User.findById(id).select("+refreshTokenHash")`).

Sanity: no existing test should read `user.refreshToken` anywhere — grep for
`refreshToken` in `tests/` and update to the new field name if a fixture does.

## Verify command (exact)

```bash
docker compose up -d mongo && npm test
```

## Acceptance criteria

1. No plaintext refresh token is persisted: the only stored value is
   `refreshTokenHash` (SHA-256 hex); verified by the new DB-level test.
2. Rotation still works: new access token issued, old refresh cookie rejected.
3. Suspending a user ends their session: `/refresh` with their cookie returns 401.
4. Changing a password ends all sessions: `/refresh` with the old cookie returns 401.
5. `POST /refresh` returns 401 for a suspended user even if a hash exists.
6. Full test suite passes (baseline 99 + new tests); report the exact count.
7. No npm dependency changes; `package-lock.json` untouched.

## Out of scope

- Frontend silent-refresh wiring (separate repo).
- Reuse-detection / jti blacklist.
- Migration of legacy plaintext rows (manual note only).
- Any other auth hardening (rate limiting on `/refresh` is PRD out-of-scope).