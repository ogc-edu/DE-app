# Setup Guide

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20+ | Required by Express 5 and Dockerfile |
| MongoDB | 7+ | Local install or via Docker Compose |
| Docker | latest | Optional, for containerized deployment |
| npm | 10+ | Comes with Node.js |

## Option 1: Local Development (without Docker)

### 1. Clone the repository

```bash
git clone <repository-url>
cd DE-website-backend
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the committed template and fill in your own secrets:

```bash
cp .env.example .env
```

```env
MONGODB_URI=mongodb://root:password123@localhost:27017/Dashboard-Database?directConnection=true&authSource=admin
JWT_SECRET=your-secure-jwt-secret
JWT_REFRESH_SECRET=your-secure-refresh-secret
DB_NAME=Dashboard-Database
CORS_ORIGIN=http://localhost:3001,http://localhost:5173

# AWS — leave the keys empty to use the default credential chain / EC2 IAM role
AWS_REGION=ap-southeast-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET_NAME=your-profile-picture-bucket
SQS_QUEUE_URL=https://sqs.<region>.amazonaws.com/<account-id>/<queue-name>
```

> Without `SQS_QUEUE_URL`, `POST /simulation/create` still returns 201 but with
> `queued: false` (and marks the simulation `failed`), and `GET /admin/queue` returns 503.

> **Important:** Use strong, random secrets for `JWT_SECRET` and `JWT_REFRESH_SECRET` in production. The `.env` file is gitignored and will not be committed.

### 4. Start MongoDB

MongoDB must run as a **replica set**, and it must have the `root` user the connection
strings authenticate as. The canonical way to get both is the compose service:

```bash
docker compose up -d mongo    # container de-db, port 27017
```

It starts `mongodb/mongodb-atlas-local:8.0.0`, creates `root:password123`, and
auto-initiates the replica set through its healthcheck. This is also the prerequisite
for `npm test`.

`notes.txt` records the equivalent standalone `docker run` under the same container
name. A plain local `mongod` without a replica set (and without that user) will fail
the connection.

### 5. Start the development server

```bash
npm run dev
```

The server starts on `http://localhost:3000` with nodemon hot-reload.

### 6. Verify the server is running

```bash
curl http://localhost:3000/api/v1/health
```

Expected response:
```json
{
  "status": "OK",
  "database": "connected",
  "uptime": 1.5,
  "timestamp": "2026-07-13T13:00:00.000Z"
}
```

---

## Option 2: Docker Compose (recommended for development)

Docker Compose starts both MongoDB and the backend with a single command.

### 1. Configure environment

The `docker-compose.yml` reads from `.env` (see step 3 above). The `MONGODB_URI` is overridden in the compose file to use the Docker network hostname `mongo` instead of `localhost`.

### 2. Start all services

```bash
docker-compose up --build
```

This will:
- Start a MongoDB container (mongodb-atlas-local 8.0.0) with replica set auto-initiation
- Build and start the backend container with hot-reload via nodemon
- Wait for MongoDB health check before starting the backend

### 3. Verify

```bash
curl http://localhost:3000/api/v1/health
```

### 4. Stop services

```bash
docker-compose down
```

To remove the MongoDB data volume:
```bash
docker-compose down -v
```

---

## Option 3: Docker (production build)

### 1. Build the production image

```bash
docker build -t de-backend:latest .
```

The multi-stage Dockerfile:
- **Builder stage:** Copies package.json, runs `npm ci --omit=dev` (production deps only)
- **Final stage:** Copies node_modules and source, runs `node server.js`

### 2. Run the container

```bash
docker run -p 3000:3000 \
  -e MONGODB_URI=mongodb://host.docker.internal:27017/Dashboard-Database \
  -e JWT_SECRET=your-secret \
  -e JWT_REFRESH_SECRET=your-refresh-secret \
  -e DB_NAME=Dashboard-Database \
  -e NODE_ENV=production \
  -e CORS_ORIGIN=https://your-frontend.com \
  de-backend:latest
```

