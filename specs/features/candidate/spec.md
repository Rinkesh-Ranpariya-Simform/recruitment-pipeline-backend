# Candidate — Self-Signup, Job Browsing & Applications (Backend)

> **Status:** Draft — awaiting approval. `plan.md` is the next artifact and does not exist yet.
> **Feature slug:** `candidate`
> **Scope:** `backend/` — Express 5 + Prisma 7 + PostgreSQL
> **Counterpart:** [../../../../frontend/specs/features/candidate/spec.md](../../../../frontend/specs/features/candidate/spec.md)
> **Depends on:** [../authentication/spec.md](../authentication/spec.md) — implemented · [../roles/spec.md](../roles/spec.md) — implemented
> **Revises:** [../roles/spec.md](../roles/spec.md) AZ-1 (reads become authenticated-open) and FR-6.10 (the `Role` delete decision)
> **Parent brief:** [../../../../recruitment-pipeline.md](../../../../recruitment-pipeline.md)

---

## Goal

Give the POC its **third actor**: a person who creates their own account, browses open requisitions, applies
to them, and watches their own progress — and nothing else.

This backend must:

1. Add `CANDIDATE` to `UserRole`, so a candidate is a first-class authenticated identity rather than a row a
   recruiter types in.
2. Turn `POST /api/auth/signup` into a **candidate-only** endpoint by **removing `role` from the contract
   entirely** — closing SEC-11.1, the open privilege-escalation path the authentication spec shipped with and
   flagged.
3. Introduce `Application` — the join between a candidate and a requisition — carrying the pipeline stage and
   the ageing timestamp every later recruiter feature reads.
4. Let any authenticated user read requisitions, while **a non-recruiter's query can only ever match `OPEN`
   rows** — the `status: OPEN` predicate is part of the query, not a filter applied to its result.
5. Return a candidate **only their own applications**, scoped inside the query, with no endpoint that takes an
   application id at all.
6. Guarantee that **no interviewer feedback, interviewer identity, internal note, or override reason is ever
   selected** into a candidate-facing response — the same query-level exclusion the brief demands for contact
   details, pointed the other way.

Success means: a candidate can sign up, find a job, apply, and see `Applied: Sep 15 · Status: Interview`,
while every recruiter-internal fact about their application is absent from the row Postgres returned — not
absent from the JSON the controller wrote.

---

## Background / Context

The brief's §2 actor table lists three roles, and **candidate is not one of them**. There, a candidate is a
_record_ a recruiter manages:

> Candidates are tracked against open roles through a defined, finite set of pipeline stages.

This feature makes the candidate a _user_. That is a deliberate **extension beyond the brief**, requested
directly, and it is recorded here so a reviewer reads it as a decision rather than a misreading of §2. It
changes none of the brief's requirements: §3.2 (interviewer scoping), §3.3 (overrides) and §3.6 (contact
details) are untouched, and the new actor is strictly _less_ privileged than either existing one.

It also closes something the brief's §6 already objected to. The authentication spec shipped
[`auth.routes.ts`](../../../src/modules/auth/auth.routes.ts) carrying its own indictment:

> SEC-11.1: `/signup` is anonymous AND accepts a `role`, and it is the only account-creation path there is.
> Anyone who can reach this API can mint a RECRUITER.

Candidate self-signup is the reason to fix it: the endpoint has to stay public, so it can no longer be
role-accepting.

### Current state of `backend/`

|                | Today                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack          | Express 5.2, TypeScript ESM, Prisma 7.10, PostgreSQL, `tsx` for dev, `zod` 4.6                                                                      |
| Structure      | `config/`, `lib/`, `middleware/`, `modules/<feature>/{routes,controller,service,schema,*.select}.ts`                                                |
| Schema         | [`prisma/schema.prisma`](../../../prisma/schema.prisma) — `UserRole` enum (`INTERVIEWER`/`RECRUITER`), `RoleStatus`, `User`, `RefreshToken`, `Role` |
| Migrations     | Three: `init`, `add_auth`, `add_roles`                                                                                                              |
| Identity       | `requireAuth` sets `req.user = { id, role }` from the access-token claims; `requireRole(...)` gates on it                                           |
| Signup         | `POST /api/auth/signup`, anonymous, **takes `role` in the body**, returns `201 { user }` with no token                                              |
| Roles          | Five endpoints, **all `RECRUITER`-only including the two reads**, paged, `?status=` filter, `DELETE` refuses a non-`CLOSED` role                    |
| Validation     | `validate` / `validateParams` / `validateQuery`, all zod, all stripping unknown keys                                                                |
| Error contract | `AppError` subclasses → `{ code, message, details? }`; eight `ErrorCode` values                                                                     |
| Exclusion      | `SAFE_USER_SELECT` and `ROLE_SELECT` — explicit column lists, never a whole-row fetch                                                               |
| Tests          | **none**, and none planned — verification is manual `curl` + `psql`                                                                                 |

### Decisions settled during the interview

| #    | Question                                    | Decision                                                                                           | Recorded in                |
| ---- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------- |
| D-1  | How to split this work                      | **One feature, `candidate`**, specced separately in each repo                                      | this document              |
| D-2  | How a candidate is modelled                 | `UserRole` gains `CANDIDATE`; **no** `CandidateProfile` table                                      | FR-1, MIG-1                |
| D-3  | Signup contract                             | **`role` removed from the body entirely**; the service hard-codes `CANDIDATE`                      | FR-2, SEC-1                |
| D-4  | Domain depth                                | Introduce `Application` + `PipelineStage` + `ApplicationStatus` now                                | FR-5, MIG-3                |
| D-5  | `DELETE /api/roles/:roleId` vs applications | **`onDelete: Restrict`** → `409 ROLE_HAS_APPLICATIONS`                                             | FR-8, MIG-7                |
| D-6  | Duplicate applications                      | **Unlimited** — no unique constraint on `(candidateUserId, roleId)`                                | FR-5.6, EC-06, SEC-11      |
| D-7  | Stage vs status                             | **Two columns** — `status` (`ACTIVE`/`HIRED`/`REJECTED`), `currentStage` (`APPLIED`→`OFFER`)       | FR-5.4, MIG-4              |
| D-8  | Withdrawal                                  | **Not in the enum.** `WITHDRAWN` is not a value and no endpoint writes one                         | Out of Scope               |
| D-9  | Job browsing endpoint                       | **Reuse `/api/roles`.** Reads open to any authenticated user; writes stay `RECRUITER`-only         | FR-4, AZ-3, Revision below |
| D-10 | Closed requisitions                         | A non-recruiter's query **forces `status: OPEN`** — a `CLOSED` role is a `404`, not a filtered row | FR-4.4, AZ-4               |
| D-11 | Search                                      | **Title only**, case-insensitive `contains`, no description search                                 | FR-4.6, PERF-4             |
| D-12 | Profile                                     | **No new endpoint and no new table.** `GET /api/auth/me` serves the profile view for every role    | FR-7                       |
| D-13 | Application payload                         | **Flat row** — role title, applied date, status, stage. No history, no ageing number               | FR-6.3                     |

### One deviation from the interview wording, stated openly

D-9's chosen option described "a narrower select" for non-recruiter callers. This spec implements that as
`PUBLIC_ROLE_SELECT` (FR-4.5), which omits **only** `updatedAt`. `Role` carries no restricted column — it
"references NO person", per the model's own doc comment — so there is nothing further to exclude, and a larger
divergence would cost the frontend a second type for no protection. The protection in D-9 comes from the
forced `status: OPEN` predicate (D-10), not from the column list.

---

## Revision to the roles feature — reads become authenticated-open

**What changes:** `GET /api/roles` and `GET /api/roles/:roleId` drop `requireRole(UserRole.RECRUITER)`. All
three user roles may call them. `POST`, `PATCH` and `DELETE` are unchanged and stay `RECRUITER`-only.

**What this reverses:** the roles spec's _"Revision — reads became recruiter-only"_, and with it the line in
[../../../CLAUDE.md](../../../CLAUDE.md): _"Do not reintroduce a broad roles read to satisfy a narrow need."_
That rule was written against exactly this move and is being overridden deliberately, not overlooked.

**Why it is being overridden:** a candidate's need here is not narrow. Browsing open requisitions **is** the
job-list surface, one-for-one with `GET /api/roles?status=OPEN`, so a second module would be the same query
behind a second name.

**What makes it safe anyway:** the widening is of the **route guard**, not of the **query**. A non-recruiter's
`where` clause is built with `status: OPEN` forced in (FR-4.4) and their `select` is `PUBLIC_ROLE_SELECT`
(FR-4.5). A `CLOSED` requisition is not fetched, ranked, counted in the pager, or returned — it is a `404`. So
the property the original revision protected — _the whole hiring picture is a recruiter's surface_ — still
holds, enforced one layer deeper than before.

