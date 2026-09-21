# Audit — Structured Trace of Every State Change (Backend)

> **Status:** Draft — awaiting approval. `plan.md` is a later artifact and does not exist yet.
> **Feature slug:** `audit`
> **Scope:** `backend/` — Express 5 + Prisma 7 + PostgreSQL
> **Counterpart:** [../../../../frontend/specs/features/audit/spec.md](../../../../frontend/specs/features/audit/spec.md)
> **Depends on:** [../authentication/spec.md](../authentication/spec.md) — implemented · [../candidate/spec.md](../candidate/spec.md) — implemented
> **Blocks:** [../pipeline/spec.md](../pipeline/spec.md) · [../interviews/spec.md](../interviews/spec.md) · [../feedback/spec.md](../feedback/spec.md) · [../candidate-access/spec.md](../candidate-access/spec.md)
> **Parent brief:** [../../../../recruitment-pipeline.md](../../../../recruitment-pipeline.md) §6

---

## Goal

1. Give every state-changing action in this API a **row in a table**, written in the same
   transaction as the change itself, so the trace and the change cannot disagree.
2. Record the **actor, the action, the entity, the time and the relevant before/after values** —
   the four questions a hiring manager asks when a candidate disputes how they were assessed.
3. Make the trace **readable by a recruiter over HTTP**, filterable by entity and by action, so
   answering "what happened to this application" is a request rather than a `psql` session.
4. Guarantee the trace **cannot be erased by deleting a user**, and **cannot itself leak** a
   candidate's contact details or the text of an interviewer's notes.
5. Ship the writer, `recordAudit`, as the single way an audit row is created — so the four features
   that follow this one cannot each invent their own.

Success means: a recruiter fetches `GET /api/audit?entityType=APPLICATION&entityId=12` and reads
the complete life of that application — applied, screened, overridden with a reason and a named
recruiter, interviewed, fed back on, hired — with no row missing because a transaction rolled back
half-way, and no candidate phone number anywhere in the response.

---

## Background / Context

The brief asks for this twice, in the requirements and again in the checks:

> Every stage transition, override, and feedback submission should leave a structured trace —
> this is what a hiring manager would ask for if a candidate disputes how they were assessed.
> — §6

> The stage-skip override (§3.3) must be genuinely recorded, not inferred — a test should confirm
> an override without a recorded reason and actor is rejected.
> — §6

And [../../../CLAUDE.md](../../../CLAUDE.md) already states the standing rule this feature makes
true: *"Never rely solely on application logs for business auditing."* Pino writes to stdout, is
redacted, rotates away, and is not queryable. It is an operations tool. A candidate disputing a
rejection is a business question, and it needs a table.

This feature is specified **first among the five remaining** and contains no business rules of its
own. It exists so that pipeline, interviews, feedback and candidates can each say *"and it writes
this audit row, in the same transaction"* and mean something concrete.

### Current state of `backend/`

|                | Today |
| -------------- | ------ |
| Stack | Express 5.2, TypeScript ESM, Prisma 7.10, PostgreSQL, `tsx` for dev, `zod` 4.6 |
| Auth | `requireAuth` (Bearer, one `user.findUnique` per request) → `req.user = { id, role }` |
| Roles | `UserRole { INTERVIEWER, RECRUITER, CANDIDATE }` |
| Models | `User`, `RefreshToken`, `Role`, `Application` |
| Transactions | `prisma.$transaction` called directly in services; **no helper exists** in [`src/lib/prisma.ts`](../../../src/lib/prisma.ts) |
| Logging | pino, `req.log` bound to `requestId`, a `redact` list covering tokens and passwords. Event names are `noun.verb` (`application.created`), **ids only, never names or emails** |
| Error envelope | flat `{ code, message, details? }` from [`src/middleware/errorHandler.ts`](../../../src/middleware/errorHandler.ts) |
| Pagination | `{ page, pageSize, total, totalPages }`, established by `roles.service.listRoles`, page + count in one `$transaction` sharing one `where` |
| Audit | **none.** No model, no table, no endpoint |
| Tests | **none**, and none planned — verification is manual `curl` + `psql` |

### Decisions settled during the interview

| # | Question | Decision | Recorded in |
|---|---|---|---|
| D-1 | Where does this sit in the build order? | **First of the remaining five.** It is infrastructure; the other four write through it | this document, [../README.md](../../README.md) |
| D-2 | Application log or database table? | **Table.** Pino stays for operations. `AuditLog` is the business record | FR-1 |
| D-3 | Written how? | **`recordAudit(tx, …)` taking the transaction client**, called inside the same `$transaction` as the state change. Never the global `prisma` | FR-3, BE-2 |
| D-4 | Is a failed audit write survivable? | **No.** It aborts the transaction, so the state change rolls back with it. A change nobody can trace does not happen | FR-3.4, EC-04 |
| D-5 | Who can read the trace? | **Recruiters only.** Not interviewers — the feed names candidates and other interviewers' actions | AZ-2 |
| D-6 | Can an audit row be edited or deleted? | **No.** No `PATCH`, no `DELETE`, no service function that writes to an existing row | FR-6, AZ-4 |
| D-7 | What is in `metadata`? | A per-action **closed shape**, listed in FR-4. Ids, enum values and an override reason — never an email, a phone number, or the text of feedback notes | FR-4, SEC-3 |
| D-8 | `action` as a Postgres enum or a string? | **Enum.** A free-text action column is how a typo becomes an unqueryable row | MIG-2 |
| D-9 | Does the audit endpoint paginate? | **Yes**, on the shipped `{ page, pageSize, total, totalPages }` envelope. The table is append-only and grows without bound | FR-5.4, PERF-2 |
| D-10 | Does this feature write any audit rows itself? | **One:** `CANDIDATE_CONTACT_UPDATED`, owned by the candidate-access feature. Every other action enum value is written by a later feature; they are all declared here so the enum is not altered five times | FR-4, MIG-3 |

---

## Users / Actors

| Actor | May do, after this feature |
|---|---|
| Anonymous | Nothing. `GET /api/audit` is `401` |
| Candidate | Nothing. `403`. A candidate cannot read the trace of their own application either |
| Interviewer | Nothing. `403` |
| Recruiter | Read the whole trace, filtered by entity, action or actor |

