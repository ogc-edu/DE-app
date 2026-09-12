# Authentication

The backend uses a dual-token JWT authentication system with refresh token rotation for secure, long-lived sessions.

## Token Types

| Token | Purpose | Storage | Expiry | Secret |
|---|---|---|---|---|
| **Access token** | Authenticate API requests | `Authorization: Bearer <token>` header | 1 hour | `JWT_SECRET` |
| **Refresh token** | Obtain new access tokens without re-login | httpOnly cookie (`refreshToken`); SHA-256 digest in `users.refreshTokenHash` | 7 days | `JWT_REFRESH_SECRET` |

## Authentication Flow

### 1. Registration

```
Client                        Backend                     Database
  |                              |                           |
  |  POST /api/v1/register       |                           |
  |  { username, email, password }|                          |
  |----------------------------->|                           |
  |                              |  User.register()          |
  |                              |-------------------------->|
  |                              |  (check duplicate email)  |
  |                              |  (hash password w/ bcrypt)|
  |                              |  (create user document)   |
  |                              |<--------------------------|
  |  201 Created                 |                           |
  |<-----------------------------|                           |
```

No tokens are issued at registration. The user must login to receive tokens.
A duplicate email returns `409`; a schema violation returns `400`.

### 2. Login

```
Client                        Backend                     Database
  |                              |                           |
  |  POST /api/v1/login          |                           |
  |  { email, password }         |                           |
  |----------------------------->|                           |
  |                              |  User.login()             |
  |                              |  (find user by email)     |
  |                              |  (check isActive)         |
  |                              |  (bcrypt.compare)         |
  |                              |-------------------------->|
  |                              |<--------------------------|
  |                              |  generateJwtToken()       |
  |                              |  generateRefreshToken()   |
  |                              |  saveRefreshToken()       |
  |                              |-------------------------->|
  |                              |  (store sha256 of token)  |
  |  Set-Cookie: refreshToken    |                           |
  |  (httpOnly, sameSite=strict) |                           |
  |  200 { token: <access> }     |                           |
  |<-----------------------------|                           |
```

**Failure codes:** invalid email or password → `401`; suspended account → `403`.

**Cookie attributes:**
- `httpOnly: true` — not accessible via JavaScript
- `secure: true` — only over HTTPS (in production)
- `sameSite: strict` — prevents CSRF
- `maxAge: 604800000` (7 days in milliseconds)

### 3. Authenticated Request

```
Client                        Backend
  |                              |
  |  GET /api/v1/simulation/get  |
  |  Authorization: Bearer <jwt> |
  |----------------------------->|
  |                              |  authMiddleware:
  |                              |    1. Extract token from header
  |                              |    2. jwt.verify(token, JWT_SECRET)
  |                              |    3. User.findById(decoded.userId)
  |                              |    4. Check user exists
  |                              |    5. Check user.isActive
  |                              |    6. Set req.userId, req.user
  |  200 { simulations: [...] }  |
  |<-----------------------------|
```

### 4. Token Refresh (Silent Renewal)

When the access token expires (after 1 hour), the frontend calls `/refresh` using the refresh token cookie. This happens silently without user re-entering credentials.

```
Client                        Backend                     Database
  |                              |                           |
  |  POST /api/v1/refresh        |                           |
  |  Cookie: refreshToken=<jwt>  |                           |
  |----------------------------->|                           |
  |                              |  1. Read cookie            |
  |                              |  2. jwt.verify(refresh)    |
  |                              |  3. User.findById() select  |
  |                              |     +refreshTokenHash       |
  |                              |     +isActive               |
  |                              |-------------------------->|
  |                              |<--------------------------|
  |                              |  4. Reject if !isActive     |
  |                              |  5. sha256(cookie token),   |
  |                              |     timingSafeEqual vs hash |
  |                              |  6. Generate NEW access     |
  |                              |     + NEW refresh token     |
  |                              |  7. Save new token's hash   |
  |                              |     (old token invalidated) |
  |                              |-------------------------->|
  |  Set-Cookie: refreshToken    |                           |
  |  (new rotated token)         |                           |
  |  200 { token: <new access> } |                           |
  |<-----------------------------|                           |
```

**Rotation:** Each refresh call issues a new refresh token and invalidates the old one. If a stolen refresh token is used, the legitimate user's next refresh attempt will fail (token mismatch), alerting them to re-authenticate.

**Hashed at rest:** the database never stores the refresh token itself — only
`refreshTokenHash`, the SHA-256 hex digest of the token (`select: false`). A leaked
database dump therefore yields no usable session. SHA-256 is sufficient here because a
7-day JWT is high-entropy; bcrypt exists for low-entropy passwords and would add its
work factor to every `/refresh` call. The presented token is hashed and compared with
`crypto.timingSafeEqual`, so the comparison leaks nothing through timing.

