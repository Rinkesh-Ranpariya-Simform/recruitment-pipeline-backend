# Interviews — Rounds and Interviewer Assignment (Backend)

> **Status:** Draft — awaiting approval. `plan.md` is a later artifact and does not exist yet.
> **Feature slug:** `interviews`
> **Scope:** `backend/` — Express 5 + Prisma 7 + PostgreSQL
> **Counterpart:** [../../../../frontend/specs/features/interviews/spec.md](../../../../frontend/specs/features/interviews/spec.md)
> **Depends on:** [../audit/spec.md](../audit/spec.md) · [../pipeline/spec.md](../pipeline/spec.md) — both must ship first
> **Revises:** [../pipeline/spec.md](../pipeline/spec.md) FR-8.2 — the dashboard gains an interview count
> **Blocks:** [../feedback/spec.md](../feedback/spec.md) · [../candidates/spec.md](../candidates/spec.md)
> **Parent brief:** [../../../../recruitment-pipeline.md](../../../../recruitment-pipeline.md) §3.2, §4, §6

---

## Goal

1. Give an application **interview rounds**: a typed, scheduled event tied to a stage, created by a
   recruiter.
2. Let **several interviewers sit on one round** — a panel — through an assignment table with a
   unique constraint that makes a duplicate assignment impossible rather than merely unlikely.
3. Make `InterviewAssignment` the **single fact every interviewer-scoped query in this system joins
   against**. It is the table that answers "may this person see this?" and it is introduced here so
   that feedback and candidates can both point at it.
4. Serve an interviewer's own rounds through a query whose `where` **already contains their
   assignment** — never a full list filtered afterwards, and never a fetch-then-check on a
   by-id read.
5. Ensure a round an interviewer is not assigned to is **indistinguishable from one that does not
   exist**.

Success means: a recruiter schedules a Technical round for an application at `INTERVIEW`, assigns
two interviewers, and each of them sees exactly that round in `GET /api/interviews` — while a third
interviewer requesting it directly by id receives `404` from a query that never loaded the row.

---

## Background / Context

The brief names this table's job before it names the table:

> After each round, the assigned interviewer submits structured feedback (e.g. a rating plus notes)
> tied to that round and that candidate.
> **An interviewer can view and act on only the candidates and rounds they are assigned to — this is
> the core hard case of this POC.**
> — §3.2

> At minimum, your model needs to represent: … **interviewer assignments per round**, feedback tied
> to a specific round …
> — §4

The request that prompted this spec adds the shape and the constraint:

> This allows multiple interviewers to participate in the same round.
> Add a unique constraint: `(interviewId, interviewerId)` to prevent duplicate assignments.

`InterviewAssignment` is therefore not a bookkeeping table. It is the **authorization primitive**
for the two features that follow it, and the reason this spec sits third rather than last.

## Revision to the pipeline spec — the dashboard gains an interview count

**What changes:** [../pipeline/spec.md](../pipeline/spec.md) FR-8.2 lists six summary fields and
FR-8.4 states, explicitly, that there is no interview count because the table does not exist yet.
It exists now. `GET /api/pipeline/summary` gains a seventh field, `interviews` — the count of
`SCHEDULED` rounds across all applications.

**What this reverses:** pipeline D-12 and FR-8.4, and pipeline XFE-9, which told the client not to
render a tile for the field.

**Why it is being overridden:** the walkthrough's recruiter dashboard shows four tiles —
*Open Jobs · Total Applicants · Interviews · Offers* — and the third was deferred only because of
build order, never on merit.

**What makes it safe:** one additional indexed `count` in the existing `$transaction`, served by
`Interview_status_scheduledAt_idx`. It adds no new query shape and no new authorization surface;
the endpoint is already recruiter-only.

**What it costs, named plainly:** the summary response grows by one key, which is a contract change
the frontend must make in the same pass. Any client written against the six-field version will
simply not render the new tile — additive, not breaking.

**What must change alongside this spec:** pipeline FR-8.2 (add the field), FR-8.4 (replaced by this
revision), XFE-9 (inverted), AC-B33 (now asserts seven keys), and pipeline PERF-4 (six counts
become seven). The frontend counterpart is revised in the same pass.

### Current state of `backend/`

|                | Today, assuming audit and pipeline have shipped |
| -------------- | ------ |
| `Application` | `{ id, candidateUserId, roleId, status, currentStage, stageEnteredAt, … }` — one per candidate per role |
| Stage rules | `modules/pipeline/pipeline.rules.ts` owns `STAGE_ORDER` and both transition maps |
| Audit | `recordAudit(tx, entry, log)`; `INTERVIEW_CREATED`, `INTERVIEWER_ASSIGNED`, `INTERVIEWER_UNASSIGNED` are already declared in `AuditAction` (audit MIG-3) |
| Users | `GET /api/users` returns interviewers only, recruiter-gated. **It has no frontend caller today** — this feature gives it one |
| Role-aware reads | One precedent: `buildRoleWhere(query, actorRole)` in `roles.service.ts`, which forces `status: OPEN` into a non-recruiter's `where` for the page, the pager's `count` **and** the single read |
| Interviews | **none.** No model, no endpoint, no assignment table |
| `/my-interviews` (frontend) | A placeholder page that is also the interviewer's landing route |

### Decisions settled during the interview

| # | Question | Decision | Recorded in |
|---|---|---|---|
| D-1 | Is a round tied to an application or to a candidate? | **An application.** A person may be in flight for two roles; a round belongs to one of them | FR-1.2 |
| D-2 | Who creates rounds? | **Recruiters only** | AZ-2 |
| D-3 | Who assigns interviewers? | **Recruiters only.** An interviewer cannot add themselves to a round, which would defeat the whole scoping model | AZ-3 |
| D-4 | Multiple interviewers per round? | **Yes** — the panel case the brief's §3.4 depends on. `InterviewAssignment` is a join table, not a column on `Interview` | FR-3.1 |
| D-5 | Duplicate assignment? | **`@@unique([interviewId, interviewerId])`.** The second attempt is a `409` from `P2002`, never a preceding `findFirst` | FR-3.4, EC-01 |
| D-6 | Can a non-interviewer be assigned? | **No.** `400 NOT_AN_INTERVIEWER`, resolved by a `findFirst({ where: { id, role: INTERVIEWER } })` — the constraint is in the lookup, not in an `if` after it | FR-3.3 |
| D-7 | One interviews list endpoint or two? | **One**, role-aware, following the shipped `buildRoleWhere` precedent exactly. Two endpoints returning the same rows under different guards is two places for the rule to rot | FR-4, BE-3 |
| D-8 | What does an interviewer see of the candidate on a round? | **`{ id, name }` and nothing else.** No email, no phone — and the select never names them, so there is nothing to strip | FR-5.3, SEC-1 |
| D-9 | Unassigned interviewer requests a round by id? | **`404`**, from the same query that would have returned it. Not `403` — a `403` confirms the round exists | FR-4.6, ERR-2 |
| D-10 | Unassignment: hard delete or soft? | **Hard delete.** The `AuditLog` row is the record that it happened; a soft-delete column would be a second, weaker record of the same fact | FR-3.6, MIG-5 |
| D-11 | Can a round be rescheduled or cancelled? | **Cancelled, yes** — `status` is an enum with `CANCELLED`. **Rescheduling is out of scope**; there is no `PATCH` on an interview in this pass | Out of Scope |
| D-12 | Must the application be `ACTIVE` to schedule a round? | **Yes.** `409 APPLICATION_NOT_ACTIVE`, reusing the code the pipeline feature added | FR-1.6 |
| D-13 | Must `Interview.stage` match the application's current stage? | **No.** A recruiter may schedule a round ahead of the move. The stage on the round is what it is *for*, not an assertion about now | FR-1.4 |

---

## Users / Actors

| Actor | May do, after this feature |
|---|---|
| Anonymous | Nothing. `401` everywhere |
| Candidate | Nothing. `403` — including on rounds scheduled for their own application |
| Interviewer | List **their own** assigned rounds; read one **assigned** round by id. Nothing else |
| Recruiter | Create rounds, list all rounds, read any round, assign and unassign interviewers |

**Deliberate POC trade-offs, so they are not read as oversights:**

- **A candidate cannot see their own interview schedule.** The walkthrough gives candidates a Jobs
  and My Applications surface and nothing more. Telling a candidate who is interviewing them is a
  product decision this POC does not make.
- **An interviewer cannot see the other rounds of a candidate they are assigned to.** Their scope is
  the round, not the person's whole process. `GET /api/interviews` returns their assignments and
  stops there.
