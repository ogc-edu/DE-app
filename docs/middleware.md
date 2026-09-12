# Middleware

This document covers all middleware used in the application, including the Express built-in middleware, custom security middleware, validation, and error handling.

## Middleware Pipeline

Middleware is applied in `app.js` in the following order:

| # | Middleware | Type | Purpose |
|---|---|---|---|
| 1 | `helmet()` | Security | HTTP security headers |
| 2 | `express.json()` | Built-in | Parse JSON request bodies |
| 3 | `express.urlencoded()` | Built-in | Parse URL-encoded bodies |
| 4 | `cookieParser()` | Third-party | Parse cookies (for refresh token) |
| 5 | `cors()` | Third-party | Cross-origin resource sharing |
| 6 | `morgan("combined")` | Third-party | HTTP request logging |
| 7 | Route handlers | Custom | Application routes |
| 8 | `notFound` | Custom | 404 for unmatched routes |
| 9 | `errorHandler` | Custom | Centralized error handling |

---

## Security Middleware

### Helmet

**File:** N/A (npm package)
**Applied in:** `app.js`

Sets security-related HTTP headers automatically:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Strict-Transport-Security` (HSTS)
- `X-DNS-Prefetch-Control`
- Content security policy headers

No configuration required — uses secure defaults.

### CORS

**File:** N/A (npm package)
**Applied in:** `app.js`

```js
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
  : true;

app.use(cors({ origin: corsOrigins, credentials: true }));
```

**Configuration:**
- `origin` — parsed from `CORS_ORIGIN` env var (comma-separated list). Falls back to `true` (allow all) if unset.
- `credentials: true` — allows cookies to be sent cross-origin (needed for refresh token)

**Example `CORS_ORIGIN` value:**
```
CORS_ORIGIN=http://localhost:3001,http://localhost:5173,https://myapp.example.com
```

---

## Authentication Middleware

### authMiddleware

**File:** `middleware/authMiddleware.js`
**Applied to:** `/api/v1/simulation`, `/api/v1/admin`, `/api/v1/user` route groups

Verifies the JWT access token and loads the user into the request.

**Flow:**
1. Extract token from `Authorization: Bearer <token>` header
2. If no token → `401 { message: "No token, authorization denied" }`
3. `jwt.verify(token, JWT_SECRET)` — decode and verify
4. `User.findById(decoded.userId).select("_id username role isActive")`
5. If user not found → `401 { message: "Token is not valid, user not found" }`
6. If `user.isActive === false` → `403 { message: "Account has been suspended" }`
7. Set `req.userId = decoded.userId` and `req.user = user`
8. Call `next()`
9. If JWT verification fails → `401 { message: "Token is not valid" }`

**Request additions:**
| Property | Type | Description |
|---|---|---|
| `req.userId` | string | The authenticated user's ObjectId (as string) |
| `req.user` | Mongoose Document | User document with `_id, username, role, isActive` |

### adminMiddleware

**File:** `middleware/adminMiddleware.js`
**Applied to:** `/api/v1/admin` route group (after authMiddleware)

Checks that the authenticated user has the `admin` role.

**Flow:**
1. Check `req.user` exists and `req.user.role === "admin"`
2. If not admin → `403 { message: "Admin access required" }`
3. Call `next()`

**Prerequisite:** Must be used after `authMiddleware` (which sets `req.user`).

---

## Validation Middleware

### validate(schema)

**File:** `middleware/validate.js`
**Applied to:** Routes with request bodies (register, login, simulation create, profile update, password change)

A factory function that returns Express middleware. Takes a Zod schema and validates `req.body` against it.

```js
const validate = (schema) => {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors,
      });
    }
    req.body = result.data; // Replace with sanitized data
    next();
  };
};
```

**Behavior:**
- On success: replaces `req.body` with the Zod-parsed output (includes transformations like `.trim()`, `.toLowerCase()`)
- On failure: returns `400` with field-specific error messages

**Available schemas** (in `validators/`):

| Schema | File | Used By |
|---|---|---|
| `registerSchema` | `validators/authValidators.js` | `POST /api/v1/register` |
| `loginSchema` | `validators/authValidators.js` | `POST /api/v1/login` |
| `updateProfileSchema` | `validators/authValidators.js` | `PATCH /api/v1/user/profile` |
| `changePasswordSchema` | `validators/authValidators.js` | `PATCH /api/v1/user/password` |
| `createSimulationSchema` | `validators/simulationValidators.js` | `POST /api/v1/simulation/create` |

**Example validation error response:**
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    { "field": "email", "message": "Please add a valid email" },
    { "field": "password", "message": "Password must be at least 6 characters long" }
  ]
}
```

