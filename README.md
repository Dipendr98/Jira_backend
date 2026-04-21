# Project Management Platform API

A production-grade backend for a **Jira-like project management tool** built with **Node.js**, **TypeScript**, **Fastify**, **PostgreSQL**, and **Socket.io**.

> ✅ All 11 sample API endpoints verified working  
> ✅ Scenarios 1, 2, 3 tested and passing  
> ✅ TypeScript strict mode — zero compilation errors  
> ✅ Docker + docker-compose for local development

---

## Live Demo

| Service | URL |
|---|---|
| **API Base URL** | `https://jirabackend-production-81ac.up.railway.app/` |
| **Swagger UI (Interactive Docs)** | `https://jirabackend-production-81ac.up.railway.app/docs` |
| **Health Check** | `https://jirabackend-production-81ac.up..railway.app/health` |

---

## Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| Runtime | Node.js 20 + TypeScript | Type safety, great ecosystem |
| Framework | Fastify | 2x faster than Express, built-in schema validation |
| Database | PostgreSQL 15 | Strong relational model, ACID transactions |
| ORM | Prisma | Type-safe queries, auto migrations, clean schema DSL |
| Real-time | Socket.io | WebSocket with reconnection + room support |
| Auth | JWT (fastify-jwt) | Stateless, scalable, industry standard |
| Docs | Swagger / OpenAPI | Auto-generated from route schemas |
| Container | Docker + Compose | Reproducible local dev and deployment |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                  Client (Browser / App)                   │
│          REST API calls + WebSocket connection            │
└─────────────┬────────────────────────────┬───────────────┘
              │ HTTP                        │ WS
              ▼                             ▼
┌─────────────────────────┐   ┌────────────────────────────┐
│   Fastify REST API      │   │     Socket.io Server        │
│                         │   │                             │
│  /api/auth              │   │  Events:                    │
│  /api/projects          │   │  • issue_created            │
│  /api/issues            │   │  • issue_updated            │
│  /api/sprints           │   │  • issue_moved              │
│  /api/comments          │   │  • comment_added            │
│  /api/search            │   │  • sprint_started           │
│  /api/notifications     │   │  • presence_updated         │
│  /api/workflow          │   │                             │
└───────────┬─────────────┘   └──────────────┬─────────────┘
            │                                │
            ▼                                ▼
┌───────────────────────────────────────────────────────────┐
│                     Prisma ORM Layer                       │
│   • Type-safe queries     • Auto migrations                │
│   • Transaction support   • Relation loading              │
└──────────────────────────┬────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────┐    ┌────────────────────────┐
│    PostgreSQL 15     │    │       Redis 7           │
│                      │    │                         │
│  Users, Projects    │    │  WebSocket presence      │
│  Issues, Sprints    │    │  tracking (online users) │
│  Activity Logs      │    │                         │
│  Workflow tables    │    └────────────────────────┘
└─────────────────────┘
```

---

## Quick Start

### Option 1: Docker (Recommended — one command)

```bash
git clone https://github.com/Dipendra98/jira-backend-v2
cd jira-backend-v2

cp .env.example .env

docker-compose up --build
```

API runs at `http://localhost:3000` | Docs at `http://localhost:3000/docs`

---

### Option 2: Local Development

```bash
# 1. Clone & install
git clone https://github.com/YOUR_USERNAME/jira-backend-v2
cd jira-backend-v2
npm install

# 2. Start PostgreSQL and Redis via Docker
docker-compose up postgres redis -d

# 3. Set up environment
cp .env.example .env
# .env already pre-filled for Docker defaults — no changes needed

# 4. Push database schema
npm run db:push

# 5. Seed with demo data
npm run db:seed

# 6. Start dev server (auto-restarts on file changes)
npm run dev
```

Server: `http://localhost:3000`  
Swagger Docs: `http://localhost:3000/docs`  
Prisma Studio: `npm run db:studio` → `http://localhost:5555`

---

## Project Structure

```
jira-backend-v2/
├── src/
│   ├── app.ts                        # Fastify app entry point
│   ├── middleware/
│   │   └── auth.ts                   # JWT authentication middleware
│   ├── config/
│   │   └── prisma.ts                 # Singleton PrismaClient
│   ├── websocket/
│   │   └── socket.ts                 # Socket.io setup + event handlers
│   └── modules/                      # Feature modules (Route → Service → DB)
│       ├── auth/
│       │   └── users.routes.ts       # POST /auth/register, /auth/login, /me
│       ├── projects/
│       │   └── projects.routes.ts    # Projects, board, activity, members
│       ├── issues/
│       │   ├── issues.routes.ts      # CRUD, transitions, watchers
│       │   └── issues.service.ts     # Business logic, optimistic locking
│       ├── sprints/
│       │   └── sprints.routes.ts     # Sprint lifecycle + carry-over logic
│       ├── comments/
│       │   └── comments.routes.ts    # Threaded comments + @mentions
│       ├── search/
│       │   └── search.routes.ts      # Full-text + structured filters
│       ├── notifications/
│       │   └── notifications.routes.ts
│       └── workflow/
│           └── workflow.routes.ts    # Workflow config, transitions
├── prisma/
│   ├── schema.prisma                 # Complete database schema
│   ├── seed.ts                       # Demo data seeder
│   └── migrations/                   # Auto-generated migration files
├── docker-compose.yml                # PostgreSQL + Redis + API
├── Dockerfile                        # Production container
├── .env.example                      # Environment template
└── tsconfig.json
```