> Replace `host.docker.internal` with your MongoDB host. In production, this would be your MongoDB Atlas URI or EC2 MongoDB instance.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONGODB_URI` | yes | `mongodb://localhost:27017` | MongoDB connection string |
| `MONGODB_URI_TEST` | no | local `de-db` URI | Overrides the connection used by `npm test` |
| `DB_NAME` | no | `Dashboard-Database` | Database name |
| `JWT_SECRET` | yes | — | Secret for signing access tokens |
| `JWT_REFRESH_SECRET` | yes | — | Secret for signing refresh tokens |
| `CORS_ORIGIN` | no | `true` (allow all) | Comma-separated list of allowed origins |
| `PORT` | no | `3000` | Server port |
| `NODE_ENV` | no | `development` | Environment (`production` enables secure cookies) |
| `LOG_LEVEL` | no | `info` | Winston log level (`error`, `warn`, `info`, `debug`) |
| `AWS_REGION` | no | `us-east-1` | Region for the S3 and SQS clients |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | no | — | Leave empty to use the default credential chain / EC2 IAM role |
| `S3_BUCKET_NAME` | no | — | Bucket for profile pictures |
| `SQS_QUEUE_URL` | no | — | Full queue URL for simulation jobs; without it create returns `queued: false` and `/admin/queue` returns 503 |

> `config/s3.js` and `config/sqs.js` read their environment variables **at require
> time**, so these must be set before the app is imported.

---

## npm Scripts

| Script | Command | Description |
|---|---|---|
| `npm start` | `node server.js` | Start production server |
| `npm run dev` | `nodemon server.js` | Start dev server with hot reload |
| `npm test` | `cross-env NODE_ENV=test jest` | Run all tests |
| `npm run test:watch` | `cross-env NODE_ENV=test jest --watch` | Run tests in watch mode |
| `npm run test:coverage` | `cross-env NODE_ENV=test jest --coverage` | Run tests with coverage report |

---

## Creating an Admin User

There is no admin registration endpoint. To create an admin user:

### Via MongoDB Shell

```bash
mongosh "mongodb://root:password123@localhost:27017/Dashboard-Database?directConnection=true&authSource=admin"
```

```js
db.users.updateOne(
  { email: "admin@example.com" },
  { $set: { role: "admin" } }
)
```

### Via Node Script

```bash
node -e "
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/user');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME });
  await User.create({ username: 'admin', email: 'admin@example.com', password: 'adminpass', role: 'admin' });
  console.log('Admin user created');
  await mongoose.connection.close();
})();
"
```

---

## Swagger UI

Once the server is running, access the interactive API documentation at:

```
http://localhost:3000/api/v1/docs
```

This provides a full UI for exploring and testing all API endpoints, including authentication via Bearer token.

---

## Troubleshooting

### MongoDB connection errors

**Error:** `MongoServerSelectionError: connect ECONNREFUSED`
- Ensure MongoDB is running: `docker compose up -d mongo` (container `de-db`)
- Check the `MONGODB_URI` in `.env` matches your MongoDB port

**Error:** `MongoServerError: not running with replication`
- The replica set must be initialized: `rs.initiate(...)` (see step 4 above)

### Port already in use

**Error:** `EADDRINUSE: address already in use :::3000`
- Change the `PORT` in `.env` or stop the process using port 3000

### Cookie not being set in browser

- Ensure `CORS_ORIGIN` includes your frontend URL
- Ensure the frontend sends `credentials: 'include'` in fetch/axios requests
- In production, `secure: true` requires HTTPS

### Tests failing with connection errors

- Ensure MongoDB is running locally
- Tests use `Dashboard-Test-Database` as the database name (separate from dev)
- The test setup in `tests/setup.js` cleans all collections between tests
