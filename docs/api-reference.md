# API Reference

Base URL: `http://localhost:3000/api/v1`

Interactive docs available at: `http://localhost:3000/api/v1/docs`

---

## Authentication

All protected endpoints require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

### Conventions

| Convention | Description |
|---|---|
| **Auth required** | Endpoints marked with a lock icon require `Authorization: Bearer <token>` |
| **Admin only** | Endpoints marked "Admin" require `role: "admin"` |
| **Validation** | Endpoints with request bodies are validated via Zod schemas |
| **Cookies** | Login and refresh endpoints set/clear an httpOnly `refreshToken` cookie |

### Response Format

**Success:**
```json
{
  "message": "Operation successful",
  "data": { ... }
}
```

**Error:**
```json
{
  "success": false,
  "error": "Error message"
}
```

**Validation error (400):**
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    { "field": "email", "message": "Please add a valid email" }
  ]
}
```

---

## Auth Endpoints

### POST /api/v1/register

Register a new user account. New users are assigned `role: "user"` by default.

**Request body:**
```json
{
  "username": "researcher1",
  "email": "researcher@example.com",
  "password": "securepass"
}
```

**Validation rules:**
| Field | Type | Rules |
|---|---|---|
| `username` | string | 3–50 chars, trimmed |
| `email` | string | valid email format, lowercased, trimmed |
| `password` | string | 6–12 chars |

**Responses:**
| Status | Description |
|---|---|
| 201 | User registered successfully |
| 400 | Validation error |
| 409 | Email already registered |

**Example success response:**
```json
{
  "success": true,
  "message": "User registered successfully"
}
```

---

### POST /api/v1/login

Authenticate a user and receive an access token. Sets an httpOnly refresh token cookie.

**Request body:**
```json
{
  "email": "researcher@example.com",
  "password": "securepass"
}
```

**Validation rules:**
| Field | Type | Rules |
|---|---|---|
| `email` | string | valid email format, lowercased, trimmed |
| `password` | string | required (min 1 char) |

**Responses:**
| Status | Description |
|---|---|
| 200 | Login successful, returns access token |
| 400 | Validation error |
| 401 | Invalid email or password |
| 403 | Account has been suspended |

**Example success response:**
```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Cookies set:**
- `refreshToken` — httpOnly, secure (in production), sameSite: strict, maxAge: 7 days

---

### POST /api/v1/verify

Verify that an access token is valid. Returns the user data if valid.

**Auth required:** Bearer token

**Responses:**
| Status | Description |
|---|---|
| 200 | Token is valid |
| 401 | No token or invalid token |

**Example success response:**
```json
{
  "status": true,
  "userData": {
    "userId": "6a54e5cc235db65db3a8db8e",
    "username": "researcher1"
  }
}
```

---

### POST /api/v1/refresh

Exchange a valid refresh token cookie for a new access token. The refresh token is rotated (old token invalidated, new token issued).

**Cookies required:** `refreshToken` (set by login)

**Responses:**
| Status | Description |
|---|---|
| 200 | New access token issued, new refresh token cookie set |
| 401 | No refresh token, invalid/expired token, or token mismatch |

