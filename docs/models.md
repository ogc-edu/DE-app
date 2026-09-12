# Database Models

Both models use Mongoose with the `timestamps: true` option, which automatically manages `createdAt` and `updatedAt` fields.

---

## User Model

**Collection name:** `users`
**File:** `models/user.js`

### Schema Fields

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `username` | String | yes | — | 3–50 chars, trimmed |
| `email` | String | yes | — | unique, regex-validated, lowercased, trimmed |
| `password` | String | yes | — | min 6 chars, `select: false` (never returned in queries), hashed by pre-save hook |
| `isVerified` | Boolean | no | `false` | Email verification (deferred per PRD — never read by any code path) |
| `role` | String | no | `"user"` | Enum: `"admin"`, `"user"` |
| `isActive` | Boolean | no | `true` | Suspended users cannot login or access protected routes |
| `refreshTokenHash` | String | no | `null` | `select: false`; SHA-256 hex digest of the current refresh token — never the token itself |
| `profilePicture` | String | no | `null` | Public S3 object URL, set via the presign + confirm flow |
| `affiliation` | String | no | `""` | Free-text institution, trimmed; accepted at register and profile update |
| `simulationCount` | Number | no | `0` | Declared but never incremented by any code path |
| `createdAt` | Date | auto | `Date.now` | Managed by `timestamps: true`, immutable |
| `updatedAt` | Date | auto | `Date.now` | Managed by `timestamps: true`, auto-updated on save |

### Indexes

| Field | Index Type | Reason |
|---|---|---|
| `email` | unique | Prevents duplicate registrations, fast lookup on login |

### Static Methods

#### `User.login(email, password)`

Authenticates a user by email and password.

**Flow:**
1. Find user by email, selecting `+password +isActive`
2. If user not found → throw `UnauthorizedError("Invalid email or password")` (401)
3. If `isActive === false` → throw `ForbiddenError("Account has been suspended")` (403)
4. Compare password with bcrypt hash
5. If mismatch → throw `UnauthorizedError("Invalid email or password")` (401)
6. Return user document

**Returns:** User document (with password field loaded)

#### `User.register(username, email, password)`

Creates a new user account.

**Flow:**
1. Validate all fields are present → `BadRequestError` (400)
2. Check for existing email → throw `ConflictError("User already exists")` (409)
3. Validate password length ≤ 12 chars → `BadRequestError` (400)
4. Create user document (triggers pre-save hook for password hashing)

**Returns:** Created user document

### Instance Methods

#### `user.generateJwtToken()`

Generates a short-lived access token.

**Payload:** `{ userId: this._id.toString() }`
**Secret:** `JWT_SECRET`
**Expiry:** 1 hour

**Returns:** JWT string

#### `user.generateRefreshToken()`

Generates a long-lived refresh token with a unique `jti` claim to ensure each token is distinct (prevents identical tokens when issued in the same second).

**Payload:** `{ userId, jti: Date.now() + random }`
**Secret:** `JWT_REFRESH_SECRET`
**Expiry:** 7 days

**Returns:** JWT string

#### `user.saveRefreshToken(token)`

Hashes the raw token with SHA-256 and stores the digest in `refreshTokenHash`, then
saves. Used during login and token rotation. The raw token is never persisted.

**Returns:** Saved user document

#### `user.clearRefreshToken()`

Sets `refreshTokenHash` to `null` and saves. Used during logout; suspension and
password change null the field directly so they can save once alongside their own
changes.

**Returns:** Saved user document

#### `User.hashRefreshToken(token)` (static)

Returns the SHA-256 hex digest of a raw refresh token. Exposed so `/refresh` can hash
the presented cookie and compare it with `crypto.timingSafeEqual`.

**Returns:** 64-character hex string

### Middleware (Hooks)

#### `pre("save")`

Automatically hashes the password with bcrypt (salt rounds: 10) before saving. Only runs when the password field has been modified.

```js
if (!this.isModified("password")) return;
const salt = await bcrypt.genSalt(10);
this.password = await bcrypt.hash(this.password, salt);
```

---

## Simulation Model

**Collection name:** `simulations`
**File:** `models/simulation.js`