**Defense in depth:** `/refresh` is not behind `authMiddleware`, so it re-checks
`isActive` itself and returns `401 "Account has been suspended"` for a suspended user
even if a stale hash somehow survived.

### 5. Logout

```
Client                        Backend                     Database
  |                              |                           |
  |  POST /api/v1/logout         |                           |
  |  Cookie: refreshToken=<jwt>  |                           |
  |----------------------------->|                           |
  |                              |  1. Read cookie            |
  |                              |  2. jwt.verify(refresh)    |
  |                              |  3. User.findById()        |
  |                              |  4. clearRefreshToken()    |
  |                              |     (refreshTokenHash=null)|
  |                              |-------------------------->|
  |                              |  5. Clear cookie           |
  |  Set-Cookie: refreshToken=   |                           |
  |    ; Max-Age=0               |                           |
  |  200 { message: "Logged out" }                           |
  |<-----------------------------|                           |
```

If no refresh token cookie is present, the endpoint returns `200` with `"Already logged out"`.

## Role-Based Access Control

### Roles

| Role | Description | Can Access |
|---|---|---|
| `user` (default) | Researcher | Auth, User, Simulation endpoints (own data only) |
| `admin` | Administrator | All user endpoints + Admin endpoints (all users' data) |

### Enforcement

1. **`authMiddleware`** — verifies JWT and loads user. Attaches `req.user` with `_id, username, role, isActive`. Rejects:
   - Missing token → `401`
   - Invalid/expired token → `401`
   - User not found → `401`
   - Suspended user (`isActive: false`) → `403`

2. **`adminMiddleware`** — checks `req.user.role === "admin"`. Rejects:
   - Non-admin user → `403`
   - Missing `req.user` (authMiddleware not run) → `403`

### Route Protection Matrix

| Route Group | authMiddleware | adminMiddleware |
|---|---|---|
| `/api/v1/health` | — | — |
| `/api/v1/register` | — | — |
| `/api/v1/login` | — | — |
| `/api/v1/verify` | — | — |
| `/api/v1/refresh` | — | — |
| `/api/v1/logout` | — | — |
| `/api/v1/simulation/*` | yes | — |
| `/api/v1/user/*` | yes | — |
| `/api/v1/admin/*` | yes | yes |

## Suspended User Handling

When an admin suspends a user via `PATCH /api/v1/admin/users/:id/suspend`:

1. The user's `isActive` field is set to `false`
2. **Login is blocked** — `User.login()` checks `isActive` and throws `"Account has been suspended"`
3. **Existing tokens are blocked** — `authMiddleware` checks `isActive` and returns `403 "Account has been suspended"`
4. **The session is ended** — suspension clears `refreshTokenHash`, so the existing refresh cookie is dead immediately. `/refresh` also refuses suspended users outright, so both the stored-hash path and the `isActive` guard reject it.

Reactivating a user does **not** restore the old session: the hash stays `null` and the
user must log in again.

## Session Invalidation

The stored `refreshTokenHash` is cleared — ending every existing session — on:

| Event | Where |
|---|---|
| Logout | `controllers/authController.js:logout` |
| Account suspension | `controllers/adminController.js:toggleSuspendUser` |
| Password change | `controllers/userController.js:changePassword` |
| Each `/refresh` (replaced, not cleared) | rotation invalidates the previous token |

Only one refresh token is stored per user, so concurrent sessions overwrite each other —
a second device logging in invalidates the first device's refresh token.

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `JWT_SECRET` | Secret key for signing access tokens | `your-secret-key` |
| `JWT_REFRESH_SECRET` | Secret key for signing refresh tokens (separate from access) | `your-refresh-secret` |
| `NODE_ENV` | When `production`, cookies are secure-only | `production` |

## Security Considerations

- **Separate secrets** — Access and refresh tokens use different secrets (`JWT_SECRET` vs `JWT_REFRESH_SECRET`) so compromising one doesn't compromise both
- **httpOnly cookies** — Refresh tokens cannot be stolen via XSS
- **sameSite: strict** — Prevents CSRF attacks
- **Token rotation** — Limits the window of opportunity for refresh token theft
- **jti claim** — Each refresh token includes a unique `jti` (JWT ID) to prevent identical tokens from being issued in the same second
- **Password hashing** — bcrypt with salt rounds of 10
- **Password never returned** — `select: false` on the password field ensures it's excluded from all queries unless explicitly selected with `+password`
- **Refresh tokens hashed at rest** — only `sha256(token)` is persisted, compared in constant time
- **Session invalidation** — logout, suspension and password change all clear the stored hash

**Known limitation (deliberate, not yet implemented):** there is no `jti` reuse-detection
blacklist, so a stolen refresh token used *before* the legitimate client's next refresh
succeeds once. Rotation still surfaces the theft on the next legitimate call.