**Example success response:**
```json
{
  "message": "Token refreshed successfully",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Rotation behavior:** Each call to `/refresh` issues a new refresh token and invalidates the old one. The old token will no longer be accepted on subsequent calls.

**Storage:** the database holds only the SHA-256 digest of the current refresh token, so
a `401` is returned whenever the presented cookie's digest does not match. Suspended
users are rejected with `401` even if a digest still matches.

---

### POST /api/v1/logout

Invalidate the refresh token and clear the cookie.

**Cookies required:** `refreshToken` (optional — if missing, returns "already logged out")

**Responses:**
| Status | Description |
|---|---|
| 200 | Logged out successfully |

**Example response:**
```json
{
  "message": "Logged out successfully"
}
```

---

## User Endpoints

All user endpoints require authentication.

### GET /api/v1/user/profile

Get the current authenticated user's profile.

**Auth required:** Bearer token

**Responses:**
| Status | Description |
|---|---|
| 200 | User profile returned |
| 404 | User not found |

**Example response:**
```json
{
  "user": {
    "_id": "6a54e5cc235db65db3a8db8e",
    "username": "researcher1",
    "email": "researcher@example.com",
    "role": "user",
    "isActive": true,
    "isVerified": false,
    "simulationCount": 3,
    "createdAt": "2026-07-13T10:00:00.000Z",
    "updatedAt": "2026-07-13T12:00:00.000Z"
  }
}
```

> **Note:** the `password` and `refreshTokenHash` fields are never included in the response.

---

### GET /api/v1/user/profile/presign

Request a presigned S3 URL for uploading a profile picture. The client then `PUT`s the
file straight to S3 and confirms with the endpoint below.

**Auth required:** Bearer token

**Query parameters:**
| Parameter | Required | Description |
|---|---|---|
| `contentType` | yes | One of `image/jpeg`, `image/png`, `image/webp`, `image/gif` |

**Responses:**
| Status | Description |
|---|---|
| 200 | Presigned upload URL returned |
| 400 | Unsupported content type |
| 401 | Unauthorized |

**Example response:**
```json
{
  "uploadUrl": "https://bucket.s3.amazonaws.com/profile-images/68a1...?X-Amz-Signature=...",
  "key": "profile-images/68a1f2c3d4e5f6a7b8c9d0e1",
  "contentType": "image/jpeg",
  "expiresIn": 300
}
```

The key is fixed per user, so each upload overwrites the same object and bucket
versioning produces a new version id. The URL expires after 5 minutes.

---

### POST /api/v1/user/profile/picture

Confirm a completed S3 upload and store the public object URL on the user.

**Auth required:** Bearer token

**Request body:**
```json
{
  "versionId": "3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY"
}
```

| Field | Rule |
|---|---|
| `versionId` | Optional; if present, 1–64 characters. Appended as a cache-buster |

**Responses:**
| Status | Description |
|---|---|
| 200 | Profile picture updated, returns the updated user |
| 400 | Validation error (empty `versionId`) |
| 401 | Unauthorized |
| 404 | User not found |

---

### PATCH /api/v1/user/profile

Update the current user's username and/or email.

**Auth required:** Bearer token

**Request body (all fields optional):**
```json
{
  "username": "newusername",
  "email": "newemail@example.com"
}
```

**Validation rules:**
| Field | Type | Rules |
|---|---|---|
| `username` | string | 3–50 chars, trimmed (optional) |
| `email` | string | valid email, lowercased, trimmed (optional) |

**Responses:**
| Status | Description |
|---|---|
| 200 | Profile updated successfully |
| 400 | Validation error |
| 409 | Email already in use |
| 404 | User not found |

---

### PATCH /api/v1/user/password

Change the current user's password. Requires the current password for verification.

**Auth required:** Bearer token

**Request body:**
```json
{
  "currentPassword": "securepass",
  "newPassword": "newpass123"
}
```

**Validation rules:**
| Field | Type | Rules |
|---|---|---|
| `currentPassword` | string | required |
| `newPassword` | string | 6–12 chars |

**Responses:**
| Status | Description |
|---|---|
| 200 | Password changed successfully |
| 400 | New password fails validation (max 12 characters) |
| 401 | Current password incorrect |
| 404 | User not found |

> The new password is automatically hashed by the Mongoose `pre('save')` hook before storage.
> A successful change also clears the stored refresh-token hash, so every existing
> session ends and the user must log in again.

---

## Simulation Endpoints

All simulation endpoints require authentication. Users can only access their own simulations.

### POST /api/v1/simulation/create

Create a new simulation. The system computes `totalModels` as the Cartesian product of all input arrays.

**Auth required:** Bearer token

**Request body:**
```json
{
  "functions": [1, 2, 3],
  "methods": {
    "mutation": [1, 2],
    "crossover": [1, 2],
    "selection": [1, 2]
  },
  "np": 20,
  "f": 0.7,
  "cr": 0.8,
  "gen": 500,
  "dim": 10
}
```
`np` (10–40, default 15), `f` (0.1–2.0, default 0.5), `cr` (0.01–1.0, default 0.9), `gen` (≥1, default 1000), `dim` (1–30 — must match de.cpp, default 30) are all optional; defaults are applied server-side.

On success the backend also **enqueues one SQS job** per simulation with the worker contract `{ simulationId, bf, mutation, crossover, selection, cr, f, np, gen, dim }` (arrays as comma-joined strings). If the SQS push fails, the simulation is marked `failed` and the response includes `"queued": false`.

**Validation rules:**
| Field | Type | Range | Min items |
|---|---|---|---|
| `functions` | integer[] | 1–10 | 1 |
| `methods.mutation` | integer[] | 1–10 | 1 |
| `methods.crossover` | integer[] | 1–4 | 1 |
| `methods.selection` | integer[] | 1–2 | 1 |

**`totalModels` calculation:**
```
totalModels = functions.length × mutation.length × crossover.length × selection.length
```
Example: 3 functions × 2 mutation × 2 crossover × 2 selection = 24 models

**Responses:**
| Status | Description |
|---|---|
| 201 | Simulation created |
| 400 | Validation error |
| 401 | Unauthorized |

**Example success response:**
```json
{
  "message": "Simulation created successfully",
  "simulationId": "6a54e5cc235db65db3a8db8f"
}
```

---

### POST /api/v1/simulation/import

Import a `.txt` results file as an already-completed simulation. No SQS job is
enqueued — imported data is final.

**Auth required:** Bearer token

**Request body:**
```json
{
  "content": "# np=15\nmodel\tbenchmark\tlowestFitness\n1/1/1\t1\t0.0001",
  "filename": "results.txt"
}
```

**Validation rules:**
| Field | Rule |
|---|---|
| `content` | Required, non-empty string (the whole file) |
| `filename` | Optional, at most 255 characters |

The file format contract lives in `import-format.md` at the monorepo root: an optional
`# key=value` metadata block (`np`, `f`, `cr`, `gen`, `dim`), a required
`model<TAB>benchmark<TAB>lowestFitness` header, then one row per (model × benchmark).
Model strings are `<mutation>/<crossover>/<selection>`.

