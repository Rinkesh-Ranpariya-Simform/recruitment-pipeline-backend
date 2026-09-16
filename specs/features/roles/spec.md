# Roles — Open Requisition Management (Backend)

> **Status:** Approved — plan at [plan.md](./plan.md). **Revised twice after implementation: reads are
> recruiter-only**, and **delete now exists, restricted to `CLOSED` roles** — see
> [Revision](#revision--reads-became-recruiter-only) and
> [Revision 2](#revision-2--delete-exists-restricted-to-closed-roles)
> **Feature slug:** `roles`
> **Scope:** `backend/` — Express 5 + Prisma 7 + PostgreSQL
> **Counterpart:** [../../../../frontend/specs/features/roles/spec.md](../../../../frontend/specs/features/roles/spec.md)
> **Depends on:** [../authentication/spec.md](../authentication/spec.md) — implemented
> **Parent brief:** [../../../../recruitment-pipeline.md](../../../../recruitment-pipeline.md)

---

## Goal

Give the API the **open requisition** — the thing candidates are considered *against* — so that every later
model in this POC has something real to hang off.

This backend must:

1. Let a recruiter create an open role, read it back, list roles, amend it, and — once it is closed —
   delete it.
2. Make **`OPEN` / `CLOSED` the whole of a role's lifecycle**, changed only by a deliberate `PATCH`.
3. Enforce **recruiter-only access at the route, on every request — reads included.** The requisition
   surface belongs to recruiters; an interviewer has no endpoint here at all (AZ-1, revised).
4. Record who created or changed a role, so a status change is never an unexplained fact.
5. Resolve, once and permanently, the **name collision between "role" the user's permission and "role" the
   open requisition** — before four more features are written against the ambiguous name.

Success means: a later feature can write `candidate.roleId` and `round.roleId` without inventing the model
first, and `RECRUITER`-only mutation is proven by a request, not by the absence of a button.

---

## Revision — reads became recruiter-only

**What changed:** `GET /api/roles` and `GET /api/roles/:roleId` moved from *any authenticated user* to
`RECRUITER`-only. All four endpoints now carry `requireRole(UserRole.RECRUITER)`.

**Why:** the original AZ-1 argued that a role carries no restricted data, so there was nothing to protect an
interviewer from. That is true of a single requisition and false of the endpoint: `GET /api/roles` is the
whole hiring picture — every req open and closed, with a filter and a pager over it — and that is a
recruiter's working surface, not a fact an interviewer needs. The need the old rule was written for (*"which
req is my round on?"*) is narrower than the endpoint that was serving it, and is properly served by an
**assignment-scoped** query on the rounds feature — the same shape the POC's sharpest requirement already
demands for candidates ([../../../CLAUDE.md](../../../CLAUDE.md) § *Authorization & data exposure*). Serving a
narrow need from a broad endpoint is the habit that requirement exists to break.

**What it costs:** nothing yet. No interviewer-facing view exists to lose the data, because rounds do not
exist. The rounds feature must carry the role title on its own assignment-scoped response rather than
assuming a second call to `/api/roles` — recorded here so it is a designed-in requirement, not a discovery.

**What changed in this document:** the Goal, the scope decision, the actors table, US-05, BE-3, the
authorization matrix, AZ-1, AZ-2, the `403` row of the error table, ERR-4, EC-15/EC-16, SEC-1, XFE-8, and
AC-B02 / AC-B08 / AC-B09 / AC-B10 / AC-B18b. The frontend counterpart is revised in the same pass.

---

## Revision 2 — delete exists, restricted to `CLOSED` roles

**What changed:** `DELETE /api/roles/:roleId` is now a **registered route**. It hard-deletes the row, and it
refuses any role that is not `CLOSED` with `409 ROLE_NOT_CLOSED`. This feature has five endpoints, not four.

**Why the original rule went:** FR-6.4 forbade delete outright because "a requisition that candidates have
been assessed against is a historical record". The premise is sound and the conclusion was too wide. **Nothing
is assessed against a role yet** — candidates, rounds and feedback are all later features — so the record
being protected does not exist, while the cost is real and immediate: a recruiter who creates a requisition
with a typo'd title, or two of the same req, has no way to remove either. `CLOSED` is not an end state for
that role; it is a permanent row of noise in a list that has a pager over it.

**Why it is not a soft delete.** A `deletedAt` column makes every read in this module, and every join from
every feature that later references a role, carry a filter that is wrong by omission rather than by error —
the query still runs, it just quietly includes rows it should not. That is a permanent cost across the whole
schema, paid for a restore path nobody has asked for. The structured `role.deleted` log line (FR-8.5) is the
audit record, and it is honest about being a log rather than pretending to be recoverable state.

**What survives the original rule:** the **CLOSED-only guard** (FR-6.7). Deleting a requisition is two
deliberate acts — close it, then delete it — so an open req in circulation can never be removed by a single
action. That is the part of FR-6.4 that was actually protecting something, and it is now enforced by a
transaction rather than by the absence of a route.

**What the next feature owes this one:** the first model to take a foreign key to `Role` must decide, in its
own spec, what a delete does to it — refuse, or cascade (FR-6.10). Postgres's default is not a decision.

**What changed in this document:** the Goal, the scope decision, FR-6.4 (superseded), FR-6.6..FR-6.10, FR-7.1,
FR-8.2, FR-8.5, the API contract, MIG-6, the authorization matrix, AZ-5, the error table, ERR-5, EC-08,
EC-14, SEC-5, SEC-6, R-14, AC-B20, AC-B36..AC-B40, and Out of Scope. The frontend counterpart is revised in
the same pass.

---

## Pending Revision 3 — reads become authenticated-open, and FR-6.10 is answered

**Status: proposed, not yet approved.** Nothing below this heading has changed in the implementation. This
note exists so this spec does not silently contradict a drafted one.

The [candidate spec](../candidate/spec.md) proposes two changes to this feature:

1. **`GET /api/roles` and `GET /api/roles/:roleId` drop `requireRole(UserRole.RECRUITER)`**, so a candidate
   can browse open positions. This reverses *Revision — reads became recruiter-only* above. The three write
   endpoints are untouched. What replaces the guard is a **query-level** rule: a non-recruiter's `where`
   carries `status: OPEN` and their `select` is `PUBLIC_ROLE_SELECT`, so a `CLOSED` requisition is never
   fetched and answers `404` — see that spec's *Revision to the roles feature* for the full argument and its
   named cost.
2. **FR-6.10 is answered.** `Application` is the first model to take a foreign key to `Role`, and it takes
   `onDelete: Restrict`. `DELETE /api/roles/:roleId` on a `CLOSED` role with applications answers a **new**
   `409 ROLE_HAS_APPLICATIONS`, derived from the `P2003` violation. The existing `409 ROLE_NOT_CLOSED` is
   checked first.

**If that spec is approved, the sections to revise here are:** AZ-1, AZ-2, the authorization matrix, the
`403` row of the error table, ERR-4, EC-15/EC-16, SEC-1, XFE-8, FR-6.10, and AC-B02 / AC-B08 / AC-B09 /
AC-B10 / AC-B18b. The frontend counterpart is revised in the same pass.

---

## Background / Context

The POC brief opens on the problem this feature is the first half of:

> nobody — not even the hiring manager — can easily tell where a role is stuck or how long a candidate has
> been sitting at a given stage.

and §4 requires the schema to represent, at minimum, *"roles, candidates and which role(s) they're being
considered for"*. [../../../CLAUDE.md](../../../CLAUDE.md) states it as **"Role — an open req"**, first in the
list of models to build out.

Nothing else in the POC can be built first. A candidate is a candidate *for a role*; an interview round is a
round *on a role*; the pipeline view is *counts per stage per role*. This is the smallest model that unblocks
all three, and it is deliberately small: it holds no candidates, no stages and no aggregates, because each of
those is its own feature.

### Current state of `backend/`

|                | Today                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack          | Express 5.2, TypeScript ESM, Prisma 7.10, PostgreSQL, `tsx` for dev                                                                          |
| Structure      | The layering the auth feature introduced — `config/`, `lib/`, `middleware/`, `modules/<feature>/{routes,controller,service,schema}.ts`        |
| Schema         | [`prisma/schema.prisma`](../../../prisma/schema.prisma) — `Role` **enum** (`INTERVIEWER`/`RECRUITER`), `User`, `RefreshToken`. Two migrations |
| Identity       | `requireAuth` establishes `req.user = { id, role }`; `requireRole(...)` gates by it. Both shipped and verified                                |
| Validation     | `validate(schema)` parses **`req.body` only** — there is no param or query-string validation anywhere yet                                     |
| Error contract | `AppError` subclasses + a single error middleware producing `{ code, message, details? }`                                                     |
| Logging        | `pino` with a per-request `requestId`; auth events are structured, and there is no audit **table**                                            |
| Tests          | **none**, and none planned — verification is manual `curl` + `psql`                                                                          |

So this feature is the **first domain model in the POC**, the first module with a full CRUD-shaped surface,
and the first route with a path parameter — which is why it has to introduce param and query validation.

### The `Role` name collision — decided here, once

`Role` means two unrelated things in this codebase:

| Meaning               | Today           | Used by                                                           |
| --------------------- | --------------- | ----------------------------------------------------------------- |
| *Who you are*         | `enum Role`     | `User.role`, `requireRole`, the JWT `role` claim, `req.user.role`  |
| *An open requisition* | (doesn't exist) | This feature, and every feature after it                           |

**Prisma models and enums share one namespace**, so `model Role` and `enum Role` cannot coexist — this is a
hard schema error, not a style preference. One of them must be renamed, and the choice is load-bearing for
every file written from here on.

**Decision: the enum is renamed `UserRole`; the new model takes the name `Role`.**

- The domain language of the brief, of `CLAUDE.md`, of the API path (`/api/roles`) and of the frontend feature
  folder is all **"role = open req"**. Renaming the *model* to `JobRole` or `Requisition` would leave every one
  of those saying `role` while the code said something else, on every feature from now on.
- `UserRole` is simply the more accurate name for the enum. It reads correctly at every call site:
  `requireRole(UserRole.RECRUITER)` is "require the caller's user-role to be recruiter".
- The cost is a one-time mechanical rename across **eight** backend files and four frontend files, on a
  codebase with one shipped feature. The alternative is a permanent tax on every feature that follows.

The convention, from this spec forward: **`UserRole` is who you are. `Role` is an open req.** The
`requireRole` middleware keeps its name — it gates on the caller's `UserRole` and has nothing to do with
requisitions.

### Scope decisions taken before writing this spec

Settled, not open:

- **Five endpoints.** The brief lists four; `DELETE /api/roles/:roleId` was added afterwards and is
  restricted to `CLOSED` roles — see FR-6.6 and [Revision 2](#revision-2--delete-exists-restricted-to-closed-roles).
- **Every endpoint is `RECRUITER`-only — reads as well as writes.** The brief says *"only recruiters should
  be able to modify roles"* and is silent on reads; this spec originally read that silence as permission and
  left reads open to any authenticated user. **Revised after implementation** (see [Revision](#revision--reads-became-recruiter-only)):
  requisition management is a recruiter surface, and an interviewer is given no door into it. What an
  interviewer legitimately needs — the title of the req their round is on — reaches them through their own
  round's endpoint, scoped to their assignment, in the feature that introduces rounds. It does not come from
  an unscoped `GET /api/roles` (AZ-1).
- **No hiring manager. This is a deliberate deviation from the brief's suggested model** (§ "Possible model",
  which lists `hiringManagerId`), taken because the field has nothing to attach to yet: `HIRING_MANAGER` is
  not a `UserRole` in this POC — the authentication spec excluded it from the enum outright — so the column
  would point at a person with no corresponding role, grant no access, be writable by any recruiter, and be
  readable by everyone. A field with no rule and no reader is a liability, not a placeholder. **A role in this
  POC references no person at all.** It arrives with the feature that adds the user role and the
  hiring-manager views the brief lists as a stretch (§2) — see [Out of Scope](#out-of-scope).
- **A role therefore holds no restricted data, and no personal data of any kind.** The
  query-level-exclusion discipline the POC is built around has nothing to bite on here; its real test is
  candidate contact details, in the feature that introduces them.
- **Status changes are logged, not tabled.** The brief's audit-trail requirement (§6) names stage
  transitions, overrides and feedback — all candidate-scoped, all later features. Role changes emit
  structured log events now; the audit **table** is designed with the feature that first needs to query it.
- **No candidate, stage, round or aggregate is modelled here.** This feature ships a requisition and nothing
  that hangs off one.

---

## Users / Actors

| Actor                           | Authenticated? | Can do against this feature                                                                                                      |
| ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Anonymous caller**            | No             | Nothing. All four endpoints return `401 UNAUTHENTICATED`.                                                                        |
| **Interviewer** (`INTERVIEWER`) | Yes            | **Nothing.** All four endpoints return `403 FORBIDDEN` — reads included (AZ-1).                                                  |
| **Recruiter** (`RECRUITER`)     | Yes            | Everything: list, read, create, amend, open and close. **Every recruiter can amend every role** — there is no per-role ownership. |
| **Operator / developer**        | N/A            | Seeds demo roles with `npm run db:seed`, and may call any endpoint with a seeded recruiter's token.                               |

**There is no hiring-manager actor**, in this feature or anywhere in the POC as currently specified. The
brief lists one as an optional stretch (§2); adding it means adding a `UserRole`, which is its own spec.

---

## User Stories

**US-01** — As a **recruiter**, I want to open a requisition with a title and a description so that candidates
have something concrete to be considered against instead of a title in my head.

**US-02** — As a **recruiter**, I want to see every role and filter by whether it is still open, so I can tell
at a glance what my team is actually hiring for.

**US-03** — As a **recruiter**, I want to correct a role's title or description after creating it, without
recreating it and orphaning everything already attached to it.

**US-04** — As a **recruiter**, I want to close a role when the req is filled or pulled, and to be able to
reopen it if it comes back, without deleting the history attached to it.

**US-05** — As an **interviewer**, I want the requisition surface to be none of my business, so that the only
hiring data I am handed is the rounds I am actually assigned to. Every call to `/api/roles` refuses me, and
the client never offers me the page. *(Revised: this story previously asked for read access.)*

**US-06** — As a **developer**, I want a seeded set of roles so that the pipeline and candidate features have
something to attach to on a fresh database.

**US-07** — As a **reviewer**, I want the recruiter-only rule proven by a request from an interviewer's token,
not by the UI not offering a button.

---

## Functional Requirements

### FR-1 — Role records

- **FR-1.1** A role is `{ id, title, description, status, createdAt, updatedAt }`. **That is the whole model** —
  it holds no reference to any user.
- **FR-1.2** `status` is one of `OPEN` | `CLOSED`, stored as a Postgres enum (`RoleStatus`) — never a
  free-text column, per [../../../CLAUDE.md](../../../CLAUDE.md).
- **FR-1.3** `title` is **not** unique. Two teams hiring the same title is ordinary; the `id` is the identity.
- **FR-1.4** `description` is required and non-empty. A requisition with no description is the exact failure
  the brief opens on — *"candidate progress lives in one recruiter's head"* — so it is not optional.
- **FR-1.5** `createdAt` and `updatedAt` are database-managed. Neither is ever accepted from a request body.

### FR-2 — Listing roles (`GET /api/roles`)

- **FR-2.1** Requires an authenticated user. **Both** `UserRole`s may call it.
- **FR-2.2** Accepts optional `status=OPEN|CLOSED`. Omitted means **all** statuses — not a hidden default of
  `OPEN`, which would make closed roles invisible without explaining why.
- **FR-2.3** Paginated with `page` (default `1`) and `pageSize` (default `20`, max `100`). The response
  carries the pagination facts back, so the client never infers whether more exist.
- **FR-2.4** Ordered by `createdAt` **descending**, then `id` descending as a tiebreak so that ordering is
  total and paging cannot repeat or skip a row when two roles share a timestamp.
- **FR-2.5** An empty result — no roles, or none matching the filter — is `200 { roles: [], pagination }`,
  never `404`.
- **FR-2.6** A `page` beyond the last page is `200` with an empty `roles` array and a truthful `pagination`,
  not an error. The client renders its own empty state (FE spec EC-08).
- **FR-2.7** The list is **never unbounded.** This is explicitly not `GET /api/users`' unpaginated shape
  (auth PERF-6): roles are the first model the brief expects to be checked at scale (§8 — 200 open roles).

### FR-3 — Reading one role (`GET /api/roles/:roleId`)

- **FR-3.1** Requires an authenticated user. Both `UserRole`s may call it.
- **FR-3.2** `:roleId` must be a positive integer. A non-numeric or non-positive value is
  `400 VALIDATION_ERROR` — rejected at the boundary, before any query runs (brief §6).
- **FR-3.3** A well-formed id with no matching row is `404 NOT_FOUND`.
- **FR-3.4** Returns the same role shape as every other endpoint in this feature (FR-7.1).

### FR-4 — Creating a role (`POST /api/roles`)

- **FR-4.1** Requires an authenticated user whose `UserRole` is `RECRUITER`. Any other authenticated caller is
  `403 FORBIDDEN`; an anonymous caller is `401`.
- **FR-4.2** Accepts `{ title, description }` and nothing else.
- **FR-4.3** **`status` is not accepted on create.** Every role is created `OPEN`. Closing is a separate,
  deliberate act (FR-6.2) and must never be something that happens in the same request that created the role.
- **FR-4.4** `id`, `createdAt` and `updatedAt` are never accepted from the body. Unknown keys are stripped by
  the schema before a Prisma `data` object is assembled (SEC-3).
- **FR-4.5** Responds `201` with the created role.

### FR-5 — Amending a role (`PATCH /api/roles/:roleId`)

- **FR-5.1** Requires `RECRUITER`, exactly as FR-4.1.
- **FR-5.2** Accepts any **non-empty subset** of `{ title, description, status }`.
- **FR-5.3** A body with none of those keys is `400 VALIDATION_ERROR`. A `PATCH` that asks for nothing is a
  mistake, not a no-op worth a `200`.
- **FR-5.4** Only the keys present are written. Two recruiters amending **different** fields of the same role
  therefore do not clobber one another; two amending the **same** field are last-write-wins (EC-09).
- **FR-5.5** Patching a role that does not exist is `404 NOT_FOUND`, derived from the update failing rather
  than from a preceding read.
- **FR-5.6** Responds `200` with the full updated role, so the client never has to merge its own patch into
  cached state to know the truth.

### FR-6 — Status lifecycle

- **FR-6.1** The lifecycle is two states and both transitions between them: `OPEN → CLOSED` (filled, or
  pulled) and `CLOSED → OPEN` (it came back). Both are allowed.
- **FR-6.2** A status change happens **only** through `PATCH` with an explicit `status`. No other action —
  creating, editing a title, or anything in a later feature — changes it implicitly.
- **FR-6.3** Setting the status a role already has is accepted and idempotent: `200`, no transition event
  logged (FR-8.3). A client retrying a request must not produce a fictitious second close.
- **FR-6.4** ~~**There is no delete.**~~ **Superseded by FR-6.6.** The original rule registered no delete at
  all, on the grounds that `CLOSED` was the end state and a requisition candidates had been assessed against
  is a historical record. That reasoning did not survive contact with the actual POC: nothing is yet assessed
  against a role, and a recruiter who creates a requisition by mistake had no way to remove it. What the rule
  was protecting is preserved by the CLOSED-only guard in FR-6.7, not by the absence of the route.
- **FR-6.6** **`DELETE /api/roles/:roleId` exists and is a HARD delete** — the row is removed, not flagged.
  There is no `deletedAt`, no archive and no restore: a soft delete that every read then has to filter is a
  permanent tax on every query in this module and every feature that later joins to it, paid for a recovery
  path no one has asked for.
- **FR-6.7** **Only a `CLOSED` role may be deleted.** A role whose status is `OPEN` is refused with
  `409 ROLE_NOT_CLOSED` and is **not modified** — the endpoint never closes a role on the caller's behalf.
  This is the whole of what survives FR-6.4: removing a requisition is **two deliberate acts**, close then
  delete, and is never one misclick. The check reads the row inside the same transaction as the delete, so a
  concurrent `PATCH` reopening the role cannot slip between them (R-14).
- **FR-6.8** A successful delete responds **`204 No Content` with an empty body**. There is no role left to
  return and no envelope worth inventing to say so.
- **FR-6.9** Deleting a role that does not exist is `404 NOT_FOUND`. **Existence is decided before status**, so
  an unknown id is never a `409` about a status it does not have (EC-14).
- **FR-6.5** Closing a role has **no cascading effect** in this feature — there is nothing yet to cascade to.
  What closing means for candidates already in flight is decided by the candidates feature, which must state
  it explicitly rather than inherit silence from here.
- **FR-6.10** **Deleting** has no cascading effect *yet*, for the same reason: `Role` has no inbound foreign
  key today (MIG-6). **The feature that adds the first one owns this decision and must state it** — whether a
  role with candidates against it becomes undeletable, or the delete cascades. Silence here is not permission
  to let Postgres decide by default.

### FR-7 — Response shape

- **FR-7.1** Exactly one role shape is returned by every endpoint that returns a role — `DELETE` returns
  none (FR-6.8):

  ```jsonc
  {
    "id": 1,
    "title": "Senior Backend Engineer",
    "description": "Owns the pipeline service…",
    "status": "OPEN",
    "createdAt": "2026-09-15T10:00:00.000Z",
    "updatedAt": "2026-09-15T10:00:00.000Z"
  }
  ```

- **FR-7.2** **No user data appears in it** — no id, no name, no email. A role in this POC references no
  person, so there is no relation to embed and no projection decision to get wrong (contract invariant 2).
- **FR-7.3** The shape is produced by **one exported `select` constant**, used by every query in the module, so
  a field cannot be returned by one endpoint and not another (mirrors `SAFE_USER_SELECT`). Listing the columns
  explicitly rather than returning the whole row is the habit that matters when candidate contact fields
  arrive — it costs nothing to keep it sharp on a model where the stakes are low.

### FR-8 — Observability

- **FR-8.1** Every mutation emits a structured log line carrying the **acting user's id** — no role is
  created or changed by an anonymous or unattributed actor.
- **FR-8.2** Events: `role.created`, `role.updated`, `role.status_changed`, `role.deleted`.
- **FR-8.3** `role.status_changed` is emitted **only on an actual transition**, carrying `from` and `to`. A
  no-op status write (FR-6.3) emits `role.updated` and no transition event.
- **FR-8.4** Log lines carry **field names, never field values** for `title` and `description`. A
  `changedFields` array is what makes a change reconstructable; pasting a whole description into a log line is
  noise that never stops growing.
- **FR-8.5** `role.deleted` is emitted **after the transaction commits**, carrying `actorId` and `roleId`, so
  the log never claims a deletion that was rolled back. It is the **only** surviving record that the role
  existed — the row is gone — which is exactly why it is not optional.

### FR-9 — Seed data

- **FR-9.1** `prisma/seed.ts` is extended to create demo roles after its demo accounts, so a fresh database
  plus one command gives the frontend something to render and later features something to attach to.
- **FR-9.2** Three roles: two `OPEN`, one `CLOSED` — so a status filter has something to prove.
- **FR-9.3** Idempotent: re-running the seed produces no duplicates. Because `title` is not unique (FR-1.3),
  this is a `findFirst`-then-`create` per title rather than an `upsert`. **A check-then-write is acceptable
  here and nowhere else in this codebase**: the seed is a single-process script with no concurrent caller,
  whereas a request path must derive conflicts from a database constraint (ERR-2).

---

## Frontend Requirements

Full frontend behaviour is specified in
[../../../../frontend/specs/features/roles/spec.md](../../../../frontend/specs/features/roles/spec.md). Only
the obligations this backend **depends on or must accommodate** are recorded here:

- **XFE-1** The client renders **write controls** only for a `RECRUITER`, and treats that purely as an
  affordance. The backend must therefore behave correctly for a write it believes the UI never offers — which
  is exactly what AC-B16 and AC-B17 check.
- **XFE-2** The client paginates and filters through the query string (`?status=`, `?page=`), so those
  parameters must be safe to link to, safe to omit, and safe to get wrong — a bad value is a `400` with
  field-keyed details, never a `500` and never a silently ignored parameter (EC-02).
- **XFE-3** The client maps `details` from a `400 VALIDATION_ERROR` onto form fields, keyed by **request-body
  field name**. This is the second consumer of that contract after the login form, and the first with more
  than two fields — **it depends on `details` actually being populated** (BE-5).
- **XFE-4** The client renders `message` verbatim, so every `message` stays user-safe copy.
- **XFE-5** The client distinguishes a **route** 404 (the app's own not-found page) from a **data** 404 (this
  API saying no such role). The second must be `404 NOT_FOUND` in the standard error shape (FR-3.3).
- **XFE-6** After a mutation the client re-renders from **this response**, not from its own optimistic merge,
  so `POST` and `PATCH` must return the complete role (FR-4.5, FR-5.6).
- **XFE-7** The client mirrors `title` and `description` length rules for responsiveness. Where the two
  disagree, this spec is correct.
- **XFE-8** The client **never issues a roles call with an interviewer's session** — its own route guard
  renders a 404 for `/roles` first (frontend FE-10). That guard is an affordance and this API
  assumes nothing from it: AC-B02 is checked with a raw interviewer token precisely because the client is not
  the thing making the refusal true.

---

## Backend Requirements

> **How each of these is built — the file layout, the middleware composition, the transaction shapes,
> the literal `validate()` fix and the log field table — is
> [plan.md § Backend Changes](./plan.md#backend-changes).** This section states only what must be true.

### BE-1 — Structure

A new `src/modules/roles/` module following the shape the auth feature established, plus two new
middlewares — the API's first path-parameter and first query-string validation. Handlers validate,
delegate and shape a response. **All Prisma access, all status-transition logic and all event logging
live in the service** — per [../../../CLAUDE.md](../../../CLAUDE.md), business rules do not live in
route handlers.

### BE-2 — Param and query validation

- **BE-2.1** `validateParams(schema)` parses `req.params`. `validateQuery(schema)` parses `req.query`.
- **BE-2.2** Neither may reassign `req.query` — **Express 5 makes it a getter**, which is how
  `validate()` currently hands its parsed result downstream. Parsed values reach controllers on
  dedicated request properties instead, and controllers **never** re-read `req.params` or `req.query`:
  the un-coerced values are not to be trusted downstream.
- **BE-2.3** Both produce the same `400 VALIDATION_ERROR` with the same field-keyed `details` as body
  validation. A caller cannot tell from the shape which part of the request was wrong — only from the keys.
- **BE-2.4** Coercion happens in the schema, so a controller receives a real `number` and never parses a
  string itself.

### BE-3 — Middleware order

Authentication and authorization are settled **before** any parsing cost is paid (auth PERF-7), so an
interviewer's malformed request is a `403`, not a `400` — the API does not help an unauthorized caller fix
their payload or their query string. This holds on the reads too, now that they are gated:
`GET /api/roles?status=PENDING` with an interviewer's token is a `403`, never the `400` a recruiter would
get.

### BE-4 — Service layer

- **BE-4.1** `listRoles`, `getRole`, `createRole`, `updateRole`. No other export.
- **BE-4.2** The list runs its page query and its `count` in **one transaction**, so `total` cannot
  describe a different snapshot than the rows beside it.
- **BE-4.3** `updateRole` reads the current `status` and writes the new row **in a single transaction**, so
  the `from` it logs is the value the update actually moved off (FR-8.3).
- **BE-4.4** Prisma errors are translated at this layer and never escape it: `P2025` (record not found) →
  `NotFoundError`. A raw Prisma error never reaches the error middleware's output (ERR-2 of the auth spec).

### BE-5 — Fix `validate()`'s `details` accumulator (pre-existing defect)

[`src/middleware/validate.ts`](../../../src/middleware/validate.ts) accumulates its error details into a
temporary array and discards it, so the key is never assigned. **Every `400 VALIDATION_ERROR` this API has
ever returned carries `details: {}`.**

It is invisible today because the only form in the client is the login form, whose two client-side rules catch
everything before a request is sent. **This feature's forms are the first real consumer of `details`** (XFE-3),
so the fix belongs here rather than in a drive-by, and AC-B22 verifies it. This is a correction to shipped
behaviour, not a new requirement — the authentication spec's VAL-5 already mandates it.

### BE-6 — Logging

Three events — `role.created`, `role.updated` and `role.status_changed` — each carrying the acting user's
id and the role's id, and the last two carrying what changed (`changedFields`, or `from`/`to`).

`actorId` is always `req.user.id` — read from the verified token, never from a body (AZ-3). **Never logged:**
`title` or `description` values (FR-8.4), and everything already on the auth spec's never-log list.

### BE-7 — No new dependencies, no new environment variables

Express, Prisma, zod and pino already cover everything here. Nothing is added to `package.json` or
`.env.example`.

---

## API Contract

All endpoints are JSON, prefixed `/api`, and require `Authorization: Bearer <access token>`. Every error
response uses the shape in [Error Handling](#error-handling).

### `GET /api/roles` — Bearer · `RECRUITER`

Query parameters, all optional:

| Parameter  | Type               | Default | Notes                             |
| ---------- | ------------------ | ------- | --------------------------------- |
| `status`   | `OPEN` \| `CLOSED` | —       | Omitted means **all** statuses    |
| `page`     | integer ≥ 1        | `1`     |                                   |
| `pageSize` | integer 1–100      | `20`    | Above 100 is a `400`, not a clamp |

```jsonc
// 200 OK
{
  "roles": [
    {
      "id": 2,
      "title": "Product Designer",
      "description": "Owns the candidate-facing surfaces…",
      "status": "OPEN",
      "createdAt": "2026-09-15T10:05:00.000Z",
      "updatedAt": "2026-09-15T10:05:00.000Z"
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 3, "totalPages": 1 }
}
```

Errors: `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `500 INTERNAL_ERROR`

### `GET /api/roles/:roleId` — Bearer · `RECRUITER`

```jsonc
// 200 OK
{
  "role": {
    "id": 1,
    "title": "Senior Backend Engineer",
    "description": "…",
    "status": "OPEN",
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

Errors: `400 VALIDATION_ERROR` (`:roleId` not a positive integer) · `401` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500`

### `POST /api/roles` — Bearer · `RECRUITER`

```jsonc
// Request
{ "title": "Senior Backend Engineer", "description": "Owns the pipeline service…" }
```

```jsonc
// 201 Created
{
  "role": {
    "id": 1,
    "title": "Senior Backend Engineer",
    "description": "Owns the pipeline service…",
    "status": "OPEN",
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

`status` in the request body is **stripped, not honoured** — the created role is always `OPEN` (FR-4.3).

Errors: `400 VALIDATION_ERROR` · `401` · `403 FORBIDDEN` · `500`

### `PATCH /api/roles/:roleId` — Bearer · `RECRUITER`

```jsonc
// Request — any non-empty subset
{ "status": "CLOSED" }
```

```jsonc
// 200 OK — the complete role, not a diff
{
  "role": {
    "id": 1,
    "title": "Senior Backend Engineer",
    "description": "…",
    "status": "CLOSED",
    "createdAt": "…",
    "updatedAt": "2026-09-15T12:00:00.000Z"
  }
}
```

Errors: `400 VALIDATION_ERROR` (bad `:roleId`, empty body, unknown status) · `401` · `403 FORBIDDEN` ·
`404 NOT_FOUND` · `500`

### `DELETE /api/roles/:roleId`

Deletes a **closed** requisition permanently. `RECRUITER`-only, like every other endpoint here.

Success — **`204 No Content`, empty body** (FR-6.8). There is nothing left to return:

```http
DELETE /api/roles/7
Authorization: Bearer <recruiter access token>

HTTP/1.1 204 No Content
```

Refused, because the role is still `OPEN` (FR-6.7) — **the role is not modified**:

```jsonc
// HTTP/1.1 409 Conflict
{
  "code": "ROLE_NOT_CLOSED",
  "message": "Close the role before deleting it"
}
```

Errors: `400 VALIDATION_ERROR` (bad `:roleId`) · `401` · `403 FORBIDDEN` · `404 NOT_FOUND` (no such role —
checked **before** status, EC-14) · `409 ROLE_NOT_CLOSED` · `500`

### Contract invariants

1. The role shape is byte-identical across every endpoint that returns a role (FR-7.1), produced by one
   `select` (FR-7.3). `DELETE` returns no body at all (FR-6.8).
2. **No response in this feature contains any `User` data** — no id, no name, no email, no hash. A role
   references no person (FR-7.2).
3. `status` is never set by `POST`, and never changes except through an explicit `PATCH` (FR-6.2). `DELETE`
   never changes it either — it refuses an open role rather than closing it first (FR-6.7).
4. Every non-2xx body matches `{ code, message, details? }`.
5. **Exactly two endpoints write a `Role` row**, and both require `RECRUITER` on every request.

---

## Data Model Changes

Additive, plus one rename. On top of `20260914151935_add_auth`.

> **The Prisma schema diff, the index definitions and the migration procedure are
> [plan.md § Database Changes](./plan.md#database-changes).**

- The `Role` **enum** is renamed `UserRole`; the new **model** takes the name `Role` — see
  [The `Role` name collision](#the-role-name-collision--decided-here-once) above.
- A `RoleStatus` enum (`OPEN` | `CLOSED`) is added. `status` is never a free-text column.
- `Role` is `{ id, title, description, status, createdAt, updatedAt }` and **has no relation to `User`**:
  a requisition references no person in this POC (FR-7.2).
- Two indexes serve the only two list queries this feature runs — the status-filtered listing and the
  unfiltered one (PERF-1).

### Migration notes

- **MIG-1 — The enum rename is the risky part, and must be inspected before it is applied.** Prisma does not
  reliably detect an enum rename; it may generate a drop-and-recreate rather than an `ALTER TYPE … RENAME`.
  The generated SQL is **read before it is run against anything**. If it preserves `User.role`, it ships as
  generated; if it would drop the column or the rows, the migration is regenerated — **it is never
  hand-edited** (per [../../../CLAUDE.md](../../../CLAUDE.md)) — and the recovery path is
  `prisma migrate reset` followed by `npm run db:seed`, which is acceptable **only** because the database
  holds nothing but seeded demo accounts. The `plan.md` for this feature must carry the actual generated SQL
  and which of those two paths was taken.
- **MIG-2** The **column** stays `role` and the values stay `INTERVIEWER` / `RECRUITER`. **No API contract
  changes**: `POST /api/auth/signup` still takes `role: "RECRUITER"`, `/api/auth/me` still returns `role`, and
  the JWT claim is untouched. The rename is internal to the schema and the TypeScript types — **a live session
  must survive it**, which AC-B26 checks.
- **MIG-3** `status` has **no database default**, so a row cannot come into existence without a code path
  having chosen its status — the same reasoning as the auth spec's MIG-2 for `User.role`.
- **MIG-4** `description` is `String` (Postgres `text`), not a length-capped `varchar`. The 5000-character
  ceiling is a validation rule (VAL), enforceable at the boundary and changeable without a migration.
- **MIG-5** Both indexes are added **now**, not after a slow query is observed — the brief expects the query
  plan to be defensible at 200 roles (§8).
- **MIG-6** **`Role` has no foreign key**, so it participates in no cascade and nothing can be orphaned by
  the delete FR-6.6 introduces. *(Revised: this rule previously read "no row in it is ever deleted".)* **No
  migration is needed for delete** — a hard delete is a `DELETE` statement, and adding no column is precisely
  why it was chosen over a `deletedAt`. The first inbound foreign key changes this, and its own spec owns the
  `onDelete` decision (FR-6.10).

---

## Authentication / Authorization

### Authorization matrix

| Endpoint                    | Anonymous                    | INTERVIEWER | RECRUITER |
| --------------------------- | ---------------------------- | ----------- | --------- |
| `GET /api/roles`            | ❌ 401                       | ❌ **403**  | ✅        |
| `GET /api/roles/:roleId`    | ❌ 401                       | ❌ **403**  | ✅        |
| `POST /api/roles`           | ❌ 401                       | ❌ **403**  | ✅        |
| `PATCH /api/roles/:roleId`  | ❌ 401                       | ❌ **403**  | ✅        |
| `DELETE /api/roles/:roleId` | ❌ 401                       | ❌ **403**  | ✅ — `CLOSED` roles only (FR-6.7) |

### Non-negotiable rules

- **AZ-1** **Reads are `RECRUITER`-only, and that is a decision, not an over-correction.** *(Revised — this
  rule previously opened reads to both `UserRole`s.)* The requisition list is a recruiter's working surface:
  it shows every req the company has open and closed, which is more of the hiring picture than an interviewer
  is given anywhere else in this POC. An interviewer's legitimate need is narrower than the endpoint — they
  need the title of the req behind *their* round, which the rounds feature will serve from an
  assignment-scoped query, the same shape the POC's hard case (a candidate an interviewer is not assigned to)
  demands. Handing them an unscoped list instead is the wrong shape for the need, so it is not handed over.
- **AZ-2** `requireRole(UserRole.RECRUITER)` runs on **every** route in this module, on **every** request —
  the two reads as well as the two writes. The frontend's decision not to render a button, and its decision
  not to route an interviewer to `/roles` at all, are not part of this.
- **AZ-3** The acting user's role comes from the verified JWT claim resolved by `requireAuth` — never from a
  body, a query parameter, or a client-supplied header.
- **AZ-4** `401` means *"we don't know who you are"*; `403` means *"we know, and you may not"*. An
  unauthenticated write is `401`, not `403` (EC-10).
- **AZ-5** No per-role ownership: any recruiter may amend **or delete** any role. Recorded as a decision
  (SEC-5) so that a later "only the creating recruiter may close it" rule is a deliberate addition rather than
  a bug report. **There is no field on a role that names a person**, so ownership cannot be inferred from the
  data either — which is exactly why the delete's only guard is the role's *status* and not its creator.
- **AZ-6** **The CLOSED-only rule is a server rule, enforced on every request** (FR-6.7). The client not
  rendering a Delete button on an open role is an affordance, in the same sense and with the same standing as
  its decision not to render a "New role" button for an interviewer (SEC-1). A `DELETE` on an open role
  answers `409` whatever the client rendered.

---

## Validation

Authoritative. The frontend mirrors these for responsiveness only.

| Field         | Where                               | Rule                                      |
| ------------- | ----------------------------------- | ----------------------------------------- |
| `title`       | create (required), patch (optional) | trimmed, 1–120 chars after trimming        |
| `description` | create (required), patch (optional) | trimmed, 1–5000 chars after trimming       |
| `status`      | patch only                          | `OPEN` \| `CLOSED`                         |
| `roleId`      | path parameter                      | coerced integer, ≥ 1                       |
| `status`      | query parameter                     | optional, `OPEN` \| `CLOSED`               |
| `page`        | query parameter                     | optional, coerced integer, ≥ 1, default 1  |
| `pageSize`    | query parameter                     | optional, coerced integer, 1–100, default 20 |

- **VAL-1** Trimming happens **inside the schema** via `.trim()`, so every downstream consumer receives the
  normalised value and no service can forget to trim — the same mechanism as the auth spec's email
  normalisation (VAL-3 there).
- **VAL-2** A title or description of only whitespace fails `min(1)` **after** trimming. `"   "` is not a
  title.
- **VAL-3** Schemas strip unknown keys, so `status` on create, or `id` / `createdAt` / `updatedAt` on either
  write, are dropped before a Prisma `data` object is built (SEC-3).
- **VAL-4** The patch schema requires **at least one** recognised key, checked with a `.refine()` on the
  parsed object — after unknown-key stripping, so `{ "nonsense": 1 }` is an empty patch and is rejected
  (EC-05).
- **VAL-5** `pageSize` above 100 is a `400`, **not silently clamped**. A client that asked for 500 rows and
  received 100 without being told has been lied to about what it has.
- **VAL-6** Validation failures return **all** field errors at once, keyed by request-body (or parameter)
  name — which is the contract BE-5 fixes the implementation of.

---

## Error Handling

No new error codes. This feature reuses the catalogue the auth feature established.

| HTTP | `code`             | `message`                                 | Raised when                                                                      |
| ---- | ------------------ | ----------------------------------------- | -------------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR` | "Invalid request body"                    | zod rejects a body, a path parameter, or a query parameter                        |
| 401  | `UNAUTHENTICATED`  | "Authentication required"                 | Missing / malformed / expired access token                                        |
| 403  | `FORBIDDEN`        | "You do not have access to this resource" | Authenticated `INTERVIEWER` calling **any** of the five endpoints                 |
| 404  | `NOT_FOUND`        | "Resource not found"                      | No role with that id                                                             |
| 409  | `ROLE_NOT_CLOSED`  | "Close the role before deleting it"       | `DELETE` on a role whose status is `OPEN` (FR-6.7). The role is **not** modified  |
| 500  | `INTERNAL_ERROR`   | "Something went wrong"                    | Anything unhandled                                                               |

### Rules

- **ERR-1** `message` stays user-safe copy the client renders verbatim. It never names a table, a column, or
  an exception.
- **ERR-2** Prisma errors are translated in the service (`P2025` → `404`) and never reach the error
  middleware's output. As with `EMAIL_TAKEN` in the auth feature, an outcome that depends on database state
  is **derived from what the database did**, not from a preceding read — a check-then-write loses under a
  race and turns a clean `404` into a `500`.
- **ERR-3** `"Invalid request body"` is the message for a bad path or query parameter too. The **`details`
  keys** say which parameter was wrong; the message does not need to, and keeping one message for one code
  keeps the catalogue honest.
- **ERR-4** A `403` says nothing about whether the role exists. An interviewer patching role `999` gets `403`,
  not `404`, and so does an interviewer *reading* it — authorization is settled before existence is looked up
  (BE-3, EC-11). An interviewer therefore cannot use this API to probe which requisition ids exist.
- **ERR-5** On `DELETE`, **existence is decided before status**: an unknown id is `404`, never a `409` about a
  status it does not have (FR-6.9, EC-14). The ordering is not cosmetic — a `409` for a role that was already
  deleted would tell a recruiter to go and close something that is not there.
- **ERR-6** `ROLE_NOT_CLOSED` is its own `code`, not a reused `VALIDATION_ERROR`. The request was well-formed;
  what was wrong was the **state of the resource**, and the client branches on that to show a different
  message than "try again" (XFE-9). It carries no `details` — there is no offending field.

---

## Edge Cases

| #     | Case                                                         | Required behaviour                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EC-01 | `GET /api/roles/abc`                                         | `400 VALIDATION_ERROR` with `details.roleId`. No query runs. Never a `500` from a failed `parseInt`.                                                                                                                                                                 |
| EC-02 | `GET /api/roles?status=PENDING`                              | `400` with `details.status`. The parameter is **not** silently ignored, and the list is not returned unfiltered.                                                                                                                                                     |
| EC-03 | `GET /api/roles?page=0` or `?pageSize=101`                   | `400` with the offending key in `details`. No clamping (VAL-5).                                                                                                                                                                                                      |
| EC-04 | `GET /api/roles?page=99` with 3 roles                        | `200`, `roles: []`, `pagination.total: 3`, `totalPages: 1`. Truthful, not an error (FR-2.6).                                                                                                                                                                         |
| EC-05 | `PATCH` with `{}` or `{ "nonsense": 1 }`                     | `400` — unknown keys are stripped first, leaving an empty patch, which VAL-4 rejects.                                                                                                                                                                                |
| EC-06 | `POST` with `{ …, "status": "CLOSED" }`                      | `201` with `status: "OPEN"`. The key is stripped, not honoured and not an error (FR-4.3).                                                                                                                                                                            |
| EC-07 | `PATCH` setting `status: "CLOSED"` on an already-closed role | `200`, `updatedAt` bumps, `role.updated` logged, **no `role.status_changed`** (FR-6.3).                                                                                                                                                                              |
| EC-08 | `DELETE /api/roles/1` by a recruiter, role is `CLOSED`       | `204 No Content`, empty body, and the row is **gone** from the table. `role.deleted` is logged with the actor (FR-6.6, FR-6.8, FR-8.5). *(Revised — this case previously required a `404`.)*                                                                         |
| EC-14 | `DELETE` on a role that is `OPEN`                            | `409 ROLE_NOT_CLOSED`, and the row is **unchanged** — still present, still `OPEN`, `updatedAt` not bumped. The endpoint never closes a role on the caller's behalf (FR-6.7).                                                                                         |
| EC-14b | `DELETE /api/roles/9999` by a recruiter                     | `404 NOT_FOUND`, never `409`. Existence is decided before status (FR-6.9, ERR-5).                                                                                                                                                                                   |
| EC-14c | `DELETE` twice on the same closed role                      | First `204`, second `404`. The delete is **not** idempotent in its status code, and that is correct: the second call names a role that does not exist.                                                                                                               |
| EC-14d | A `PATCH` reopening a role races a `DELETE` of it           | Exactly one wins, and neither corrupts the other. The status read and the delete share one transaction, so the delete either sees `CLOSED` and removes the row, or sees `OPEN` and `409`s (R-14). There is no window in which an open role is deleted.               |
| EC-09 | Two recruiters `PATCH` the same role at the same instant     | Both succeed. Disjoint fields both survive; the same field is last-write-wins, and `updatedAt` plus the two log lines make the order reconstructable. **Accepted and documented** — a requisition edit is not the brief's concurrency case (§3.4), which is feedback. |
| EC-10 | Anonymous `POST /api/roles`                                  | `401`, never `403`. The API does not confirm that the endpoint would have been recruiter-only (AZ-4).                                                                                                                                                                |
| EC-11 | Interviewer `PATCH`es a role id that does not exist          | `403`, not `404` — authorization is decided before existence is (ERR-4).                                                                                                                                                                                             |
| EC-12 | `title` of `"   "` (whitespace only)                         | `400` — the rule applies after trimming (VAL-2).                                                                                                                                                                                                                     |
| EC-13 | A 5001-character description                                 | `400` with `details.description`. Not truncated.                                                                                                                                                                                                                     |
| EC-14 | A valid access token issued **before** the enum rename       | Still authenticates. The claim value is the unchanged string `"RECRUITER"` — only the TypeScript and Postgres type names moved (MIG-2).                                                                                                                              |
| EC-15 | Interviewer `GET /api/roles` or `GET /api/roles/:id`         | `403 FORBIDDEN` in the standard error shape, with **no role data in the body** — not a `200` with an empty list, which would imply there is nothing to see rather than nothing they may see (AZ-1).                                                                                                              |
| EC-16 | Interviewer `GET /api/roles?status=PENDING`                  | `403`, not `400`. Authorization precedes parsing (BE-3), so the API does not tell an unauthorized caller that their query string was also wrong.                                                                                                                                                              |

---

## Security Requirements

- **SEC-1 — The recruiter-only rule is enforced at the route, on every request.** `requireRole` sits on all
  four routes; the client's decision not to render a "New role" button, and its decision to answer an
  interviewer at `/roles` with its own 404, are affordances and are never the control (AZ-2). **AC-B02,
  AC-B16 and AC-B17 prove it with an interviewer's token**, against endpoints the UI never offers that user.
- **SEC-2 — A role references no person.** There is no user id, name or email anywhere in this model, its
  queries, or its responses, so there is nothing here that could leak one and no relation whose projection
  could be got wrong (FR-7.2, contract invariant 2). The query-level-exclusion discipline the POC is judged on
  meets its real test with candidate contact details; this feature simply has no restricted data.
- **SEC-3 — No mass assignment.** Unknown keys are stripped by the schema before any Prisma `data` object
  exists, so `id`, `createdAt`, `updatedAt` and `status`-on-create cannot be driven from a request body
  (VAL-3, EC-06).
- **SEC-4 — Every mutation is attributed.** `actorId` on every log line comes from the verified token (BE-6,
  FR-8.1). There is no path by which a role changes without a known actor — **and the log is the only place
  that attribution exists**, since the model itself records no person (FR-7.2).
- **SEC-5 — Known accepted gaps** (stated so a reviewer need not find them):
  - **No per-role ownership.** Any recruiter may amend or close any role, including one they did not create.
    Acceptable for a POC with one recruiter; it is the first thing to revisit if the actor list grows.
  - **Last-write-wins on concurrent edits** (EC-09). There is no `If-Match` / version check, so a recruiter
    can silently overwrite another's edit to the same field within the same second.
  - **No rate limiting**, inherited from the auth feature's documented gap.
  - **Delete is permanent and unrecoverable.** *(Revised — this bullet previously read "No soft-delete or
    restore", as a consequence of there being no delete at all.)* There is no `deletedAt`, no archive and no
    undo: a deleted role is gone, and the `role.deleted` log line is the only record it existed (FR-8.5). The
    CLOSED-only guard (FR-6.7) and the client's confirmation dialog are what stand between a recruiter and
    that outcome — deliberately, because a restore path costs every read in every future feature a filter.
    A title overwritten by mistake is likewise not recoverable, since nothing records what it was.
  - **Any recruiter may delete any role**, including one they did not create (AZ-5). Same gap as amending,
    with a worse outcome; it is the second thing to revisit if the actor list grows.

---

## Performance Requirements

- **PERF-1** `GET /api/roles` completes in **< 50 ms** p95 at 200 roles, filtered or not, served by
  `@@index([status, createdAt])` or `@@index([createdAt])`. **The query plan must be an index scan, not a
  sequential scan followed by a sort** — checked with `EXPLAIN ANALYZE` and recorded in `plan.md`.
- **PERF-2** `GET /api/roles/:roleId` completes in **< 30 ms** p95 — one primary-key lookup.
- **PERF-3** A list page costs **exactly two queries**: the page and its `count`, together in one transaction
  (BE-4.2). The model has no relation, so there is no relation to load and **no N+1 is possible in this
  feature at all** — the explicit `select` and the absence of incidental `include`s are what keep that true as
  the model grows (AC-B25).
- **PERF-4** `pageSize` is capped at 100 in the schema, so **no request can ask this endpoint for an unbounded
  result set.** This is the pattern for every list endpoint in the POC from here on; `GET /api/users`'
  unpaginated shape is the exception, allowed only because it returns tens of rows and has no UI.
- **PERF-5** `total` never counts rows the filter excludes — the `count` carries the same `where` as the page
  query, inside the same transaction.
- **PERF-6** Ordering is total (`createdAt desc, id desc`), so paging cannot repeat or drop a row when two
  roles share a `createdAt` (FR-2.4).

---

## Acceptance Criteria

Given/When/Then. **There is no automated test suite for this POC** — every criterion is signed off by hand
with `curl` against the running API, plus `psql` wherever the proof is database state. The exact commands
belong in [plan.md § Verification Commands](./plan.md#verification-commands).

Two access tokens are needed throughout: one for `recruiter@demo.test` and one for `interviewer1@demo.test`,
both seeded.

### Reading

- **AC-B01** — **Given** three seeded roles, **when** a recruiter calls `GET /api/roles`, **then** the
  response is `200`, `roles` has three entries newest-first, and `pagination` is
  `{ page: 1, pageSize: 20, total: 3, totalPages: 1 }`.
- **AC-B02** — **Given** the same data, **when** an **interviewer** calls `GET /api/roles` **and**
  `GET /api/roles/:id` with a real id, **then** **both** return `403 FORBIDDEN` in the standard error shape
  and **neither body contains a role, a `roles` array or a `pagination` object** (AZ-1, EC-15). *Revised: this
  criterion previously required a `200` identical to AC-B01.*
- **AC-B03** — **Given** two open and one closed role, **when** `GET /api/roles?status=OPEN` is called,
  **then** exactly the two open roles are returned and `pagination.total` is `2` — not `3`.
- **AC-B04** — **Given** three roles, **when** `GET /api/roles?pageSize=2&page=2` is called, **then** one role
  is returned, `totalPages` is `2`, and it is a role **not** present on page 1.
- **AC-B05** — **Given** three roles, **when** `GET /api/roles?page=99` is called, **then** the response is
  `200` with `roles: []` and `total: 3`.
- **AC-B06** — **Given** a seeded role, **when** `GET /api/roles/:id` is called with its id, **then** the
  response is `200` and the role object is **deep-equal** to that role's entry in the `GET /api/roles`
  response — one shape, one `select` (FR-7.1).
- **AC-B07** — **Given** no role with id `9999`, **when** `GET /api/roles/9999` is called, **then** the
  response is `404 NOT_FOUND` in the standard error shape.
- **AC-B08** — **Given** a **recruiter's** token, **when** `GET /api/roles/abc` is called, **then** the
  response is `400 VALIDATION_ERROR` and `details.roleId` is non-empty.
- **AC-B09** — **Given** a **recruiter's** token, **when** `GET /api/roles?status=PENDING` is called, **then**
  the response is `400` with `details.status` — and **not** an unfiltered `200`.
- **AC-B10** — **Given** a **recruiter's** token, **when** `GET /api/roles?pageSize=101` is called, **then**
  the response is `400`, not a silently clamped `200` (VAL-5).

### Creating

- **AC-B11** — **Given** a recruiter's token, **when** `POST /api/roles` is called with a valid title and
  description, **then** the response is `201`, `status` is `"OPEN"`, and `id`, `createdAt` and `updatedAt` are
  present.
- **AC-B12** — **Given** a recruiter's token, **when** `POST /api/roles` is called with `status: "CLOSED"` in
  the body, **then** the response is `201` with `status: "OPEN"` (EC-06).
- **AC-B13** — **Given** a recruiter's token, **when** `POST /api/roles` is called with an empty or
  whitespace-only `title`, **then** the response is `400`, `details.title` is non-empty, and **no row is
  created** (verified with `psql`).
- **AC-B14** — **Given** a recruiter's token, **when** `POST /api/roles` omits `description`, **then** the
  response is `400` with `details.description` (FR-1.4).
- **AC-B15** — **Given** a recruiter's token, **when** `POST /api/roles` is called with
  `{ title, description, id: 1, createdAt: "1999-01-01T00:00:00.000Z" }`, **then** the response is `201`, the
  new role has a fresh autoincrement `id` and a `createdAt` of now — the extra keys were stripped (SEC-3).

### Authorization

- **AC-B16** — **Given** an **interviewer's** token, **when** `POST /api/roles` is called with a perfectly
  valid body, **then** the response is `403 FORBIDDEN` and **no row is created**. *This is the criterion that
  proves the brief's "only recruiters should be able to modify roles".*
- **AC-B17** — **Given** an **interviewer's** token, **when** `PATCH /api/roles/:id` is called with
  `{ status: "CLOSED" }`, **then** the response is `403` and the role's `status` is unchanged in the database.
- **AC-B18** — **Given** an interviewer's token, **when** `PATCH /api/roles/9999` is called, **then** the
  response is `403`, **not** `404` — authorization precedes existence (EC-11).
- **AC-B18b** — **Given** an interviewer's token, **when** `GET /api/roles?status=PENDING` is called, **then**
  the response is `403`, **not** the `400` the same call earns a recruiter (EC-16, BE-3).
- **AC-B19** — **Given** **no** `Authorization` header, **when** each of the five endpoints is called, **then**
  every one returns `401 UNAUTHENTICATED` — not `403`, and not `404`.
- **AC-B20** — **Given** an **interviewer's** token and a role that exists, **when** `DELETE /api/roles/:id` is
  called, **then** the response is `403 FORBIDDEN` and **the row still exists** — the refusal happens before
  existence or status is looked up (AZ-6, ERR-4). *(Revised — this criterion previously required a `404`,
  because the route was unregistered.)*

### Amending

- **AC-B21** — **Given** an open role, **when** a recruiter `PATCH`es `{ title: "New title" }`, **then** the
  response is `200`, the title changed, `description` and `status` are **unchanged**, and `updatedAt` is later
  than `createdAt`.
- **AC-B22** — **Given** a recruiter's token, **when** `PATCH` is called with `{ title: "", description: "" }`,
  **then** the response is `400` and `details` contains **both** `title` and `description` with non-empty
  message arrays. *This is the criterion that catches the `validate()` defect in BE-5 — an empty `details: {}`
  fails it.*
- **AC-B23** — **Given** a recruiter's token, **when** `PATCH` is called with an empty body `{}`, **then** the
  response is `400` (EC-05).
- **AC-B24** — **Given** an open role, **when** a recruiter `PATCH`es `{ status: "CLOSED" }` twice, **then**
  both responses are `200` with `status: "CLOSED"`, and the server log shows `role.status_changed` **once**
  and `role.updated` twice (EC-07, FR-8.3).

### Cross-cutting

- **AC-B25** — **Given** 20 roles, **when** `GET /api/roles?pageSize=20` is called with the Prisma query log
  on, **then** **exactly two** SQL statements are issued — the page and its count (PERF-3).
- **AC-B26** — **Given** a user logged in **before** the enum rename migration is applied, **when** the
  migration is applied and that user's still-valid access token is used against `GET /api/auth/me`, **then**
  the response is `200` with `role: "RECRUITER"` — the rename changed no API contract (MIG-2, EC-14).
- **AC-B27** — **Given** every endpoint in this feature is exercised in turn, **when** each response body is
  inspected, **then** **no body contains any user field at all** — no `name`, no `email`, no `passwordHash`,
  no user id (SEC-2, contract invariant 2).
- **AC-B28** — **Given** a recruiter creates and then closes a role, **when** the server log is read, **then**
  it contains `role.created` and `role.status_changed` lines carrying that recruiter's `actorId`, and
  **neither line contains the title or description text** (FR-8.4).
- **AC-B29** — **Given** `npm run db:seed` is run twice on a fresh database, **when** the `Role` table is
  inspected, **then** it contains exactly three rows both times and the command exits `0` both times
  (FR-9.3).
- **AC-B30** — **Given** 200 seeded roles, **when** `EXPLAIN ANALYZE` is run on the query behind
  `GET /api/roles?status=OPEN`, **then** the plan uses the `status, createdAt` index and shows no sequential
  scan of `Role` (PERF-1).

### Deleting

- **AC-B36** — **Given** a recruiter's token and a role whose status is `CLOSED`, **when**
  `DELETE /api/roles/:id` is called, **then** the response is **`204` with a completely empty body**, and
  `SELECT * FROM "Role" WHERE id = :id` returns **no rows** (FR-6.6, FR-6.8). A `200`, or a `204` carrying
  JSON, is a failure.
- **AC-B37** — **Given** a recruiter's token and a role whose status is `OPEN`, **when** `DELETE` is called,
  **then** the response is `409` with `code: "ROLE_NOT_CLOSED"`, **and** a subsequent `GET` of that role
  returns it unchanged — same `status`, same `updatedAt` (FR-6.7, EC-14). A role silently closed by the
  attempt is a failure.
- **AC-B38** — **Given** a recruiter's token, **when** `DELETE /api/roles/9999` is called, **then** the
  response is `404 NOT_FOUND`, **not** `409` (FR-6.9, ERR-5, EC-14b).
- **AC-B39** — **Given** a closed role is deleted successfully, **when** the server log is read, **then** it
  contains exactly one `role.deleted` line carrying that recruiter's `actorId` and the `roleId`, and **the
  line does not contain the title or description text** (FR-8.4, FR-8.5).
- **AC-B40** — **Given** the same closed role, **when** `DELETE` is called twice, **then** the first returns
  `204` and the second returns `404` (EC-14c).
- **AC-B41** — **Given** a recruiter's token, **when** `DELETE /api/roles/abc` is called, **then** the response
  is `400 VALIDATION_ERROR` with `roleId` in `details` — the param schema guards this route exactly as it
  guards `GET` and `PATCH` (FR-3.2).

---

## Out of Scope

Explicitly excluded. Each is a deliberate decision, not an omission.

| Excluded                                                                       | Note                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hiring manager — the field, the relation and the concept**                   | **A deliberate deviation from the brief's suggested model.** `hiringManagerId` is not in the schema, not in any request, and not in any response. `HIRING_MANAGER` is not a `UserRole` (the auth spec excluded it), so the column would reference a person with no role, grant nothing, and have no reader. It arrives with the `UserRole` and the views that need it — together, in one spec, or not at all. |
| **`HIRING_MANAGER` as a `UserRole`**                                           | Still excluded from the enum. Adding it is an enum migration plus its own spec, and is what the brief's §2 stretch actor needs before any of the above is worth building.                                                                                                        |
| **Hiring-manager-scoped views** ("my open roles", ageing for my reqs)          | The brief's §2 stretch. Needs both the `UserRole` and the relation above.                                                                                                                                                                                                       |
| ~~**`DELETE /api/roles/:roleId`**~~ — **now in scope**                         | **No longer excluded.** Added in [Revision 2](#revision-2--delete-exists-restricted-to-closed-roles): a hard delete, restricted to `CLOSED` roles (FR-6.6, FR-6.7).                                                                                                             |
| **Soft delete / archive / restore** (`deletedAt`, an undo, a trash view)       | Considered and rejected with the delete itself. A nullable `deletedAt` puts a filter on every read in this module and every future join to it — wrong by omission rather than by error — to buy a restore path nobody asked for. `role.deleted` in the log is the audit record (FR-8.5, SEC-5). |
| **Bulk delete**                                                                | Covered by the bulk-operations row below, and worse: one mistaken request would remove many requisitions at once.                                                                                                                                                              |
| **Search and sort**                                                            | No `?q=`, no `?sortBy=`. Newest-first only. At 200 roles with a status filter this is usable; a search needs an index decision that deserves its own change.                                                                                                                     |
| **Optimistic concurrency** (`If-Match` / a version column)                     | Last-write-wins, documented (EC-09). The brief's concurrency requirement is about feedback on a round, not requisition edits.                                                                                                                                                    |
| **Candidates, stages, rounds, feedback, overrides**                            | Every one is its own feature. This ships the requisition and nothing hanging off it.                                                                                                                                                                                            |
| **Pipeline counts and ageing on a role**                                       | The aggregate endpoints the brief requires (§3.5) belong to the pipeline feature; they will read this model, not extend it.                                                                                                                                                     |
| **An audit table**                                                             | Role changes are structured log events (FR-8). The queryable audit trail is designed with the stage/override feature that first needs to read it back.                                                                                                                          |
| **Role templates, departments, locations, headcount, salary bands, seniority** | Not in the brief's model and not needed by any later feature here.                                                                                                                                                                                                              |
| **Bulk operations**                                                            | No bulk close, no bulk create.                                                                                                                                                                                                                                                  |
| **Automated tests of any kind**                                                | Every criterion above is verified manually. A test runner and suite remain a deliberate later decision — no test dependency, config or file is added.                                                                                                                           |

---

## Dependencies

### Blocked by

**[The authentication feature](../authentication/spec.md)** — implemented. This feature is entirely built on
`req.user.{id, role}`: the `RECRUITER` gate, the `actorId` on every log line, and the fact that no endpoint
here has an anonymous path.

### Blocks

**Candidates, interview rounds, feedback, stage overrides, and the pipeline/ageing views.** A candidate is a
candidate *for a role*; a round is a round *on a role*; the pipeline view is *counts per stage per role*. None
can be modelled before `Role` exists.

### New npm dependencies

**None.** Express, Prisma, zod and pino cover all of it (BE-7).

### New environment variables

**None.**

### Modified existing files

Eight existing files change, plus the new `src/modules/roles/**` and the two new middlewares (BE-1).
Six of the eight are the mechanical `Role` → `UserRole` rename; the other two are
[`src/app.ts`](../../../src/app.ts) mounting the router and
[`src/middleware/validate.ts`](../../../src/middleware/validate.ts) carrying the BE-5 defect fix.

> **The file-by-file table is [plan.md § Backend Changes](./plan.md#backend-changes).**

### Infrastructure

A running PostgreSQL instance and one new migration. **No separate test database** — verification is manual
against the development database using the seeded accounts and roles.

### External dependencies

**None.**

### Cross-repo

The frontend counterpart shares this API contract and the `UserRole` rename. A change to the endpoints, the
role shape, the error shape, or the enum naming must be made in **both** specs — see
[../../../../frontend/specs/features/roles/spec.md](../../../../frontend/specs/features/roles/spec.md).