**What it costs, named plainly:** an interviewer regains a read they were deliberately denied, and the roles
spec's promise that _"the rounds feature must carry the role title on its own assignment-scoped response"_ is
no longer forced by the API. The rounds feature **should still do it** — an assignment-scoped title is one
query instead of two — but it is now a convention rather than a constraint. This is the cost of D-9, and it is
accepted.

**What must change alongside this spec:** a `Revision 3` note in [../roles/spec.md](../roles/spec.md) and in
the frontend roles spec, and the `CLAUDE.md` paragraph quoted above, so the documents do not contradict each
other.

---

## Users / Actors

| Actor                 | May do, after this feature                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anonymous**         | `POST /api/auth/signup` — creates a `CANDIDATE` and **nothing else**. `login`, `refresh`, `logout` as before                                                     |
| **Candidate** _(new)_ | Read `OPEN` requisitions only · apply to one · list **their own** applications · read their own `/api/auth/me`                                                   |
| **Interviewer**       | Everything they could before, **plus** reading `OPEN` requisitions (Revision above). No application access                                                       |
| **Recruiter**         | Everything they could before, unchanged: all requisitions in both statuses, all five roles endpoints. **No application endpoints yet** — that is a later feature |

**Deliberate POC trade-offs, so they are not read as oversights:**

- **A recruiter cannot see applications through the API yet.** The rows exist and are queryable in `psql`, but
  no recruiter-facing endpoint reads them. That surface belongs to the pipeline feature, which owns the
  aggregates and the ageing view; shipping half of it here would mean specifying counts-per-stage twice.
- **A candidate can apply to the same requisition without limit** (D-6). See SEC-11 and EC-06.
- **Nothing writes a stage other than `APPLIED` or a status other than `ACTIVE`.** The enums are defined in
  full so later features extend the row instead of migrating 20,000 of them; the seed supplies the other
  combinations so the UI has something real to render (FR-10.3).
- **No email verification, no password reset, and no rate limit** on the now-public signup path (SEC-12).

---

## User Stories

| ID        | Story                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **US-01** | As a visitor, I want to create my own account from the app, so that I can apply without a recruiter provisioning me.                      |
| **US-02** | As an operator, I want signup to be _incapable_ of creating a recruiter, so that a public endpoint cannot hand out privilege.             |
| **US-03** | As a candidate, I want to see the list of open positions, so that I know what I can apply to.                                             |
| **US-04** | As a candidate, I want to search that list by title, so that I can find a specific role without paging.                                   |
| **US-05** | As a candidate, I want to open a position and read its full description, so that I can decide before applying.                            |
| **US-06** | As a candidate, I want to apply with one action, so that applying does not require filling in a profile first.                            |
| **US-07** | As a candidate, I want a list of everything I applied to, with the date and where I have got to, so that I am not left guessing.          |
| **US-08** | As a candidate, I want to be certain I cannot see interviewer feedback or recruiter notes, so that the status I am shown is all there is. |
| **US-09** | As any user, I want a profile view showing who I am signed in as, so that the account I am acting under is never ambiguous.               |
| **US-10** | As a recruiter, I want deleting a requisition to be refused once someone has applied, so I cannot erase an application by tidying a list. |

---

## Functional Requirements

### FR-1 — Candidate identity

- **FR-1.1** `UserRole` gains a third value, `CANDIDATE`. The enum becomes
  `INTERVIEWER | RECRUITER | CANDIDATE`.
- **FR-1.2** A candidate is an ordinary `User` row. There is **no** `Candidate` table, no `CandidateProfile`
  table, and no second authentication path (D-2).
- **FR-1.3** Login, refresh, rotation, reuse detection and logout behave identically for a candidate. No code
  in [`auth.service.ts`](../../../src/modules/auth/auth.service.ts) branches on the new value.
- **FR-1.4** The access token's `role` claim carries `CANDIDATE`, so `requireRole` gates on it with **no
  change to the middleware**.
- **FR-1.4a** _(added during implementation — this spec was wrong.)_ FR-1.4 was true of `requireRole` and
  false of the layer beneath it. [`lib/tokens.ts`](../../../src/lib/tokens.ts)'s `verifyAccessToken` validated
  the claim against **two hard-coded literals** — `role !== INTERVIEWER && role !== RECRUITER` — so every
  candidate token was rejected as malformed and answered `401` before `requireRole` ever ran. The fix does not
  add a third literal: `isUserRole` now tests membership of the `UserRole` enum, so a role added to the schema
  needs no edit here. This is a shape check, not an authorization one — deciding what a role may _do_ remains
  `requireRole`'s job, on a route.
- **FR-1.5** `SAFE_USER_SELECT` is unchanged, and `GET /api/auth/me` returns a candidate in the same shape as
  every other user.
- **FR-1.6** `GET /api/users` continues to return **interviewers only**. Candidates never appear in it, and
  the service's existing `where: { role: UserRole.INTERVIEWER }` guarantees that without modification.

### FR-2 — Self-service signup

- **FR-2.1** `POST /api/auth/signup` stays anonymous and stays the only HTTP account-creation path.
- **FR-2.2** **`role` is removed from `signupSchema`.** The accepted body is exactly `{ name, email, password }`.
- **FR-2.3** A body carrying `role` is **silently stripped**, not rejected — zod's object default drops
  unknown keys, matching every other schema in the repo. A caller sending `role: "RECRUITER"` gets `201` and a
  `CANDIDATE` account (AC-B04).
- **FR-2.4** `auth.service.signup` writes `role: UserRole.CANDIDATE` as a literal. **No value derived from the
  request reaches that field**, so there is no input to validate and no branch to get wrong (SEC-1).
- **FR-2.5** The response is unchanged: `201 { user }`, the safe projection, **no token and no cookie**
  (authentication FR-2.2). A new candidate must then log in.
- **FR-2.6** A duplicate email still answers `409 EMAIL_TAKEN`, still derived from the `P2002` constraint
  violation rather than a preceding `findUnique`.
- **FR-2.7** Name, email and password rules are unchanged, including the 72-byte bcrypt ceiling.
- **FR-2.8** The `user.created` log line keeps its shape; `role` is now always `CANDIDATE` for `source: 'signup'`.

### FR-3 — Provisioning interviewers and recruiters

- **FR-3.1** After FR-2.2 there is **no HTTP path that creates an `INTERVIEWER` or a `RECRUITER`**.
- **FR-3.2** `npm run db:seed` becomes the only provisioning path for those two roles. The existing
  [`prisma/seed.ts`](../../../prisma/seed.ts) already upserts them and needs no change to keep doing so.
- **FR-3.3** No operator-secret route, no `POST /api/users`, no admin module is added. The authentication
  spec's contract invariant 5 — _no authenticated user can create another user_ — is not merely preserved but
  strengthened: now no **anonymous** caller can create a privileged one either.
- **FR-3.4** This is a **breaking change** to a shipped contract. Any script or Postman collection that
  provisions a recruiter over HTTP stops working and must move to the seed (R-2).

### FR-4 — Reading requisitions as a job board

- **FR-4.1** `GET /api/roles` and `GET /api/roles/:roleId` require **authentication only**. An anonymous
  caller still gets `401`.
- **FR-4.2** `POST /api/roles`, `PATCH /api/roles/:roleId` and `DELETE /api/roles/:roleId` keep
  `requireRole(UserRole.RECRUITER)` unchanged.
- **FR-4.3** The service decides the query from `req.user.role`. There is exactly **one** such decision, in
  one function, and both read endpoints call it — a second copy is what makes this kind of rule rot.
- **FR-4.4** For a caller whose role is **not** `RECRUITER`, `status: RoleStatus.OPEN` is written into the
  Prisma `where` clause **before the query runs** — for the list, for the `count` that feeds the pager, and for
  the single-role read. A `CLOSED` requisition is never fetched.
- **FR-4.5** For a non-recruiter, the projection is `PUBLIC_ROLE_SELECT` — `id`, `title`, `description`,
  `status`, `createdAt`. `updatedAt` is omitted. A recruiter keeps `ROLE_SELECT` exactly as today.
- **FR-4.6** `GET /api/roles` accepts a new optional `q` parameter: a case-insensitive `contains` match on
  **`title` only**. `description` is not searched (D-11).
- **FR-4.7** `q` combines with the existing `status` and pager parameters with `AND`. For a non-recruiter,
  `?status=CLOSED` cannot widen the result set — the forced `OPEN` predicate wins and the response is an empty
  page, never an error (EC-04).
- **FR-4.8** `GET /api/roles/:roleId` for a non-recruiter naming a `CLOSED` or non-existent role answers
  `404 NOT_FOUND`. The two cases are **indistinguishable**, so the endpoint cannot be used to enumerate closed
  requisitions (SEC-4).
- **FR-4.9** The list envelope — `{ roles, pagination: { page, pageSize, total, totalPages } }` — is unchanged. Only the row
  set and the per-row column list differ by caller.