**Responses:**
| Status | Description |
|---|---|
| 201 | Data imported successfully |
| 400 | Zod validation error, or parse failure with line-numbered `errors[]` |
| 401 | Unauthorized |

**Example success response:**
```json
{
  "message": "Data imported successfully",
  "simulationId": "68a1f2c3d4e5f6a7b8c9d0e1",
  "totalModels": 40
}
```

**Example parse-failure response (400):**
```json
{
  "success": false,
  "message": "Import failed",
  "errors": [
    { "line": 4, "message": "benchmark must be an integer between 1 and 10" }
  ]
}
```

The imported simulation is stored with `status: "completed"`, `progress: 100`, and
`completedModels === totalModels`.

---

### GET /api/v1/simulation/get

List all simulations belonging to the authenticated user. Supports pagination and status filtering.

**Auth required:** Bearer token

**Query parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `page` | integer | 1 | Page number (only used when `limit` > 0) |
| `limit` | integer | 0 | Items per page (0 = no pagination, return all) |
| `status` | string | — | Filter by status: `pending`, `completed`, `failed`, `cancelled` |

**Responses:**
| Status | Description |
|---|---|
| 200 | List of simulations |
| 401 | Unauthorized |

**Example response (without pagination):**
```json
{
  "simulations": [ { ...simulationObject } ],
  "simulationCount": 5
}
```

**Example response (with pagination, `?page=1&limit=2`):**
```json
{
  "simulations": [ { ...simulationObject } ],
  "simulationCount": 5,
  "currentPage": 1,
  "totalPages": 3
}
```

---

### GET /api/v1/simulation/get/:simulationId

Get a single simulation by its ID.

**Auth required:** Bearer token

**Path parameters:**
| Param | Type | Description |
|---|---|---|
| `simulationId` | string | MongoDB ObjectId of the simulation |

