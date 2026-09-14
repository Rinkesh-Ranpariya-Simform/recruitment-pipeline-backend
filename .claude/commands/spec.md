---
description: Spec-Driven Development phase 1 — interview me, then write specs/features/<feature>/spec.md
argument-hint: [feature description]
---

We are following Spec-Driven Development.

I want to build the following backend feature:

$ARGUMENTS

**Do NOT write production code.**

Your job in this phase is to help me produce a complete backend feature specification. If I gave you no feature description above, ask me what feature to spec before doing anything else.

---

## Step 1 — Explore the codebase, only as necessary

Read enough to ground the spec in what actually exists. Do not read the whole repo. All paths are relative to this repo's root (`backend/`).

- `CLAUDE.md` — conventions, the query-level data-exclusion rule, business rules
- `../recruitment-pipeline.md` — the POC brief and source of truth (sits above this repo; skip if not present)
- `prisma/schema.prisma` + `prisma/migrations/` — the data model today
- `src/` — existing routes, services, middleware, error shape, validation patterns
- `package.json` — what is actually installed (never assume a dependency exists)
- `specs/features/` — existing specs this builds on

Prefer one `Explore` subagent over many individual reads when the scope is uncertain.

Then report what you found in one short paragraph — particularly anything that **contradicts or constrains** what I asked for. Surfacing a conflict early is worth more than a file inventory.

---

## Step 2 — Interview me

Ask in **rounds of up to 4 questions**, using `AskUserQuestion` with concrete options and a recommended default. Continue until the requirements are unambiguous — usually 3–5 rounds. Never ask about something you can determine yourself from the code.

**Do not make important assumptions silently. If something is ambiguous, ask me.**

Cover these, skipping only what genuinely does not apply:

**Product & scope** — business goal (what breaks today without this) · users/roles (`INTERVIEWER` / `RECRUITER`) · user behavior (what triggers this) · out-of-scope behavior

**Contract & data** — API contracts (endpoints, methods, request/response shapes, status codes) · database/data model (tables, columns, enums, indexes, relations) · migration requirements (additive vs destructive, backfill, existing rows) · backwards compatibility (does this change a shipped contract)