### FR-5 — Applying

- **FR-5.1** `POST /api/applications` creates an application. Body: `{ roleId: number }` and nothing else.
- **FR-5.2** `CANDIDATE`-only. An interviewer or recruiter gets `403 FORBIDDEN`.
- **FR-5.3** `candidateUserId` is taken from `req.user.id`. **The body cannot name a candidate** — there is no
  such field to send, so there is no impersonation case to defend against.
- **FR-5.4** A created row is always `status: ACTIVE`, `currentStage: APPLIED`, `stageEnteredAt: now()`. These
  are literals in the service; nothing in the request influences them.
- **FR-5.5** The target requisition is resolved by a query whose `where` is `{ id: roleId, status: OPEN }`. A
  `CLOSED` or missing role is a `404 NOT_FOUND` from that same query — **the eligibility rule and the lookup
  are one statement**, so there is no window between checking and using, and no second error code to explain
  why a closed role was refused.
- **FR-5.6** A candidate may apply to the same requisition any number of times (D-6). There is **no**
  `@@unique([candidateUserId, roleId])`, no `409`, and no idempotency. Each apply creates a distinct row with
  its own `createdAt`.
- **FR-5.7** The lookup and the insert run inside one `prisma.$transaction`, so the `Role` row's existence is
  guaranteed for the insert and the foreign key cannot fail with an unexplained `P2003`.
- **FR-5.8** Response: `201 { application }` using `APPLICATION_SELECT` (FR-6.4).
- **FR-5.9** A structured `application.created` line is logged: `event`, `applicationId`, `candidateUserId`,
  `roleId`. **Never** the candidate's email or name.

### FR-6 — Listing a candidate's own applications

- **FR-6.1** `GET /api/applications` returns the caller's applications. `CANDIDATE`-only; every other role
  gets `403`.
- **FR-6.2** The scoping is `where: { candidateUserId: req.user.id }` **inside the Prisma query**. No query
  fetches a wider set and narrows it in application code — the brief's §3.2 discipline applied to the new
  actor.
- **FR-6.3** Each row carries exactly: application `id`, `createdAt` (the _Applied_ date), `status`,
  `currentStage`, and the nested role's `id` and `title` (D-13).
- **FR-6.4** `APPLICATION_SELECT` is a single exported constant listing those columns, used by **both**
  endpoints in the module so the two shapes cannot drift — the same construction as `SAFE_USER_SELECT` and
  `ROLE_SELECT`.
- **FR-6.5** The nested role select is `{ id: true, title: true }`. `description`, `status`, `updatedAt` and
  every other requisition column are **not selected**, so a candidate's application list cannot become a
  second, unpaged view of the requisition table.
- **FR-6.6** Ordered `createdAt desc` — newest first. No pager in this feature; a POC candidate's list is
  small, and PERF-3 names the index that keeps the query cheap regardless.
- **FR-6.7** An empty result is `200 { applications: [] }`, never a `404` — matching `GET /api/users`
  (authentication FR-3.4).
- **FR-6.8** There is deliberately **no `GET /api/applications/:applicationId`**, and no route is registered
  for it. An unregistered path falls through to `notFound` and answers `404` like any other. **The absence is
  the guarantee**: there is no by-id surface on which one candidate could request another's application, so
  there is no scoping rule to forget. Do not add one without a spec change.

### FR-7 — The profile view

- **FR-7.1** No endpoint and no model is added for profiles (D-12). The existing `GET /api/auth/me` serves it.
- **FR-7.2** It serves **every** role, not only candidates — the frontend's Profile page is shared chrome.
- **FR-7.3** Profile data is therefore read-only by construction: **no endpoint writes a `User` row after
  creation**, so "a candidate cannot edit their profile" needs no check to enforce it.

### FR-8 — Deleting a requisition that has applications

- **FR-8.1** `Application.roleId` takes `onDelete: Restrict` (D-5). This is the decision roles spec FR-6.10
  required of the first model to reference `Role`.
- **FR-8.2** `DELETE /api/roles/:roleId` on a `CLOSED` role with **one or more** applications answers
  `409 ROLE_HAS_APPLICATIONS`, message _"This role has applications and cannot be deleted"_.
- **FR-8.3** The `CLOSED` check (roles FR-6.6, `409 ROLE_NOT_CLOSED`) runs **first**. An `OPEN` role with
  applications reports `ROLE_NOT_CLOSED`, because closing it is the first of the two steps either way.
- **FR-8.4** The refusal is derived from the database — the `P2003` foreign-key violation raised by the
  delete, caught and mapped, exactly as `EMAIL_TAKEN` is derived from `P2002`. **Not** from a preceding
  `count()`, which a concurrent apply could invalidate between the check and the delete (EC-07).

### FR-9 — Logging

- **FR-9.1** `application.created` on every successful apply (FR-5.9).
- **FR-9.2** `role.delete.refused` with `reason: 'has_applications'` when FR-8.2 fires — a refused destructive
  action is exactly what an audit trail is for.
- **FR-9.3** The `user.created` line is unchanged in shape.
- **FR-9.4** No log line in this feature contains a name, an email, a password, or a requisition description.
- **FR-9.5** These are `pino` lines carrying the per-request `requestId`, as everywhere else. **No audit table
  is introduced** — that belongs to the feature that first needs to _read_ the trail.

### FR-10 — Seed data

- **FR-10.1** `prisma/seed.ts` gains one candidate: `Cara Candidate <candidate@demo.test>`, role `CANDIDATE`,
  upserted on email like the existing three.
- **FR-10.2** It gains applications for that candidate against the seeded `OPEN` requisitions.
- **FR-10.3** Those applications cover **more than the default**: at least one `(ACTIVE, APPLIED)`, one
  `(ACTIVE, INTERVIEW)` and one `(REJECTED, SCREEN)`, so the frontend's badge states — and the brief's own
  `Status: Interview` example — are renderable before any recruiter feature exists.
- **FR-10.4** The seed stays idempotent: the seeded candidate's applications are deleted and recreated on each
  run. Re-running must not accumulate duplicates, even though the schema permits them (D-6).

---

## Frontend Requirements

The obligations this backend places on the Next.js client. The rest of the frontend design lives in
[../../../../frontend/specs/features/candidate/spec.md](../../../../frontend/specs/features/candidate/spec.md).

- **XFE-1** Transport is unchanged: `Authorization: Bearer <accessToken>` on every call, `credentials:
'include'` so the `Path=/api/auth` refresh cookie is sent. `apiFetch` needs no modification.
- **XFE-2** CORS is unchanged — `origin: env.FRONTEND_ORIGIN`, `credentials: true`. Signup is same-origin-policy
  identical to login; no preflight change.
- **XFE-3** The client **must remove `role` from its signup request body.** Sending it is harmless (FR-2.3)
  but a client that offers a role selector is offering a lie.
- **XFE-4** The client hard-codes the literal `"CANDIDATE"` in its `UserRole` union. Adding it must be a
  **type error until every role-keyed lookup is filled in** — that is why `NAV_SECTIONS` is a
  `Record<UserRole, …>` rather than a filtered array.
- **XFE-5** Error `code` values the client branches on: `VALIDATION_ERROR`, `EMAIL_TAKEN`, `UNAUTHENTICATED`,
  `FORBIDDEN`, `NOT_FOUND`, and the new `ROLE_HAS_APPLICATIONS`. Branch on `code`, never on `message`.
- **XFE-6** `details` stays `Record<string, string[]>`, keyed by request-body field name, so it maps onto form
  fields. Signup's keys are now `name`, `email`, `password` — **`role` is no longer a possible key**.
- **XFE-7** An empty list is `200` with an empty array — `{ roles: [] }`, `{ applications: [] }` — never a
  `404`. The client must render an empty state, not an error.
- **XFE-8** `GET /api/roles` for a candidate never contains a `CLOSED` row. **If one ever appears, that is a
  backend bug to report, not a row to filter client-side.**
- **XFE-9** An application row carries **no** interviewer name, feedback, rating, note, or override reason. If
  such a field ever appears in the payload, same rule as XFE-8.
- **XFE-10** `GET /api/auth/me` is the profile source for every role. There is no `/api/profile` and none is
  coming; do not write a client for one.
- **XFE-11** `POST /api/applications` succeeding twice for the same role is **expected behaviour**, not an
  error to suppress (D-6). The client must not assume an `Applied` state is terminal.

---

## Backend Requirements

- **BE-1** Layering is unchanged: routes wire middleware, controllers shape HTTP, services own rules and
  Prisma. **No route handler in this feature holds business logic.**
- **BE-2** One new module, `src/modules/applications/`, following the existing shape:
  `applications.routes.ts`, `applications.controller.ts`, `applications.service.ts`,
  `applications.schema.ts`, `application.select.ts`.
