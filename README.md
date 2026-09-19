# Differential Evolution Research Dashboard Backend

A Dockerized Express 5 backend that accepts simulation parameter sets from researchers, queues them for processing by EC2 workers, and stores results (per-model-per-function lowest fitness values) to Amazon DynamoDB with real-time progress tracking.

## Quick Start

```bash
# Install dependencies
npm install

# Create .env (see docs/setup.md for details)
cp .env.example .env  # or create manually

# Start DynamoDB Local and create the tables
docker compose up -d dynamodb
npm run db:create

# Start development server
npm run dev

# Or start everything with Docker Compose
docker-compose up --build
```

The server runs on `http://localhost:3000`.
Swagger UI available at `http://localhost:3000/api/v1/docs`.

## Documentation

Full documentation is available in the [`docs/`](./docs/) directory:

| Document | Description |
|---|---|
| [PRD](./docs/PRD.md) | Product requirements, user stories, implementation decisions |
| [Context](./docs/context.md) | Living codebase context: layout, API surface, conventions, gotchas |
| [Implementation Plan](./docs/IMPLEMENTATION_PLAN.md) | Master plan for the 001-004 work and the decisions log |
| [Feature Plans](./docs/plans/) | Per-feature plans (001 repo health, 002 refresh tokens, 003 error semantics, 004 docs) |
| [Setup Guide](./docs/setup.md) | Installation, environment variables, Docker |
| [Architecture](./docs/architecture.md) | Project structure, design decisions, request lifecycle |
| [Authentication](./docs/authentication.md) | JWT auth flow, refresh token rotation, RBAC |
| [API Reference](./docs/api-reference.md) | All endpoints with request/response examples |
| [Database Models](./docs/models.md) | DynamoDB tables, keys, GSIs, item shapes (⚠️ still describes the old Mongoose schemas — see `CLAUDE.md`) |
| [Middleware](./docs/middleware.md) | Auth, admin, validation, error handling, logging |
| [Testing](./docs/testing.md) | Test structure, running tests, coverage |

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express 5 |
| Database | Amazon DynamoDB (AWS SDK v3, no ODM) |
| Auth | JWT + bcrypt + refresh token rotation (hashed at rest) |
| Validation | Zod 4 |
| Logging | Winston + Morgan |
| Security | Helmet, CORS, httpOnly cookies |
| API Docs | Swagger/OpenAPI 3.0 |
| Testing | Jest 30 + Supertest 7 (107 tests, 6 suites) |
| Containerization | Docker (multi-stage, Node 20 slim) |

## API Overview

All routes are versioned under `/api/v1`.

| Endpoint Group | Auth | Description |
|---|---|---|
| `/api/v1/register`, `/login`, `/verify`, `/refresh`, `/logout` | — | Authentication |
| `/api/v1/user/profile`, `/user/password` | Bearer token | User profile management |
| `/api/v1/simulation/*` | Bearer token | Simulation CRUD, results, and `.txt` data import |
| `/api/v1/admin/*` | Bearer token + Admin | Admin oversight |
| `/api/v1/health` | — | Health check |
| `/api/v1/docs` | — | Swagger UI |

See the [API Reference](./docs/api-reference.md) for complete details.

## npm Scripts

```bash
npm start              # Start production server
npm run dev            # Start dev server (nodemon hot-reload)
npm test               # Run all tests -- requires DynamoDB Local:
                       #   docker compose up -d dynamodb   (container de-dynamodb, port 8000)
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Run tests with coverage report
```

## Project Structure

```
├── app.js              # Express app (middleware, routes)
├── server.js           # Server entry point
├── config/             # Database, logger, S3 and SQS clients
├── controllers/        # Route handlers (auth, simulation, admin, user)
├── middleware/         # auth, admin, validation, error handling
├── models/             # DynamoDB data-access facades (User, Simulation) — no ODM
├── routes/             # Express routers (auth, simulation, admin, user)
├── validators/         # Zod validation schemas
├── utils/              # importParser (.txt import format) + typed HTTP errors
├── docs/               # Documentation + Swagger config
├── tests/              # Jest + Supertest test suites
├── Dockerfile          # Production image
├── Dockerfile.dev      # Development image
└── docker-compose.yml  # DynamoDB Local + backend services
```

See [Architecture](./docs/architecture.md) for detailed breakdown.

## DE Models Compared

The dashboard compares up to 80 different Differential Evolution models by combining:
- 10 mutation schemes (1–10)
- 4 crossover operators (1–4)
- 2 selection methods (1–2)

Across 10 benchmark fitness functions (1–10), the system computes all combinations as a Cartesian product and stores the lowest fitness value for each model per function.
