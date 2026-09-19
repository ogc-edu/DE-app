# DE Research Dashboard Backend — Documentation

Complete documentation for the Differential Evolution Research Dashboard backend API.

## Table of Contents

| Document | Description |
|---|---|
| [PRD](./PRD.md) | Product requirements, user stories, implementation & testing decisions (backlog source of truth) |
| [Context](./context.md) | Living codebase context: layout, API surface, auth flow, conventions, gotchas |
| [Implementation Plan](./IMPLEMENTATION_PLAN.md) | Approved master plan for remaining work (001–004) and decisions log |
| [Feature Plans](./plans/) | Per-feature implementation plans: `001-repo-health-baseline.md`, `002-refresh-token-hardening.md`, `003-api-error-semantics-fix.md`, `004-documentation-baseline-refresh.md` |
| [Setup Guide](./setup.md) | Installation, environment variables, Docker, running the server |
| [Architecture](./architecture.md) | Project structure, design decisions, request lifecycle |
| [Authentication](./authentication.md) | JWT auth flow, refresh token rotation, role-based access |
| [API Reference](./api-reference.md) | All endpoints with request/response examples |
| [Database Models](./models.md) | DynamoDB tables, keys, GSIs, item shapes (⚠️ still describes the old Mongoose schemas — see repo root `CLAUDE.md`) |
| [Middleware](./middleware.md) | Auth, admin, validation, error handling, logging |
| [Testing](./testing.md) | Test structure, running tests, coverage |

## Quick Links

- **Swagger UI**: `http://localhost:3000/api/v1/docs` (interactive API docs when server is running)
- **Health Check**: `http://localhost:3000/api/v1/health`
- **Base URL**: `http://localhost:3000/api/v1`

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express 5 |
| Database | Amazon DynamoDB (AWS SDK v3, no ODM) |
| Auth | JWT (jsonwebtoken) + bcrypt; refresh tokens hashed at rest |
| Validation | Zod 4 |
| Logging | Winston + Morgan |
| Security | Helmet, CORS, httpOnly cookies |
| API Docs | Swagger/OpenAPI 3.0 |
| Testing | Jest 30 + Supertest 7 (107 tests, 6 suites) |
| Containerization | Docker (multi-stage, Node 20 slim) |

## API Versioning

All routes are versioned under `/api/v1`. Future versions will use `/api/v2`, etc.

## Overview

This backend serves a research dashboard for comparing Differential Evolution (DE) algorithm variants across benchmark fitness functions. Researchers configure experiments (benchmark functions, mutation schemes, crossover operators, selection methods), and the system computes all model combinations as a Cartesian product. Results are stored as a grid of lowest fitness values per model per function.

### Core Features

- **User authentication** — JWT access tokens (1h) + refresh token rotation (7d) via httpOnly cookies
- **Role-based access control** — `user` (researcher) and `admin` roles enforced at route level
- **Simulation management** — create, list (paginated), retrieve, cancel, delete, and view results
- **Admin oversight** — list all users (paginated), suspend/activate users, view all simulations, delete any simulation, queue status
- **User profile** — view profile, update username/email, change password
- **Input validation** — Zod schemas on all mutation endpoints
- **Structured logging** — Winston logger with file + console transports
- **API documentation** — Swagger UI auto-generated from JSDoc annotations
- **Dockerized** — multi-stage Dockerfile + docker-compose with DynamoDB Local