- **An interviewer cannot see who else is on their panel until the feedback feature ships.** This
  spec returns the assignment list to recruiters only; the feedback feature is where a panel member
  gains sight of their colleagues' submissions, because that is where the brief asks for it.
- **There is no calendar, no availability, no conflict detection.** `scheduledAt` is a timestamp a
  recruiter types.

---

## User Stories

| ID | Story |
|---|---|
| **US-01** | As a recruiter, I want to schedule a typed round against an application, so that "Technical, Sep 18" is a record rather than a calendar invite nobody else can see. |
| **US-02** | As a recruiter, I want to put two interviewers on one round, so that a panel is representable. |
| **US-03** | As a recruiter, I want a duplicate assignment refused, so that a double-click does not produce two rows and two feedback slots. |
| **US-04** | As a recruiter, I want to remove an interviewer from a round, so that a reassignment is possible, and I want the removal recorded. |
| **US-05** | As an interviewer, I want to open my own list and see exactly the rounds I am on, so that I do not have to be told what I am doing. |
| **US-06** | As an interviewer, I want no way at all to reach a round I am not on, including by typing its id, so that the boundary is the system's and not my own discretion. |
| **US-07** | As a security reviewer, I want the interviewer's round response to carry no candidate contact detail, and I want to confirm it was never fetched. |

---

## Functional Requirements

### FR-1 — Rounds

- **FR-1.1** An `Interview` is one round: `{ id, applicationId, type, stage, scheduledAt, status,
  createdByUserId, createdAt, updatedAt }`.
- **FR-1.2** A round belongs to an **application**, not to a candidate (D-1). A person in flight for
  two roles has two application rows, and a round attaches to exactly one of them — which is also
  what makes the interviewer's authorization chain single-valued (FR-4.5).
- **FR-1.3** `type` is the Postgres enum `InterviewType`:
  `PHONE_SCREEN`, `TECHNICAL`, `SYSTEM_DESIGN`, `CULTURE_FIT`, `HIRING_MANAGER`. A finite set, for
  the same reason `PipelineStage` is one — a free-text round type is unqueryable by the third
  typo.
- **FR-1.4** `stage` is a `PipelineStage` and records **which stage the round is for**. It is
  **not** required to equal the application's `currentStage` (D-13): a recruiter routinely schedules
  the technical round while the candidate is still at `SCREEN`. It is an intent, not an assertion.
- **FR-1.5** `status` is the Postgres enum `InterviewStatus`:
  `SCHEDULED`, `COMPLETED`, `CANCELLED`. New rounds are created `SCHEDULED` by a literal in the
  service, never by a schema default — matching the shipped decision on `Role.status` and
  `Application.status` that a rule should live where it can be read.
- **FR-1.6** `POST /api/applications/:applicationId/interviews` creates a round. Recruiter-only.
  The target application is resolved by
  `findFirst({ where: { id, status: ACTIVE }, select: { id: true } })` — **the eligibility rule and
  the lookup are one statement**, so there is no window between checking and using. A missing or
  terminal application is `404` and `409 APPLICATION_NOT_ACTIVE` respectively, distinguished by a
  single follow-up read only when the first misses.
- **FR-1.7** `scheduledAt` is an ISO 8601 datetime. It may be in the past — backfilling a round that
  already happened is a normal thing to do and refusing it would push recruiters to lie about the
  date.
- **FR-1.8** Creation writes, in **one** transaction: the `Interview` row, then
  `recordAudit(tx, { action: 'INTERVIEW_CREATED', entityType: 'INTERVIEW', entityId,
  metadata: { applicationId, type, stage, scheduledAt } })`.
- **FR-1.9** `GET /api/applications/:applicationId/interviews` lists an application's rounds.
  **Recruiter-only** — an interviewer reaching rounds by application id would bypass the assignment
  scoping entirely, so this route has no interviewer path at all.

### FR-2 — Cancelling

- **FR-2.1** `PATCH /api/interviews/:interviewId` accepts exactly one field, `{ status: "CANCELLED" }`
  or `{ status: "COMPLETED" }`. Recruiter-only.
- **FR-2.2** `SCHEDULED` may become `COMPLETED` or `CANCELLED`. Neither terminal value may change
  again: a second `PATCH` is `409 INVALID_STAGE_TRANSITION`, reusing the code the pipeline feature
  added rather than inventing a parallel one for the same idea.
- **FR-2.3** Cancelling does **not** delete assignments or feedback. The round happened or was
  scheduled; erasing its panel would erase the record that the panel was ever chosen.
- **FR-2.4** A `CANCELLED` round still appears in an assigned interviewer's list, carrying its
  status, so that a cancellation is visible rather than mysterious.

### FR-3 — Assignment

- **FR-3.1** `InterviewAssignment` is a join table: `{ id, interviewId, interviewerId,
  assignedByUserId, createdAt }`. **Many interviewers per round** (D-4) — the panel case the brief's
  concurrent-feedback requirement depends on.
- **FR-3.2** `POST /api/interviews/:interviewId/assignments` with `{ interviewerId }`.
  Recruiter-only (D-3).
- **FR-3.3** The target user must exist **and** have `role: INTERVIEWER`. This is resolved by
  `findFirst({ where: { id: interviewerId, role: UserRole.INTERVIEWER }, select: { id: true } })` —
  **the role requirement is in the `where`**, not in an `if` after fetching the user. No row →
  `400 NOT_AN_INTERVIEWER`. A recruiter or candidate id therefore cannot be assigned, and the
  service never holds a user row it had no right to read.
- **FR-3.4** A duplicate assignment is refused by **Postgres**, not by a preceding read:
  `@@unique([interviewId, interviewerId])` raises `P2002`, which the service maps to
  `409 ALREADY_ASSIGNED` (D-5). A check-then-write loses to two concurrent clicks; a unique index
  cannot (EC-01).
- **FR-3.5** Assignment writes, in one transaction: the row, then
  `recordAudit(… INTERVIEWER_ASSIGNED, metadata: { interviewerId })`.
- **FR-3.6** `DELETE /api/interviews/:interviewId/assignments/:userId` removes an assignment.
  Recruiter-only. **A hard delete** (D-10) — the `AuditLog` row is the record that the assignment
  existed and was removed, and a soft-delete column would be a second, weaker record of the same
  fact. Responds `204` with an empty body, matching the shipped `DELETE /api/roles/:roleId`.
- **FR-3.7** Unassigning writes `recordAudit(… INTERVIEWER_UNASSIGNED, metadata: { interviewerId })`
  in the same transaction as the delete.
- **FR-3.8** Removing an assignment that does not exist is `404`. It is **not** idempotent-`204`:
  a client that thinks it removed somebody who was never there has a bug worth surfacing.
- **FR-3.9** **Unassigning does not delete that interviewer's feedback.** The feedback feature owns
  that decision and states it (feedback FR-6.4); this spec records only that the deletion here is
  scoped to the assignment row, and that `Feedback` has no foreign key to `InterviewAssignment` for
  exactly this reason.
- **FR-3.10** An interviewer removed from a round **immediately loses read access to it**, because
  the authorization is a join against the assignment table evaluated per request (FR-4.5) — not a
  claim captured in a token.

### FR-4 — Reading rounds, role-aware

- **FR-4.1** `GET /api/interviews` is **one endpoint serving both roles** (D-7), following the
  shipped `buildRoleWhere` precedent exactly. One function owns the decision:

  ```ts
  export function buildInterviewWhere(
    query: Pick<ListInterviewsQuery, 'status' | 'applicationId' | 'roleId'>,
    actorRole: UserRole,
    actorId: number,
  ): Prisma.InterviewWhereInput;
  ```

- **FR-4.2** For an **interviewer**, `buildInterviewWhere` pushes
  `{ assignments: { some: { interviewerId: actorId } } }` into the `where`. For a **recruiter** it
  does not. Predicates are **ANDed, never overwritten**, so an interviewer passing
  `?applicationId=` narrows within their own assignments and can never widen beyond them.
- **FR-4.3** The same `where` is used for the page, for the pager's `count`, **and** for the single
  read (FR-4.5). One decision, three call sites, no copies. **If a third interviews read is ever
  added, it routes through `buildInterviewWhere`** — a second copy of this decision is how the rule
  rots.
- **FR-4.4** Optional filters: `status`, `applicationId`, `roleId`. Paginated on the shipped
  `{ page, pageSize, total, totalPages }` envelope, ordered `[{ scheduledAt: 'desc' },
  { id: 'desc' }]`.