---

## Error Handling Middleware

### notFound

**File:** `middleware/notFound.js`
**Applied in:** `app.js` (after routes, before errorHandler)

Catches all requests that don't match any route.

**Response:**
```json
{
  "error": "Route not found",
  "path": "/api/v1/unknown-endpoint"
}
```
Status: `404`

### errorHandler

**File:** `middleware/errorHandler.js`
**Applied in:** `app.js` (last middleware)

Centralized error handler that normalizes different error types into consistent JSON responses.

**Error type handling:**

| Error Type | Condition | Status | Message Source |
|---|---|---|---|
| Typed HTTP error | `typeof err.statusCode === "number"` | `err.statusCode` | `err.message` |
| CastError | `err.name === "CastError"` | 404 | `"Resource not found with id: <value>"` |
| Duplicate key | `err.code === 11000` | 400 | `"Duplicate field value entered for field: <field>"` |
| ValidationError | `err.name === "ValidationError"` | 400 | Joined field-specific messages from `err.errors[key].message` |
| JWT invalid/expired | `err.name === "JsonWebTokenError"` / `"TokenExpiredError"` | 401 | `"Token is not valid or has expired"` |
| Anything else | — | 500 | `err.message`, else `"Server Error"` |

The typed branch runs **first**, so a domain error carries its own status code
straight through. Everything untyped falls to `500` — an unexpected `new Error(...)`
is a server fault, not a client error.

### Typed errors (`utils/errors.js`)

Models and controllers throw these instead of a bare `Error`:

| Class | Status |
|---|---|
| `BadRequestError` | 400 |
| `UnauthorizedError` | 401 |
| `ForbiddenError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |

All extend `HttpError`, which sets `name = "HttpError"` and `statusCode`.

### Status matrix

| Situation | Status |
|---|---|
| Login: invalid credentials / unknown email | 401 |
| Login: suspended account | 403 |
| Register: email already exists | 409 |
| Cross-user simulation access (get / results / delete / cancel) | 403 |
| Simulation not found | 404 |
| Cancel a simulation in a terminal status | 409 |
| Profile: email already in use | 409 |
| Password change: current password wrong | 401 |
| Admin: cannot suspend an admin | 400 |
| Zod validation, import parse errors, unsupported content type | 400 |
| Suspended user hits a protected route | 403 (`authMiddleware`, not this handler) |
| Unexpected internal failure | 500 |

> Existence is checked **before** ownership, so requesting another user's simulation
> returns `403` while a wholly unknown id returns `404`. This is a deliberate trade-off:
> the ids are unguessable ObjectIds, so the distinction leaks nothing practical.

**Logging:** All errors are logged via Winston at the `error` level, including the error name, code, and stack trace location.

**Response format:**
```json
{
  "success": false,
  "error": "Error message"
}
```

---

## Logging Middleware

### Morgan

**File:** N/A (npm package)
**Applied in:** `app.js`

Logs HTTP requests in `combined` format, piped through Winston's info level:

```js
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);
```

**Example log output:**
```
2026-07-13T13:34:47.037Z info: ::ffff:127.0.0.1 - - [13/Jul/2026:13:34:47 +0000] "GET /api/v1/user/profile HTTP/1.1" 200 275 "-" "-"
```

### Winston Logger

**File:** `config/logger.js`

**Transports:**
| Transport | Level | Output |
|---|---|---|
| Console | info | Colorized in dev, JSON in prod |
| `logs/error.log` | error | Error-level only |
| `logs/combined.log` | info | All levels |

**Usage in code:**
```js
const logger = require("../config/logger");
logger.info("Database connected successfully");
logger.error("Failed to start server:", error);
```

---

## Swagger/OpenAPI Middleware

**File:** `docs/swagger.js` + `app.js`

Serves interactive API documentation at `/api/v1/docs`.

```js
app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
```

The `swaggerSpec` is generated by `swagger-jsdoc` from:
- The OpenAPI definition in `docs/swagger.js` (info, servers, security schemes)
- JSDoc `@openapi` annotations in all files under `routes/*.js`

Each route file contains `@openapi` JSDoc comments that define the endpoint's summary, tags, parameters, request body, and responses.
