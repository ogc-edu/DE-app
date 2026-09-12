# Testing Guide

## Overview

The test suite uses **Jest 30** as the test runner and **Supertest 7** for HTTP assertions. Tests run against a local MongoDB instance using a separate test database.

## Test Files

| File | Tests | Coverage |
|---|---|---|
| `tests/auth.test.js` | 22 | Register, login, verify, refresh (rotation, hash-at-rest, suspension), logout |
| `tests/simulation.test.js` | 24 | Create (incl. SQS contract + DE params), get (paginated/filtered), results, delete, cancel, authorization |
| `tests/admin.test.js` | 19 | Role-based access, user listing, user detail, suspend (incl. session clearing), simulations, queue metrics |
| `tests/user.test.js` | 17 | Profile view/update, password change (incl. session invalidation), presigned upload, profile picture |
| `tests/importParser.test.js` | 19 | Pure parser for the `.txt` import format (unit tests, no DB) |
| `tests/import.test.js` | 6 | `POST /simulation/import` endpoint behavior |
| **Total** | **107** | |

## Running Tests

### Prerequisites

- A **replica-set** MongoDB must be running locally — a plain `mongod` will not do.
  The canonical way to start it is `docker compose up -d mongo` (container `de-db`,
  port 27017); see the [Setup Guide](./setup.md).
- The test suite connects to `Dashboard-Test-Database` (separate from the dev database).
- Tests never reach AWS: `tests/setup.js` mocks `@aws-sdk/client-sqs`, and the suites
  that touch S3 mock `@aws-sdk/s3-request-presigner`.

### Commands

```bash
# Run all tests once
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run a specific test file
npx cross-env NODE_ENV=test npx jest tests/auth.test.js

# Run a single test by name
npx cross-env NODE_ENV=test npx jest -t "should rotate the refresh token"
```

### Test Environment

Tests run with `NODE_ENV=test` (set via `cross-env` in the npm script). This affects:
- Winston log format (JSON in production, colorized otherwise — test mode uses the default)
- Cookie `secure` flag (false in test mode since `NODE_ENV !== "production"`)

## Test Setup

**File:** `tests/setup.js`

This file is configured as Jest's `setupFilesAfterEnv` in `package.json`:

```json
"jest": {
  "testEnvironment": "node",
  "testMatch": ["**/tests/**/*.test.js"],
  "setupFilesAfterEnv": ["<rootDir>/tests/setup.js"],
  "forceExit": true,
  "detectOpenHandles": true
}
```

### Lifecycle Hooks

| Hook | Action |
|---|---|
| module load | Set `AWS_REGION` / `S3_BUCKET_NAME` / `SQS_QUEUE_URL` and mock `@aws-sdk/client-sqs` — `config/s3.js` and `config/sqs.js` read these env vars at **require time**, so they must be set before `app.js` is imported |
| `beforeAll` | Set test env vars (`JWT_SECRET`, `JWT_REFRESH_SECRET`, `MONGODB_URI`), connect to test database |
| `afterEach` | Clear all collections (delete all documents) — ensures clean state between tests |
| `afterAll` | Close MongoDB connection |

### Environment Variables (test)

The setup file sets these if not already in `.env`:

```js
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-jwt-refresh-secret";
process.env.MONGODB_URI =
  process.env.MONGODB_URI_TEST ||
  "mongodb://root:password123@localhost:27017/Dashboard-Test-Database?directConnection=true&authSource=admin";
process.env.DB_NAME = "Dashboard-Test-Database";
```

## Test Patterns

### App Import

Tests import the Express app from `app.js` (not `server.js`) to avoid starting the HTTP server:

```js
const request = require("supertest");
const app = require("../app");
```

### Making Requests

```js
// Without auth
const res = await request(app).post("/api/v1/register").send(testUser);

// With auth (Bearer token)
const res = await request(app)
  .get("/api/v1/simulation/get")
  .set("Authorization", `Bearer ${token}`);

// With cookie (refresh token)
const res = await request(app)
  .post("/api/v1/refresh")
  .set("Cookie", `refreshToken=${refreshToken}`);
```

### Extracting Refresh Token from Cookies

```js
const res = await request(app)
  .post("/api/v1/login")
  .send({ email, password });

const cookies = res.headers["set-cookie"];
const cookieStr = Array.isArray(cookies) ? cookies.join(";") : cookies;
const match = cookieStr.match(/refreshToken=([^;]+)/);
const refreshToken = match ? match[1] : null;
```

### Creating Test Users

```js
// Regular user (via model static — bypasses Zod middleware)
const user = await User.register("testuser", "test@example.com", "password123");
const token = user.generateJwtToken();

// Admin user (via direct create — sets role)
const admin = await User.create({
  username: "admin",
  email: "admin@example.com",
  password: "adminpass",
  role: "admin",
});
const adminToken = admin.generateJwtToken();
```

> **Note:** `User.create()` triggers the `pre("save")` hook for password hashing, same as `User.register()`.

### Creating Test Simulations

```js
const sim = await Simulation.createSimulation(
  userId,
  [1, 2],                                    // functions
  { mutation: [1], crossover: [1], selection: [1] }  // methods
);
```

## Test Coverage by Area

### Auth Tests (`tests/auth.test.js`)