**Deliberate POC trade-offs, so they are not read as oversights:**

- **A candidate cannot see their own audit trail.** The brief's disputing candidate asks a *hiring
  manager*, who asks the system; there is no candidate-facing disclosure surface in this POC. Adding
  one means deciding what a candidate may see of a recruiter's internal reasoning, which is a
  product question this POC does not answer.
- **There is no hiring-manager role.** The brief marks it optional (§2). A recruiter reads the
  trace on their behalf.
- **Nothing outside this API writes audit rows.** The seed writes them (FR-7); a human running an
  `UPDATE` in `psql` does not. That is an accepted gap (SEC-5) and it is the reason the trace is a
  record of *what this API did*, not of *what the database contains*.

---

## User Stories

| ID | Story |
|---|---|
| **US-01** | As a recruiter, I want to see every action taken on one application in order, so that I can answer a candidate's dispute with facts instead of memory. |
| **US-02** | As a recruiter, I want each entry to name the person who performed it, so that "who moved this candidate to Offer" is never a question I have to ask in Slack. |
| **US-03** | As a recruiter, I want an override's recorded reason to appear in the trace, so that a skipped stage is explained where it is discovered. |
| **US-04** | As a recruiter, I want to filter the trace by action, so that I can review every stage override performed this month without reading everything else. |
| **US-05** | As an engineer, I want the audit write to share the transaction with the state change, so that a half-written history is impossible rather than merely unlikely. |
| **US-06** | As a security reviewer, I want to confirm the trace contains no candidate contact details, so that an audit feed does not become the leak the rest of the design prevents. |

---

## Functional Requirements

### FR-1 — The record

- **FR-1.1** A single append-only table, `AuditLog`, holds one row per state-changing action
  performed through this API.
- **FR-1.2** A row carries exactly: `id`, `actorUserId`, `action`, `entityType`, `entityId`,
  `metadata`, `createdAt`. Nothing else. There is no `updatedAt`, because a row is never updated
  (FR-6.1).
- **FR-1.3** `actorUserId` is a real foreign key to `User`, with `onDelete: Restrict`. An audit row
  a user deletion can erase is not an audit row (MIG-4).
- **FR-1.4** `action` is the Postgres enum `AuditAction`; `entityType` is the Postgres enum
  `AuditEntityType`. Neither is a free-text column (D-8).
- **FR-1.5** `entityId` is an integer and is **deliberately not a foreign key**. It points at four
  different tables depending on `entityType`, so no single FK can express it — and a trace that a
  cascade can delete is worse than one without referential integrity. The consequence is stated
  plainly in SEC-4: `entityId` may reference a row that no longer exists.
- **FR-1.6** `createdAt` is the database's `now()`, never a client-supplied timestamp.

### FR-2 — Actor

- **FR-2.1** The actor is **always** `req.user.id`, resolved by `requireAuth` from a verified access
  token. No endpoint accepts an actor in a request body, a query parameter or a header.
- **FR-2.2** There is no anonymous audit row. Every action that writes one sits behind
  `requireAuth`, so an unauthenticated request is refused before any service runs.
- **FR-2.3** The seed is the single exception and is documented as such (FR-7.2): it writes rows
  whose actor is a seeded recruiter, because a demo database with an empty audit table teaches the
  wrong thing about the feature.

### FR-3 — The writer

- **FR-3.1** One exported function creates audit rows:

  ```ts
  export async function recordAudit(
    tx: Prisma.TransactionClient,
    entry: AuditEntry,
    log: Logger,
  ): Promise<void>;
  ```

  It lives in `src/modules/audit/audit.service.ts` and takes the **transaction client** as its first
  argument (D-3).
- **FR-3.2** Every caller invokes it **inside** the `prisma.$transaction` that performs the state
  change. There is no call site that passes the global `prisma` client, and no call site outside a
  transaction.
- **FR-3.3** `AuditEntry` is a discriminated union over `action`, so the `metadata` shape required
  for each action (FR-4) is enforced by the compiler at the call site. A caller that writes
  `STAGE_OVERRIDE_CREATED` without a `reason` in `metadata` does not compile.
- **FR-3.4** `recordAudit` does not catch its own errors. A failed insert propagates, the
  transaction aborts, and the state change rolls back with it (D-4, EC-04). **An action that could
  not be recorded did not happen.**
- **FR-3.5** After a successful write, `recordAudit` logs `{ event: 'audit.recorded', action,
  entityType, entityId, actorUserId }` at `info` — ids and enum values only, matching the shipped
  logging convention. It never logs `metadata`.

### FR-4 — Actions and their metadata

- **FR-4.1** `AuditAction` holds exactly these nine values. All nine are declared in this feature's
  migration even though eight of them are first written by a later feature (D-10) — one enum
  migration, not five.

  | `action` | Written by | `entityType` | `entityId` | `metadata` |
  |---|---|---|---|---|
  | `CANDIDATE_STAGE_CHANGED` | pipeline | `APPLICATION` | application id | `{ fromStage, toStage }` |
  | `STAGE_OVERRIDE_CREATED` | pipeline | `APPLICATION` | application id | `{ fromStage, toStage, reason, overrideId, skipped }` |
  | `APPLICATION_OUTCOME_SET` | pipeline | `APPLICATION` | application id | `{ fromStatus, toStatus, atStage }` |
  | `INTERVIEW_CREATED` | interviews | `INTERVIEW` | interview id | `{ applicationId, type, stage, scheduledAt }` |
  | `INTERVIEWER_ASSIGNED` | interviews | `INTERVIEW` | interview id | `{ interviewerId }` |
  | `INTERVIEWER_UNASSIGNED` | interviews | `INTERVIEW` | interview id | `{ interviewerId }` |
  | `FEEDBACK_SUBMITTED` | feedback | `FEEDBACK` | feedback id | `{ interviewId, rating }` |
  | `FEEDBACK_UPDATED` | feedback | `FEEDBACK` | feedback id | `{ interviewId, fromRating, toRating }` |
  | `CANDIDATE_CONTACT_UPDATED` | candidates | `CANDIDATE` | candidate user id | `{ fields }` — the **names** of the changed fields, never their values |