- **FR-4.5** `GET /api/interviews/:interviewId` resolves the round with the **same** scoped `where`:

  ```ts
  prisma.interview.findFirst({
    where: { id: interviewId, ...buildInterviewWhere({}, actorRole, actorId) },
    select: actorRole === UserRole.RECRUITER ? RECRUITER_INTERVIEW_SELECT : INTERVIEWER_INTERVIEW_SELECT,
  });
  ```

  **The authorization condition is inside the database query.** An unassigned interviewer's request
  returns no row, so the restricted data is never retrieved into application memory — the exact
  failure mode the brief §4 asks to be designed out.
- **FR-4.6** No row → `404 NOT_FOUND` (D-9). **Not `403`.** A `403` would confirm the round exists,
  turning the endpoint into an enumeration oracle; `404` makes "not yours" and "not there"
  indistinguishable.
- **FR-4.7** There is **no** `GET /api/interviews/:interviewId/assignments` for interviewers. The
  recruiter round detail carries the panel; an interviewer's does not (FR-5.3).

### FR-5 — Projections

- **FR-5.1** Two selects, in `interview.select.ts`, and **the role decides which is used before the
  query runs** — not which fields are stripped after it returns.
- **FR-5.2** `RECRUITER_INTERVIEW_SELECT` carries the round, the application's stage and status, the
  role's `{ id, title }`, the candidate's `{ id, name }`, and the assignment list expanded to
  `{ id, interviewer: { id, name } }`.
- **FR-5.3** `INTERVIEWER_INTERVIEW_SELECT` carries the round, the role's `{ id, title }`, and the
  candidate as **`{ id, name }` only** (D-8). It **does not name `email`**, it joins **no**
  `candidateProfile`, and it carries **no assignment list** — an interviewer learns who else is on
  the panel from the feedback feature, where that disclosure is specified, not incidentally from a
  round payload.
- **FR-5.4** The recruiter's select is a **superset** in content but a **different object**, not a
  runtime branch inside one select. There is no code path in which a `phone` or `email` column is
  fetched and then removed for an interviewer. **A shape that never selects the columns cannot leak
  them.**
- **FR-5.5** Neither select names `candidateUserId`, `createdByUserId` or `assignedByUserId` — raw
  foreign keys give a client something to guess with and nothing to render.

### FR-6 — Revision to `GET /api/pipeline/summary`

- **FR-6.1** The summary gains `interviews`: the count of `Interview` rows with
  `status: SCHEDULED`. One more indexed `count` in the existing `$transaction` (see the Revision
  section above).
- **FR-6.2** Pipeline FR-8.4 and XFE-9, which stated the field's absence, are superseded. Pipeline
  AC-B33 now asserts seven keys.

### FR-7 — Logging and seed

- **FR-7.1** New pino events: `interview.created`, `interview.status_changed`,
  `interview.assigned`, `interview.unassigned`, `interview.assign_refused`,
  `interview.scoped_read_miss` (an interviewer's by-id read that matched no row — the signal worth
  watching).
- **FR-7.2** Ids and enum values only. **No candidate name, no email, no round notes.**
- **FR-7.3** [`prisma/seed.ts`](../../../prisma/seed.ts) gains: a Technical round on the seeded
  `INTERVIEW`-stage application with **both** seeded interviewers assigned (so the panel and the
  concurrent-feedback case are demonstrable out of the box), and a System Design round on a second
  application with **only** `interviewer1` assigned — so that `interviewer2` has a real round they
  are not on, which is what AC-B24 fires against.

---

## Frontend Requirements

The obligations this backend places on the Next.js client. The rest of the frontend design lives in
[../../../../frontend/specs/features/interviews/spec.md](../../../../frontend/specs/features/interviews/spec.md).

- **XBE/XFE-1** `GET /api/interviews` is **one endpoint with two response shapes**, chosen by the
  caller's role. An interviewer's rounds carry no assignment list and no candidate contact fields;
  a recruiter's carry both panel and candidate `{ id, name }`. The client needs two TypeScript
  types, not one with optional fields — a shape with `email?: string` invites a component to render
  it.
- **XFE-2** An interviewer's `GET /api/interviews` response contains **only** rounds they are
  assigned to. **If an unassigned round ever appears, that is a backend bug to report, not a row to
  filter client-side.**
- **XFE-3** `GET /api/interviews/:id` for an unassigned interviewer is **`404`, not `403`**
  (FR-4.6). The client renders its not-found view; it must not special-case a `403` here, because
  there is none to catch.
- **XFE-4** The creation, assignment and unassignment endpoints are **recruiter-only** and answer
  `403` otherwise. The client must not render those affordances for an interviewer.
- **XFE-5** `409 ALREADY_ASSIGNED` is the duplicate-assignment answer. Its remedy is "this person is
  already on the panel" — the client should also disable already-assigned interviewers in its
  picker, **but the picker is UX and the `409` is the control.**
- **XFE-6** `400 NOT_AN_INTERVIEWER` means the chosen user is not an interviewer. The client sources
  its picker from `GET /api/users`, which returns interviewers only, so this should be unreachable
  through the UI — and it is still returned, because an unreachable error is the one worth having.
- **XFE-7** `DELETE …/assignments/:userId` answers `204` with an **empty body**. `apiFetch` already
  resolves a 204 to `''`; the client's api wrapper must be typed `Promise<void>`, matching the
  shipped `deleteRole`.
- **XFE-8** `InterviewType` and `InterviewStatus` are stable enum strings. The client keys its label
  maps on them as `Record<InterviewType, string>`, so a new value is a compile error rather than a
  blank cell.
- **XFE-9** `scheduledAt` is an ISO 8601 UTC string and **may be in the past** (FR-1.7). The client
  must not assume future dates or sort as if it could.
- **XFE-10** An interviewer's round payload contains **no `email`, no `phone`, and no assignment
  list**. This is the single most important guarantee this backend offers the interviewer UI: the
  interview detail screen has nothing to hide, because it was sent nothing to hide (FR-5.3).
- **XFE-11** `GET /api/pipeline/summary` now carries `interviews` (FR-6.1). This supersedes pipeline
  XFE-9.

---

## Backend Requirements

- **BE-1 — Structure.** A new module, `src/modules/interviews/`:
  `interviews.service.ts`, `interviews.repository.ts` (`buildInterviewWhere` and the scoped reads),
  `interviews.controller.ts`, `interviews.routes.ts`, `interviews.schema.ts`, `interview.select.ts`.
- **BE-2 — Two routers.** The two application-nested routes mount on the existing
  `/api/applications` path; the rest mount on a new `/api/interviews`. Both are exported from
  `interviews.routes.ts`, so the module that owns the scoping owns every route that needs it.
- **BE-3 — `buildInterviewWhere` is the only place the interviewer scope is expressed.** It mirrors
  `buildRoleWhere` in shape, naming and ANDing discipline, so a reader who has understood one has
  understood both. **No handler and no other service composes that predicate itself.**
- **BE-4 — Selects are chosen by role before the query, never applied after it** (FR-5.4). The
  controller passes `req.user.role` to the service; the service picks the select. There is no
  post-fetch mapping step in this module, and no function named `sanitise`, `strip` or `redact` —
  their absence is the design.
- **BE-5 — Middleware order** on every route: `requireAuth` → `requireRole(…)` where the route is
  single-role → `validateParams` → `validate` / `validateQuery`. The two reads carry **no**
  `requireRole`, because both roles may call them and the scoping is in the query.
- **BE-6 — Conflicts come from constraints.** `P2002` → `409 ALREADY_ASSIGNED`, `P2025` → `404`.
  The service catches Prisma codes **outside** the transaction callback, matching the shipped
  pattern in `applications.service.createApplication`. There is no `findFirst` preceding a create
  for the purpose of detecting a duplicate.
- **BE-7 — Every write is one transaction** containing its row change and its `recordAudit` call.
- **BE-8 — Service signature convention.** `log: Logger` last on every service function.
- **BE-9 — No new dependencies, no new environment variables.**

**How each of these is built — the file layout, the `buildInterviewWhere` body, the transaction
shapes and the log field table — is `plan.md § Backend Changes`.** This section states only what
must be true.

---

## API Contract

### `POST /api/applications/:applicationId/interviews` — Bearer · `RECRUITER`

```jsonc
// request
{ "type": "TECHNICAL", "stage": "INTERVIEW", "scheduledAt": "2026-09-24T09:30:00.000Z" }
```