| Test | Description |
|---|---|
| Register with valid credentials | 201 + success response |
| Register duplicate user | 409 |
| Register with missing fields | 400 (Zod validation) |
| Login with valid credentials | 200 + access token + set-cookie |
| Login sets httpOnly refresh cookie | Cookie has `HttpOnly` attribute |
| Login with invalid password | 401 |
| Login with non-existent email | 401 |
| Login with suspended account | 403 + "suspended" message |
| Verify valid token | 200 + user data |
| Verify without token | 401 |
| Protected route without token | 401 |
| Suspended user on protected route | 403 |
| Refresh with valid token | 200 + new access token |
| Refresh rotates the token | New token differs from old |
| Refresh stores only a hash | DB holds `sha256(rawToken)`, not the cookie value |
| Old refresh token after rotation | 401 |
| Refresh after the user is suspended | 401 |
| Refresh while inactive with an intact hash | 401 + "suspended" (exercises the `isActive` guard) |
| Refresh with invalid token | 401 |
| Refresh without token | 401 |
| Logout clears cookie | 200 |
| Logout invalidates DB token | `refreshTokenHash` is `null` in DB |

### Simulation Tests (`tests/simulation.test.js`)

| Test | Description |
|---|---|
| Create with valid params | 201 + simulationId |
| totalModels = Cartesian product | 2×2×1×1 = 4 |
| Create without token | 401 |
| Create with invalid input (Zod) | 400 + errors array |
| Create with out-of-range DE params (Zod) | 400 + errors array |
| DE parameters persisted / defaulted | `np`/`f`/`cr`/`gen`/`dim` stored |
| Enqueues exactly one SQS job | Message body matches the worker contract |
| SQS failure on create | 201 + `queued: false`, simulation marked `failed` |
| Get all simulations | 200 + correct count |
| Get empty list | 200 + count 0 |
| Get with pagination | Correct page/totalPages |
| Get with status filter | Only matching status returned |
| Get without token | 401 |
| Get single simulation | 200 + simulation data |
| Access another user's simulation | 403 |
| Get a non-existent simulation | 404 |
| Get results endpoint | 200 + simulationData grid |
| Results for a non-existent simulation | 404 |
| Delete own simulation | 200 + removed from DB |
| Delete another user's simulation | 403 |
| Cancel own simulation | 200 + "cancelled" message |
| Cancel a completed simulation | 409 + "Cannot cancel" |

### Admin Tests (`tests/admin.test.js`)

| Test | Description |
|---|---|
| Regular user denied admin access | 403 |
| Admin user allowed admin access | 200 |
| No token on admin route | 401 |
| List users with pagination | Correct count + pagination |
| Refresh token not in user list | Neither `refreshToken` nor `refreshTokenHash` is exposed |
| Get user by ID | 200 + user details |
| Get non-existent user | 404 |
| Suspend a regular user | 200 + isActive false |
| Suspend clears the stored session | `refreshTokenHash` is `null` after suspension |
| Reactivate a suspended user | 200 + isActive true |
| Cannot suspend admin | 400 |
| Suspend non-existent user | 404 |
| List all simulations | 200 + count |
| Filter simulations by userId | 200 + filtered count |
| Delete any simulation | 200 + removed from DB |
| Delete non-existent simulation | 404 |
| Queue metrics | 200 + depth / in-flight / delayed / oldest-message age |
| Queue without `SQS_QUEUE_URL` | 503 |

### User Tests (`tests/user.test.js`)

| Test | Description |
|---|---|
| Get profile | 200 + user data (no password / refresh-token fields) |
| Get profile without token | 401 |
| Update username | 200 + new username |
| Update email | 200 + new email |
| Update affiliation | 200 + new affiliation |
| Update to taken email | 409 + "already in use" |
| Change password (correct current) | 200 |
| Change password (incorrect current) | 401 + "incorrect" |
| Password change ends sessions | Old refresh cookie → 401; stored hash `null` |
| New password works for login | 200 + token |
| New password too long (Zod) | 400 + errors |
| Presigned upload URL | 200 + `uploadUrl` / `key` / `expiresIn` |
| Unsupported content type | 400 |
| Confirm profile picture | 200 + public URL, with and without the `versionId` cache-buster |
| Empty `versionId` (Zod) | 400 + errors |

### Import Tests (`tests/importParser.test.js`, `tests/import.test.js`)

`importParser.test.js` unit-tests the pure parser in `utils/importParser.js` (no DB,
no HTTP): the optional `# key=value` metadata block, the required
`model<TAB>benchmark<TAB>lowestFitness` header, right-to-left model parsing, and the
line-numbered error objects for every malformed case.

`import.test.js` covers `POST /api/v1/simulation/import` end to end: a valid file
becomes a `completed` simulation with `progress: 100` and no SQS job, a malformed
file returns `400` with `errors[]` carrying line numbers, and a missing `content`
field is rejected by Zod.

## Writing New Tests

### Template

```js
const request = require("supertest");
const app = require("../app");
const User = require("../models/user");

describe("New Feature Endpoints", () => {
  let token;

  beforeEach(async () => {
    const user = await User.register("testuser", "test@example.com", "password123");
    token = user.generateJwtToken();
  });

  describe("GET /api/v1/new-feature", () => {
    it("should do something", async () => {
      const res = await request(app)
        .get("/api/v1/new-feature")
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("data");
    });

    it("should return 401 without token", async () => {
      const res = await request(app).get("/api/v1/new-feature");
      expect(res.statusCode).toBe(401);
    });
  });
});
```

### Best Practices

1. **Use `beforeEach` for setup** — creates fresh test data for each test, ensuring isolation
2. **Don't share state between tests** — `afterEach` in `setup.js` clears all collections
3. **Test the API boundary** — use supertest to test HTTP behavior, not internal functions
4. **Test both success and failure paths** — every endpoint should have positive and negative tests
5. **Test authorization** — verify non-owners can't access other users' resources
6. **Test role enforcement** — verify `user` role is blocked from admin endpoints
7. **Assert status codes AND response body** — don't just check the status code