**Behaviour & correctness** — backend behavior (the flow through validation → authorization → service → DB) · authentication (what identity this needs) · **authorization — who may do this, and is restricted data excluded at the query or filtered after?** · validation (field rules, what's rejected before business logic) · error cases (which failure maps to which code and status) · edge cases (races, concurrency, duplicates, missing parents, ordering) · integrations (external services, other features read from or written to)

**Non-functional** — security (leak paths, enumeration, secrets, privilege escalation, audit) · performance (expected scale, indexed aggregate vs in-memory work) · observability/logging (what to log, what must never be logged) · notifications · verification (the manual `curl` and `psql` checks that will prove each acceptance criterion, including negative and concurrent cases)

**For this POC specifically, always resolve:**
- Is restricted data **excluded at the query** or filtered afterwards? The brief demands the former.
- Must a write hold under **two genuinely concurrent requests**? If so, what's the documented outcome, and is it enforced by a DB constraint or transaction rather than check-then-write?
- Does this action need a **recorded actor and reason** rather than an inferred one?
- Must this query stay usable at ~200 roles / ~20,000 candidates?

---

## Step 3 — Write the spec

Create `specs/features/[feature-name]/spec.md` (kebab-case slug) with **exactly these headings, in this order**:

```
# <Feature Name> (Backend)
## Goal
## Background / Context
## Users / Actors
## User Stories
## Functional Requirements
## Frontend Requirements
## Backend Requirements
## API Contract
## Data Model Changes
## Authentication / Authorization
## Validation
## Error Handling
## Edge Cases
## Security Requirements
## Performance Requirements
## Acceptance Criteria
## Out of Scope
## Dependencies
```

### What each section must contain

- **Goal** — what this makes true, as a numbered list of obligations. Not a restatement of the title.
- **Background / Context** — why now, relevant brief sections quoted, a table of the current state of this repo, and the decisions settled during the interview.
- **Users / Actors** — a table of who can do what. Call out deliberate POC trade-offs explicitly so they aren't mistaken for oversights.
- **User Stories** — numbered `US-01…`, "As a … I want … so that …".
- **Functional Requirements** — numbered and hierarchical (`FR-1.1`), each independently checkable. The bulk of the spec.
- **Frontend Requirements** — **not a stub.** List the obligations the client places on this backend (`XFE-1…`): transport, CORS, error-shape keying, names the client hard-codes. Link to the frontend spec at `../frontend/specs/features/[feature-name]/spec.md` for the rest.
- **Backend Requirements** — structure, layering, middleware, dependencies added, logging. Route handlers hold no business logic.
- **API Contract** — every endpoint with request body, success body, status codes, headers, and every error code it can emit. End with contract invariants (what must appear in zero responses).
- **Data Model Changes** — the Prisma diff in a fenced block, plus numbered migration notes (`MIG-1…`) covering nullability, defaults, indexes, cascade behaviour, and row growth.
- **Authentication / Authorization** — a full endpoint × role matrix, plus non-negotiable rules (`AZ-1…`). State whether scoping happens in the query.
- **Validation** — a field table, plus rules (`VAL-1…`) explaining anything non-obvious.
- **Error Handling** — the response shape, a full code catalogue table, and rules (`ERR-1…`). Never leak Prisma errors or stack traces.
- **Edge Cases** — a numbered table (`EC-01…`): concurrency, duplicates-under-race, missing parents, boot-time misconfiguration.
- **Security Requirements** — numbered (`SEC-1…`), ending with a **"known accepted gaps"** entry stating the weaknesses plainly rather than leaving a reviewer to find them.
- **Performance Requirements** — numbered (`PERF-1…`) with real p95 numbers and named indexes. State what must **not** happen (no sequential scan, no loading rows into memory).
- **Acceptance Criteria** — see below.
- **Out of Scope** — a table of exclusions, each with a one-line reason. An exclusion without a reason reads as an oversight.
- **Dependencies** — what this blocks, what blocks it, new npm packages, new env vars, modified existing files (table with paths), external services.

### Acceptance criteria

Write them in precise **Given / When / Then** form, numbered `AC-B01…`.

**This project writes no automated tests — every criterion is verified by hand**, so each one must be checkable with a `curl` against the running API (plus a `psql` query where the proof is database state). Write the *observable* outcome — status, headers, body, row counts — not an assertion.

- Cover negatives explicitly: wrong role → `403`, no token → `401`, tampered body ignored, restricted field absent from every response.
- Cover concurrency where relevant — *fired concurrently*, not two sequential requests.
- Include at least one cross-cutting invariant stating a restricted field appears in **no** response from any endpoint.

### Style

- Link files as clickable relative paths from the spec's own location (e.g. `../../../src/server.ts`).
- Tables for matrices and catalogues; fenced `jsonc` for bodies; `prisma` for schema.
- Every requirement gets a stable ID so `plan.md` can reference it.
- Be decisive. A spec that says "consider using…" is not finished.

---

## Step 4 — After writing

1. Verify all 19 headings are present and in order.
2. Confirm every interview decision is reflected, with no silent additions.
3. Update the feature status table in `CLAUDE.md`.
4. If the feature has a UI, say that the frontend spec is the next artifact and that the two share one API contract — a change to endpoints, error shape, or cookie/header names must be made in both repos.
5. Report plainly: what you wrote, which decisions I made, and any assumption you had to state rather than resolve.

**Reference example:** `specs/features/authentication/spec.md` is an approved spec written to this standard. Match its depth and precision.

`plan.md` is a **later phase** — do not write it now unless I explicitly ask.
