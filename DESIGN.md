# Design Documentation

## Architecture Decisions

---

### 1. Why Fastify over Express?

**Decision**: Use Fastify as the HTTP framework.

**Reasons**:
- **~2x faster throughput** than Express (benchmarked at 30k+ req/sec vs ~15k)
- **Built-in JSON Schema validation** on every route — validation errors are caught before your handler runs, eliminating defensive `if (!body.field)` checks
- **Auto-generates Swagger/OpenAPI** from route schemas — zero extra documentation effort
- **TypeScript-first** with full type inference on request/reply

**Trade-off**: Smaller ecosystem than Express. Some middleware packages don't have Fastify versions yet (e.g., Passport.js requires workarounds).

---

### 2. Why Prisma over raw SQL or Knex?

**Decision**: Use Prisma ORM with generated TypeScript client.

**Reasons**:
- **Compile-time type safety** — schema mismatches (wrong field name, wrong type) are caught by TypeScript before the server starts
- **Auto migrations** — `prisma migrate dev` generates idempotent SQL migration files from schema changes
- **Clean schema DSL** — the `schema.prisma` file is a single source of truth for both the DB shape and TypeScript types
- **Relation loading** — `include: { assignee: true, status: true }` replaces 5-table JOIN with clean syntax

**Trade-off**: Prisma generates slightly less optimal SQL than hand-tuned raw queries for very complex aggregations. For the `velocity` calculation in sprint completion, a raw SQL `SUM()` would be faster at scale — currently using `reduce()` in JS.

---

### 3. Workflow Engine: Transition Table Design

**Decision**: Store allowed transitions as database rows, not hardcoded `if/else` logic.

**Implementation**:
```
workflow_statuses: [To Do, In Progress, In Review, Done]
status_transitions: [
  (To Do → In Progress),
  (In Progress → In Review),
  (In Review → Done),
  (In Review → In Progress)   ← send back for rework
]
```

**Checking a transition** = single DB query:
```sql
SELECT id FROM status_transitions
WHERE fromStatusId = ? AND toStatusId = ?
```
If no row → 422 Workflow Violation.

**Why this design**:
- Workflows are **fully configurable per project** without code changes
- Adding a new transition = inserting one DB row
- Supports **auto-actions** (JSON field on the transition): e.g., auto-assign reviewer when moving to "In Review"
- Validation rules (e.g., "must have assignee before In Review") are stored as JSON in the `autoAction` field

**Trade-off**: Two DB queries per transition (fetch transition row + validate rules) instead of one. Acceptable latency for this use case.

---

### 4. Optimistic Locking for Concurrent Updates

**Decision**: Use a `version` integer field on issues for optimistic concurrency control.

**How it works**:
1. Client fetches issue — gets `version: 3`
2. Client sends `PATCH /issues/:id` with `{ expectedVersion: 3, title: "New" }`
3. Server checks: `WHERE id = ? AND version = 3`
4. If match → update + increment version to 4 → return 200
5. If no match (another user updated first) → return **409 Conflict**

**Why not pessimistic locking (SELECT FOR UPDATE)**:
- Pessimistic locks block all readers, not just writers
- In a web API with many concurrent users, this creates significant blocking
- Optimistic locking only "locks" when a conflict actually occurs, which is the minority case

**Trade-off**: Client must retry on 409. Requires UI to handle conflict gracefully (show "someone else updated this, reload?").

---

### 5. Cursor-Based Pagination

**Decision**: All list endpoints use cursor-based pagination, not page numbers.

**Why**:
```
Page 1: items 1-20
→ Someone inserts item between item 10 and 11
Page 2: items 21-40  ← item 11 is now on page 1 AND page 2 (duplicate!)
```

Cursor pagination uses the last seen ID as a stable anchor:
```
GET /api/search?q=bug&cursor=<last-id>&limit=20
```
No duplicates, works correctly under concurrent writes, scales to millions of rows.

**Trade-off**: Cannot jump to page 5 directly. Must paginate sequentially. Acceptable for most real-time feeds and search results.

---

### 6. Activity Log as Append-Only

**Decision**: `activity_logs` table is insert-only. Never updated or deleted.

**Why**:
- **Full audit trail** — every field change logged with `oldValue` / `newValue`
- **Tamper-proof** — useful for compliance (who changed what, when)
- **Debug-friendly** — can replay the full history of any issue

**Event types logged**:
- `issue_created`, `status_changed`, `assignee_changed`
- `priority_changed`, `title_changed`, `sprint_changed`
- `comment_added`, `sprint_started`, `sprint_completed`
- `sprint_carry_over`, `issue_moved_to_backlog`

**Trade-off**: Table grows indefinitely. Would add archival/partitioning by month in production.

---

### 7. WebSocket Architecture

**Decision**: Socket.io with project-based rooms, not per-issue subscriptions.

**Room design**:
```
project:{projectId}  ← all board updates
                     ← presence tracking
                     ← sprint events
```

Instead of `issue:{issueId}` rooms (which would require clients to track N subscriptions), clients join one project room and receive all updates for that board.

**Presence tracking**: Uses Redis to store `{userId: socketId}` mapping per project. When a user goes offline (disconnect), their presence is removed from Redis and `presence_updated` is broadcast.

**Trade-off**: Single-instance only. For horizontal scaling (multiple Node processes), would need `@socket.io/redis-adapter` so Socket.io events are broadcast across all instances.

---

## Database Schema Diagram (ERD)