---

## API Documentation

Interactive Swagger UI: `http://localhost:3000/docs`

### Authentication

All endpoints require a Bearer JWT token (except register/login).

```bash
# Register
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"pass123","displayName":"Alice"}'

# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"pass123"}'
# → returns { token: "eyJhbG..." }

export TOKEN="eyJhbG..."
```

### Sample Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register user |
| POST | `/api/auth/login` | Login, get JWT |
| GET | `/api/me` | Get current user profile |
| POST | `/api/projects` | Create project (auto-creates workflow) |
| GET | `/api/projects/:id/board` | Kanban board with columns + issues |
| POST | `/api/projects/:id/issues` | Create issue (auto-generates issueKey) |
| PATCH | `/api/issues/:id` | Update issue (optimistic locking via `expectedVersion`) |
| POST | `/api/issues/:id/transitions` | Move issue status (workflow enforced) |
| GET | `/api/projects/:id/sprints` | List all sprints |
| POST | `/api/projects/:id/sprints` | Create sprint |
| POST | `/api/sprints/:id/start` | Start sprint (status → ACTIVE) |
| GET | `/api/sprints/:id/incomplete` | List incomplete issues before completing |
| POST | `/api/sprints/:id/complete` | Complete sprint with carry-over |
| GET | `/api/issues/:id/comments` | List comments |
| POST | `/api/issues/:id/comments` | Add comment (@mentions trigger notifications) |
| GET | `/api/projects/:id/activity` | Full audit trail feed |
| GET | `/api/search?q=...` | Full-text + filter search |
| GET | `/api/notifications` | User notifications |
| PATCH | `/api/notifications/:id/read` | Mark notification as read |

---

## Key Scenarios Verified

### Scenario 1: Concurrent Updates (Optimistic Locking)
```bash
# Two users update the same issue simultaneously
# First update succeeds:
PATCH /api/issues/:id  { "title": "New Title", "expectedVersion": 1 }  → 200

# Second update with stale version is rejected:
PATCH /api/issues/:id  { "title": "Other Title", "expectedVersion": 1 } → 409 Conflict
# Error: "Conflict: Issue was updated by another user"
```

### Scenario 2: Sprint Completion with Carry-Over
```bash
# See what's incomplete
GET /api/sprints/:id/incomplete
# → { incomplete: [...], totalIncompletePoints: 10 }

# Complete sprint, selectively carry over issues
POST /api/sprints/:id/complete
{ "carryOverIssueIds": ["id1", "id2"], "nextSprintId": "sprint-2" }
# → { summary: { velocity: 4, carriedOver: 2, movedToBacklog: 1 } }
```

### Scenario 3: Workflow Violation
```bash
# Attempt illegal transition (To Do → Done)
POST /api/issues/:id/transitions { "toStatusId": "<done-id>" }
# → 422 Unprocessable Entity
# { "error": "Workflow violation: Cannot move from \"To Do\" to requested status" }
```

---

## WebSocket Integration

```javascript
import { io } from 'socket.io-client'

const socket = io('http://localhost:3000', {
  auth: { userId: 'your-user-id' }
})

// Join a project room
socket.emit('join_project', 'project-id')

// Real-time events
socket.on('issue_created',   (issue) => { /* update board */ })
socket.on('issue_updated',   ({ issue }) => { /* refresh card */ })
socket.on('issue_moved',     ({ issue, fromStatus, toStatus }) => { /* move column */ })
socket.on('comment_added',   ({ issueId, comment }) => { /* show comment */ })
socket.on('sprint_started',  ({ sprint }) => { /* update sprint panel */ })
socket.on('presence_updated',({ onlineUsers }) => { /* show online avatars */ })
```

---

## Environment Variables

```env
DATABASE_URL="postgresql://postgres:password@localhost:5433/jira_db"
JWT_SECRET="your-super-secret-key"
REDIS_URL="redis://localhost:6379"
PORT=3000
NODE_ENV="development"
```

---

## NPM Scripts

```bash
npm run dev          # Start dev server with hot-reload
npm run build        # Compile TypeScript
npm run start        # Run compiled production build
npm run db:push      # Push schema to DB (no migration files)
npm run db:migrate   # Create & run migration
npm run db:seed      # Seed database with demo data
npm run db:studio    # Open Prisma Studio GUI
```

---

## Design Decisions & Trade-offs

See [DESIGN.md](./DESIGN.md) for full architecture decisions, ERD, and trade-offs.

---

## What I'd Add With More Time

1. Redis pub/sub for multi-instance WebSocket sync
2. `pg_trgm` GIN indexes for production full-text search
3. Rate limiting (`@fastify/rate-limit`)
4. Email notifications via SendGrid/Resend
5. File attachments on issues (S3/R2)
6. Comprehensive Jest + Supertest test suite
7. GitHub Actions CI/CD pipeline