- **FR-4.2** `AuditEntityType` holds exactly `APPLICATION`, `INTERVIEW`, `FEEDBACK`, `CANDIDATE`.
- **FR-4.3** `metadata` is `Json`, never null. An action with nothing to record writes `{}`; a null
  column would be indistinguishable from a bug that forgot to populate it.
- **FR-4.4** **`metadata` never carries free personal text.** Specifically: no `email`, no `phone`,
  no `name`, no `title`, and **not the `notes` field of a feedback submission**. `rating` is
  recorded because it is a bounded integer a hiring manager needs; `notes` is not, because the audit
  feed is recruiter-readable and the notes belong on the feedback record where the authorization
  rules for reading them already live (SEC-3).
- **FR-4.5** `STAGE_OVERRIDE_CREATED` records `reason`. This is the one free-text field any
  `metadata` may hold, and it is a recruiter's own words about a process decision, not a fact about
  a person. The brief requires it be recorded (§3.3) and this is where a reader finds it.
- **FR-4.6** `skipped` in an override's metadata is the **number of stages jumped**, computed from
  the canonical stage order — so "was a stage actually skipped, or did a recruiter use the override
  path for a legal move?" is answerable without re-deriving the stage graph at read time.

### FR-5 — Reading the trace

- **FR-5.1** `GET /api/audit` returns a page of audit entries, newest first, ordered
  `[{ createdAt: 'desc' }, { id: 'desc' }]` — `id` is the stable tiebreak, matching the shipped
  ordering convention in `roles.service` and `applications.service`.
- **FR-5.2** Four optional filters, ANDed, never overwriting one another:
  `entityType`, `entityId`, `action`, `actorId`. Passing `entityId` without `entityType` is a
  `400` — an entity id alone means nothing across four tables (VAL-3).
- **FR-5.3** Each entry carries its actor expanded to `{ id, name, role }`. A trace naming
  `actorUserId: 7` is not a trace anyone can read. `email` is **not** included — the actor is a
  recruiter or an interviewer, not a candidate, but the rule that this feed carries no contact
  detail is absolute and has no per-role exception (SEC-2).
- **FR-5.4** The response uses the shipped pagination envelope
  `{ entries, pagination: { page, pageSize, total, totalPages } }`. `page` defaults to 1,
  `pageSize` to 20, max 100 — `?pageSize=101` is a `400`, never a silent clamp, matching
  `listRolesQuerySchema`.
- **FR-5.5** An empty result is `200` with `entries: []` and accurate pagination, never a `404`.
- **FR-5.6** The count and the page are fetched in **one** `prisma.$transaction` sharing a single
  `where`, so the total cannot describe a different filter than the rows.

### FR-6 — Immutability

- **FR-6.1** There is **no** `PATCH /api/audit/:id`, no `DELETE /api/audit/:id`, and no service
  function that updates or deletes an `AuditLog` row. The absence is the guarantee. Do not add one
  without a spec change.
- **FR-6.2** The `audit` module exports exactly two functions: `recordAudit` (write) and
  `listAuditEntries` (read). There is no third.

### FR-7 — Seed data

- **FR-7.1** [`prisma/seed.ts`](../../../prisma/seed.ts) gains audit rows matching the state it
  already seeds, so `GET /api/audit` is not empty on a fresh database.
- **FR-7.2** Seeded rows name `recruiter@demo.test` as actor and are written in the same
  delete-then-create block that owns the seeded applications, so re-running `npm run db:seed`
  does not accumulate duplicates.
- **FR-7.3** The seed is the **only** writer that calls `recordAudit` outside an HTTP request. It
  is documented in the file itself, next to the existing note that the seed is the single exception
  to the "conflicts are decided by constraints" rule.

### FR-8 — Logging

- **FR-8.1** New pino event names: `audit.recorded` (FR-3.5) and `audit.listed`
  (`{ event, actorId, resultCount }`).
- **FR-8.2** No log line contains `metadata`, a reason string, or any field listed in FR-4.4.
- **FR-8.3** The existing `redact` list in [`src/lib/logger.ts`](../../../src/lib/logger.ts) is
  extended with `reason` and `*.reason`, so an accidental future log of an override cannot print a
  recruiter's free text.

---

## Frontend Requirements

The obligations this backend places on the Next.js client. The rest of the frontend design lives in
[../../../../frontend/specs/features/audit/spec.md](../../../../frontend/specs/features/audit/spec.md).

- **XFE-1** `GET /api/audit` is **recruiter-only**. An interviewer or candidate session receives
  `403`, which `apiFetch` already turns into a `/forbidden` redirect. The client must not render an
  Audit nav link for those roles.
- **XFE-2** The response envelope is `{ entries, pagination }`. `pagination` is byte-identical in
  shape to the one `GET /api/roles` returns, so the shipped `RolesPagination` component's props are
  reusable without a new type.
- **XFE-3** `entry.action` and `entry.entityType` are **stable enum strings**. The client keys its
  label maps on them (`Record<AuditAction, string>`), so a new action value is a compile error
  rather than a blank cell.
- **XFE-4** `entry.metadata` is an **open object whose shape depends on `action`**. The client must
  render it defensively — an unknown key must not throw. The per-action shapes in FR-4.1 are the
  contract for the keys the client formats specially; anything else falls back to a raw key/value
  row.
- **XFE-5** `entry.actor` is always present and always `{ id, name, role }`. It is never null, even
  if the actor's account was later deactivated, because `onDelete: Restrict` makes deletion
  impossible (FR-1.3).
- **XFE-6** `entry.metadata` contains **no** `email`, `phone`, or feedback `notes` (FR-4.4). If one
  ever appears, **that is a backend bug to report, not a field to hide client-side.**
- **XFE-7** Filters are query parameters, not a request body: `?entityType=&entityId=&action=&actorId=&page=`.
  `entityId` without `entityType` is a `400 VALIDATION_ERROR` with `details.entityId` set — the
  client must disable or clear the id input while no entity type is selected.
- **XFE-8** `createdAt` is an ISO 8601 UTC string. Formatting is the client's job; the API never
  sends a pre-formatted date.

---

## Backend Requirements