- **BE-3** The roles module is **modified, not replaced**. `roles.service.ts` gains the role-aware query
  builder (FR-4.3); `roles.routes.ts` loses two `requireRole` calls; `roles.schema.ts` gains `q`;
  `role.select.ts` gains `PUBLIC_ROLE_SELECT`.
- **BE-4** Middleware order is unchanged and load-bearing: `requireAuth` → `requireRole` → `validateParams` /
  `validateQuery` / `validate` → controller. An anonymous caller always gets `401` before a `403`, and an
  unauthorized caller always gets `403` before a `400` — the API does not help an unauthorized caller fix
  their payload.
- **BE-5** `src/lib/errors.ts` gains exactly one class, `RoleHasApplicationsError`, and `ErrorCode` gains one
  value. No other error shape changes.
- **BE-6** **No new npm dependency.** Express, Prisma and zod cover all of this.
- **BE-7** `app.ts` mounts `applicationsRouter` at `/api/applications`, **before** `notFound`.
- **BE-8** Prisma error mapping (`P2002` → `EMAIL_TAKEN`, `P2003` → `ROLE_HAS_APPLICATIONS`) stays inside the
  service that issued the write. A raw Prisma error never reaches the client.

---

## API Contract

### `POST /api/auth/signup` — **MODIFIED (BREAKING)**

Anonymous. Creates a `CANDIDATE`.

```jsonc
// request
{ "name": "Cara Candidate", "email": "cara@example.com", "password": "correct-horse" }
```

```jsonc
// 201
{
  "user": {
    "id": 7,
    "name": "Cara Candidate",
    "email": "cara@example.com",
    "role": "CANDIDATE",
    "createdAt": "2026-09-16T10:00:00.000Z",
  },
}
```

| Status | `code`             | When                                             |
| ------ | ------------------ | ------------------------------------------------ |
| `400`  | `VALIDATION_ERROR` | name/email/password fails a rule (`details` set) |
| `409`  | `EMAIL_TAKEN`      | the email already exists                         |
| `500`  | `INTERNAL_ERROR`   | anything unexpected                              |

**Breaking:** `role` is no longer read. `"role": "RECRUITER"` in the body yields a `CANDIDATE`.

### `GET /api/roles` — **MODIFIED**

`requireAuth` only. Query: `q?`, `status?`, `page?`, `pageSize?`.

```jsonc
// 200 — candidate or interviewer (PUBLIC_ROLE_SELECT, OPEN only)
{
  "roles": [
    {
      "id": 1,
      "title": "Senior Backend Engineer",
      "description": "…",
      "status": "OPEN",
      "createdAt": "2026-09-14T…",
    },
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 2, "totalPages": 1 },
}
```

A recruiter's response is unchanged and additionally carries `updatedAt` on each row.

| Status | `code`             | When                                    |
| ------ | ------------------ | --------------------------------------- |
| `400`  | `VALIDATION_ERROR` | bad `q`, `status`, `page` or `pageSize` |
| `401`  | `UNAUTHENTICATED`  | no or invalid access token              |

### `GET /api/roles/:roleId` — **MODIFIED**

`requireAuth` only. `200 { role }`.

| Status | `code`             | When                                                                      |
| ------ | ------------------ | ------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR` | `:roleId` is not a positive integer                                       |
| `401`  | `UNAUTHENTICATED`  | no or invalid access token                                                |
| `404`  | `NOT_FOUND`        | no such role — **or**, for a non-recruiter, the role is `CLOSED` (FR-4.8) |

### `DELETE /api/roles/:roleId` — **MODIFIED**

Unchanged except for one new failure.

| Status | `code`                  | When                                                 |
| ------ | ----------------------- | ---------------------------------------------------- |
| `409`  | `ROLE_NOT_CLOSED`       | the role is still `OPEN` — checked first (FR-8.3)    |
| `409`  | `ROLE_HAS_APPLICATIONS` | **new** — closed, but one or more applications exist |

### `POST /api/applications` — **NEW**

`requireAuth` + `requireRole(CANDIDATE)`.

```jsonc
// request
{ "roleId": 1 }
```

```jsonc
// 201
{
  "application": {
    "id": 12,
    "status": "ACTIVE",
    "currentStage": "APPLIED",
    "createdAt": "2026-09-16T10:04:00.000Z",
    "role": { "id": 1, "title": "Senior Backend Engineer" },
  },
}
```

| Status | `code`             | When                                                 |
| ------ | ------------------ | ---------------------------------------------------- |
| `400`  | `VALIDATION_ERROR` | `roleId` missing or not a positive integer           |
| `401`  | `UNAUTHENTICATED`  | no or invalid access token                           |
| `403`  | `FORBIDDEN`        | caller is an interviewer or recruiter                |
| `404`  | `NOT_FOUND`        | no such role, **or** the role is not `OPEN` (FR-5.5) |

### `GET /api/applications` — **NEW**

`requireAuth` + `requireRole(CANDIDATE)`. No query parameters.

```jsonc
// 200
{
  "applications": [
    {
      "id": 12,
      "status": "ACTIVE",
      "currentStage": "INTERVIEW",
      "createdAt": "2026-09-15T…",
      "role": { "id": 1, "title": "Senior Backend Engineer" },
    },
  ],
}
```

| Status | `code`            | When                                  |
| ------ | ----------------- | ------------------------------------- |
| `401`  | `UNAUTHENTICATED` | no or invalid access token            |
| `403`  | `FORBIDDEN`       | caller is an interviewer or recruiter |

### Contract invariants — what must appear in **zero** responses

1. `passwordHash`, on any endpoint, for any role. Unchanged and still guaranteed by `SAFE_USER_SELECT`.
2. A `role` field in any **request** the client sends to `/api/auth/signup` that has any effect.
3. A requisition with `"status": "CLOSED"` in any response to a `CANDIDATE` or `INTERVIEWER`.
4. Any field named `feedback`, `rating`, `notes`, `interviewer`, `overrideReason`, or `stageHistory` on an
   application returned to a candidate — in this feature they do not exist as columns, and
   `APPLICATION_SELECT` is the mechanism that keeps it so when they do.
5. Another user's `id`, `name` or `email` in any candidate-facing response. A candidate's world contains
   exactly one user: themselves.
6. `updatedAt` on a requisition returned to a non-recruiter.

---

## Data Model Changes

```prisma
// MODIFIED — a third value. Additive; existing rows are untouched.
enum UserRole {
  INTERVIEWER
  RECRUITER
  CANDIDATE
}

/// NEW. The brief's §3.1 stage set, minus the terminal outcomes, which live on
/// `ApplicationStatus` instead (D-7). A stage is where a live application sits;
/// an outcome is whether it is still live at all.
enum PipelineStage {
  APPLIED
  SCREEN
  INTERVIEW
  OFFER
}

/// NEW. `WITHDRAWN` is deliberately absent (D-8) — nothing in this POC can
/// produce it, and an enum value no code path writes is a lie in the schema.
enum ApplicationStatus {
  ACTIVE
  HIRED
  REJECTED
}

model User {
  // …unchanged…
  applications Application[]   // NEW back-relation
}

model Role {
  // …unchanged…
  applications Application[]   // NEW back-relation
}