**Responses:**
| Status | Description |
|---|---|
| 200 | Simulation details |
| 401 | Unauthorized (no/invalid token) |
| 403 | Simulation belongs to another user |
| 404 | Simulation not found |

---

### GET /api/v1/simulation/get/:simulationId/results

Get only the results data for a simulation — a lighter payload focused on the results grid.

**Auth required:** Bearer token

**Path parameters:**
| Param | Type | Description |
|---|---|---|
| `simulationId` | string | MongoDB ObjectId of the simulation |

**Responses:**
| Status | Description |
|---|---|
| 200 | Results data returned |
| 401 | Unauthorized (no/invalid token) |
| 403 | Simulation belongs to another user |
| 404 | Simulation not found |

**Example response:**
```json
{
  "simulationId": "6a54e5cc235db65db3a8db8f",
  "status": "completed",
  "totalModels": 24,
  "completedModels": 24,
  "progress": 100,
  "simulationData": [
    {
      "functionId": 1,
      "mutationId": 1,
      "crossoverId": 1,
      "selectionId": 1,
      "lowestFitness": 0.0023
    },
    {
      "functionId": 1,
      "mutationId": 1,
      "crossoverId": 1,
      "selectionId": 2,
      "lowestFitness": 0.0019
    }
  ]
}
```

> **Note:** `simulationData` starts empty and is populated by EC2 workers as they process each model. Each entry represents one combination of (functionId × mutationId × crossoverId × selectionId) with its lowest fitness value.

---

### DELETE /api/v1/simulation/delete/:simulationId

Delete a simulation. Only the simulation owner can delete it.

**Auth required:** Bearer token

**Path parameters:**
| Param | Type | Description |
|---|---|---|
| `simulationId` | string | MongoDB ObjectId of the simulation |

**Responses:**
| Status | Description |
|---|---|
| 200 | Simulation deleted successfully |
| 401 | Unauthorized (no/invalid token) |
| 403 | Simulation belongs to another user |
| 404 | Simulation not found |

---

### POST /api/v1/simulation/cancel/:simulationId

Cancel a pending simulation. Sets status to `cancelled`. Only the simulation owner can cancel it.

**Auth required:** Bearer token

**Path parameters:**
| Param | Type | Description |
|---|---|---|
| `simulationId` | string | MongoDB ObjectId of the simulation |

**Responses:**
| Status | Description |
|---|---|
| 200 | Simulation cancelled successfully |
| 401 | Unauthorized (no/invalid token) |
| 403 | Simulation belongs to another user |
| 404 | Simulation not found |
| 409 | Simulation is already in a terminal status (`completed`, `failed`, `cancelled`) |

---

## Admin Endpoints

All admin endpoints require both authentication (`authMiddleware`) and admin role (`adminMiddleware`).

### GET /api/v1/admin/users

List all users with pagination.

**Auth required:** Bearer token + Admin role

**Query parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `page` | integer | 1 | Page number |
| `limit` | integer | 20 | Items per page |

**Responses:**
| Status | Description |
|---|---|
| 200 | Paginated list of users |
| 401 | Unauthorized (no/invalid token) |
| 403 | Admin access required |

**Example response:**
```json
{
  "userCount": 25,
  "currentPage": 1,
  "totalPages": 2,
  "users": [
    {
      "_id": "6a54e5cc235db65db3a8db8e",
      "username": "researcher1",
      "email": "researcher@example.com",
      "role": "user",
      "isActive": true,
      "createdAt": "2026-07-13T10:00:00.000Z"
    }
  ]
}
```

> `refreshTokenHash` is never included in the response.

---

### GET /api/v1/admin/users/:id

Get a single user's details by ID.

**Auth required:** Bearer token + Admin role

**Path parameters:**
| Param | Type | Description |
|---|---|---|
| `id` | string | MongoDB ObjectId of the user |

**Responses:**
| Status | Description |
|---|---|
| 200 | User details |
| 404 | User not found |

---