- **BE-1 — Structure.** A new module, `src/modules/audit/`, holding
  `audit.service.ts` (the `recordAudit` writer and `listAuditEntries` reader),
  `audit.controller.ts`, `audit.routes.ts`, `audit.schema.ts` (the query schema) and
  `audit.select.ts` (the one projection). Route handlers hold no business logic; they read
  `req.validatedQuery`, call the service, and shape the HTTP response.
- **BE-2 — The writer is a dependency, not a module import cycle.** `recordAudit` is imported by
  pipeline, interviews, feedback and candidates. It imports nothing from any of them — its
  `AuditEntry` union is defined in terms of the Prisma enums, not those modules' types. This keeps
  `audit` a leaf.
- **BE-3 — Middleware order** on `GET /api/audit`: `requireAuth` → `requireRole(UserRole.RECRUITER)`
  → `validateQuery(listAuditQuerySchema)`. Anonymous is always `401`, wrong role is always `403`,
  and neither reveals whether the query string was also malformed.
- **BE-4 — `req.validatedQuery`, never `req.query`.** Express 5 makes `req.query` a getter that
  cannot be reassigned; the shipped `validateQuery` middleware assigns to `req.validatedQuery` for
  exactly that reason. The controller reads `req.validatedQuery as ListAuditQuery`.
- **BE-5 — One projection.** `AUDIT_SELECT` in `audit.select.ts` is the only shape
  `listAuditEntries` returns. It names `actor: { select: { id: true, name: true, role: true } }` and
  **does not name `email`** — the exclusion is in the select list, not in a mapping step afterward.
- **BE-6 — Service signature convention.** Both service functions take `log: Logger` as their last
  argument, matching every shipped service. Neither imports the global logger.
- **BE-7 — No new dependencies and no new environment variables.** `Json` columns, enums and
  `$transaction` are all Prisma 7 features already in use.

**How each of these is built — the file layout, the `AuditEntry` union, the transaction shapes and
the log field table — is `plan.md § Backend Changes`.** This section states only what must be true.

---

## API Contract

### `GET /api/audit` — Bearer · `RECRUITER`

Query parameters:

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `entityType` | `APPLICATION` \| `INTERVIEW` \| `FEEDBACK` \| `CANDIDATE` | — | Optional |
| `entityId` | positive integer | — | Optional; **requires `entityType`** |
| `action` | one of the nine `AuditAction` values | — | Optional |
| `actorId` | positive integer | — | Optional |
| `page` | integer ≥ 1 | `1` | |
| `pageSize` | integer 1–100 | `20` | `101` is a `400`, not a clamp |

```jsonc
// 200 OK — GET /api/audit?entityType=APPLICATION&entityId=12
{
  "entries": [
    {
      "id": 314,
      "action": "STAGE_OVERRIDE_CREATED",
      "entityType": "APPLICATION",
      "entityId": 12,
      "metadata": {
        "fromStage": "SCREEN",
        "toStage": "OFFER",
        "reason": "Candidate completed equivalent external screening.",
        "overrideId": 4,
        "skipped": 1
      },
      "createdAt": "2026-09-18T09:14:02.881Z",
      "actor": { "id": 1, "name": "Rhea Recruiter", "role": "RECRUITER" }
    },
    {
      "id": 298,
      "action": "CANDIDATE_STAGE_CHANGED",
      "entityType": "APPLICATION",
      "entityId": 12,
      "metadata": { "fromStage": "APPLIED", "toStage": "SCREEN" },
      "createdAt": "2026-09-16T11:02:40.117Z",
      "actor": { "id": 1, "name": "Rhea Recruiter", "role": "RECRUITER" }
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 2, "totalPages": 1 }
}
```

```jsonc
// 400 Bad Request — entityId without entityType
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid request body",
  "details": { "entityId": ["Provide entityType when filtering by entityId"] }
}
```

| Status | `code` | When |
|---|---|---|
| `200` | — | Success, including an empty page |
| `400` | `VALIDATION_ERROR` | Unknown `action`/`entityType`, non-numeric `entityId`/`actorId`/`page`, `pageSize` > 100, or `entityId` without `entityType` |
| `401` | `UNAUTHENTICATED` | No token, malformed header, expired or invalid token, deleted user |
| `403` | `FORBIDDEN` | Authenticated as `CANDIDATE` or `INTERVIEWER` |
| `500` | `INTERNAL_ERROR` | Anything unhandled |

### Contract invariants — what must appear in **zero** responses

1. No `email` field, anywhere in the `entries` array, including inside `actor` and inside
   `metadata`.
2. No `phone` field, anywhere.
3. No `notes` field — the text of an interviewer's feedback is never in an audit response
   (FR-4.4).
4. No `passwordHash`, no token, no `tokenHash`.
5. No `actorUserId` — the raw foreign key is replaced by the expanded `actor` object, so a client
   has nothing to join on and no reason to try.
6. No route exists that mutates an `AuditLog` row. `PATCH` and `DELETE` on `/api/audit` and
   `/api/audit/:id` fall through to the shipped `notFound` handler and answer `404`.

---

## Data Model Changes