/// NEW. A candidate's application to one requisition.
///
/// Deliberately NOT unique on (candidateUserId, roleId) — a candidate may apply
/// repeatedly, and that is a documented POC trade-off (D-6), not an omission.
model Application {
  id Int @id @default(autoincrement())

  candidateUserId Int
  roleId          Int

  /// Is this application still live, and if not, how did it end.
  status ApplicationStatus

  /// Where a live application sits. Frozen once `status` leaves `ACTIVE`.
  currentStage PipelineStage

  /// When `currentStage` was last entered — the ageing column the pipeline
  /// feature computes "time at current stage" from. Written here because the
  /// write path is here; adding it later means backfilling every row with a
  /// value nobody can derive.
  stageEnteredAt DateTime

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  candidate User @relation(fields: [candidateUserId], references: [id], onDelete: Cascade)
  role      Role @relation(fields: [roleId], references: [id], onDelete: Restrict)

  /// `GET /api/applications` — filter and sort served by one index.
  @@index([candidateUserId, createdAt])

  /// The pipeline view's counts-per-stage-per-role, and the FK check that
  /// makes `onDelete: Restrict` cheap.
  @@index([roleId, currentStage])
}
```

### Migration notes

- **MIG-1** Migration name: `add_candidate_applications`. **Additive only.** No column is dropped, no column
  is made stricter, and no existing row is rewritten.
- **MIG-2** Adding `CANDIDATE` to `UserRole` is an `ALTER TYPE … ADD VALUE`. In older Postgres this cannot run
  inside a transaction block alongside other statements; if `prisma migrate dev` produces a migration that
  fails for that reason, split the enum change into its own migration file rather than editing the generated
  SQL by hand.
- **MIG-3** `Application` is a new table. `status`, `currentStage` and `stageEnteredAt` are **non-null with no
  default** — the service sets all three explicitly, so the rule lives where it can be read rather than in a
  column definition. This matches `Role.status`, which was specified the same way and for the same reason.
- **MIG-4** Two enums rather than one (D-7). `PipelineStage` deliberately excludes `HIRED`/`REJECTED` so the
  contradictory state the two-column design risks — `status: ACTIVE` with `currentStage: REJECTED` — is **not
  representable**. No `CHECK` constraint is needed because the value sets do not overlap.
- **MIG-5** The remaining invariant _is_ write-side and cannot be a constraint: once `status` is `HIRED` or
  `REJECTED`, `currentStage` and `stageEnteredAt` must not change, and `status` must not return to `ACTIVE`.
  **This feature writes only `(ACTIVE, APPLIED)`, so nothing here can violate it.** The feature that first
  writes a transition owns enforcing it, and must say so in its own spec.
- **MIG-6** `candidate → onDelete: Cascade`. Deleting a user erases their applications. There is no endpoint
  that deletes a user, so this is a schema-consistency statement, not a live path.
- **MIG-7** `role → onDelete: Restrict` (D-5, FR-8.1). This is the answer roles spec FR-6.10 demanded. Postgres
  rejects the delete; the service maps `P2003` to `409`.
- **MIG-8** Two indexes, both added now rather than after a slow query is observed, matching how `Role`'s were
  specified. `[candidateUserId, createdAt]` serves FR-6.6's filter-and-sort in one index;
  `[roleId, currentStage]` serves the pipeline aggregate and, by its `roleId` prefix, the FK check in MIG-7.
- **MIG-9** Row growth: one row per apply action, unbounded per (candidate, role) by D-6. At the brief's
  20,000-candidate scale this table is the largest in the schema, which is why neither index is optional.
- **MIG-10** Rollback is `prisma migrate resolve --rolled-back` plus a `DROP TABLE "Application"`. The enum
  value cannot be removed from `UserRole` without recreating the type; if a rollback is ever needed, leave the
  value in place — an unused enum value is harmless.

---

## Authentication / Authorization

### Endpoint × role matrix

| Endpoint                    | Anonymous | Candidate                  | Interviewer                | Recruiter |
| --------------------------- | --------- | -------------------------- | -------------------------- | --------- |
| `POST /api/auth/signup`     | ✅ 201    | ✅ 201                     | ✅ 201                     | ✅ 201    |
| `POST /api/auth/login`      | ✅        | ✅                         | ✅                         | ✅        |
| `POST /api/auth/refresh`    | cookie    | cookie                     | cookie                     | cookie    |
| `POST /api/auth/logout`     | ✅ 204    | ✅ 204                     | ✅ 204                     | ✅ 204    |
| `GET /api/auth/me`          | 401       | ✅                         | ✅                         | ✅        |
| `GET /api/users`            | 401       | **403**                    | 403                        | ✅        |
| `GET /api/roles`            | 401       | ✅ **OPEN only**           | ✅ **OPEN only**           | ✅ all    |
| `GET /api/roles/:roleId`    | 401       | ✅ **OPEN only, else 404** | ✅ **OPEN only, else 404** | ✅ any    |
| `POST /api/roles`           | 401       | 403                        | 403                        | ✅        |
| `PATCH /api/roles/:roleId`  | 401       | 403                        | 403                        | ✅        |
| `DELETE /api/roles/:roleId` | 401       | 403                        | 403                        | ✅        |
| `POST /api/applications`    | 401       | ✅                         | **403**                    | **403**   |
| `GET /api/applications`     | 401       | ✅                         | **403**                    | **403**   |

### Non-negotiable rules

- **AZ-1** `401` and `403` are never interchanged. `requireAuth` runs before `requireRole` on every guarded
  route, so an anonymous caller gets `401` and an authenticated-but-wrong-role caller gets `403`.
- **AZ-2** `GET /api/applications` is scoped **in the query**, by `where: { candidateUserId: req.user.id }`.
  There is no code path that reads applications more broadly and filters afterwards.
- **AZ-3** The roles read guard widens to `requireAuth` (D-9). **The query does not widen** — see AZ-4.
- **AZ-4** Non-recruiter role reads carry `status: OPEN` in the `where` clause of the list, the pager's
  `count`, and the single read. A `CLOSED` role is not fetched, so it cannot be leaked by a mapping mistake.
- **AZ-5** `POST /api/applications` never reads a candidate identifier from the request. The only source is
  `req.user.id`, established by `requireAuth` from a signed token.
- **AZ-6** Applying is authorized by the **same query that fetches the role** (FR-5.5). There is no
  fetch-then-check.
- **AZ-7** A recruiter is deliberately `403` on the application endpoints, not `200` with everything. The
  recruiter view is a different query with different scoping, and it belongs to the pipeline feature. A
  recruiter reusing the candidate endpoint would get one candidate's list — their own, empty — which is worse
  than a refusal.
- **AZ-8** Signup performs **no** authorization decision, because it has no input that could influence one
  (FR-2.4).

---

## Validation

| Endpoint                 | Field      | Rule                                                             | Failure                   |
| ------------------------ | ---------- | ---------------------------------------------------------------- | ------------------------- |
| `POST /api/auth/signup`  | `name`     | string, trimmed, 1–100 chars                                     | `400`, `details.name`     |
| `POST /api/auth/signup`  | `email`    | string, trimmed, lowercased, valid email, ≤254 chars             | `400`, `details.email`    |
| `POST /api/auth/signup`  | `password` | string, ≥8 chars, ≤72 **bytes**                                  | `400`, `details.password` |
| `POST /api/auth/signup`  | `role`     | **not in the schema** — stripped silently                        | none                      |
| `GET /api/roles`         | `q`        | optional string, trimmed, ≤120 chars; empty after trim → ignored | `400`, `details.q`        |
| `GET /api/roles`         | `status`   | optional `OPEN`/`CLOSED` (unchanged)                             | `400`                     |
| `GET /api/roles`         | `page`     | optional int ≥1, default 1 (unchanged)                           | `400`                     |
| `GET /api/roles`         | `pageSize` | optional int 1–100, default 20 (unchanged)                       | `400`                     |
| `POST /api/applications` | `roleId`   | required, coerced int, positive                                  | `400`, `details.roleId`   |

- **VAL-1** Every schema strips unknown keys (zod object default), so no unexpected field reaches a Prisma
  `data` object. This is what makes FR-2.3 true without a rejection rule.
- **VAL-2** `q` is capped at 120 characters — the same ceiling as `Role.title`, since a search term longer
  than the column it searches cannot match anything and should not reach the database.
- **VAL-3** `q` trimmed to empty is treated as **absent**, not as a match-everything filter. `?q=` and no `q`
  return the same page, so a client clearing a search box needs no special case.
- **VAL-4** `roleId` is coerced in the schema, so the controller receives a real `number` and never parses
  one. A non-numeric `roleId` is a `400` before any query runs, never a `500` further down.
- **VAL-5** There is **no** validation that the role is `OPEN`. That is not a shape rule — it is a business
  rule, and FR-5.5 enforces it in the query where it cannot race.
- **VAL-6** `details` values are arrays of messages keyed by request-body field name, unchanged
  (`Record<string, string[]>`).
- **VAL-7** Signup's password rules stay off the **login** schema, unchanged — applying them there would
  return `400` where `401` belongs and reveal that no account can have a short password.
- **VAL-8** Validation runs **after** `requireAuth` and `requireRole` on every guarded route (BE-4), so an
  unauthorized caller never learns whether their payload was also malformed.

---

## Error Handling

Response shape, unchanged:

```jsonc
{ "code": "ROLE_HAS_APPLICATIONS", "message": "This role has applications and cannot be deleted" }
```

`details` appears on `VALIDATION_ERROR` and nowhere else.

| `code`                  | Status | Raised when                                                                              | New?    |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------- | ------- |
| `VALIDATION_ERROR`      | 400    | any zod failure (body, params, query)                                                    | no      |
| `INVALID_CREDENTIALS`   | 401    | login failure                                                                            | no      |
| `UNAUTHENTICATED`       | 401    | missing/invalid/expired access token, or an invalid refresh token                        | no      |
| `FORBIDDEN`             | 403    | wrong `UserRole` for the route                                                           | no      |
| `NOT_FOUND`             | 404    | unknown route; unknown role; **a non-`OPEN` role read or applied to by a non-recruiter** | no      |
| `EMAIL_TAKEN`           | 409    | signup email collides (`P2002`)                                                          | no      |
| `ROLE_NOT_CLOSED`       | 409    | delete attempted on an `OPEN` role                                                       | no      |
| `ROLE_HAS_APPLICATIONS` | 409    | delete attempted on a `CLOSED` role with applications (`P2003`)                          | **yes** |
| `INTERNAL_ERROR`        | 500    | anything unexpected                                                                      | no      |

- **ERR-1** `code` is the stable machine contract; `message` is user-safe copy the client may render verbatim
  and may change without being a breaking change.
- **ERR-2** A raw Prisma error, stack trace, SQL fragment or constraint name **never** reaches the client. Every
  known Prisma code is translated in the service that issued the write; anything else becomes `INTERNAL_ERROR`.
- **ERR-3** `ROLE_HAS_APPLICATIONS` is derived from the `P2003` foreign-key violation, not from a preceding
  `count()` — the same discipline as `EMAIL_TAKEN`, and for the same reason (EC-07).
- **ERR-4** A non-recruiter reading or applying to a `CLOSED` role gets `404`, **not** `403`. A `403` would
  confirm the requisition exists, turning the endpoint into an enumeration oracle (SEC-4).
- **ERR-5** `404` from an unregistered route (`GET /api/applications/1`) is indistinguishable from `404` for a
  missing resource. The client cannot probe for unimplemented endpoints.
- **ERR-6** `409 ROLE_NOT_CLOSED` is checked before `409 ROLE_HAS_APPLICATIONS` (FR-8.3), so a recruiter is
  always told the _first_ thing they need to do.
- **ERR-7** No error message names another user, an email, or a count of applications. _"This role has
  applications"_ does not say how many or whose.

---

## Edge Cases

| ID        | Case                                                                             | Behaviour                                                                                                                                                                                                                                                                      |
| --------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **EC-01** | Signup body includes `"role": "RECRUITER"`                                       | `201`, account created as `CANDIDATE`. The key is stripped by zod before the service sees it (FR-2.3)                                                                                                                                                                          |
| **EC-02** | Two signups with the same email, fired concurrently                              | One `201`, one `409 EMAIL_TAKEN`. Decided by the unique index, not a read-then-write. Exactly one row exists                                                                                                                                                                   |
| **EC-03** | An existing `INTERVIEWER` or `RECRUITER` logs in after this ships                | Unchanged. The migration is additive; no existing row's `role` is touched                                                                                                                                                                                                      |
| **EC-04** | Candidate requests `GET /api/roles?status=CLOSED`                                | `200` with an **empty page**. The forced `OPEN` predicate wins; this is not an error, and not a `403` (FR-4.7)                                                                                                                                                                 |
| **EC-05** | Candidate requests `GET /api/roles/:id` for a role that exists but is `CLOSED`   | `404 NOT_FOUND`, identical to a role that never existed (FR-4.8)                                                                                                                                                                                                               |
| **EC-06** | Same candidate applies to the same role twice, fired concurrently                | **Both succeed.** Two rows, two `201`s, two distinct ids. This is D-6's documented outcome, not a race that slipped through — there is no constraint to violate                                                                                                                |
| **EC-07** | Candidate applies while a recruiter deletes the same `CLOSED` role, concurrently | Postgres serialises them. Either the delete commits and the apply's `404` follows from the role being gone, or the apply commits and the delete gets `409`. **Never both**, because the FK is enforced by the database, not by a `count()`                                     |
| **EC-08** | Candidate applies while a recruiter **closes** the same role, concurrently       | The apply may succeed against a role that is `CLOSED` a moment later. **Accepted.** The row is valid, the FK holds, and the candidate applied while it was genuinely open. Preventing it would need row locking on `Role` for every apply, which is not worth it at this scale |
| **EC-09** | `GET /api/applications/1`                                                        | `404 NOT_FOUND` from `notFound` — the route is not registered and never will be (FR-6.8)                                                                                                                                                                                       |
| **EC-10** | `POST /api/applications` with `{ "roleId": 1, "candidateUserId": 99 }`           | `201`, application belongs to the **caller**. The extra key is stripped; there is no field to impersonate with (AZ-5)                                                                                                                                                          |
| **EC-11** | A candidate's token is presented after their `User` row is deleted               | `401` from the existing `/api/auth/me` guard. Their applications are already gone via `onDelete: Cascade` (MIG-6)                                                                                                                                                              |
| **EC-12** | Candidate lists applications whose role was later closed                         | The row still appears with its title. `APPLICATION_SELECT`'s nested role select has **no `status` filter** — a candidate's own history is not hidden from them                                                                                                                 |
| **EC-13** | `?q=` (empty after trim)                                                         | Treated as absent. Same response as no `q` at all (VAL-3)                                                                                                                                                                                                                      |
| **EC-14** | `?q=' OR 1=1 --`                                                                 | Passed to Prisma as a parameterised `contains` value. Matches nothing. No raw SQL is constructed anywhere in this feature                                                                                                                                                      |
| **EC-15** | Recruiter calls `GET /api/applications`                                          | `403 FORBIDDEN`, not an empty list. A silent empty response would read as "no applications exist" (AZ-7)                                                                                                                                                                       |
| **EC-16** | The seed is run twice                                                            | Four users, three roles, and the **same** application count. Applications for the seeded candidate are cleared and recreated (FR-10.4)                                                                                                                                         |