### PATCH /api/v1/admin/users/:id/suspend

Toggle a user's active/suspended status. Suspended users cannot login or access protected routes.

**Auth required:** Bearer token + Admin role

**Path parameters:**
| Param | Type | Description |
|---|---|---|
| `id` | string | MongoDB ObjectId of the user |

**Responses:**
| Status | Description |
|---|---|
| 200 | User status toggled |
| 400 | Cannot suspend an admin user |
| 404 | User not found |

**Example response (suspending):**
```json
{
  "message": "User suspended successfully",
  "userId": "6a54e5cc235db65db3a8db8e",
  "isActive": false
}
```

**Example response (reactivating):**
```json
{
  "message": "User activated successfully",
  "userId": "6a54e5cc235db65db3a8db8e",
  "isActive": true
}
```

> Admin users cannot be suspended. The endpoint returns 400 if the target user has `role: "admin"`.

---

### GET /api/v1/admin/simulations

List all simulations across all users. Optionally filter by userId.

**Auth required:** Bearer token + Admin role

**Query parameters:**
| Param | Type | Description |
|---|---|---|
| `userId` | string | Filter simulations by a specific user's ID |

**Responses:**
| Status | Description |
|---|---|
| 200 | List of simulations |
| 403 | Admin access required |

---

### DELETE /api/v1/admin/simulations/:id

Delete any simulation regardless of ownership.

**Auth required:** Bearer token + Admin role

**Path parameters:**
| Param | Type | Description |
|---|---|---|
| `id` | string | MongoDB ObjectId of the simulation |

**Responses:**
| Status | Description |
|---|---|
| 200 | Simulation deleted successfully |
| 404 | Simulation not found |

---

### GET /api/v1/admin/queue

Get real SQS queue metrics for the simulation job queue.

**Auth required:** Bearer token + Admin role

**Responses:**
| Status | Description |
|---|---|
| 200 | Real queue metrics (depth, in-flight, delayed, oldest message age) |
| 503 | SQS queue not configured (`SQS_QUEUE_URL` missing) |

**Example response:**
```json
{
  "queue": {
    "queueUrl": "https://sqs.ap-southeast-1.amazonaws.com/727974229118/DE-Queue",
    "approximateNumberOfMessages": 3,
    "approximateNumberOfMessagesNotVisible": 1,
    "approximateNumberOfMessagesDelayed": 0,
    "oldestMessageAge": 42
  }
}
```

**Example 503 response:**
```json
{
  "message": "SQS queue not configured (SQS_QUEUE_URL missing)",
  "queue": null
}
```

---

## Health Check

### GET /api/v1/health

Check the server and database status. No authentication required.

**Responses:**
| Status | Description |
|---|---|
| 200 | Server is running |

**Example response:**
```json
{
  "status": "OK",
  "database": "connected",
  "uptime": 3600.5,
  "timestamp": "2026-07-13T13:00:00.000Z"
}
```

**Database states:**
| Value | Description |
|---|---|
| `connected` | MongoDB connection is active |
| `disconnected` | MongoDB is not connected |
| `connecting` | Connection in progress |
| `disconnecting` | Disconnection in progress |
| `unknown` | Unrecognized state |

---

## Error Codes Summary

| Status | Description | When |
|---|---|---|
| 200 | OK | Successful GET, PATCH, POST (logout, refresh) |
| 201 | Created | Successful register, simulation create |
| 400 | Bad Request | Zod validation, import parse errors, unsupported upload type, suspending an admin |
| 401 | Unauthorized | Missing/invalid JWT or refresh token, wrong login or current password |
| 403 | Forbidden | Suspended user, admin access required, another user's resource |
| 404 | Not Found | User or simulation not found |
| 409 | Conflict | Email already registered or in use, cancelling a terminal simulation |
| 503 | Service Unavailable | `GET /admin/queue` with no `SQS_QUEUE_URL` configured |
| 500 | Internal Server Error | Unhandled server errors |

Ownership is checked **after** existence, so another user's simulation id yields `403`
while an unknown id yields `404`.