```prisma
/// NEW. Every state-changing action this API performs, as a row.
///
/// Nine values, all declared in one migration even though eight are first
/// written by a later feature (D-10). Adding a value later is an enum migration
/// against a table that is by then large; adding all nine now costs nothing.
enum AuditAction {
  CANDIDATE_STAGE_CHANGED
  STAGE_OVERRIDE_CREATED
  APPLICATION_OUTCOME_SET
  INTERVIEW_CREATED
  INTERVIEWER_ASSIGNED
  INTERVIEWER_UNASSIGNED
  FEEDBACK_SUBMITTED
  FEEDBACK_UPDATED
  CANDIDATE_CONTACT_UPDATED
}

/// NEW. What `AuditLog.entityId` points at. An enum, not a string, for the same
/// reason `RoleStatus` is one: a typo in a free-text discriminator produces a row
/// no filter will ever return, and nothing fails loudly.
enum AuditEntityType {
  APPLICATION
  INTERVIEW
  FEEDBACK
  CANDIDATE
}

/// NEW. Append-only. No `updatedAt`, because no code path updates a row (FR-6.1).
model AuditLog {
  id          Int             @id @default(autoincrement())
  actorUserId Int
  action      AuditAction
  entityType  AuditEntityType

  /// Deliberately NOT a foreign key (FR-1.5). It addresses four different tables
  /// depending on `entityType`, so no single FK expresses it — and a trace a
  /// cascade can delete is worse than one without referential integrity. The
  /// consequence is stated in SEC-4, not hidden.
  entityId Int

  /// Never null; an action with nothing to record writes `{}` (FR-4.3). The shape
  /// per action is FR-4.1, enforced at the call site by a discriminated union
  /// rather than by the column (FR-3.3).
  metadata Json

  createdAt DateTime @default(now())

  /// `Restrict`, not `Cascade`. `User` cascades to `RefreshToken` and
  /// `Application`; it must not cascade here. Deleting a recruiter would
  /// otherwise erase the record of every decision they made, which is precisely
  /// the record the brief asks for (MIG-4).
  actor User @relation(fields: [actorUserId], references: [id], onDelete: Restrict)

  @@index([entityType, entityId, createdAt]) // the "life of this application" read — FR-5.2
  @@index([actorUserId, createdAt])          // "everything this recruiter did"
  @@index([action, createdAt])               // "every override this month" — US-04
  @@index([createdAt])                       // the unfiltered feed's ORDER BY
}

model User {
  // …unchanged fields…

  auditLogs AuditLog[] // MODIFIED — back-relation only; no column is added to User
}
```

### Migration notes

- **MIG-1** Migration name: `add_audit_log`. **Additive only.** Two new enum types, one new table,
  four new indexes. No existing column is altered, no existing row is touched, and the only change
  to `User` is a Prisma-level back-relation, which produces no SQL.
- **MIG-2** `AuditAction` and `AuditEntityType` are Postgres `CREATE TYPE … AS ENUM`. A free-text
  `action` column was rejected (D-8): a typo would produce a row that no filter returns and nothing
  fails loudly.
- **MIG-3** All nine `AuditAction` values ship in this migration although eight are first written
  by features 5–8 (D-10). Prisma's `ALTER TYPE … ADD VALUE` cannot run inside a transaction on
  older Postgres and forces a migration per feature otherwise; declaring the closed set once is
  both cheaper and a better statement of intent. **An enum value no code writes is normally a lie
  in the schema — this is the documented exception, and it is closed by feature 8.**
- **MIG-4** `actor` is `onDelete: Restrict`. This is a **deliberate departure** from the `Cascade`
  used on `RefreshToken.user` and `Application.candidate`. Consequence, stated plainly: once a user
  has performed any audited action, `prisma.user.delete` on them raises `P2003`. There is no user
  deletion endpoint in this POC, so nothing breaks today; if one is ever added it must anonymise
  rather than delete.
- **MIG-5** Four indexes, all added now rather than after a slow query is observed. `AuditLog` is
  the fastest-growing table in the schema — one row per state change, forever — and every filter in
  FR-5.2 has an index whose leading columns match it. `@@index([createdAt])` serves the unfiltered
  feed's `ORDER BY` alone.
- **MIG-6** Row growth, named: roughly one row per stage transition, override, outcome, interview,
  assignment and feedback submission. At the brief's simulated scale — 200 roles, 20 000 candidates,
  say six audited actions each — that is ~120 000 rows. Well inside what the indexes above handle,
  and the reason the endpoint paginates rather than returning everything (D-9).
- **MIG-7** No backfill. There is no history before this table exists, and inventing rows for past
  state changes would produce a trace that is false in exactly the way the feature exists to
  prevent. The pipeline feature backfills `StageHistory` for *ageing*, which is a different
  question; it does **not** backfill `AuditLog`.

---

## Authentication / Authorization

### Endpoint × role matrix

| Endpoint | Anonymous | Candidate | Interviewer | Recruiter |
|---|---|---|---|---|
| `GET /api/audit` | `401` | **`403`** | **`403`** | ✅ |

### Non-negotiable rules

- **AZ-1** `401` and `403` are never interchanged. `requireAuth` runs before
  `requireRole(UserRole.RECRUITER)` on the one route this feature adds, so no token is always
  `401` and a wrong role is always `403`.
- **AZ-2** The audit feed is **recruiter-only** (D-5). It names candidates by application id, other
  interviewers by name, and carries recruiters' free-text override reasons — none of which an
  interviewer may see, and all of which would undo the scoping the candidates and feedback features
  build.
- **AZ-3** The role check is the **whole** authorization for the read. There is no per-row scoping,
  because there is no role permitted to read a subset. This is stated so nobody later adds an
  interviewer to the guard and assumes a row filter is protecting them — **there is none.**
- **AZ-4** No route mutates an audit row (FR-6.1). Immutability is enforced by the absence of a
  handler, not by a permission check that could be widened.
- **AZ-5** The actor written to a row is always `req.user.id` (FR-2.1). No request field can set,
  spoof or override it; a body carrying `"actorUserId": 1` reaches no service that reads it.
- **AZ-6** `recordAudit` performs **no** authorization of its own. Its callers have already
  authorized the state change it is recording, and a second check inside the writer would be a
  second place for the rule to rot. This is a deliberate division and is why the writer is not
  exported to any route.

---

## Validation

All query parameters on `GET /api/audit`, via `listAuditQuerySchema` and the shipped
`validateQuery` middleware.

| Field | Where | Rule | Failure |
|---|---|---|---|
| `entityType` | query | `z.enum(AuditEntityType)`, optional | `400` `details.entityType` |
| `entityId` | query | `z.coerce.number().int().positive()`, optional | `400` `details.entityId` |
| `action` | query | `z.enum(AuditAction)`, optional | `400` `details.action` |
| `actorId` | query | `z.coerce.number().int().positive()`, optional | `400` `details.actorId` |
| `page` | query | `z.coerce.number().int().min(1).default(1)` | `400` `details.page` |
| `pageSize` | query | `z.coerce.number().int().min(1).max(100).default(20)` | `400` `details.pageSize` |
| — | query | `.refine(entityId === undefined \|\| entityType !== undefined)` | `400` `details.entityId` |

- **VAL-1** Validation runs **after** `requireAuth` and `requireRole` (BE-3), so a candidate sending
  a malformed query gets `403` and learns nothing about the query contract.