---

## Security Requirements

- **SEC-1** **SEC-11.1 is closed.** `POST /api/auth/signup` can no longer mint a privileged account, because
  the role is a literal in the service and no request field reaches it (FR-2.4). This is the single most
  important line in this spec.
- **SEC-2** There is now **no** path — anonymous or authenticated — that creates an `INTERVIEWER` or
  `RECRUITER` over HTTP (FR-3.1).
- **SEC-3** A candidate's applications are scoped in the query by the token's `sub`, never by a
  client-supplied id (AZ-2, AZ-5).
- **SEC-4** `CLOSED` requisitions are not enumerable by a candidate. The list cannot return them (FR-4.4) and
  the single read answers `404` identically to a non-existent id (FR-4.8), so neither the row set nor the
  status code distinguishes "closed" from "never existed".
- **SEC-5** No candidate-facing response carries another user's identity. Applications join to `Role`, never
  to `User` (FR-6.5).
- **SEC-6** The brief's §3.6 contact-detail rule is unaffected and reinforced: a candidate's email lives on
  `User`, and no interviewer-facing query in this feature selects from `User` at all.
- **SEC-7** No raw SQL, anywhere in this feature. `q` is a parameterised Prisma `contains` (EC-14).
- **SEC-8** No log line carries a name, an email, a password, or a requisition description (FR-9.4).
- **SEC-9** Signup's response still contains **no token and no cookie** (FR-2.5), so a signup flood produces
  accounts but no sessions.
- **SEC-10** Middleware order guarantees an unauthorized caller learns nothing about payload validity (VAL-8).
- **SEC-11** **Known accepted gap — application flooding.** D-6 removes the unique constraint, so a single
  authenticated candidate can create unlimited applications to one requisition. There is no rate limit and no
  per-candidate cap. Consequences: the `Application` table is a write amplification target, and the pipeline
  feature's counts-per-stage will count one person once per application. Both are accepted for the POC and
  **must be closed before this is reachable from anywhere but localhost.**
- **SEC-12** **Known accepted gaps — carried forward and extended.**
  1. **Signup is unauthenticated and unrate-limited.** It can no longer escalate privilege (SEC-1), but it can
     still be used to create unlimited candidate accounts. Mitigation for the POC: localhost binding only.
  2. **No email verification.** Any address can be claimed by anyone.
  3. **No password reset**, so a forgotten password means a new account.
  4. **Application flooding**, per SEC-11.
  5. **Interviewers regained a requisition read** they were deliberately denied (D-9 / the Revision above). It
     is limited to `OPEN` rows, but it is a real widening of an interviewer's surface, accepted knowingly.

---

## Performance Requirements

- **PERF-1** `GET /api/applications` must be **one** indexed query. p95 < 30 ms for a candidate with up to 100
  applications. Served by `@@index([candidateUserId, createdAt])` — the filter and the `ORDER BY` in one index,
  so there is no sort step.
- **PERF-2** `POST /api/applications` is **two** statements in one transaction: the `OPEN`-scoped role lookup
  (primary key, index-only) and the insert. p95 < 50 ms.
- **PERF-3** `EXPLAIN ANALYZE` on `GET /api/applications` must show an **index scan** on
  `Application_candidateUserId_createdAt_idx` and **no sequential scan** on `Application`, at the brief's
  20,000-candidate scale.
- **PERF-4** **`q` is an unindexed scan, and this is a stated accepted limit.** A case-insensitive
  `contains` compiles to `ILIKE '%term%'`, which **cannot** use a btree index. At the brief's stated 200-open-roles
  scale that is a scan of ≤200 rows and is comfortably under 50 ms. The documented upgrade path, if the
  requisition table ever grows past a few thousand rows, is a `pg_trgm` GIN index on `lower(title)` — a new
  Postgres extension and a migration, deliberately not taken now.
- **PERF-5** The role list's `count` for the pager carries the **same** `where` clause as the page query,
  including the forced `OPEN` predicate. A count over a wider set than the page is both wrong and slower.