```
┌──────────────────────┐
│        users         │
├──────────────────────┤
│ id (PK, uuid)        │
│ email (unique)       │
│ password (hashed)    │
│ displayName          │
│ avatarUrl            │
│ createdAt            │
└──────┬───────────────┘
       │ 1
       │ has many
       ▼ N
┌──────────────────────┐         ┌──────────────────────┐
│   project_members    │         │       projects        │
├──────────────────────┤         ├──────────────────────┤
│ id (PK)              │◄────────│ id (PK, uuid)         │
│ userId (FK→users)    │         │ key (unique, e.g PROJ)│
│ projectId (FK→proj)  │         │ name                  │
│ role (OWNER/ADMIN/   │         │ description           │
│       MEMBER/VIEWER) │         │ issueSequence         │
│ joinedAt             │         │ createdAt             │
└──────────────────────┘         └──────┬───────────────┘
                                         │ 1
                    ┌────────────────────┼──────────────────────┐
                    │                    │                       │
                    ▼ N                  ▼ N                     ▼ N
       ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
       │  workflow_statuses  │  │      sprints        │  │       issues       │
       ├────────────────────┤  ├────────────────────┤  ├────────────────────┤
       │ id (PK)            │  │ id (PK)            │  │ id (PK)            │
       │ name               │  │ name               │  │ issueKey (unique)  │
       │ color              │  │ goal               │  │ type (EPIC/STORY/  │
       │ position           │  │ status (PLANNED/   │  │       TASK/BUG/    │
       │ isDefault          │  │   ACTIVE/COMPLETED)│  │       SUBTASK)     │
       │ projectId (FK)     │  │ startDate          │  │ title              │
       └────────┬───────────┘  │ endDate            │  │ description        │
                │              │ projectId (FK)     │  │ priority           │
                │ 1            └────────────────────┘  │ storyPoints        │
                ▼ N                                     │ labels[]           │
       ┌────────────────────┐                          │ version            │
       │ status_transitions  │                          │ parentId (FK self) │
       ├────────────────────┤                          │ projectId (FK)     │
       │ id (PK)            │                          │ statusId (FK)      │
       │ fromStatusId (FK)  │                          │ assigneeId (FK)    │
       │ toStatusId (FK)    │                          │ reporterId (FK)    │
       │ autoAction (JSON)  │                          │ sprintId (FK, null)│
       └────────────────────┘                          └────────┬───────────┘
                                                                │ 1
                    ┌───────────────────────────────────────────┤
                    │                    │                       │
                    ▼ N                  ▼ N                     ▼ N
       ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
       │      comments      │  │   activity_logs    │  │    notifications   │
       ├────────────────────┤  ├────────────────────┤  ├────────────────────┤
       │ id (PK)            │  │ id (PK)            │  │ id (PK)            │
       │ content            │  │ eventType          │  │ type               │
       │ issueId (FK)       │  │ oldValue           │  │ message            │
       │ authorId (FK)      │  │ newValue           │  │ isRead             │
       │ parentId (FK self) │  │ metadata (JSON)    │  │ userId (FK)        │
       │ createdAt          │  │ issueId (FK)       │  │ issueId (FK)       │
       └────────────────────┘  │ projectId (FK)     │  └────────────────────┘
                               │ userId (FK)        │
                               │ createdAt          │
                               └────────────────────┘

       ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
       │   issue_watchers   │  │custom_field_defs   │  │custom_field_values │
       ├────────────────────┤  ├────────────────────┤  ├────────────────────┤
       │ issueId (PK, FK)   │  │ id (PK)            │  │ id (PK)            │
       │ userId (PK, FK)    │  │ name               │  │ value              │
       │ [composite PK]     │  │ fieldType          │  │ issueId (FK)       │
       └────────────────────┘  │ options (JSON)     │  │ fieldId (FK)       │
                               │ required           │  │ [unique:issueId+   │
                               │ projectId (FK)     │  │  fieldId]          │
                               └────────────────────┘  └────────────────────┘
```

---

## Trade-offs Summary

| Decision | What We Optimized For | What We Gave Up |
|---|---|---|
| Fastify over Express | Raw throughput, built-in validation | Ecosystem size |
| Prisma over raw SQL | Developer velocity, type safety | Fine-grained SQL control |
| Transition table workflow | Configurability, no code changes | Extra DB round-trip per transition |
| Optimistic locking | No blocking, high concurrency | Client must handle 409 retry |
| Cursor pagination | Stability under concurrent writes | Random page access |
| Append-only activity log | Full audit trail, tamper-proof | Unbounded table growth |
| Project-room WebSockets | Simple client API | Over-broadcasting (all board events) |
| Single Node process | Simplicity, lower infra cost | Horizontal scaling requires Redis adapter |
| PostgreSQL ILIKE search | Zero extra infra | Slower than Elasticsearch at large scale |

---

## Indexes & Performance

```sql
-- Issues are queried most frequently by:
@@index([projectId])    -- board view, issue lists
@@index([sprintId])     -- sprint board
@@index([assigneeId])   -- "my issues" view
@@index([statusId])     -- column grouping

-- Activity log is append-only, queried by project
@@index([issueId])
@@index([projectId])

-- Comments per issue
@@index([issueId])

-- Notifications per user
@@index([userId])
```

For production at scale, would add:
- `pg_trgm` GIN index on `issues.title` + `issues.description` for fast full-text search
- Composite index `(projectId, statusId)` for board column queries
- Partial index `(userId, isRead) WHERE isRead = false` for unread notification count