- **VAL-2** `?pageSize=101` is a `400`, not a silent clamp to 100 — matching `listRolesQuerySchema`,
  where the same decision was taken and for the same reason: a clamped page size makes the client's
  pagination arithmetic silently wrong.
- **VAL-3** `?entityId=12` with no `entityType` is a `400`, not an unfiltered result. An entity id
  is ambiguous across four tables; returning application 12's trace *and* interview 12's trace
  because the caller forgot a parameter is worse than refusing.
- **VAL-4** `?action=BANANA` is a `400` before any service runs. The brief requires bad input to be
  rejected before business logic (§6), and a zod enum at the route boundary is where that happens.
- **VAL-5** Unknown query parameters are **ignored**, not rejected — zod strips them, matching the
  shipped behaviour on `GET /api/roles`. A stale bookmark carrying `?sort=asc` renders the default
  ordering rather than an error.

---

## Error Handling

The shipped envelope, unchanged — flat, no `error` wrapper:

```jsonc
{ "code": "VALIDATION_ERROR", "message": "Invalid request body", "details": { "field": ["…"] } }
```

| `code` | Status | Raised when | New? |
|---|---|---|---|
| `VALIDATION_ERROR` | `400` | Any rule in the Validation table fails (`details` set) | no |
| `UNAUTHENTICATED` | `401` | No/invalid/expired token, or the user row is gone | no |
| `FORBIDDEN` | `403` | Authenticated as `CANDIDATE` or `INTERVIEWER` | no |
| `INTERNAL_ERROR` | `500` | Anything unhandled, including a failed audit write | no |

**This feature adds no new error code.** That is worth stating: an audit failure is not a client
error and has no client remedy, so it surfaces as `500` like any other internal fault.

- **ERR-1** A Prisma error from the audit insert is never returned to the client. The shipped
  `errorHandler` logs `{ err, method, path }` and answers
  `{ "code": "INTERNAL_ERROR", "message": "Something went wrong" }`. No stack trace, no SQL, no
  Prisma code reaches the wire, in any environment.
- **ERR-2** A failed `recordAudit` aborts the enclosing transaction, so the caller's endpoint
  returns `500` and **the state change is not persisted** (FR-3.4). The client sees a failure and
  the database is unchanged — the two agree.
- **ERR-3** `GET /api/audit` for an entity that has no rows is `200` with `entries: []`, never a
  `404`. A `404` would mean "this entity does not exist", which this endpoint cannot determine and
  must not imply.
- **ERR-4** Errors are never swallowed. [../../../CLAUDE.md](../../../CLAUDE.md) states it and this
  feature is the reason it matters: *"an audit trail is only useful if failures are visible too."*

---

## Edge Cases

| ID | Case | Behaviour |
|---|---|---|
| **EC-01** | The state change commits but the audit insert fails | Impossible by construction. Both are in one `prisma.$transaction`; the insert's failure rolls the change back (FR-3.4) |
| **EC-02** | The audit insert commits but the state change fails | Same answer, same reason. One transaction, both or neither |
| **EC-03** | A caller invokes `recordAudit` with the global `prisma` instead of `tx` | A type error: the parameter is `Prisma.TransactionClient`, which `PrismaClient` does not satisfy in the position used. The mistake does not compile (FR-3.1) |
| **EC-04** | A caller writes `STAGE_OVERRIDE_CREATED` without a `reason` in metadata | A type error. `AuditEntry` is a discriminated union over `action` (FR-3.3) |
| **EC-05** | Two actions on the same entity commit at the same instant | Both rows persist. `AuditLog` has no unique constraint and nothing to contend on; `id` and `createdAt` order them, with `id` as the tiebreak when timestamps collide (FR-5.1) |
| **EC-06** | `entityId` points at a row that has since been deleted | The entry still returns, with its `entityId` intact. The trace outlives the entity **by design** (FR-1.5, SEC-4) |
| **EC-07** | Someone tries to delete a recruiter who has audit rows | Postgres raises `P2003` from `onDelete: Restrict`. There is no user-deletion endpoint, so this is unreachable over HTTP; it is recorded because a future one must anonymise, not delete (MIG-4) |
| **EC-08** | `?page=999` on a 2-row table | `200`, `entries: []`, `pagination: { page: 999, pageSize: 20, total: 2, totalPages: 1 }`. Matching the shipped roles behaviour — an empty page past the end, not an error |
| **EC-09** | `total` is 0 | `totalPages` is `0`, not `1` — `Math.ceil(0 / 20)`, matching `roles.service` |
| **EC-10** | A `metadata` object contains a key the client does not know | Returned verbatim. The client renders it defensively (XFE-4); the API does not filter its own metadata to match a client's expectations |
| **EC-11** | The seed is run twice | The audit rows are rewritten in the same delete-then-create block that owns the seeded applications (FR-7.2). No duplicates |
| **EC-12** | An interviewer guesses `/api/audit?actorId=<their own id>` | `403`. The guard is on the route, not on the filter; there is no self-scoped read (AZ-3) |

---

## Security Requirements

- **SEC-1** The actor is taken from the verified token and from nowhere else (FR-2.1, AZ-5). A
  client-supplied `actorUserId` reaches no code path that reads it, so a forged attribution is not
  possible.
- **SEC-2** `AUDIT_SELECT` names `actor: { id, name, role }` and **does not name `email`**. The
  exclusion is in the Prisma select list, not in a mapping step after the fetch — the column is
  never in the row Postgres returns, so no future call site can leak it (BE-5). This matters even
  though actors are never candidates: the rule holds without exception, which is what makes it
  auditable.
- **SEC-3** `metadata` carries no email, phone, name, title, or feedback `notes` (FR-4.4). The one
  free-text field permitted is an override's `reason`, which is a recruiter's statement about
  process, not a fact about a person — and the brief requires it be recorded.
- **SEC-4** **`entityId` has no referential integrity** (FR-1.5). An entry can name a deleted
  interview. This is chosen, not overlooked: a foreign key here would let a cascade erase the trace,
  which defeats the feature. A reader must treat `entityId` as a historical reference, not a
  guaranteed join target.
- **SEC-5** The trace records **what this API did**, not what the database contains. A direct
  `UPDATE` in `psql` leaves no entry. Stated so that nobody reads an unbroken trace as proof that
  no out-of-band change occurred.