- **PERF-6** The `onDelete: Restrict` check on `DELETE /api/roles/:roleId` is served by the `roleId` prefix of
  `@@index([roleId, currentStage])`. Without that index Postgres performs a sequential scan of `Application`
  on every requisition delete (MIG-8).
- **PERF-7** Nothing in this feature loads a result set into memory to filter, count or sort it. Every
  predicate named in this spec is in the `where` clause of the query that returns the rows.
- **PERF-8** `GET /api/applications` has **no pager**, which is a scale decision, not an omission: a
  candidate's list is bounded by their own behaviour. If SEC-11 is ever closed with a per-candidate cap, this
  stays correct; if it is not, and a candidate floods the table, this endpoint is the first thing to page.

---

## Acceptance Criteria

Verified by hand — `curl` against the running API, `psql` where the proof is database state. There is no test
suite. `$C`, `$I`, `$R` below are access tokens for a candidate, an interviewer and a recruiter.

### Signup and identity

- **AC-B01** — **Given** an empty database, **when** `POST /api/auth/signup` is sent
  `{"name":"Cara","email":"cara@example.com","password":"correct-horse"}`, **then** the response is `201` and
  the body is `{"user":{…,"role":"CANDIDATE",…}}` with no `passwordHash`, no `accessToken`, and no
  `Set-Cookie` header.
- **AC-B02** — **Given** the same request, **when** `psql` runs `SELECT role FROM "User" WHERE email='cara@example.com'`,
  **then** exactly one row returns and its `role` is `CANDIDATE`.
- **AC-B03** — **Given** a signup body with **no** `role` key, **when** it is sent, **then** the response is
  `201` — proving `role` is not a required field.
- **AC-B04** — **Given** a signup body containing `"role":"RECRUITER"`, **when** it is sent, **then** the
  response is `201` and the created user's `role` is `CANDIDATE`. _(The escalation path is closed — SEC-1.)_
- **AC-B05** — **Given** the same, **when** `psql` runs
  `SELECT count(*) FROM "User" WHERE role='RECRUITER' AND email='…'`, **then** the count is `0`.
- **AC-B06** — **Given** an existing candidate, **when** signup repeats that email, **then** the response is
  `409 EMAIL_TAKEN` and `psql` shows one row, not two.
- **AC-B07** — **Given** two signups with the same email **fired concurrently** (`curl … & curl … & wait`),
  **then** one returns `201`, the other `409 EMAIL_TAKEN`, and `psql` shows exactly one row.
- **AC-B08** — **Given** a body with a 7-character password, **when** sent, **then** `400 VALIDATION_ERROR`
  with `details.password` present and **no** `details.role` key.
- **AC-B09** — **Given** a candidate account, **when** `POST /api/auth/login` is sent its credentials, **then**
  `200` with an `accessToken`, a `Set-Cookie` refresh cookie, and `user.role` of `CANDIDATE`.
- **AC-B10** — **Given** `$C`, **when** `GET /api/auth/me` is called, **then** `200` with
  `{id, name, email, role: "CANDIDATE", createdAt}` and no other key. _(Serves the Profile view — FR-7.)_
- **AC-B11** — **Given** `$C`, **when** `GET /api/users` is called, **then** `403 FORBIDDEN`.
- **AC-B12** — **Given** `$R`, **when** `GET /api/users` is called, **then** `200` and **no** returned user has
  `role: "CANDIDATE"`.

### Job browsing

- **AC-B13** — **Given** no token, **when** `GET /api/roles` is called, **then** `401 UNAUTHENTICATED`.
- **AC-B14** — **Given** `$C` and the seeded data (2 `OPEN`, 1 `CLOSED`), **when** `GET /api/roles` is called,
  **then** `200`, `roles` has length `2`, every row has `"status":"OPEN"`, and `pagination.total` is `2` — **not** `3`.
- **AC-B15** — **Given** the same call, **when** the response is inspected, **then** **no** row contains an
  `updatedAt` key (FR-4.5).
- **AC-B16** — **Given** `$R`, **when** `GET /api/roles` is called, **then** `200`, `roles` has length `3`,
  one row has `"status":"CLOSED"`, and every row contains `updatedAt`. _(Recruiter behaviour unchanged.)_
- **AC-B17** — **Given** `$C`, **when** `GET /api/roles?status=CLOSED` is called, **then** `200` with
  `roles: []` and `pagination.total: 0` — not `403`, not an error (EC-04).
- **AC-B18** — **Given** `$C` and the `CLOSED` seeded role's id, **when** `GET /api/roles/:id` is called,
  **then** `404 NOT_FOUND`.
- **AC-B19** — **Given** `$C`, **when** `GET /api/roles/999999` is called, **then** `404 NOT_FOUND` with a body
  **byte-identical** to AC-B18's. _(No enumeration oracle — SEC-4.)_
- **AC-B20** — **Given** `$R` and the `CLOSED` role's id, **when** `GET /api/roles/:id` is called, **then**
  `200` with that role.
- **AC-B21** — **Given** `$I`, **when** `GET /api/roles` is called, **then** `200` with the `OPEN` roles only —
  no longer `403`. _(The Revision, verified.)_
- **AC-B22** — **Given** `$C`, **when** `GET /api/roles?q=backend` is called, **then** `200` and every returned
  title contains "backend" case-insensitively.
- **AC-B23** — **Given** `$C`, **when** `GET /api/roles?q=BACKEND` is called, **then** the result is identical
  to AC-B22's.
- **AC-B24** — **Given** `$C`, **when** `GET /api/roles?q=` is called, **then** the result is identical to
  `GET /api/roles` (EC-13).
- **AC-B25** — **Given** `$C`, **when** `GET /api/roles?q=` + a 121-character string is called, **then**
  `400 VALIDATION_ERROR` with `details.q`.
- **AC-B26** — **Given** `$C` and a term matching only the `CLOSED` role's title, **when**
  `GET /api/roles?q=<term>` is called, **then** `200` with `roles: []`. _(Search cannot widen the row set.)_
- **AC-B27** — **Given** `$C`, **when** `POST /api/roles` is called, **then** `403 FORBIDDEN`. Likewise
  `PATCH` and `DELETE`.

### Applying

- **AC-B28** — **Given** `$C` and an `OPEN` role id, **when** `POST /api/applications` is sent `{"roleId":1}`,
  **then** `201` with `application.status === "ACTIVE"`, `application.currentStage === "APPLIED"`, and
  `application.role` containing **only** `id` and `title`.
- **AC-B29** — **Given** that response, **when** `psql` runs
  `SELECT status, "currentStage", "stageEnteredAt" FROM "Application" WHERE id=<id>`, **then** the row is
  `ACTIVE`, `APPLIED`, and `stageEnteredAt` is within a second of `createdAt`.
- **AC-B30** — **Given** `$C` and the `CLOSED` role's id, **when** `POST /api/applications` is called, **then**
  `404 NOT_FOUND` and `psql` shows **no** new `Application` row.
- **AC-B31** — **Given** `$C`, **when** `POST /api/applications` is sent `{"roleId":999999}`, **then**
  `404 NOT_FOUND` with a body identical to AC-B30's.
- **AC-B32** — **Given** `$C`, **when** `POST /api/applications` is sent `{}`, **then** `400 VALIDATION_ERROR`
  with `details.roleId`.
- **AC-B33** — **Given** `$C`, **when** `POST /api/applications` is sent `{"roleId":"abc"}`, **then**
  `400 VALIDATION_ERROR`, **not** `500`.
- **AC-B34** — **Given** `$C`, **when** `POST /api/applications` is sent
  `{"roleId":1,"candidateUserId":<another user's id>,"status":"HIRED"}`, **then** `201`, and `psql` shows the
  row's `candidateUserId` is the **caller's** id and its `status` is `ACTIVE` (EC-10).
- **AC-B35** — **Given** `$I`, **when** `POST /api/applications` is called, **then** `403 FORBIDDEN`. Likewise
  `$R`.
- **AC-B36** — **Given** no token, **when** `POST /api/applications` is called, **then** `401`, never `403`.
- **AC-B37** — **Given** `$C` who has already applied to role `1`, **when** they apply to role `1` again,
  **then** `201` with a **new** id, and `psql` shows two rows. _(D-6 — unlimited, verified, not assumed.)_
- **AC-B38** — **Given** `$C`, **when** two `POST /api/applications` for the same role are **fired
  concurrently**, **then** both return `201` with distinct ids and `psql` shows exactly **two** rows —
  neither a `409` nor a single merged row (EC-06).

### My applications

- **AC-B39** — **Given** `$C` with no applications, **when** `GET /api/applications` is called, **then** `200`
  with `{"applications":[]}` — not `404`.
- **AC-B40** — **Given** `$C` with three applications, **when** `GET /api/applications` is called, **then**
  `200` with three rows ordered `createdAt` descending.