```jsonc
// 201 Created
{
  "interview": {
    "id": 7,
    "type": "TECHNICAL",
    "stage": "INTERVIEW",
    "scheduledAt": "2026-09-24T09:30:00.000Z",
    "status": "SCHEDULED",
    "createdAt": "2026-09-19T12:00:11.004Z",
    "application": {
      "id": 12,
      "currentStage": "INTERVIEW",
      "status": "ACTIVE",
      "role": { "id": 3, "title": "Senior Backend Engineer" },
      "candidate": { "id": 21, "name": "John Smith" }
    },
    "assignments": []
  }
}
```

| Status | `code` | When |
|---|---|---|
| `201` | — | Created |
| `400` | `VALIDATION_ERROR` | `type`/`stage` not in their enum, `scheduledAt` not a datetime, bad `applicationId` |
| `401` / `403` | | Anonymous / not a recruiter |
| `404` | `NOT_FOUND` | No such application |
| `409` | `APPLICATION_NOT_ACTIVE` | Application is `HIRED` or `REJECTED` |

### `GET /api/applications/:applicationId/interviews` — Bearer · `RECRUITER`

`200 { "interviews": [ … ] }` — recruiter projection, ordered `scheduledAt desc`, unpaged (bounded
by the rounds on one application). Errors: `400` · `401` · `403` · `404`.

### `PATCH /api/interviews/:interviewId` — Bearer · `RECRUITER`

```jsonc
// request
{ "status": "CANCELLED" }
```

`200 { "interview": { … } }`. Errors: `400 VALIDATION_ERROR` · `401` · `403` · `404 NOT_FOUND` ·
`409 INVALID_STAGE_TRANSITION` (already terminal).

### `GET /api/interviews` — Bearer · `RECRUITER` or `INTERVIEWER`

Query: `status` · `applicationId` · `roleId` · `page` · `pageSize` (1–100, default 20).

