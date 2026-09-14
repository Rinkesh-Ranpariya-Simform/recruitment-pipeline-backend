---
description: Spec-Driven Development phase 2 — read the approved spec, then write specs/features/<feature>/plan.md
argument-hint: [feature-name]
---

We are now in the **planning phase** for the backend.

Feature:

$ARGUMENTS

If I gave you no feature name above, list the folders under `specs/features/` and ask me which one to plan.

**Do NOT modify production code.** The only file you create is `plan.md`. Do not make speculative changes.

---

## Step 1 — Read the spec

Read `specs/features/[feature-name]/spec.md` in full. It is the source of truth for this plan; the plan explains *how*, never *what* or *why*.

Also read, for cross-boundary context (paths relative to this repo's root; skip any not present):

- `../frontend/specs/features/[feature-name]/spec.md` — so the shared contract is planned consistently
- `CLAUDE.md` — layering, security and migration rules the plan must obey
- `../recruitment-pipeline.md` — the POC brief

**If the specification is insufficient to create a reliable plan, stop.** Do not fill gaps by assuming. List the exact questions that need answers, then wait. A plan built on a guess is worse than no plan.

---

## Step 2 — Explore the existing codebase

Ground every proposed change in what actually exists:

- `src/` — current routes, services, middleware, error handling, app wiring
- `prisma/schema.prisma` + `prisma/migrations/` — the current data model and migration history
- `package.json` — what is installed, what scripts exist (never assume a dependency exists)
- `specs/features/` — plans for features this one builds on

Actively look for existing functions, services, middleware and utilities to **reuse**. Do not plan new code where a suitable implementation already exists — name the existing one and its path instead.

---

## Step 3 — Write the plan

Create `specs/features/[feature-name]/plan.md` with **exactly these headings, in this order**:

```
# Implementation Plan — <Feature Name> (Backend)
## Architecture Impact
## Frontend Changes
## Backend Changes
## Database Changes
## API Changes
## Shared Types / Contracts
## Verification Commands
## Risks
## Implementation Order
## Acceptance Criteria Mapping
```

### Section contents

**## Architecture Impact**
What structurally changes in this repo: new layers or directories, new middleware in the chain (and **where in the order**), new cross-cutting concerns. Call out anything that changes an existing pattern rather than extending it.

**## Frontend Changes**
This is a backend plan, so this section records **only what the frontend must change because of this backend work** — a new endpoint to call, a changed response shape, a renamed header or cookie. Link to `../frontend/specs/features/[feature-name]/plan.md` for the actual frontend plan. If nothing on the frontend is affected, **state that explicitly** rather than leaving the section empty.

**## Backend Changes**
The bulk of the plan. For **each** change, give:

- **file/path** — exact, e.g. `src/modules/auth/auth.service.ts`
- **route** — method + path, where applicable
- **controller** — what it validates, delegates to, and returns
- **service** — the business logic it owns
- **middleware** — which middleware applies, in what order
- **validation** — which zod schema, and which fields
- **responsibility** — one sentence on what this file owns
- **required modification** — new file, or the precise change to an existing one

Group by module. Mark each entry **NEW** or **MODIFIED**. Route handlers must hold no business logic.

**## Database Changes**
- schema changes — the Prisma diff
- migrations — the migration name, whether it is additive or destructive, and the exact `prisma migrate` command
- indexes — every index added, and the query each one serves
- data migration requirements — backfill needs, existing-row handling, and the rollback story

**If no database changes are required, state that explicitly.**

**## API Changes**
For every endpoint added or changed: endpoint · HTTP method · request shape · response shape · errors (code + status) · authentication/authorization required. Mark each **NEW**, **MODIFIED** or **BREAKING**. A breaking change needs a migration note for existing clients.

**## Shared Types / Contracts**
What must stay in sync between Express and Next.js: response shapes, error `code` values, enum values, header and cookie names, status-code semantics. State which side owns each, and what breaks on the other side if it changes. Remember these are two separate repos — nothing is shared by import, only by agreement.

**## Verification Commands**
The exact commands to run, in order, with what each proves. Include install, migrate, seed, lint and type-check. Note anything that must be running first (Postgres, the API).

**This project writes no automated tests** — every acceptance criterion is signed off by hand. So follow the commands with a **manual verification table**: one row per criterion, giving the exact `curl` (or `psql`) command, the response or database state to observe (status, headers, body, row counts), and the criterion ID it proves. Call out checks needing special setup: concurrency (two requests fired at once, not sequentially), seeded fixtures, env manipulation.

**## Risks**
Technical risks and compatibility concerns, each with an impact and a mitigation. Cover at least: destructive migrations, breaking contract changes, concurrency correctness, performance at the brief's stated scale, and new dependencies.

**## Implementation Order**
The safest sequence, as numbered steps. Schema and migrations before services; services before routes. Each step should leave the codebase in a working, type-checking state. Note which steps are independent and could be done in parallel.

**## Acceptance Criteria Mapping**
A table with **every** acceptance criterion from `spec.md` — none omitted:

| Acceptance Criterion | Implementation | Manual Verification |
| -------------------- | -------------- | ------------------- |
| AC-B01 — signup returns 201 with safe user | `src/modules/auth/auth.service.ts` `createUser()`, `auth.routes.ts` | `curl -i -X POST localhost:3000/api/auth/signup …` → `201`, body has no `passwordHash` |

Reference implementation entries by the file paths used in **## Backend Changes**, so the table and the plan agree.

---

## Step 4 — After writing

1. Verify every heading is present and in order.
2. Verify **every** acceptance criterion in `spec.md` appears in the mapping table — a missing row means unplanned work.
3. Confirm every planned file is either NEW or a named modification to a real existing path.
4. Report plainly: what the plan covers, anything in the spec you could not plan reliably, and any question still open.

Do not start implementing.

**Reference:** `specs/features/authentication/spec.md` shows the spec standard these plans are derived from.