- **SEC-6** The feed is recruiter-only and there is no row-level scoping behind the role guard
  (AZ-3). Widening the guard leaks the whole trace; there is no partial view to fall back on.
- **SEC-7** `reason` is added to the pino `redact` list (FR-8.3), so a future log line that
  accidentally includes an override's metadata prints `[redacted]` rather than a recruiter's words.
- **SEC-8** **Known accepted gaps.** (a) There is no integrity protection — no hash chain, no
  append-only enforcement at the database level, no `REVOKE UPDATE` on the table. Anyone with
  database credentials can rewrite history silently, and nothing in this POC would detect it.
  (b) There is no retention policy or archival; the table grows forever. (c) There is no rate limit
  on `GET /api/audit`, so an authenticated recruiter can page the entire table as fast as the
  server answers. All three are accepted for a localhost POC and **must be addressed before this is
  reachable from anywhere but localhost.**

---

## Performance Requirements

- **PERF-1** `GET /api/audit?entityType=APPLICATION&entityId=…` p95 < 60 ms at 120 000 rows
  (MIG-6). `EXPLAIN ANALYZE` must show an **index scan** on
  `AuditLog_entityType_entityId_createdAt_idx` and **no sequential scan** on `AuditLog`.
- **PERF-2** The unfiltered feed's first page is served by an index scan on
  `AuditLog_createdAt_idx`. The endpoint paginates precisely so that a growing table cannot become
  a growing response (D-9); there is **no** unpaginated audit read, and none may be added.
- **PERF-3** `?action=…` is served by `AuditLog_action_createdAt_idx`, `?actorId=…` by
  `AuditLog_actorUserId_createdAt_idx`. Every filter FR-5.2 offers has a matching index — none
  degrades to a scan.
- **PERF-4** The page and the count run in one `$transaction` (FR-5.6) — two queries per request,
  never one per row. The actor is fetched by Prisma's relation `select`, which joins; it is **not**
  an N+1 lookup per entry. `EXPLAIN ANALYZE` on the generated SQL must confirm a join, not a loop.
- **PERF-5** `recordAudit` adds exactly **one** `INSERT` to its caller's transaction. It performs
  no read, no count, and no lookup of the actor — the actor id is already in `req.user` and is
  passed down. An audit write must never turn a one-statement endpoint into a three-statement one.
- **PERF-6** Writing the audit row must not measurably change the enclosing endpoint's p95. The
  budget is < 5 ms of the transaction's total, verifiable by comparing the pipeline feature's
  `PATCH /api/applications/:id/stage` timing against a build with the write commented out.

---

## Acceptance Criteria

Verified by hand with `curl` against the running API, plus `psql` where the proof is database state.
There is no test suite. `$R` is a recruiter's access token, `$I` an interviewer's, `$C` a
candidate's — all from `npm run db:seed`.

### Reading the trace

- **AC-B01** — **Given** a seeded database, **when** `GET /api/audit` is called with `$R`, **then**
  the response is `200`, `entries` is a non-empty array, and `pagination` has the four keys `page`,
  `pageSize`, `total`, `totalPages` (FR-5.4, FR-7.1).
- **AC-B02** — **Given** the same, **when** the response is read, **then** every entry has exactly
  the keys `id`, `action`, `entityType`, `entityId`, `metadata`, `createdAt`, `actor` — and
  **no** `actorUserId` (contract invariant 5).
- **AC-B03** — **Given** the same, **when** `entries` is read top to bottom, **then** `createdAt` is
  non-increasing (FR-5.1).
- **AC-B04** — **Given** an application id with audit rows, **when**
  `GET /api/audit?entityType=APPLICATION&entityId=<id>` is called with `$R`, **then** every returned
  entry has that `entityType` and that `entityId` (FR-5.2).
- **AC-B05** — **Given** the same, **when** `&action=CANDIDATE_STAGE_CHANGED` is added, **then**
  every returned entry has that action and `total` is less than or equal to the previous call's
  (FR-5.2, filters AND).
- **AC-B06** — **Given** an entity with no rows, **when** it is filtered for, **then** the response
  is `200` with `entries: []` and `total: 0`, `totalPages: 0` — **not** `404` (ERR-3, EC-09).
- **AC-B07** — **Given** a 2-row result set, **when** `?page=999` is sent, **then** the response is
  `200`, `entries: []`, and `pagination.page` is `999` with `total: 2` (EC-08).
- **AC-B08** — **Given** any entry, **when** `actor` is read, **then** it is
  `{ id, name, role }` with exactly three keys and **no** `email` (SEC-2, contract invariant 1).

### Validation

- **AC-B09** — **Given** `$R`, **when** `GET /api/audit?action=BANANA` is sent, **then** the
  response is `400` `VALIDATION_ERROR` with `details.action` populated, and the server log shows no
  service call (VAL-4).
- **AC-B10** — **Given** `$R`, **when** `GET /api/audit?entityId=12` is sent with no `entityType`,
  **then** the response is `400` with `details.entityId` set to the message in VAL-3.
- **AC-B11** — **Given** `$R`, **when** `GET /api/audit?pageSize=101` is sent, **then** the response
  is `400` with `details.pageSize` — **not** `200` with 100 rows (VAL-2).
- **AC-B12** — **Given** `$R`, **when** `GET /api/audit?sort=asc&nonsense=1` is sent, **then** the
  response is `200` and the ordering is unchanged — unknown parameters are stripped, not rejected
  (VAL-5).

### Authorization

- **AC-B13** — **Given** no `Authorization` header, **when** `GET /api/audit` is called, **then**
  the response is `401` `UNAUTHENTICATED` (AZ-1).
- **AC-B14** — **Given** `$I`, **when** `GET /api/audit` is called, **then** the response is `403`
  `FORBIDDEN` and the body contains no `entries` key (AZ-2).
- **AC-B15** — **Given** `$C`, **when** `GET /api/audit` is called, **then** the response is `403`
  (AZ-2).
- **AC-B16** — **Given** `$I`, **when** `GET /api/audit?actorId=<their own user id>` is called,
  **then** the response is `403`, not a self-scoped `200` (EC-12, AZ-3).