```jsonc
// 200 — INTERVIEWER. No assignments array, no contact fields anywhere.
{
  "interviews": [
    {
      "id": 7,
      "type": "TECHNICAL",
      "stage": "INTERVIEW",
      "scheduledAt": "2026-09-24T09:30:00.000Z",
      "status": "SCHEDULED",
      "role": { "id": 3, "title": "Senior Backend Engineer" },
      "candidate": { "id": 21, "name": "John Smith" }
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

```jsonc
// 200 — RECRUITER. Same endpoint, different projection.
{
  "interviews": [
    {
      "id": 7,
      "type": "TECHNICAL",
      "stage": "INTERVIEW",
      "scheduledAt": "2026-09-24T09:30:00.000Z",
      "status": "SCHEDULED",
      "application": {
        "id": 12,
        "currentStage": "INTERVIEW",
        "status": "ACTIVE",
        "role": { "id": 3, "title": "Senior Backend Engineer" },
        "candidate": { "id": 21, "name": "John Smith" }
      },
      "assignments": [
        { "id": 14, "interviewer": { "id": 4, "name": "Ivan Interviewer" } },
        { "id": 15, "interviewer": { "id": 5, "name": "Ingrid Interviewer" } }
      ]
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

Errors: `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` (candidate) · `500`.

### `GET /api/interviews/:interviewId` — Bearer · `RECRUITER` or `INTERVIEWER`

`200 { "interview": { … } }`, projection by role as above.

```jsonc
// 404 Not Found — an interviewer who is not assigned. Byte-identical to a
// round that does not exist (FR-4.6).
{ "code": "NOT_FOUND", "message": "Resource not found" }
```

| Status | `code` | When |
|---|---|---|
| `200` | — | Found, and the caller is permitted |
| `400` | `VALIDATION_ERROR` | `interviewId` not a positive integer |
| `401` | `UNAUTHENTICATED` | No token |
| `403` | `FORBIDDEN` | Candidate |
| `404` | `NOT_FOUND` | No such round **or** the interviewer is not assigned — indistinguishable |

### `POST /api/interviews/:interviewId/assignments` — Bearer · `RECRUITER`

```jsonc
// request
{ "interviewerId": 5 }
```

```jsonc
// 201 Created
{ "assignment": { "id": 15, "interviewId": 7, "interviewer": { "id": 5, "name": "Ingrid Interviewer" }, "createdAt": "2026-09-19T12:04:02.771Z" } }
```

| Status | `code` | When |
|---|---|---|
| `201` | — | Assigned |
| `400` | `VALIDATION_ERROR` | `interviewerId` missing or not a positive integer |
| `400` | `NOT_AN_INTERVIEWER` | The user does not exist, or is not an `INTERVIEWER` (FR-3.3) |
| `401` / `403` | | Anonymous / not a recruiter |
| `404` | `NOT_FOUND` | No such interview |
| `409` | `ALREADY_ASSIGNED` | That interviewer is already on that round (`P2002`) |

### `DELETE /api/interviews/:interviewId/assignments/:userId` — Bearer · `RECRUITER`

`204`, empty body. Errors: `400` · `401` · `403` · `404 NOT_FOUND` (no such assignment — FR-3.8).

### Contract invariants — what must appear in **zero** responses

1. **No `email`, in any response from any endpoint in this feature, for any role.** Not the
   candidate's, not the interviewer's, not the recruiter's.
2. **No `phone`, anywhere.**
3. **No `assignments` array in any interviewer-role response** (FR-5.3). An interviewer's payload
   does not name their colleagues.
4. No `candidateUserId`, `createdByUserId` or `assignedByUserId` — the expanded objects replace
   them (FR-5.5).
5. No `passwordHash`, no token.
6. An interviewer's `GET /api/interviews` response contains **no round they are not assigned to**,
   at any page, under any filter combination.
7. No endpoint returns a `403` for an unassigned interviewer's by-id read. The only answer is `404`
   (FR-4.6).

---

## Data Model Changes

```prisma
/// NEW. A finite set, for the same reason `PipelineStage` is one: a free-text
/// round type is unqueryable by the third typo (FR-1.3).
enum InterviewType {
  PHONE_SCREEN
  TECHNICAL
  SYSTEM_DESIGN
  CULTURE_FIT
  HIRING_MANAGER
}

/// NEW. Rescheduling is out of scope (D-11), so there is no `RESCHEDULED`
/// value — an enum value no code path writes is a lie in the schema.
enum InterviewStatus {
  SCHEDULED
  COMPLETED
  CANCELLED
}

/// NEW. One round, against one application (D-1).
model Interview {
  id            Int @id @default(autoincrement())
  applicationId Int

  type InterviewType

  /// Which stage this round is FOR. Deliberately NOT constrained to equal
  /// `Application.currentStage` (D-13) — a recruiter schedules the technical
  /// round while the candidate is still at SCREEN, routinely.
  stage PipelineStage

  /// May be in the past (FR-1.7). Backfilling a round that already happened is
  /// normal; refusing it would push recruiters to lie about the date.
  scheduledAt DateTime

  /// No default: the service writes SCHEDULED explicitly, so the rule lives
  /// where it can be read. Same reasoning as `Role.status` and
  /// `Application.status` (FR-1.5).
  status InterviewStatus

  createdByUserId Int
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  application Application           @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  createdBy   User                  @relation("InterviewCreator", fields: [createdByUserId], references: [id], onDelete: Restrict)
  assignments InterviewAssignment[]
  feedback    Feedback[]            // populated by the feedback feature

  @@index([applicationId, scheduledAt])   // an application's rounds — FR-1.9
  @@index([status, scheduledAt])          // the dashboard's SCHEDULED count — FR-6.1
  @@index([scheduledAt])                  // the unfiltered recruiter list's ORDER BY
}

/// NEW — and the most load-bearing table in this schema.
///
/// This is the row every interviewer-scoped query in the system joins against.
/// `GET /api/interviews`, `GET /api/interviews/:id`, the feedback feature's
/// insert precondition and the candidates feature's `getInterviewerCandidate`
/// all resolve authorization through `assignments.some.interviewerId`. It is
/// introduced here, third in the build order, because the two features after it
/// cannot express their rules without it.
model InterviewAssignment {
  id          Int @id @default(autoincrement())
  interviewId Int

  interviewerId    Int
  assignedByUserId Int

  createdAt DateTime @default(now())

  interview   Interview @relation(fields: [interviewId], references: [id], onDelete: Cascade)
  interviewer User      @relation("InterviewAssignee", fields: [interviewerId], references: [id], onDelete: Cascade)
  assignedBy  User      @relation("InterviewAssigner", fields: [assignedByUserId], references: [id], onDelete: Restrict)

  /// One person, one seat, one round (D-5). The rule is HERE, in the database,
  /// not as a `findFirst` in the service: a read-then-write check loses to two
  /// concurrent clicks and would let both commit; a unique index cannot (EC-01).
  /// The service maps the resulting `P2002` to `409 ALREADY_ASSIGNED`.
  @@unique([interviewId, interviewerId])

  /// "My interviews" AND every authorization join in the two features that
  /// follow. `interviewerId` leads because it is the predicate, always.
  @@index([interviewerId, createdAt])
}

model Application {
  // …unchanged…
  interviews Interview[] // MODIFIED — back-relation
}

model User {
  // …unchanged…
  interviewsCreated   Interview[]           @relation("InterviewCreator")  // MODIFIED
  interviewAssignments InterviewAssignment[] @relation("InterviewAssignee") // MODIFIED
  assignmentsMade     InterviewAssignment[] @relation("InterviewAssigner") // MODIFIED
}
```

### Migration notes

- **MIG-1** Migration name: `add_interviews_and_assignments`. **Additive only.** Two enum types, two
  tables, five indexes, back-relations that produce no SQL. No existing column is altered and no
  existing row is touched.
- **MIG-2** `Interview.status` and `Interview.type` have **no schema default**. The service writes
  `SCHEDULED` explicitly, matching the shipped decision on `Role.status` and `Application.status`
  (roles MIG-3): the rule lives where a reader will find it, not in a column definition.
- **MIG-3** `@@unique([interviewId, interviewerId])` is the duplicate-assignment guard and is a
  **database** constraint, not a service check (D-5). Under two concurrent identical requests,
  Postgres rejects one; a `findFirst` before a `create` would let both commit. This is the same
  reasoning that put `@@unique([candidateUserId, roleId])` on `Application`.
- **MIG-4** `@@index([interviewerId, createdAt])` is added now, not later. It serves "my interviews"
  and — more importantly — it is the index behind the `some: { interviewerId }` join that the
  feedback and candidates features both depend on. **A sequential scan here would make the
  authorization query the slowest thing in the system**, which is a bad property for the query the
  POC is judged on.
- **MIG-5** Unassignment is a **hard delete** (D-10). There is no `deletedAt` column, because the
  `AuditLog` row written in the same transaction (FR-3.7) is the record that it happened, and two
  records of one fact eventually disagree.
- **MIG-6** Cascade behaviour, stated deliberately:
  `Application → Interview` is `Cascade` (a round without its application is meaningless);
  `Interview → InterviewAssignment` is `Cascade` (a seat on a deleted round is meaningless);
  `User → InterviewAssignment` (as interviewer) is `Cascade` (deleting a person removes their
  seats); but `createdBy` and `assignedBy` are `Restrict`, matching `AuditLog.actor` — **an actor
  reference is a historical fact and must not be erasable.**
- **MIG-7** `Feedback[]` appears on `Interview` in this diff but the `Feedback` model itself is the
  next feature's migration. Prisma requires both sides of a relation to exist, so the back-relation
  and the model **ship in the feedback migration**; it is written here only to show the shape this
  table is being built toward. **The `interviews` migration does not contain it.**
- **MIG-8** Row growth: a handful of rounds per application and one to four assignments per round.
  At 20 000 candidates that is on the order of 40 000 interviews and 80 000 assignments — small, and
  fully indexed for both access patterns.

---

## Authentication / Authorization

### Endpoint × role matrix

| Endpoint | Anonymous | Candidate | Interviewer | Recruiter |
|---|---|---|---|---|
| `POST /api/applications/:id/interviews` | `401` | `403` | **`403`** | ✅ |
| `GET /api/applications/:id/interviews` | `401` | `403` | **`403`** | ✅ |
| `PATCH /api/interviews/:id` | `401` | `403` | **`403`** | ✅ |
| `GET /api/interviews` | `401` | `403` | ✅ **assigned only** | ✅ all |
| `GET /api/interviews/:id` | `401` | `403` | ✅ **assigned only, else `404`** | ✅ all |
| `POST /api/interviews/:id/assignments` | `401` | `403` | **`403`** | ✅ |
| `DELETE /api/interviews/:id/assignments/:userId` | `401` | `403` | **`403`** | ✅ |

### Non-negotiable rules

- **AZ-1** `401` and `403` are never interchanged. `requireAuth` precedes every guard.
- **AZ-2** Round creation, listing by application, status changes, assignment and unassignment are
  **recruiter-only** (D-2, D-3).
- **AZ-3** **An interviewer cannot assign themselves, or anyone else, to anything.** The assignment
  endpoints are recruiter-gated at the route. If an interviewer could write to
  `InterviewAssignment`, they could grant themselves access to any candidate in the system — the
  entire scoping model rests on this one guard, and it is the reason assignment is not a
  self-service action.
- **AZ-4** **The interviewer scope is in the query, not after it.** `buildInterviewWhere` pushes
  `{ assignments: { some: { interviewerId: actorId } } }` into the `where` for the page, the pager's
  `count` and the single read alike (FR-4.3). **No handler filters a fetched list**, and there is no
  `if (interview.assignments.some(...))` anywhere in this module — a reviewer can confirm it by
  reading `interviews.repository.ts` alone.
- **AZ-5** A by-id read that the scope excludes answers **`404`, never `403`** (FR-4.6). This is the
  brief's sharpest check and the distinction matters: `403` tells an interviewer that round 41
  exists.
- **AZ-6** `GET /api/applications/:applicationId/interviews` has **no interviewer path at all**
  (FR-1.9). Reaching rounds through an application id would bypass the assignment predicate; the
  route is recruiter-only so that there is nothing to bypass.
- **AZ-7** The actor on every row — `createdByUserId`, `assignedByUserId` — is `req.user.id`. No
  body field sets it; zod strips any that tries.
- **AZ-8** Access is evaluated **per request**, against the assignment table (FR-3.10). It is not a
  token claim, so an unassignment takes effect on the interviewer's next request rather than on
  their next login.
- **AZ-9** A candidate is `403` on every endpoint here, including rounds for their own application.
  The walkthrough gives candidates no interview surface.

---

## Validation

| Endpoint | Field | Rule | Failure |
|---|---|---|---|
| all | `interviewId` / `applicationId` (param) | `z.coerce.number().int().positive()` | `400` `details.<param>` |
| `DELETE …/:userId` | `userId` (param) | `z.coerce.number().int().positive()` | `400` `details.userId` |
| `POST …/interviews` | `type` | `z.enum(InterviewType)`, required | `400` `details.type` |
| `POST …/interviews` | `stage` | `z.enum(PipelineStage)`, required | `400` `details.stage` |
| `POST …/interviews` | `scheduledAt` | `z.coerce.date()`, required | `400` `details.scheduledAt` |
| `PATCH /api/interviews/:id` | `status` | `z.enum(['COMPLETED', 'CANCELLED'])`, required | `400` `details.status` |
| `POST …/assignments` | `interviewerId` | `z.coerce.number().int().positive()`, required | `400` `details.interviewerId` |
| `GET /api/interviews` | `status` | `z.enum(InterviewStatus)`, optional | `400` `details.status` |
| `GET /api/interviews` | `applicationId`, `roleId` | `z.coerce.number().int().positive()`, optional | `400` |
| `GET /api/interviews` | `page` / `pageSize` | `min(1).default(1)` / `min(1).max(100).default(20)` | `400` |

- **VAL-1** **A round type or stage outside its enum is rejected before business logic**, satisfying
  brief §6. `{"type":"COFFEE_CHAT"}` never reaches Prisma.
- **VAL-2** `{"status":"SCHEDULED"}` on `PATCH /api/interviews/:id` is a `400`: the enum is the two
  terminal values only. Un-cancelling is not a supported action, and a validation error states that
  more clearly than a `409` would (mirroring pipeline VAL-4).
- **VAL-3** `scheduledAt` accepts any valid datetime, **including the past** (FR-1.7). There is no
  `.min(new Date())` refinement, deliberately.
- **VAL-4** Validation runs **after** `requireAuth` and `requireRole` (BE-5). An interviewer POSTing
  a malformed assignment gets `403`, not a `400` that would teach them the body shape.
- **VAL-5** Unknown body keys are stripped by zod. A body of
  `{"interviewerId":5,"assignedByUserId":1}` reaches the service as `{ interviewerId: 5 }`.
- **VAL-6** `NOT_AN_INTERVIEWER` is a **`400`, not a `404`**, even though it is produced by a `where`
  that matched no row (FR-3.3). The recruiter supplied a value their own picker should have
  constrained; that is a bad request, not a missing resource. It also does not leak whether the id
  exists as some other role — the message is the same either way.
- **VAL-7** `?pageSize=101` is a `400`, never a silent clamp, matching `listRolesQuerySchema`.

---

## Error Handling

| `code` | Status | Raised when | New? |
|---|---|---|---|
| `VALIDATION_ERROR` | `400` | Any Validation-table rule fails | no |
| `NOT_AN_INTERVIEWER` | `400` | Assignment target does not exist or is not an `INTERVIEWER` | **yes** |
| `UNAUTHENTICATED` | `401` | No/invalid/expired token | no |
| `FORBIDDEN` | `403` | Candidate anywhere; interviewer on a recruiter-only route | no |
| `NOT_FOUND` | `404` | No such application/interview/assignment — **or** an interviewer's scoped read matched nothing | no |
| `ALREADY_ASSIGNED` | `409` | `P2002` on `(interviewId, interviewerId)` | **yes** |
| `APPLICATION_NOT_ACTIVE` | `409` | Scheduling against a terminal application | no — added by pipeline |
| `INVALID_STAGE_TRANSITION` | `409` | `PATCH` on an already-terminal round | no — added by pipeline |
| `INTERNAL_ERROR` | `500` | Anything unhandled | no |

- **ERR-1** An interviewer's by-id read of a round they are not assigned to is `404 NOT_FOUND`,
  **byte-identical** to the response for a round that does not exist (FR-4.6, AZ-5). No header, no
  timing difference the service introduces, and no distinguishing message.
- **ERR-2** `403` is reserved for *wrong role for this route*. It is never used for *right role,
  wrong row* — that case is always `404`. Mixing them would turn every scoped endpoint into an
  existence oracle.
- **ERR-3** `ALREADY_ASSIGNED` comes from catching `P2002` **outside** the transaction callback,
  matching the shipped handling of `ALREADY_APPLIED` in `applications.service`. No `findFirst`
  precedes the create.
- **ERR-4** `INVALID_STAGE_TRANSITION` is reused for a terminal round rather than a new
  `INTERVIEW_NOT_SCHEDULED` code. It is the same idea — a state machine refusing a move — and a
  second code for it would give the client two branches where one suffices.
- **ERR-5** No Prisma code, SQL or stack trace reaches the client, in any environment.
- **ERR-6** A failed `recordAudit` aborts the transaction (audit FR-3.4): the round is not created,
  the assignment is not written, and the client sees `500`.

---

## Edge Cases

| ID | Case | Behaviour |
|---|---|---|
| **EC-01** | The same interviewer is assigned to one round **twice, concurrently** | Exactly one `201`; the other is `409 ALREADY_ASSIGNED` from `P2002`. `psql` shows **one** row. No check-then-write is involved (D-5, MIG-3) |
| **EC-02** | Two **different** interviewers are assigned to one round concurrently | Both `201`. Different unique-key tuples, nothing to contend on. This is the panel the brief's §3.4 needs |
| **EC-03** | A recruiter is passed as `interviewerId` | `400 NOT_AN_INTERVIEWER`, from a `where` that matched no row (FR-3.3). The recruiter's user row is never loaded |
| **EC-04** | A nonexistent user id is passed as `interviewerId` | `400 NOT_AN_INTERVIEWER` — the same response as EC-03, so the endpoint does not reveal whether the id exists (VAL-6) |
| **EC-05** | An interviewer requests a round they are not assigned to, **by id** | `404`. The row is never fetched: the assignment predicate is in the `where` (FR-4.5, AZ-4). **This is the brief's sharpest check** |
| **EC-06** | An interviewer passes `?applicationId=` for an application they have no round on | `200` with `interviews: []`. Their scope predicate ANDs with the filter; a filter can narrow but never widen (FR-4.2) |
| **EC-07** | An interviewer is unassigned while holding a page of results | Their **next** request excludes the round; the stale page in their browser does not grant access to anything (FR-3.10, AZ-8) |
| **EC-08** | An assignment is deleted twice | First `204`, second `404` — not an idempotent `204` (FR-3.8) |
| **EC-09** | A round is scheduled for a stage the application has not reached | `201`. `Interview.stage` is intent, not an assertion about now (D-13, FR-1.4) |
| **EC-10** | A round is scheduled with a past `scheduledAt` | `201`. Backfilling a round that happened is normal (FR-1.7, VAL-3) |
| **EC-11** | A round is scheduled against a `REJECTED` application | `409 APPLICATION_NOT_ACTIVE` (D-12, FR-1.6) |
| **EC-12** | An application is moved to `REJECTED` **after** a round was scheduled | The round remains and keeps its assignments. Cancelling it is a separate recruiter action (FR-2.3) |
| **EC-13** | A cancelled round | Still appears in the assigned interviewer's list, carrying `status: "CANCELLED"` (FR-2.4). A cancellation must be visible, not silent |
| **EC-14** | `PATCH` on an already-`CANCELLED` round | `409 INVALID_STAGE_TRANSITION` (FR-2.2) |
| **EC-15** | An interviewer with no assignments calls `GET /api/interviews` | `200`, `interviews: []`, `total: 0`, `totalPages: 0`. Never `404`, never `403` |
| **EC-16** | An interviewer sends `?page=999` | `200` with an empty array and accurate pagination, matching the shipped roles behaviour |
| **EC-17** | A candidate calls any endpoint here | `403`, including for rounds on their own application (AZ-9) |
| **EC-18** | An interviewer tries `POST /api/interviews/:id/assignments` naming themselves | `403` at the route, before the body is read (AZ-3, VAL-4). **This is the escalation the whole model rests on closing** |
| **EC-19** | An application is deleted | Its rounds cascade, and their assignments cascade with them (MIG-6). `Application` is itself `Restrict`-protected from role deletion, so this is not reachable over HTTP today |
| **EC-20** | `recordAudit` throws during assignment | The transaction aborts; no assignment row, `500` to the client (ERR-6) |

---

## Security Requirements

- **SEC-1** **An interviewer's projection never names a contact column.**
  `INTERVIEWER_INTERVIEW_SELECT` selects the candidate as `{ id, name }`; it does not name `email`
  and joins no `candidateProfile` (FR-5.3, D-8). The row Postgres returns does not contain the
  restricted data, so no future call site, log line or serializer can leak it. This answers the
  brief's §4 question directly: **excluded at the query, not stripped afterwards.**
- **SEC-2** **The assignment predicate is in the `where`** (AZ-4). An unassigned interviewer's
  request produces no row at all — the service has nothing to check and nothing to forget to check.
  There is no `sanitise`, `strip` or `redact` function in this module, and their absence is the
  design (BE-4).
- **SEC-3** **Only recruiters write to `InterviewAssignment`** (AZ-3). This is the single guard the
  entire interviewer-scoping model rests on: an interviewer who could create an assignment could
  grant themselves access to any candidate. It is enforced at the route, on both the `POST` and the
  `DELETE`, and there is no other write path to that table outside the seed.
- **SEC-4** `404` rather than `403` on a scoped miss (AZ-5, ERR-1) closes the enumeration oracle. An
  interviewer cannot walk the id space to learn how many rounds exist or which ids are live.
- **SEC-5** An interviewer's payload carries **no assignment list** (FR-5.3, contract invariant 3).
  Panel membership is a recruiter's information here; the feedback feature discloses colleagues'
  submissions deliberately and states why.
- **SEC-6** Raw foreign keys are absent from every response (FR-5.5). A client has nothing to
  enumerate against.
- **SEC-7** Logs carry ids and enum values only (FR-7.2). `interview.scoped_read_miss` records that
  an interviewer's by-id read matched nothing — the single most useful line for noticing someone
  probing, and it contains no candidate data.
- **SEC-8** The actor on every row is the verified token's subject (AZ-7), so an audit entry naming
  a recruiter cannot have been forged by a request body.
- **SEC-9** **Known accepted gaps.** (a) Any recruiter can assign any interviewer to any round —
  there is no per-role ownership, because there is no hiring-manager actor. (b) An interviewer
  assigned to a round learns the candidate's **name**, which is itself personal data; the brief
  restricts *contact details* specifically, and a name is required for the interview to happen at
  all. (c) There is no rate limit on the by-id read, so an authenticated interviewer can probe the
  id space as fast as the server answers `404` — the responses are indistinguishable, but the
  timing is not formally constant. (d) Unassignment does not revoke feedback already submitted;
  the feedback feature states that rule and its reasoning. All four are accepted for a localhost POC
  and **(c) must be addressed before this is reachable from anywhere but localhost.**

---

## Performance Requirements

- **PERF-1** `GET /api/interviews` for an interviewer p95 < 80 ms at 40 000 rounds / 80 000
  assignments. `EXPLAIN ANALYZE` must show the plan entering through
  `InterviewAssignment_interviewerId_createdAt_idx` and show **no sequential scan** on
  `InterviewAssignment` or `Interview`.
- **PERF-2** The interviewer's scope is a **join, not a two-step fetch**. The service must never
  load an interviewer's assignment ids and then query interviews with an `in` list — that is a
  fetch-then-filter wearing a different coat, and it degrades as the assignment count grows.
- **PERF-3** The page and the pager's `count` run in **one** `$transaction` sharing one `where`
  (FR-4.3), matching `roles.service.listRoles`. Two queries per request, never one per row.
- **PERF-4** `GET /api/interviews/:id` is a single `findFirst` — one query, including the
  authorization. **The authorization costs nothing extra**, because it is part of the query that was
  already being run.
- **PERF-5** The assignment list on a recruiter's round is fetched by Prisma's relation `select`,
  which joins. It is **not** an N+1 lookup per round. `EXPLAIN ANALYZE` on the generated SQL must
  confirm a join.
- **PERF-6** `POST /api/interviews/:id/assignments` is three statements: the interviewer lookup, the
  insert, the audit insert. **No pre-check `findFirst` for duplicates** — the unique index does that
  work (MIG-3), and adding a check would cost a query and still be wrong under concurrency.
- **PERF-7** The dashboard's new `interviews` count (FR-6.1) is served by
  `Interview_status_scheduledAt_idx` and adds < 10 ms to `GET /api/pipeline/summary`.
- **PERF-8** `GET /api/applications/:id/interviews` is unpaginated because it is bounded by the
  rounds on one application — a single-digit number in practice. If a single application ever
  exceeds 50 rounds, this endpoint must paginate; that is the documented threshold.

---

## Acceptance Criteria

Verified by hand with `curl` and `psql`. `$R` is a recruiter's token, `$I1` and `$I2` the two
seeded interviewers', `$C` a candidate's. `$APP` is a seeded `ACTIVE` application. `$IV` is a round
**both** interviewers are assigned to; `$IV_SOLO` is a round **only `$I1`** is assigned to (FR-7.3).

### Creating rounds

- **AC-B01** — **Given** `$APP` and `$R`, **when** `POST /api/applications/$APP/interviews` is sent
  with `{"type":"TECHNICAL","stage":"INTERVIEW","scheduledAt":"2026-09-24T09:30:00Z"}`, **then** the
  response is `201`, `interview.status` is `"SCHEDULED"`, and `interview.assignments` is `[]`
  (FR-1.5).
- **AC-B02** — **Given** that succeeded, **when**
  `GET /api/audit?entityType=INTERVIEW&entityId=<new id>` is called with `$R`, **then** the newest
  entry is `INTERVIEW_CREATED` with `metadata.applicationId`, `metadata.type` and `metadata.stage`
  (FR-1.8).
- **AC-B03** — **Given** `$R`, **when** `{"type":"COFFEE_CHAT",…}` is sent, **then** the response is
  `400` with `details.type`, and the server log shows no `interview.*` event (VAL-1).
- **AC-B04** — **Given** a `REJECTED` application, **when** a round is scheduled against it, **then**
  the response is `409 APPLICATION_NOT_ACTIVE` and `psql` shows no new `Interview` row (EC-11).
- **AC-B05** — **Given** `$R`, **when** a round is scheduled with a `scheduledAt` one year in the
  past, **then** the response is `201` (EC-10, VAL-3).
- **AC-B06** — **Given** `$R` and an application at `SCREEN`, **when** a round with
  `"stage":"OFFER"` is scheduled, **then** the response is `201` — the round's stage is intent, not
  an assertion (EC-09, D-13).

### Assignment

- **AC-B07** — **Given** `$IV` and `$R`, **when** `POST /api/interviews/$IV/assignments` is sent
  with `{"interviewerId": <$I1's id>}`, **then** the response is `201` and `psql` shows one row in
  `InterviewAssignment` with `assignedByUserId` equal to the recruiter's id (FR-3.5, AZ-7).
- **AC-B08** — **Given** that assignment exists, **when** the identical request is sent again,
  **then** the response is `409 ALREADY_ASSIGNED` and `psql` still shows **one** row (FR-3.4).
- **AC-B09** — **Given** `$R`, **when** `{"interviewerId": <the recruiter's own id>}` is sent,
  **then** the response is `400 NOT_AN_INTERVIEWER` and no row is written (FR-3.3, EC-03).
- **AC-B10** — **Given** `$R`, **when** `{"interviewerId": 999999}` is sent, **then** the response
  is `400 NOT_AN_INTERVIEWER` — **the same code and message as AC-B09**, so the endpoint does not
  reveal whether the id exists (VAL-6, EC-04).
- **AC-B11** — **Given** `$IV` with `$I1` assigned, **when**
  `DELETE /api/interviews/$IV/assignments/<$I1's id>` is sent with `$R`, **then** the response is
  `204` with an empty body and `psql` shows the row gone (FR-3.6).
- **AC-B12** — **Given** the same delete succeeded, **when** it is repeated, **then** the response
  is `404`, **not** `204` (FR-3.8, EC-08).
- **AC-B13** — **Given** an unassignment succeeded, **when** `GET /api/audit?action=INTERVIEWER_UNASSIGNED`
  is called with `$R`, **then** an entry exists naming the recruiter as actor and carrying
  `metadata.interviewerId` (FR-3.7).

### Concurrency — fired concurrently, not sequentially

- **AC-B14** — **Given** `$IV` with no assignments, **when** **two identical** assignment requests
  for `$I1` are **fired concurrently**, **then** exactly one returns `201`, the other `409
  ALREADY_ASSIGNED`, and `psql` shows **exactly one** row (EC-01, MIG-3).
- **AC-B15** — **Given** `$IV`, **when** assignments for `$I1` and `$I2` are **fired concurrently**,
  **then** **both** return `201` and `psql` shows two rows — the panel case (EC-02).

### The scoped read — the brief's sharpest check

- **AC-B16** — **Given** `$I1` assigned to `$IV_SOLO`, **when** `GET /api/interviews` is called with
  `$I1`, **then** the response is `200` and every returned round is one `$I1` is assigned to
  (FR-4.2).
- **AC-B17** — **Given** `$I2` **not** assigned to `$IV_SOLO`, **when** `GET /api/interviews` is
  called with `$I2`, **then** `$IV_SOLO` does **not** appear at any page or under any filter
  (contract invariant 6).
- **AC-B18** — **Given** `$I2`, **when** `GET /api/interviews/$IV_SOLO` is called — **the round's id
  supplied directly** — **then** the response is **`404 NOT_FOUND`**, with a body byte-identical to
  `GET /api/interviews/999999`. *This is the brief's §6 check: an interviewer requesting a round
  outside their assignment, directly by ID, refused at the point of the query* (FR-4.5, AZ-5,
  ERR-1, EC-05).
- **AC-B19** — **Given** the same request, **when** the server log is read, **then** an
  `interview.scoped_read_miss` line is present and the response was **not** `403` (SEC-4, SEC-7).
- **AC-B20** — **Given** `$I2`, **when** `GET /api/interviews?applicationId=<the application behind
  $IV_SOLO>` is called, **then** the response is `200` with `interviews: []` — the filter narrowed
  within their scope and could not widen it (EC-06, FR-4.2).
- **AC-B21** — **Given** `$I1` assigned to `$IV_SOLO`, **when** the assignment is deleted by `$R`
  and `$I1` immediately re-requests `GET /api/interviews/$IV_SOLO`, **then** the response is `404`
  — without `$I1` re-authenticating (FR-3.10, AZ-8, EC-07).
- **AC-B22** — **Given** the repository, **when**
  `grep -rn "assignments.some\|interviewerId" src/modules/interviews/` is run, **then** every match
  is inside `interviews.repository.ts` — the predicate exists in exactly one file (AZ-4, BE-3).
- **AC-B23** — **Given** the repository, **when**
  `grep -rniE "sanitis|sanitiz|strip|redact" src/modules/interviews/` is run, **then** it returns
  nothing (BE-4, SEC-2).

### Contact-detail exclusion

- **AC-B24** — **Given** `$I1` assigned to `$IV`, **when** `GET /api/interviews/$IV` is called with
  `$I1` and the **entire** response body is searched, **then** the strings `"email"` and `"phone"`
  appear **zero** times (contract invariants 1–2, SEC-1).
- **AC-B25** — **Given** the same response, **when** it is inspected, **then** there is **no**
  `assignments` key — an interviewer's payload does not name their panel (contract invariant 3,
  FR-5.3).
- **AC-B26** — **Given** the same response, **when** `candidate` is inspected, **then** it has
  exactly the keys `id` and `name` (D-8, FR-5.3).
- **AC-B27** — **Given** `$I1`, **when** `GET /api/interviews` is called and the whole body is
  searched, **then** `"email"`, `"phone"` and `"candidateUserId"` appear **zero** times (contract
  invariants 1, 2, 4).
- **AC-B28** — **Given** `$R`, **when** `GET /api/interviews/$IV` is called and the body searched,
  **then** `"email"` appears **zero** times — the rule has no recruiter exception in this feature;
  contact details are the candidates feature's surface (contract invariant 1).
- **AC-B29** — **Given** the codebase, **when** `INTERVIEWER_INTERVIEW_SELECT` in
  `interview.select.ts` is read, **then** it names neither `email` nor `candidateProfile` **nor**
  `assignments` (FR-5.3, SEC-1).

### Authorization

- **AC-B30** — **Given** no token, **when** any endpoint here is called, **then** the response is
  `401` (AZ-1).
- **AC-B31** — **Given** `$I1`, **when** `POST /api/interviews/$IV/assignments` is sent naming
  **themselves**, **then** the response is `403` and `psql` shows no new row. *This is the
  escalation the whole scoping model rests on closing* (AZ-3, EC-18, SEC-3).
- **AC-B32** — **Given** `$I1`, **when** `POST /api/applications/$APP/interviews` is called, **then**
  the response is `403` (AZ-2).
- **AC-B33** — **Given** `$I1`, **when** `GET /api/applications/$APP/interviews` is called, **then**
  the response is `403` — **not** a scoped `200`. There is no interviewer path on this route
  (AZ-6, FR-1.9).
- **AC-B34** — **Given** `$I1`, **when** `DELETE /api/interviews/$IV/assignments/<$I2's id>` is
  called, **then** the response is `403` and `psql` shows `$I2` still assigned (AZ-3).
- **AC-B35** — **Given** `$C` whose own application has a round, **when** `GET /api/interviews` is
  called, **then** the response is `403` (AZ-9, EC-17).
- **AC-B36** — **Given** `$I1`, **when** a malformed assignment body is POSTed, **then** the
  response is `403`, **not** `400` — the role guard precedes validation (VAL-4).
- **AC-B37** — **Given** `$R`, **when** an assignment body carries
  `{"interviewerId":5,"assignedByUserId":999}`, **then** the response is `201` and `psql` shows
  `assignedByUserId` equal to the **recruiter's own id** (VAL-5, AZ-7).

### Lifecycle and the dashboard revision

- **AC-B38** — **Given** a `SCHEDULED` round, **when** `PATCH /api/interviews/$IV` is sent with
  `{"status":"CANCELLED"}` and `$R`, **then** the response is `200` and `psql` shows the assignments
  **still present** (FR-2.3).
- **AC-B39** — **Given** that cancelled round, **when** `$I1` calls `GET /api/interviews`, **then**
  it still appears, carrying `"status":"CANCELLED"` (FR-2.4, EC-13).
- **AC-B40** — **Given** an already-`CANCELLED` round, **when** `PATCH` is sent again, **then** the
  response is `409 INVALID_STAGE_TRANSITION` (FR-2.2, EC-14).
- **AC-B41** — **Given** `{"status":"SCHEDULED"}`, **when** `PATCH` is sent, **then** the response
  is `400` with `details.status` (VAL-2).
- **AC-B42** — **Given** `$R`, **when** `GET /api/pipeline/summary` is called, **then** the response
  now carries **seven** keys including `interviews`, whose value equals the `SCHEDULED` round count
  in `psql` (FR-6.1, the Revision).

### Performance

- **AC-B43** — **Given** a database at 40 000 rounds and 80 000 assignments, **when**
  `EXPLAIN ANALYZE` is run on the interviewer's list query, **then** the plan enters through
  `InterviewAssignment_interviewerId_createdAt_idx` and shows **no sequential scan** on either table
  (PERF-1).
- **AC-B44** — **Given** the repository, **when** `interviews.service.ts` is read, **then** no
  function fetches assignment ids and then queries interviews with an `in` list (PERF-2).
- **AC-B45** — **Given** a recruiter's list of 20 rounds, **when** the query log is read, **then**
  exactly two statements ran — the page and the count — not one per round for assignments (PERF-3,
  PERF-5).

---

## Out of Scope

| Excluded | Why |
|---|---|
| Rescheduling a round (`scheduledAt` edit) | D-11. A reschedule needs a notification story and a record of the previous time; cancel-and-recreate says the same thing with rows that already exist |
| Calendar integration, availability, conflict detection | The brief models rounds, not scheduling. `scheduledAt` is a timestamp a recruiter types |
| Notifying an interviewer of an assignment | No notification channel exists in this POC, and inventing one would be a feature the requirements do not ask for |
| An interviewer seeing their panel colleagues | Deliberate (FR-5.3, SEC-5). The feedback feature discloses colleagues' submissions where the brief asks for it |
| An interviewer seeing a candidate's other rounds | Their scope is the round, not the person's process |
| A candidate seeing their interview schedule | The walkthrough gives candidates Jobs and My Applications only |
| Round duration, location, meeting links | Not in the requirements; each would be a field with no reader |
| Bulk assignment | Multiplies the concurrency surface for a convenience nobody asked for |
| Soft-deleting assignments | D-10. The audit row is the record; two records of one fact eventually disagree |
| Deleting a round | No requirement asks for it, and `CANCELLED` preserves the history that a round was planned |

---

## Dependencies

**Blocked by:** [../audit/spec.md](../audit/spec.md) — every write calls `recordAudit`, and the
three `AuditAction` values this feature writes are declared there.
[../pipeline/spec.md](../pipeline/spec.md) — `Interview.stage` is a `PipelineStage`, the
`APPLICATION_NOT_ACTIVE` and `INVALID_STAGE_TRANSITION` codes are added there, and this spec revises
its summary endpoint.
[../candidate/spec.md](../candidate/spec.md) (implemented) — `Application` is the parent of a round.

**Blocks:** [../feedback/spec.md](../feedback/spec.md) — feedback is authorized by an
`InterviewAssignment` row and has nothing to join without this table.
[../candidates/spec.md](../candidates/spec.md) — `getInterviewerCandidate()` walks
`applications → interviews → assignments`.

**Revises:** [../pipeline/spec.md](../pipeline/spec.md) FR-8.2, FR-8.4, XFE-9, PERF-4, AC-B33 — see
the Revision section above. The frontend counterpart is revised in the same pass.

**New npm packages:** **none.**

**New environment variables:** **none.**

**New files**

| Path | Purpose |
|---|---|
| `src/modules/interviews/interviews.repository.ts` | `buildInterviewWhere` + the scoped reads (BE-3) |
| `src/modules/interviews/interviews.service.ts` | Create, status change, assign, unassign, list, get |
| `src/modules/interviews/interviews.controller.ts` | HTTP concerns only |
| `src/modules/interviews/interviews.routes.ts` | Two exported routers (BE-2) |
| `src/modules/interviews/interviews.schema.ts` | Body, param and query schemas |
| `src/modules/interviews/interview.select.ts` | `RECRUITER_INTERVIEW_SELECT`, `INTERVIEWER_INTERVIEW_SELECT` |

**Modified existing files**

| Path | Change |
|---|---|
| [`prisma/schema.prisma`](../../../prisma/schema.prisma) | Two enums, `Interview`, `InterviewAssignment`, back-relations on `Application` and `User` |
| [`src/lib/errors.ts`](../../../src/lib/errors.ts) | `NOT_AN_INTERVIEWER`, `ALREADY_ASSIGNED` + subclasses |
| [`src/app.ts`](../../../src/app.ts) | Mount `interviewsRouter` at `/api/interviews` |
| [`src/modules/applications/applications.routes.ts`](../../../src/modules/applications/applications.routes.ts) | Mount the two application-nested round routes (BE-2) |
| `src/modules/pipeline/pipeline.service.ts` | Summary gains the `interviews` count (FR-6.1) |
| [`prisma/seed.ts`](../../../prisma/seed.ts) | Two rounds, three assignments, matching audit rows (FR-7.3) |
| [`CLAUDE.md`](../../../CLAUDE.md) | Feature table row; the `InterviewRound` domain bullet now points here |

**External services:** none.

**Cross-repo:** a change to the seven endpoints, the two new error codes, the two projections, or
the summary's field list must be made in
[../../../../frontend/specs/features/interviews/spec.md](../../../../frontend/specs/features/interviews/spec.md)
in the same pass.