### Schema Fields

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `userId` | ObjectId | yes | — | Ref: `User`, indexed |
| `simulationData` | Array<Subdoc> | no | `[]` | Results grid, populated by EC2 workers |
| `status` | String | yes | `"pending"` | Enum: `pending`, `running`, `completed`, `failed`, `cancelled`. Indexed. Workers set `running` |
| `functions` | Number[] | yes | — | Integer array, values 1–10 |
| `methods.mutation` | Number[] | yes | — | Integer array, values 1–10 |
| `methods.crossover` | Number[] | yes | — | Integer array, values 1–4 |
| `methods.selection` | Number[] | yes | — | Integer array, values 1–2 |
| `totalModels` | Number | yes | `0` | Computed on create: Cartesian product of all arrays |
| `completedModels` | Number | no | `0` | Updated by workers as models complete |
| `progress` | Number | no | `0` | 0–100 percentage |
| `np` | Number | no | `15` | DE population size, 10–40 |
| `f` | Number | no | `0.5` | DE scaling factor, 0.1–2.0 |
| `cr` | Number | no | `0.9` | DE crossover rate, 0.01–1.0 |
| `gen` | Number | no | `1000` | Generations, ≥ 1 |
| `dim` | Number | no | `30` | Problem dimensionality, 1–30 (matches the `de.cpp` limit) |
| `createdAt` | Date | auto | `Date.now` | Managed by `timestamps: true` |
| `updatedAt` | Date | auto | `Date.now` | Managed by `timestamps: true` |

### simulationData Subdocument Schema

Each element in the `simulationData` array represents one model combination:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `functionId` | Number | yes | — | Benchmark function ID (1–10) |
| `mutationId` | Number | yes | — | Mutation scheme ID (1–10) |
| `crossoverId` | Number | yes | — | Crossover operator ID (1–4) |
| `selectionId` | Number | yes | — | Selection method ID (1–2) |
| `lowestFitness` | Number | no | `null` | Lowest fitness value found by the worker for this combination |

### Indexes

| Field | Index Type | Reason |
|---|---|---|
| `userId` | standard | Fast lookup when listing a user's simulations |
| `status` | standard | Fast filtering by status (admin dashboard, user filtering) |

### Validators

The `isIntegerArray` custom validator ensures all arrays:
- Are not empty (length > 0)
- Contain only integers

```js
const isIntegerArray = (arr) => arr.length > 0 && arr.every(Number.isInteger);
```

### Static Methods

#### `Simulation.createSimulation(userId, functions, methods, params)`

Creates a new simulation with `totalModels` computed from the Cartesian product.
`params` carries the DE knobs (`np`, `f`, `cr`, `gen`, `dim`); each falls back to its
schema default when omitted, so a direct model call persists a complete job spec.

**Calculation:**
```
totalModels = functions.length × methods.mutation.length × methods.crossover.length × methods.selection.length
```

**Returns:** Created simulation document

#### `Simulation.getSimulation(userId, options)`

Retrieves simulations for a user with optional pagination and status filtering.

**Parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `userId` | ObjectId | — | Required: filter by user |
| `options.page` | Number | 1 | Page number (used when limit > 0) |
| `options.limit` | Number | 0 | Items per page (0 = return all) |
| `options.status` | String | — | Filter by status enum |

**Returns:**
- With pagination (`limit > 0`): `{ simulations, simulationCount, currentPage, totalPages }`
- Without pagination: `{ simulations, simulationCount }`

#### `Simulation.getSimulationById(id)`

Retrieves a single simulation by its ObjectId.

**Returns:** Simulation document or `null`

#### `Simulation.deleteSimulation(userId, simulationId)`

Deletes a simulation after verifying ownership.

**Flow:**
1. Find simulation by ID → throw `NotFoundError("Simulation not found")` (404)
2. Check `simulation.userId` matches `userId` → throw `ForbiddenError("Unauthorized")` (403) if mismatch
3. Delete the document

**Returns:** Deleted simulation's `_id` as string

#### `Simulation.cancelSimulation(userId, simulationId)`

Cancels a simulation by setting `status: "cancelled"` after verifying ownership. Uses `{ new: true }` option. `updatedAt` is auto-managed by `timestamps: true`.

**Flow:**
1. Find simulation by ID → throw `NotFoundError("Simulation not found")` (404)
2. Ownership mismatch → throw `ForbiddenError("Unauthorized")` (403)
3. Status is not `pending` or `running` → throw
   `ConflictError('Cannot cancel a simulation in "<status>" status')` (409), so a
   terminal result is never overwritten by a late cancel

**Returns:** Cancelled simulation's `_id` as string

#### `Simulation.importSimulation(userId, data)`

Persists a user-uploaded results file as an already-`completed` simulation
(`progress: 100`, `completedModels === totalModels`). No SQS job is enqueued —
imported data is final. `totalModels` is the number of parsed rows.

**Returns:** Created simulation document

---

## Entity Relationship

```
User (users collection)
  |
  | 1 : N
  |
  v
Simulation (simulations collection)
  |
  | userId → User._id (ref)
  |
  | simulationData[]
  |   └── { functionId, mutationId, crossoverId, selectionId, lowestFitness }
```

A user can have zero or many simulations. Each simulation belongs to exactly one user. The `userId` field on the Simulation model stores an ObjectId reference to the User model's `_id` field.