- **AC-B17** — **Given** `$C`, **when** `GET /api/audit?action=BANANA` is sent, **then** the
  response is `403`, **not** `400` — the role guard runs before validation and the candidate learns
  nothing about the query contract (VAL-1, BE-3).

### Immutability

- **AC-B18** — **Given** `$R` and an existing audit entry id, **when**
  `DELETE /api/audit/<id>` is sent, **then** the response is `404` from the shipped `notFound`
  handler, and `psql` shows the row still present (FR-6.1, contract invariant 6).
- **AC-B19** — **Given** the same, **when** `PATCH /api/audit/<id>` is sent with any body, **then**
  the response is `404` and the row is unchanged (FR-6.1).
- **AC-B20** — **Given** the repository, **when** `grep -rn "auditLog.update\|auditLog.delete" src/`
  is run, **then** it returns no results (FR-6.2).

### The transaction guarantee

- **AC-B21** — **Given** a build in which `recordAudit` is temporarily made to throw, **when** any
  audited endpoint is called, **then** the response is `500` **and** `psql` shows the state change
  was **not** persisted — no new `StageHistory` row, no changed `currentStage` (FR-3.4, EC-01).
- **AC-B22** — **Given** the same build restored, **when** the same endpoint is called, **then** the
  response succeeds **and** `psql` shows exactly one new row in both the state table and `AuditLog`
  (EC-02).
- **AC-B23** — **Given** the repository, **when**
  `grep -rn "recordAudit(" src/ | grep -v "tx"` is run, **then** it returns no call site passing the
  global client (FR-3.2, EC-03).

### Cross-cutting invariants

- **AC-B24** — **Given** a seeded database with rows of every `action` value present, **when**
  `GET /api/audit?pageSize=100` is called with `$R` and the entire response body is searched, **then**
  the strings `"email"`, `"phone"`, `"passwordHash"` and `"notes"` appear **zero** times
  (contract invariants 1–4, SEC-2, SEC-3).
- **AC-B25** — **Given** the same response, **when** every `metadata` object is inspected, **then**
  the only free-text value present anywhere is an override `reason` (FR-4.4, FR-4.5).
- **AC-B26** — **Given** a running server with `NODE_ENV=production`, **when** an audit insert is
  forced to fail, **then** the HTTP response body is exactly
  `{"code":"INTERNAL_ERROR","message":"Something went wrong"}` with no stack trace, SQL or Prisma
  code (ERR-1).
- **AC-B27** — **Given** any audited action, **when** the server log is read, **then** an
  `audit.recorded` line is present carrying `action`, `entityType`, `entityId`, `actorUserId` and
  **no** `metadata` (FR-3.5, FR-8.2).

---

## Out of Scope

| Excluded | Why |
|---|---|
| A candidate-facing view of their own trace | Requires deciding what a candidate may see of a recruiter's reasoning — a product question this POC does not answer (Actors) |
| Tamper-evidence (hash chain, append-only grants) | Stated as an accepted gap (SEC-8a) rather than half-built; a partial integrity scheme is worse than an honest absence |
| Retention, archival or partitioning | The table grows forever and that is fine at POC scale (SEC-8b) |
| CSV / JSON export of the trace | A reporting feature; the brief asks for a trace, not a reporting tool |
| Diffing arbitrary before/after column values | `metadata` records the specific fields each action changes (FR-4.1). A generic diff engine would capture columns the feed must not carry |
| Auditing reads | The brief asks for state changes. Logging every read would multiply the table's growth by an order of magnitude and record nothing a reviewer asked for |
| Auditing authentication events | `auth.login.success` and friends are already pino events and are an operations concern, not a hiring-decision one |
| Backfilling history for pre-existing rows | There is no history before this table; invented rows would be false in exactly the way the feature prevents (MIG-7) |
| A `hiringManager` actor | Optional in the brief (§2) and absent from the requirements this pass covers |

---

## Dependencies

**Blocked by:** [../authentication/spec.md](../authentication/spec.md) (implemented) — every audit
row needs an authenticated actor, and §6 of the brief forbids an anonymous path.
[../candidate/spec.md](../candidate/spec.md) (implemented) — `Application` must exist for
`entityType: APPLICATION` to mean anything.

**Blocks:** [../pipeline/spec.md](../pipeline/spec.md), [../interviews/spec.md](../interviews/spec.md),
[../feedback/spec.md](../feedback/spec.md), [../candidate-access/spec.md](../candidate-access/spec.md). Each
calls `recordAudit` inside its own transaction and cannot be implemented before this ships. See
[../README.md](../../README.md) for the full order.

**New npm packages:** **none.** `Json` columns, Postgres enums and `$transaction` are Prisma 7
features already in use.

**New environment variables:** **none.**

**New files**

| Path | Purpose |
|---|---|
| `src/modules/audit/audit.service.ts` | `recordAudit` (write) + `listAuditEntries` (read) |
| `src/modules/audit/audit.controller.ts` | HTTP concerns only |
| `src/modules/audit/audit.routes.ts` | One route, guarded per BE-3 |
| `src/modules/audit/audit.schema.ts` | `listAuditQuerySchema` |
| `src/modules/audit/audit.select.ts` | `AUDIT_SELECT` |

**Modified existing files**

| Path | Change |
|---|---|
| [`prisma/schema.prisma`](../../../prisma/schema.prisma) | Two enums, one model, one back-relation on `User` |
| [`src/app.ts`](../../../src/app.ts) | Mount `auditRouter` at `/api/audit` |
| [`src/lib/logger.ts`](../../../src/lib/logger.ts) | `redact` gains `reason`, `*.reason` (FR-8.3) |
| [`prisma/seed.ts`](../../../prisma/seed.ts) | Seed audit rows for the existing seeded applications (FR-7) |
| [`CLAUDE.md`](../../../CLAUDE.md) | Feature table row; the "Domain model to build out" audit bullet now points here |

**External services:** none.

**Cross-repo:** this backend and the Next.js client share one API contract. A change to the
endpoint, the response envelope, the `AuditAction` values or the error shape must be made in
[../../../../frontend/specs/features/audit/spec.md](../../../../frontend/specs/features/audit/spec.md)
in the same pass.