- **AC-B41** — **Given** a second candidate `$C2` with their own applications, **when** `$C` calls
  `GET /api/applications`, **then** **none** of `$C2`'s application ids appear. Confirm with
  `SELECT id FROM "Application" WHERE "candidateUserId" = <C2's id>` and diff against the response.
- **AC-B42** — **Given** `$C`, **when** the response is inspected, **then** each row has exactly the keys
  `id`, `status`, `currentStage`, `createdAt`, `role`, and `role` has exactly `id` and `title`.
- **AC-B43** — **Given** `$I`, **when** `GET /api/applications` is called, **then** `403 FORBIDDEN` — **not**
  `200 {"applications":[]}` (EC-15). Likewise `$R`.
- **AC-B44** — **Given** `$C` and any application id, **when** `GET /api/applications/<id>` is called, **then**
  `404 NOT_FOUND` — the route does not exist (FR-6.8, EC-09).
- **AC-B45** — **Given** `$C` who applied to a role that a recruiter then closed, **when**
  `GET /api/applications` is called, **then** the row is still present with its title (EC-12).

### Role deletion

- **AC-B46** — **Given** `$R` and an `OPEN` role with one application, **when** `DELETE /api/roles/:id` is
  called, **then** `409 ROLE_NOT_CLOSED` — checked before the applications rule (FR-8.3).
- **AC-B47** — **Given** that role then closed, **when** `DELETE /api/roles/:id` is called, **then**
  `409 ROLE_HAS_APPLICATIONS`, and `psql` shows the `Role` row **and** the `Application` row both still exist.
- **AC-B48** — **Given** a `CLOSED` role with **zero** applications, **when** `DELETE /api/roles/:id` is
  called, **then** `204`. _(Roles feature behaviour is preserved where it still applies.)_
- **AC-B49** — _(revised during implementation — as first written, half of this criterion was unreachable.)_
  Applying requires the role to be `OPEN`; deleting requires it to be `CLOSED`. Those preconditions are
  **disjoint**, so a two-way apply-vs-delete race can never produce the `201` branch: the apply always `404`s
  on the status predicate. The race that _is_ reachable is three-way. **Given** `$C` applying to role `Z`,
  `$R` closing `Z`, and `$R` deleting `Z`, **all fired concurrently**, **then** every outcome is explainable
  and the database is consistent — and in particular the `Application` table **never** contains a row whose
  `roleId` has no `Role`, because the refusal is the foreign key's, not a `count()`'s (EC-07).
- **AC-B50** — **Given** any of the above `409`s, **when** the response body is read, **then** it contains no
  application count, no candidate name and no candidate email (ERR-7).

### Cross-cutting invariants

- **AC-B51** — **Given** every endpoint in this API called as `$C`, `$I` and `$R`, **when** each response body
  is searched, **then** the string `passwordHash` appears in **none** of them.
- **AC-B52** — **Given** every response returned to `$C` or `$I` from `GET /api/roles` and
  `GET /api/roles/:roleId`, **when** searched, **then** `"status":"CLOSED"` appears in **none** of them.
- **AC-B53** — **Given** every response returned to `$C`, **when** searched, **then** none of `feedback`,
  `rating`, `notes`, `interviewer`, `overrideReason` or `stageHistory` appears as a key.
- **AC-B54** — **Given** the API log output during a full run of the above, **when** searched, **then** no line
  contains a password, an email address, or a requisition description.
- **AC-B55** — **Given** a fresh database, **when** `npm run db:seed` is run **twice**, **then** `psql` shows
  four users, three roles, and the **same** application count after each run (EC-16, FR-10.4).

---

## Out of Scope

| Excluded                                           | Why                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Recruiter-facing application endpoints             | The pipeline feature owns counts-per-stage and ageing; specifying half of it here means specifying it twice |
| Stage transitions and overrides                    | Brief §3.1/§3.3 — a separate feature with its own actor, reason and audit requirements                      |
| Interview rounds, assignments, feedback            | Brief §3.2/§3.4 — the POC's hard case, and it needs the pipeline model first                                |
| Withdrawing an application                         | D-8 — `WITHDRAWN` is not in the enum, and no code path could write one                                      |
| Editing any profile field                          | D-12 — no write path to `User` exists, so read-only needs no enforcement                                    |
| `CandidateProfile`, phone number, resume upload    | D-2/D-12 — the only contact detail this POC restricts is `email` on `User`, already covered                 |
| A unique constraint on `(candidateUserId, roleId)` | D-6 — deliberately unlimited; the consequence is recorded in SEC-11, not hidden                             |
| Pagination on `GET /api/applications`              | PERF-8 — bounded by the candidate's own behaviour; the first thing to add if SEC-11 is ever closed          |
| Description search, location/department filters    | D-11 — `Role` has no such columns, and adding them changes the recruiter's shipped create/edit forms        |
| Email verification, password reset, rate limiting  | SEC-12 — POC scope; all three are named as accepted gaps rather than left to be discovered                  |
| An operator-secret provisioning route              | D-3/FR-3.3 — the seed already does this, and a second creation path is a second thing to secure             |
| An audit **table**                                 | FR-9.5 — belongs to the feature that first needs to _read_ the trail; `pino` lines carry it until then      |
| Automated tests                                    | Repo-wide decision — verification is manual `curl` + `psql` (CLAUDE.md)                                     |

---

## Dependencies

**Blocked by:** [../authentication/spec.md](../authentication/spec.md) (implemented) ·
[../roles/spec.md](../roles/spec.md) (implemented).

**Blocks:** the pipeline/ageing feature, the rounds + feedback feature, and the stage-override feature — all
three read or write `Application` and inherit the `PipelineStage` enum, MIG-5's write-side invariant, and
SEC-11's counting caveat.

**New npm packages:** **none.**

**New env vars:** **none.** `SEED_PASSWORD` is already required and now also covers the seeded candidate.

**Modified existing files**

| Path                                                                                      | Change                                                                                                                |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`prisma/schema.prisma`](../../../prisma/schema.prisma)                                   | `UserRole` += `CANDIDATE`; `PipelineStage`, `ApplicationStatus`, `Application`; two back-relations                    |
| [`prisma/seed.ts`](../../../prisma/seed.ts)                                               | One candidate account + seeded applications (FR-10)                                                                   |
| [`src/modules/auth/auth.schema.ts`](../../../src/modules/auth/auth.schema.ts)             | **Remove** `role` from `signupSchema`                                                                                 |
| [`src/modules/auth/auth.service.ts`](../../../src/modules/auth/auth.service.ts)           | `signup` writes the `CANDIDATE` literal instead of `input.role`                                                       |
| [`src/modules/auth/auth.routes.ts`](../../../src/modules/auth/auth.routes.ts)             | Replace the SEC-11.1 comment with a note that the gap is closed                                                       |
| [`src/modules/roles/roles.routes.ts`](../../../src/modules/roles/roles.routes.ts)         | Drop `requireRole(RECRUITER)` from the two GETs; keep it on the three writes                                          |
| [`src/modules/roles/roles.service.ts`](../../../src/modules/roles/roles.service.ts)       | Role-aware `where` + `select` (FR-4.3/4.4/4.5); `q` filter; `P2003` → `409` on delete                                 |
| [`src/modules/roles/roles.schema.ts`](../../../src/modules/roles/roles.schema.ts)         | `listRolesQuerySchema` gains `q`                                                                                      |
| [`src/modules/roles/role.select.ts`](../../../src/modules/roles/role.select.ts)           | Add `PUBLIC_ROLE_SELECT`                                                                                              |
| [`src/modules/roles/roles.controller.ts`](../../../src/modules/roles/roles.controller.ts) | Pass `req.user.role` through to the service                                                                           |
| [`src/lib/errors.ts`](../../../src/lib/errors.ts)                                         | `ErrorCode` += `ROLE_HAS_APPLICATIONS`; new `RoleHasApplicationsError`                                                |
| [`src/app.ts`](../../../src/app.ts)                                                       | Mount `applicationsRouter` at `/api/applications`, before `notFound`                                                  |
| [`CLAUDE.md`](../../../CLAUDE.md)                                                         | Feature table; the actors table; the "do not reintroduce a broad roles read" paragraph; the signup/SEC-11.1 paragraph |
| [`../roles/spec.md`](../roles/spec.md)                                                    | `Revision 3` recording the authenticated-open reads and the FR-6.10 answer                                            |

**New files**

| Path                                                  | Responsibility                                  |
| ----------------------------------------------------- | ----------------------------------------------- |
| `src/modules/applications/applications.routes.ts`     | Two routes, middleware order, nothing else      |
| `src/modules/applications/applications.controller.ts` | HTTP shaping only                               |
| `src/modules/applications/applications.service.ts`    | The apply transaction and the scoped list query |
| `src/modules/applications/applications.schema.ts`     | `createApplicationSchema`                       |
| `src/modules/applications/application.select.ts`      | `APPLICATION_SELECT` — the single projection    |

**External services:** none.
