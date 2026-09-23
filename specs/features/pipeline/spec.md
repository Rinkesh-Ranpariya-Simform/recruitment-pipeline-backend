# Pipeline — Stage Transitions, Overrides, Ageing (Backend)

> **Status:** ✅ Approved and implemented. `plan.md` was skipped — the feature was built straight
> from this spec, as `candidate` and `audit` were.
> **Revised by:** [../interviews/spec.md](../interviews/spec.md) — `GET /api/pipeline/summary` gained
> a seventh field, `interviews`. FR-8.2, FR-8.3, FR-8.4, XFE-9, PERF-4, AC-B33 and D-12 are amended
> in place below; the struck-through text is what the field's absence used to say.
> **Feature slug:** `pipeline`
> **Scope:** `backend/` — Express 5 + Prisma 7 + PostgreSQL
> **Counterpart:** [../../../../frontend/specs/features/pipeline/spec.md](../../../../frontend/specs/features/pipeline/spec.md)
> **Depends on:** [../candidate/spec.md](../candidate/spec.md) — implemented · [../audit/spec.md](../audit/spec.md) — must ship first
> **Blocks:** [../interviews/spec.md](../interviews/spec.md) · [../candidate-access/spec.md](../candidate-access/spec.md)
> **Parent brief:** [../../../../recruitment-pipeline.md](../../../../recruitment-pipeline.md) §3.1, §3.3, §3.5, §6

---

## Goal

1. Move an application through a **finite, defined stage graph** — and refuse, before any write,
   a transition the graph does not permit.
2. Make a stage skip possible **only** through an explicit override that records **who, when and
   why**, with the reason enforced by a `NOT NULL` column rather than by a hopeful validator.
3. Leave a **complete history** of every transition, so "how long has this candidate been sitting at
   Screen" and "who moved them, and when" are both answerable from rows.
4. Answer **counts per stage per role, with ageing**, as an indexed SQL aggregate — never by loading
   candidates into Node and looping.
5. Hold correctly when **two recruiters act on the same application at the same instant**: one
   wins, the other is told why, and no update is silently lost.

Success means: a recruiter opens a board, sees `SCREEN: 8 candidates, oldest 14 days`, drags one to
Interview, is refused when they try to drag another from Applied straight to Offer, performs that
same jump through an override with a typed reason, and every one of those events is a row a hiring
manager can read back — while the aggregate behind the board runs as one indexed `GROUP BY` at
20 000 candidates.

---

## Background / Context

The brief's §3.1 is two sentences and both are load-bearing:

> Candidates are tracked against open roles through a defined, finite set of pipeline stages
> (e.g. applied → screen → interview → offer → hired/rejected).
> A candidate cannot skip a stage without an explicit override.

§3.3 turns the override into a record, not a flag:

> The override records who performed it, when, and why; decide and document who is allowed to
> perform one (recruiters, presumably — but be explicit).

§3.5 asks for the view, and §6 forbids the obvious implementation of it:

> A view showing candidate counts per stage per role, plus how long candidates have been sitting
> at their current stage (ageing).
> The pipeline view and ageing-by-stage query need to stay usable as the number of open roles and
> candidates grows — **don't load every candidate into memory and compute ageing in code.**

### Current state of `backend/`

|                  | Today                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Application`    | `{ id, candidateUserId, roleId, status, currentStage, stageEnteredAt, createdAt, updatedAt }`                                                                                                |
| Enums            | `PipelineStage { APPLIED SCREEN INTERVIEW OFFER }` and `ApplicationStatus { ACTIVE HIRED REJECTED }` — **deliberately disjoint** so `ACTIVE + REJECTED` is unrepresentable                   |
| `stageEnteredAt` | **Already on the table**, written at apply time. The candidate spec added it specifically for this feature: _"the ageing column the pipeline feature computes 'time at current stage' from"_ |
| Indexes          | `Application`: `@@unique([candidateUserId, roleId])`, `@@index([candidateUserId, createdAt])`, `@@index([roleId, currentStage])` — the last one annotated _"the pipeline aggregate"_         |
| Write paths      | Exactly one: `POST /api/applications`, candidate-only, producing `(ACTIVE, APPLIED)`                                                                                                         |
| Read paths       | Exactly one: `GET /api/applications`, candidate-scoped, unpaged. It is **not** widened by this feature                                                                                       |
| Transitions      | **none.** No endpoint changes `currentStage` or `status`                                                                                                                                     |
| History          | **none.** No `StageHistory`, no `StageOverride`                                                                                                                                              |
| Aggregates       | **none.** No `GET /api/pipeline`                                                                                                                                                             |
| Raw SQL          | **never used.** Every query today is Prisma's query builder                                                                                                                                  |

The schema was built anticipating this feature; this spec is where that anticipation is spent.

### Decisions settled during the interview

| #    | Question                                          | Decision                                                                                                                                                                                | Recorded in    |
| ---- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| D-1  | Where do `HIRED`/`REJECTED` live?                 | **On `ApplicationStatus`, not `PipelineStage`** — as shipped. So the transition rules split into a stage graph and an outcome map, rather than the single map the request sketched      | FR-2, FR-3     |
| D-2  | Who may move a candidate?                         | **Recruiters only.** Every endpoint in this feature is `requireRole(RECRUITER)`                                                                                                         | AZ-2           |
| D-3  | Who may override?                                 | **Recruiters only**, answering the brief's explicit "be explicit"                                                                                                                       | AZ-3           |
| D-4  | Is a reason optional on an override?              | **No.** `StageOverride.reason` is `NOT NULL`, min 10 characters after trim. An override without a reason is refused by validation and, if that were bypassed, by Postgres               | FR-4.3, VAL-2  |
| D-5  | May an override move backwards?                   | **Yes**, to any stage other than the current one. A recruiter who advanced someone by mistake needs a recorded way back, and the reason column is what makes it accountable             | FR-4.5         |
| D-6  | One history table or two?                         | **Two.** `StageHistory` is every transition; `StageOverride` is the subset that used the override path. Joined by `StageHistory.overrideId`                                             | FR-5, MIG-3    |
| D-7  | Is `reason` duplicated onto `StageHistory`?       | **No.** It lives only on `StageOverride`. A duplicated column is a column that can disagree with itself                                                                                 | MIG-3          |
| D-8  | Where does ageing come from?                      | **`Application.stageEnteredAt`**, computed in SQL. `StageHistory` is the audit of _how_ a stage was entered; `stageEnteredAt` is the denormalised _when_, kept for the aggregate's sake | FR-7.3, PERF-1 |
| D-9  | Raw SQL or Prisma `groupBy`?                      | **Raw SQL via `$queryRaw`.** Prisma's `groupBy` cannot compute `now() - stageEnteredAt` per group, and doing it in Node is what §6 forbids                                              | FR-7.4, BE-4   |
| D-10 | Two recruiters move the same application at once? | **The first wins; the second gets `409 STAGE_CONFLICT`.** Enforced by a stage-guarded `updateMany` whose `count: 0` means someone else moved first — never a read-then-write            | FR-6, EC-01    |
| D-11 | Can a terminal application be moved?              | **No.** `HIRED` and `REJECTED` are terminal. Any transition or override against one is `409 APPLICATION_NOT_ACTIVE`                                                                     | FR-2.6, FR-4.6 |
| D-12 | Does the dashboard count interviews?              | ~~**Not yet.**~~ **REVERSED — it does.** The interviews feature shipped the table and the `interviews` field in one pass (interviews FR-6.1)                                            | FR-8.2, FR-8.4 |
| D-13 | Does this feature touch `GET /api/applications`?  | **No.** It stays candidate-scoped and unpaged. A recruiter's view of applications is `GET /api/candidates`, owned by the candidate-access feature                                       | Out of Scope   |

---

## Users / Actors

| Actor       | May do, after this feature                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Anonymous   | Nothing. `401` on every endpoint here                                                                 |
| Candidate   | Nothing. `403` on every endpoint here — including against their own application                       |
| Interviewer | Nothing. `403` on every endpoint here                                                                 |
| Recruiter   | Move a stage, override a stage, set an outcome, read the pipeline aggregate and the dashboard summary |

**Deliberate POC trade-offs, so they are not read as oversights:**

- **A candidate cannot move their own application, and cannot withdraw it.** `ApplicationStatus`
  has no `WITHDRAWN` value — the candidate spec removed it on the grounds that an enum value no code
  path writes is a lie in the schema. Withdrawal is out of scope, so the value stays absent.
- **A candidate sees their stage change but is not told who changed it.** `GET /api/applications`
  returns `currentStage`; it returns no actor, no reason and no history. That is unchanged by this
  feature.
- **An interviewer has no view of the pipeline at all.** They see their assigned rounds, and that is
  the interviews feature. A `403` here is the correct and complete answer.
- **There is no hiring-manager role**, so "pipeline and ageing for their own open roles" (brief §2,
  optional) is served by the recruiter's unfiltered view.

---

## User Stories

| ID        | Story                                                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **US-01** | As a recruiter, I want to advance a candidate one stage, so that the board reflects reality without me editing a spreadsheet.                                           |
| **US-02** | As a recruiter, I want an illegal jump refused, so that the process is enforced by the system rather than by my memory of it.                                           |
| **US-03** | As a recruiter, I want to skip a stage when a candidate has genuinely already cleared it, by typing a reason, so that an exception is possible without being invisible. |
| **US-04** | As a hiring manager, I want every skip to name the person who performed it and their reason, so that an exception is accountable.                                       |
| **US-05** | As a recruiter, I want to mark an application hired or rejected, so that the board shows live candidates only.                                                          |
| **US-06** | As a recruiter, I want counts per stage per role and how long people have been waiting, so that I can see where a role is stuck.                                        |
| **US-07** | As a recruiter, I want that view to stay fast at 200 roles and 20 000 candidates, so that it is usable rather than a demo.                                              |
| **US-08** | As a recruiter, I want to be told when a colleague moved the same candidate a moment before me, so that my change does not silently overwrite theirs.                   |

---

## Functional Requirements

### FR-1 — The stage model, restated

- **FR-1.1** The live pipeline is the shipped `PipelineStage` enum, in this canonical order:
  `APPLIED → SCREEN → INTERVIEW → OFFER`. The order is declared once, in
  `modules/pipeline/pipeline.rules.ts`, as `STAGE_ORDER`.
- **FR-1.2** The terminal outcomes are the shipped `ApplicationStatus` values `HIRED` and
  `REJECTED`. An application is live iff `status === ACTIVE`.
- **FR-1.3** The request that prompted this spec sketched one map with `HIRED` and `REJECTED` as
  stages. **That is not the shipped schema** and is not adopted (D-1): keeping the value sets
  disjoint is what makes `status: ACTIVE, currentStage: REJECTED` unrepresentable without a `CHECK`
  constraint. The rules therefore split in two — FR-2 governs stage moves, FR-3 governs outcomes.
- **FR-1.4** Both maps are **total over their enums**, typed
  `Record<PipelineStage, ReadonlyArray<…>>`, so adding a stage is a compile error until every
  transition from it is decided — not a silent hole.

### FR-2 — Legal stage transitions

- **FR-2.1** The graph:

  ```ts
  const ALLOWED_STAGE_TRANSITIONS: Record<PipelineStage, ReadonlyArray<PipelineStage>> = {
    APPLIED: ['SCREEN'],
    SCREEN: ['INTERVIEW'],
    INTERVIEW: ['OFFER'],
    OFFER: [],
  };
  ```

  One step forward, no skips, no reversals. Everything else needs an override (FR-4) or is an
  outcome (FR-3).

- **FR-2.2** `PATCH /api/applications/:applicationId/stage` with `{ toStage }` performs a legal
  transition. Recruiter-only.
- **FR-2.3** `toStage` is validated as a `PipelineStage` **by zod at the route boundary**, before
  any service runs. `{ "toStage": "PROBATION" }` is a `400`, satisfying the brief's requirement that
  _"a transition naming a stage that isn't defined"_ is rejected before business logic (§6).
- **FR-2.4** A well-formed but illegal transition — `APPLIED → OFFER`, or `SCREEN → APPLIED` — is
  `409 INVALID_STAGE_TRANSITION`. The error body names both the current stage and the stages that
  _are_ reachable, so a client can render the legal options without hard-coding the graph.
- **FR-2.5** `toStage === currentStage` is `409 INVALID_STAGE_TRANSITION`, not a no-op `200`. A
  transition to where you already are is a client bug, and answering `200` hides it.
- **FR-2.6** An application whose `status` is not `ACTIVE` cannot be moved:
  `409 APPLICATION_NOT_ACTIVE` (D-11). `HIRED` and `REJECTED` are terminal.
- **FR-2.7** A successful transition, in **one** `prisma.$transaction`:
  1. a stage-guarded `updateMany` sets `currentStage = toStage` and `stageEnteredAt = now()`
     (FR-6.2);
  2. a `StageHistory` row is inserted with `overrideId: null`;
  3. `recordAudit(tx, { action: 'CANDIDATE_STAGE_CHANGED', … })` is called.

  All three commit or none do.

### FR-3 — Outcomes

- **FR-3.1** The map:

  ```ts
  const ALLOWED_OUTCOMES: Record<PipelineStage, ReadonlyArray<ApplicationStatus>> = {
    APPLIED: ['REJECTED'],
    SCREEN: ['REJECTED'],
    INTERVIEW: ['REJECTED'],
    OFFER: ['HIRED', 'REJECTED'],
  };
  ```

  Rejection is possible from any live stage. **Hiring is possible only from `OFFER`** — hiring
  someone who was never offered is the stage skip this feature exists to prevent, and it must go
  through an override to `OFFER` first, leaving a reason.

- **FR-3.2** `PATCH /api/applications/:applicationId/outcome` with `{ status, reason? }`.
  Recruiter-only. `status` is `HIRED` or `REJECTED` only — `ACTIVE` is rejected by validation
  (VAL-4): un-rejecting a candidate is not a supported action in this POC.
- **FR-3.3** An outcome not permitted from the current stage is `409 INVALID_STAGE_TRANSITION`,
  carrying the same detail shape as FR-2.4.
- **FR-3.4** An application already `HIRED` or `REJECTED` is `409 APPLICATION_NOT_ACTIVE`
  (FR-2.6).
- **FR-3.5** Setting an outcome **does not change `currentStage`**. The application stops where it
  stopped, which is the fact a hiring manager needs — "rejected at Screen" and "rejected at Offer"
  are different outcomes. `stageEnteredAt` is likewise not touched.
- **FR-3.6** `reason` on an outcome is **optional** free text, max 1000 characters. It is recorded
  in the audit event's metadata when present. It is optional because rejecting at the defined
  terminal of a stage is not an exception to the process — unlike a skip, which is (FR-4.3).
- **FR-3.7** A successful outcome, in one transaction: status-guarded `updateMany` → `StageHistory`
  row (`toStage === fromStage`, `toStatus` changed) → `recordAudit(… APPLICATION_OUTCOME_SET …)`.

### FR-4 — Overrides

- **FR-4.1** `POST /api/applications/:applicationId/stage-override` with `{ toStage, reason }`.
  **Recruiters only** (D-3, AZ-3) — the brief asks for this to be decided and stated, and this is
  the statement.
- **FR-4.2** An override may target **any `PipelineStage` other than the current one**, forwards or
  backwards (D-5). It is the escape hatch from FR-2.1, so it is not itself constrained by the graph
  — constraining it would just produce a second graph to work around.
- **FR-4.3** **`reason` is required.** Trimmed, 10–1000 characters. It is enforced in three places,
  deliberately: zod at the boundary (`400`), the `NOT NULL` column (`StageOverride.reason`), and the
  fact that the insert precedes the update in the same transaction. The brief requires the override
  be _"genuinely recorded, not inferred"_, and a nullable column would make "recorded" a matter of
  code discipline rather than schema.
- **FR-4.4** `toStage === currentStage` is `400` — an override that changes nothing is a client
  bug, and recording it would pollute the very trail the feature exists to keep clean.
- **FR-4.5** An override to a stage the graph would have allowed anyway (`APPLIED → SCREEN`) is
  **permitted and recorded**, with `metadata.skipped: 0`. Refusing it would force a client to
  re-derive the graph to decide which endpoint to call; recording the distinction lets a reader
  filter later.
- **FR-4.6** An application that is not `ACTIVE` cannot be overridden: `409 APPLICATION_NOT_ACTIVE`
  (D-11).
- **FR-4.7** A successful override, in **one** transaction, in this order:
  1. insert `StageOverride` — the record of _why_, written **first**, so a failure downstream can
     never leave a moved candidate with no explanation;
  2. stage-guarded `updateMany` on `Application` (FR-6.2);
  3. insert `StageHistory` with `overrideId` set to the new override's id;
  4. `recordAudit(tx, { action: 'STAGE_OVERRIDE_CREATED', metadata: { fromStage, toStage, reason,
overrideId, skipped } })`.
- **FR-4.8** `skipped` is the count of stages jumped, computed from `STAGE_ORDER` as
  `indexOf(toStage) - indexOf(fromStage) - 1`, floored at 0. It is recorded so that "was a stage
  actually skipped" is answerable at read time without re-deriving the graph.
- **FR-4.9** An override **cannot set an outcome**. `toStage` is a `PipelineStage`, so `HIRED` is
  not a value it accepts — hiring still requires reaching `OFFER`, by override if necessary, and
  then FR-3. This closes the hole a single combined map would have opened.

### FR-5 — History

- **FR-5.1** Every change to `currentStage` or `status` writes exactly one `StageHistory` row, in
  the same transaction as the change (FR-2.7, FR-3.7, FR-4.7). There is no code path that changes
  either column without writing one.
- **FR-5.2** A row records `applicationId`, `fromStage`, `toStage`, `fromStatus`, `toStatus`,
  `changedByUserId`, `overrideId` and `createdAt`.
- **FR-5.3** `fromStage` is nullable and is `null` **only** on the row representing entry into
  `APPLIED` — the application's creation. Every later row has both ends.
- **FR-5.4** `overrideId` is non-null **iff** the transition used the override path. It is
  `@unique`, so an override has at most one history row and the two cannot fan out.
- **FR-5.5** `reason` is **not** a column on `StageHistory` (D-7). A reader who needs it joins
  `StageOverride`, where it is `NOT NULL` and cannot be absent. Duplicating it would create a
  column that can disagree with itself.
- **FR-5.6** History is written by this feature and **read** by the candidate-access feature, on the
  recruiter candidate detail. This feature adds no history-reading endpoint of its own — one more
  endpoint returning the same rows in a different envelope is how a contract rots.
- **FR-5.7** `POST /api/applications` (candidate feature) is amended to write the `APPLIED` entry
  row inside its existing transaction — see the Revision note in FR-9.1.

### FR-6 — Concurrency

- **FR-6.1** The rule: **the first writer wins, the second is told.** Never a silent overwrite, and
  never a check-then-write (D-10).
- **FR-6.2** Every stage change is a **guarded `updateMany`**:

  ```ts
  const { count } = await tx.application.updateMany({
    where: { id, status: ApplicationStatus.ACTIVE, currentStage: fromStage },
    data: { currentStage: toStage, stageEnteredAt: new Date() },
  });
  if (count === 0) throw new StageConflictError();
  ```

  The stage the caller observed is part of the `where`. If another request moved the row between
  the read and the write, `count` is `0` and the transaction aborts — so the second recruiter gets
  `409 STAGE_CONFLICT` rather than overwriting the first.

- **FR-6.3** Outcome writes use the same shape, guarded on `status: ACTIVE`.
- **FR-6.4** `409 STAGE_CONFLICT` is distinct from `409 INVALID_STAGE_TRANSITION`. They have
  different remedies — refetch and retry versus "this move is not allowed" — and collapsing them
  into one code makes the client's message wrong half the time.
- **FR-6.5** Two overrides fired concurrently against the same application: exactly one commits.
  The loser's `StageOverride` row is rolled back with its transaction, so **no orphan override
  exists** for a move that did not happen (EC-02).
- **FR-6.6** There is no optimistic-concurrency version column and none is needed: `currentStage`
  is itself the version, because every transition changes it.

### FR-7 — The pipeline aggregate

- **FR-7.1** `GET /api/pipeline` returns, for each role, a count of live applications per stage
  plus ageing. Recruiter-only.
- **FR-7.2** Optional filters: `?roleId=` (one role) and `?stage=` (one stage). ANDed, never
  overwriting.
- **FR-7.3** Ageing is computed from `Application.stageEnteredAt` (D-8), as
  `now() - stageEnteredAt`. Three numbers per role/stage cell: `candidateCount`, `avgDaysInStage`
  (1 decimal place), `maxDaysInStage` (1 decimal place).
- **FR-7.4** **The aggregate is one raw SQL statement** via `prisma.$queryRaw` (D-9):

  ```sql
  SELECT a."roleId", r.title, a."currentStage",
         COUNT(*)::int                                                           AS candidate_count,
         ROUND(AVG(EXTRACT(EPOCH FROM (now() - a."stageEnteredAt")) / 86400)::numeric, 1) AS avg_days,
         ROUND(MAX(EXTRACT(EPOCH FROM (now() - a."stageEnteredAt")) / 86400)::numeric, 1) AS max_days
    FROM "Application" a
    JOIN "Role" r ON r.id = a."roleId"
   WHERE a.status = 'ACTIVE'
   GROUP BY a."roleId", r.title, a."currentStage";
  ```

  Prisma's `groupBy` cannot express the interval arithmetic, and doing it in Node is what brief §6
  forbids by name.

- **FR-7.5** Every parameter is passed through Prisma's tagged-template interpolation
  (`$queryRaw` with `${}`), never string concatenation. This is the only raw SQL in the codebase
  and the rule is absolute (SEC-3).
- **FR-7.6** Only `status = ACTIVE` rows are counted. A board is a picture of live candidates;
  hired and rejected people are outcomes, reported separately by FR-8.
- **FR-7.7** The service **densifies** the result: every role in the response carries all four
  stages, with `candidateCount: 0` and null ageing for empty ones. SQL returns no row for an empty
  group, and a client that has to invent missing columns is a client that will invent them
  differently from the next one.
- **FR-7.8** Roles are returned in the shipped roles ordering — `createdAt desc`, `id desc`. Stages
  within a role are returned in `STAGE_ORDER`, never alphabetically: `APPLIED, INTERVIEW, OFFER,
SCREEN` is a board nobody can read.
- **FR-7.9** `GET /api/pipeline` is **not paginated**. It returns one row per role per stage — at
  the brief's 200 roles that is 800 cells, a bounded payload independent of the 20 000 candidates
  behind it. The bound is the point: the response scales with roles, not with people. If roles ever
  outgrow this, the fix is pagination on roles, and PERF-5 names the threshold.

### FR-8 — The dashboard summary

- **FR-8.1** `GET /api/pipeline/summary` returns the recruiter's headline counts. Recruiter-only.
- **FR-8.2** ~~Four numbers~~ **Seven numbers**: `openRoles`, `totalApplicants` (all applications,
  any status), `activeApplicants`, `offers` (live applications at `OFFER`), `hired`, `rejected`, and
  — **added by the interviews feature (interviews FR-6.1)** — `interviews`, the count of `SCHEDULED`
  rounds across all applications.
- **FR-8.3** Each is a `count` with a `where` — ~~six~~ **seven** cheap indexed counts in one
  `$transaction`, never a `findMany` whose length is taken.
- **FR-8.4** ~~**No interview count.**~~ **SUPERSEDED by the interviews feature**, which shipped the
  `Interview` table and the seventh field in the same pass (interviews FR-6.1, FR-6.2, and its
  "Revision to the pipeline spec" section). This clause said the field would not exist because the
  table did not; both halves of that are now false. D-12 is reversed with it. The field is
  **additive** — a client written against the six-field version simply does not render the new
  tile.

### FR-9 — Changes to shipped behaviour

- **FR-9.1** **`POST /api/applications` gains one statement.** Inside its existing transaction, after
  creating the `Application`, it writes the entry `StageHistory` row
  (`fromStage: null, toStage: APPLIED, fromStatus: null, toStatus: ACTIVE, changedByUserId:
<the candidate>`). No response shape changes, no status code changes, and the candidate feature's
  acceptance criteria are unaffected. This is the only amendment to shipped code in this feature.
- **FR-9.2** `GET /api/applications` is **unchanged** (D-13). It stays candidate-scoped, unpaged,
  and carries no history, no actor and no reason.
- **FR-9.3** The `ErrorCode` union in [`src/lib/errors.ts`](../../../src/lib/errors.ts) gains three
  values: `INVALID_STAGE_TRANSITION`, `STAGE_CONFLICT`, `APPLICATION_NOT_ACTIVE`.

### FR-10 — Logging and seed

- **FR-10.1** New pino events: `pipeline.stage_changed`, `pipeline.override_created`,
  `pipeline.outcome_set`, `pipeline.transition_refused`, `pipeline.stage_conflict`,
  `pipeline.aggregate_read`.
- **FR-10.2** Ids and enum values only. **A reason string is never logged** — it is in the `redact`
  list the audit feature added.
- **FR-10.3** [`prisma/seed.ts`](../../../prisma/seed.ts) gains `StageHistory` rows consistent with
  the applications it already seeds (which sit at `INTERVIEW`, `APPLIED` and `SCREEN`), one
  `StageOverride` with a real reason, and the matching audit rows. A fresh database therefore shows
  a non-trivial board and a non-empty history.

---

## Frontend Requirements

The obligations this backend places on the Next.js client. The rest of the frontend design lives in
[../../../../frontend/specs/features/pipeline/spec.md](../../../../frontend/specs/features/pipeline/spec.md).

- **XFE-1** All five endpoints are **recruiter-only**. An interviewer or candidate session gets
  `403`, which `apiFetch` already turns into a `/forbidden` redirect. The client must not render
  pipeline affordances for those roles.
- **XFE-2** `409 INVALID_STAGE_TRANSITION` carries
  `details: { toStage: [<message>], allowed: [<stage>, …] }`. **The client renders the legal moves
  from `allowed` and never hard-codes the stage graph.** If the client owns a second copy of the
  graph, the two will disagree the first time the graph changes.
- **XFE-3** `409 STAGE_CONFLICT` means _someone else moved this candidate_. Its remedy is refetch,
  not retry-as-is. It is a **different code** from `INVALID_STAGE_TRANSITION` precisely so the
  client can say the right thing (FR-6.4).
- **XFE-4** `409 APPLICATION_NOT_ACTIVE` means the application is `HIRED` or `REJECTED`. Terminal;
  the client should stop offering move controls once `status !== 'ACTIVE'`.
- **XFE-5** The override endpoint rejects a missing or short `reason` with `400` and
  `details.reason`. The client should also require it before enabling Submit — **but the client
  check is UX, and the `400` is the control.**
- **XFE-6** `GET /api/pipeline` is **densified** (FR-7.7): every role carries all four stages, in
  `STAGE_ORDER`, including zero-count ones. The client renders columns directly from the array
  and never invents a missing stage.
- **XFE-7** `avgDaysInStage` and `maxDaysInStage` are `number | null`. They are `null` exactly when
  `candidateCount` is `0`. A client that formats `null` as `0 days` is stating something false.
- **XFE-8** `GET /api/pipeline` is unpaginated and returns no candidate names — only counts and
  ageing (FR-7.9). **The board is not a candidate list.** Names come from `GET /api/candidates`,
  which is the candidate-access feature and is paginated.
- **XFE-9** ~~`GET /api/pipeline/summary` has **no interview count**~~ — **INVERTED by the
  interviews feature.** The summary now carries `interviews` (interviews FR-6.1, XFE-11), and the
  client renders the walkthrough's third tile from it.
- **XFE-10** Every successful write returns the updated application as
  `{ application: { id, status, currentStage, stageEnteredAt, role: { id, title } } }` — enough to
  update a board cell without a refetch, though the client is free to invalidate instead.
- **XFE-11** No response from any endpoint in this feature contains a candidate's `email`, `phone`
  or `name`. **If one ever appears, that is a backend bug to report, not a field to hide
  client-side.**

---

## Backend Requirements

- **BE-1 — Structure.** A new module, `src/modules/pipeline/`:
  `pipeline.rules.ts` (the two maps, `STAGE_ORDER`, and the pure predicates over them),
  `pipeline.repository.ts` (the raw SQL aggregate and the guarded updates),
  `pipeline.service.ts` (the transactions), `pipeline.controller.ts`, `pipeline.routes.ts`,
  `pipeline.schema.ts`, `pipeline.select.ts`.
- **BE-2 — `pipeline.rules.ts` is pure.** It imports the Prisma enums and nothing else — no
  `prisma`, no Express, no logger. It is the file a reviewer reads to answer _"where is the stage
  progression rule enforced?"_ (brief §7.1), so it must be readable without following anything.
- **BE-3 — Rules are consulted before the transaction opens.** The service resolves the application,
  asks `pipeline.rules` whether the move is legal, and only then opens the write transaction. An
  illegal move costs one read and no write.
- **BE-4 — Raw SQL is confined to `pipeline.repository.ts`.** It is the only file in the codebase
  permitted to contain `$queryRaw`, it is tagged-template interpolated (FR-7.5), and its result is
  typed by an explicit interface rather than `any`.
- **BE-5 — Routes are split across two routers.** The three writes mount on the existing
  `/api/applications` path (`applicationsRouter` gains them, since the resource is an application);
  the two reads mount on a new `/api/pipeline`. Both live in `pipeline.routes.ts` and are exported
  separately, so the module owning the rules also owns every route that applies them.
- **BE-6 — Middleware order** on every write: `requireAuth` → `requireRole(RECRUITER)` →
  `validateParams(applicationIdParamSchema)` → `validate(bodySchema)`. On the reads:
  `requireAuth` → `requireRole(RECRUITER)` → `validateQuery(…)`.
- **BE-7 — One transaction per write.** The guarded update, the history insert, the override insert
  where applicable, and the `recordAudit` call all share one `prisma.$transaction` callback. No
  service in this feature performs a write outside one.
- **BE-8 — Service signature convention.** Every service function takes `log: Logger` last, matching
  every shipped service.
- **BE-9 — No new dependencies, no new environment variables.**

**How each of these is built — the file layout, the SQL text, the transaction bodies and the log
field table — is `plan.md § Backend Changes`.** This section states only what must be true.

---

## API Contract

### `PATCH /api/applications/:applicationId/stage` — Bearer · `RECRUITER`

```jsonc
// request
{ "toStage": "SCREEN" }
```

```jsonc
// 200 OK
{
  "application": {
    "id": 12,
    "status": "ACTIVE",
    "currentStage": "SCREEN",
    "stageEnteredAt": "2026-09-19T10:31:07.412Z",
    "role": { "id": 3, "title": "Senior Backend Engineer" },
  },
}
```

```jsonc
// 409 Conflict — illegal move
{
  "code": "INVALID_STAGE_TRANSITION",
  "message": "A candidate at APPLIED cannot move to OFFER without an override",
  "details": { "toStage": ["Not reachable from APPLIED"], "allowed": ["SCREEN"] },
}
```

| Status | `code`                     | When                                                                               |
| ------ | -------------------------- | ---------------------------------------------------------------------------------- |
| `200`  | —                          | Moved                                                                              |
| `400`  | `VALIDATION_ERROR`         | `toStage` missing or not a `PipelineStage`; `applicationId` not a positive integer |
| `401`  | `UNAUTHENTICATED`          | No/invalid token                                                                   |
| `403`  | `FORBIDDEN`                | Not a recruiter                                                                    |
| `404`  | `NOT_FOUND`                | No application with that id                                                        |
| `409`  | `INVALID_STAGE_TRANSITION` | Legal stage, illegal move — including `toStage === currentStage`                   |
| `409`  | `APPLICATION_NOT_ACTIVE`   | Application is `HIRED` or `REJECTED`                                               |
| `409`  | `STAGE_CONFLICT`           | Another request moved it first                                                     |
| `500`  | `INTERNAL_ERROR`           | Unhandled                                                                          |

### `POST /api/applications/:applicationId/stage-override` — Bearer · `RECRUITER`

```jsonc
// request
{
  "toStage": "INTERVIEW",
  "reason": "Candidate completed equivalent external screening.",
}
```

```jsonc
// 201 Created
{
  "application": {
    "id": 12,
    "status": "ACTIVE",
    "currentStage": "INTERVIEW",
    "stageEnteredAt": "2026-09-19T10:34:55.004Z",
    "role": { "id": 3, "title": "Senior Backend Engineer" },
  },
  "override": {
    "id": 4,
    "fromStage": "APPLIED",
    "toStage": "INTERVIEW",
    "reason": "Candidate completed equivalent external screening.",
    "skipped": 1,
    "createdAt": "2026-09-19T10:34:55.004Z",
    "performedBy": { "id": 1, "name": "Rhea Recruiter" },
  },
}
```

```jsonc
// 400 Bad Request — the reason the brief demands
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid request body",
  "details": { "reason": ["Give a reason of at least 10 characters"] },
}
```

| Status        | `code`                   | When                                                                   |
| ------------- | ------------------------ | ---------------------------------------------------------------------- |
| `201`         | —                        | Overridden                                                             |
| `400`         | `VALIDATION_ERROR`       | `reason` missing/short/too long; `toStage` invalid or equal to current |
| `401` / `403` |                          | Anonymous / not a recruiter                                            |
| `404`         | `NOT_FOUND`              | No such application                                                    |
| `409`         | `APPLICATION_NOT_ACTIVE` | Terminal application                                                   |
| `409`         | `STAGE_CONFLICT`         | Another request moved it first                                         |

### `PATCH /api/applications/:applicationId/outcome` — Bearer · `RECRUITER`

```jsonc
// request
{ "status": "HIRED", "reason": "Accepted the offer on Sep 19." }
```

```jsonc
// 200 OK — currentStage is deliberately unchanged (FR-3.5)
{
  "application": {
    "id": 12,
    "status": "HIRED",
    "currentStage": "OFFER",
    "stageEnteredAt": "2026-09-19T10:34:55.004Z",
    "role": { "id": 3, "title": "Senior Backend Engineer" },
  },
}
```

| Status        | `code`                     | When                                                                 |
| ------------- | -------------------------- | -------------------------------------------------------------------- |
| `200`         | —                          | Outcome set                                                          |
| `400`         | `VALIDATION_ERROR`         | `status` absent, or not `HIRED`/`REJECTED`; `reason` over 1000 chars |
| `401` / `403` |                            | Anonymous / not a recruiter                                          |
| `404`         | `NOT_FOUND`                | No such application                                                  |
| `409`         | `INVALID_STAGE_TRANSITION` | `HIRED` from a stage other than `OFFER`                              |
| `409`         | `APPLICATION_NOT_ACTIVE`   | Already terminal                                                     |
| `409`         | `STAGE_CONFLICT`           | Another request changed it first                                     |

### `GET /api/pipeline` — Bearer · `RECRUITER`

Query: `roleId` (positive int, optional) · `stage` (`PipelineStage`, optional).

```jsonc
// 200 OK
{
  "roles": [
    {
      "id": 3,
      "title": "Senior Backend Engineer",
      "status": "OPEN",
      "totalActive": 13,
      "stages": [
        { "stage": "APPLIED", "candidateCount": 8, "avgDaysInStage": 4.2, "maxDaysInStage": 11.0 },
        { "stage": "SCREEN", "candidateCount": 3, "avgDaysInStage": 9.7, "maxDaysInStage": 21.4 },
        { "stage": "INTERVIEW", "candidateCount": 2, "avgDaysInStage": 2.0, "maxDaysInStage": 3.1 },
        { "stage": "OFFER", "candidateCount": 0, "avgDaysInStage": null, "maxDaysInStage": null },
      ],
    },
  ],
}
```

Errors: `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `500 INTERNAL_ERROR`.

### `GET /api/pipeline/summary` — Bearer · `RECRUITER`

```jsonc
// 200 OK
{
  "summary": {
    "openRoles": 8,
    "totalApplicants": 142,
    "activeApplicants": 130,
    "offers": 5,
    "hired": 5,
    "rejected": 7,
  },
}
```

Errors: `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `500 INTERNAL_ERROR`.

### Contract invariants — what must appear in **zero** responses

1. No `email`, anywhere, from any of the five endpoints.
2. No `phone`, anywhere.
3. No candidate **name** from `GET /api/pipeline` or `/summary` — the board is counts, not people
   (XFE-8). `override.performedBy.name` is a _recruiter's_ name and is the one name any of these
   endpoints returns.
4. No `candidateUserId` on the returned `application` object — a recruiter navigating to a candidate
   does it through `GET /api/candidates`, which is scoped for the purpose.
5. No raw SQL, Prisma error code, or stack trace in any error body.
6. No endpoint here returns a list of candidates. There is no shape in this contract that scales
   with the number of people.

---

## Data Model Changes

```prisma
/// NEW. Every change to an Application's stage or status, as a row (FR-5).
///
/// This is the audit of HOW a stage was entered. `Application.stageEnteredAt` is
/// the denormalised WHEN, kept because the ageing aggregate must not join this
/// table 20,000 times (D-8, PERF-1).
model StageHistory {
  id            Int @id @default(autoincrement())
  applicationId Int

  /// Null ONLY on the row representing entry into APPLIED — the application's
  /// creation (FR-5.3). Every later row has both ends.
  fromStage  PipelineStage?
  toStage    PipelineStage
  fromStatus ApplicationStatus?
  toStatus   ApplicationStatus

  changedByUserId Int

  /// Non-null IFF this transition used the override path (FR-5.4). `@unique`, so
  /// one override has at most one history row and the two cannot fan out.
  ///
  /// `reason` is deliberately NOT duplicated here (D-7) — it lives on
  /// StageOverride, NOT NULL, one join away. A duplicated column is a column
  /// that can disagree with itself.
  overrideId Int? @unique

  createdAt DateTime @default(now())

  application Application   @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  changedBy   User          @relation("StageHistoryActor", fields: [changedByUserId], references: [id], onDelete: Restrict)
  override    StageOverride? @relation(fields: [overrideId], references: [id], onDelete: Cascade)

  @@index([applicationId, createdAt]) // the candidate-detail timeline read
}

/// NEW. A stage skip, and the reason for it (FR-4, brief §3.3).
///
/// `reason` is NOT NULL. The brief requires an override be "genuinely recorded,
/// not inferred", and a nullable column would make "recorded" a matter of code
/// discipline rather than of schema. This is the row a reviewer asks to see.
model StageOverride {
  id            Int @id @default(autoincrement())
  applicationId Int

  fromStage PipelineStage
  toStage   PipelineStage

  /// 10–1000 characters, enforced at the boundary by zod and here by NOT NULL.
  reason String

  performedByUserId Int
  createdAt         DateTime @default(now())

  application Application   @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  performedBy User          @relation("StageOverrideActor", fields: [performedByUserId], references: [id], onDelete: Restrict)
  history     StageHistory?

  @@index([applicationId, createdAt])
}

model Application {
  // …unchanged fields, including the already-shipped `stageEnteredAt`…

  stageHistory StageHistory[]  // MODIFIED — back-relation
  overrides    StageOverride[] // MODIFIED — back-relation

  /// NEW INDEX. The ageing aggregate's WHERE + GROUP BY, in one index
  /// (FR-7.4, PERF-1). The shipped `@@index([roleId, currentStage])` cannot
  /// serve it: `status = 'ACTIVE'` is the most selective predicate and must lead.
  @@index([status, roleId, currentStage])
}

model User {
  // …unchanged fields…

  stageChanges StageHistory[]  @relation("StageHistoryActor")  // MODIFIED
  overrides    StageOverride[] @relation("StageOverrideActor") // MODIFIED
}
```

### Migration notes

- **MIG-1** Migration name: `add_pipeline_history_and_overrides`. **Additive**, with one backfill
  (MIG-5). Two new tables, one new index on `Application`, four back-relations that produce no SQL.
- **MIG-2** No existing column is altered. `PipelineStage`, `ApplicationStatus` and
  `Application.stageEnteredAt` all ship today and are used as-is — this feature is the reason
  `stageEnteredAt` was added by the candidate feature, and it is spent here rather than replaced.
- **MIG-3** Two tables, not one (D-6). `StageHistory` answers _"what happened"_ for every
  transition; `StageOverride` answers _"why"_ for the subset that skipped. Folding them together
  would mean a nullable `reason` on every row, which is precisely the design the brief's
  "genuinely recorded, not inferred" rules out.
- **MIG-4** Actor foreign keys are `onDelete: Restrict`, matching `AuditLog.actor` and for the same
  reason (audit MIG-4): a history row whose actor a deletion can erase is not a history row. The
  application foreign keys are `Cascade` — deleting an application should take its history with it,
  and `Application` is itself `Restrict`-protected from role deletion, so this is not reachable in
  practice.
- **MIG-5** **Backfill, in the same migration.** One `StageHistory` row is inserted per existing
  `Application`:
  `fromStage: NULL, toStage: 'APPLIED', fromStatus: NULL, toStatus: 'ACTIVE',
changedByUserId: <the application's candidateUserId>, createdAt: <the application's createdAt>`.
  Without it, every pre-existing application shows an empty timeline, and a reader cannot tell an
  application with no history from one whose history was never captured. **This backfills
  `StageHistory` only — it does not invent `AuditLog` rows** (audit MIG-7), because history is a
  reconstruction of known facts and an audit trail is a record of observed actions.
- **MIG-6** `@@index([status, roleId, currentStage])` is added now, not after a slow query is
  observed. `status` leads because `WHERE status = 'ACTIVE'` is the aggregate's most selective
  predicate; the shipped `@@index([roleId, currentStage])` cannot serve the aggregate and is kept
  for the `Restrict` foreign-key check it was also added for.
- **MIG-7** Row growth: one `StageHistory` row per transition — at most five per application in the
  normal path (entry, three moves, one outcome), plus one per override. At 20 000 candidates that
  is ~100 000 rows, indexed by `applicationId`. `StageOverride` grows only with exceptions and is
  expected to be two orders of magnitude smaller.
- **MIG-8** `overrideId` is `@unique` on a nullable column. Postgres permits many `NULL`s in a
  unique index, so this constrains only the override-linked rows — exactly the intent (FR-5.4).

---

## Authentication / Authorization

### Endpoint × role matrix

| Endpoint                                    | Anonymous | Candidate   | Interviewer | Recruiter         |
| ------------------------------------------- | --------- | ----------- | ----------- | ----------------- |
| `PATCH /api/applications/:id/stage`         | `401`     | **`403`**   | **`403`**   | ✅                |
| `POST /api/applications/:id/stage-override` | `401`     | **`403`**   | **`403`**   | ✅                |
| `PATCH /api/applications/:id/outcome`       | `401`     | **`403`**   | **`403`**   | ✅                |
| `GET /api/pipeline`                         | `401`     | **`403`**   | **`403`**   | ✅                |
| `GET /api/pipeline/summary`                 | `401`     | **`403`**   | **`403`**   | ✅                |
| `GET /api/applications` _(shipped)_         | `401`     | ✅ own only | `403`       | `403` — unchanged |

### Non-negotiable rules

- **AZ-1** `401` and `403` are never interchanged. `requireAuth` precedes `requireRole` on all five
  routes.
- **AZ-2** Every endpoint in this feature is `requireRole(UserRole.RECRUITER)` (D-2). There is **no
  per-row scoping behind that guard** — a recruiter sees every role and every application. This is
  stated so nobody later adds a second role to a guard assuming a row filter protects them: there is
  none.
- **AZ-3** **Only recruiters may override** (D-3). The brief asks for this to be decided and
  documented rather than assumed, and this rule is the answer. An interviewer with an override
  endpoint would be able to advance a candidate they are assessing, which is the conflict of
  interest the separation exists to prevent.
- **AZ-4** A **candidate is `403` on their own application**, not `200`. There is no
  self-service stage change and no self-withdrawal in this POC.
- **AZ-5** The actor on every `StageHistory`, `StageOverride` and `AuditLog` row is `req.user.id`
  and nothing else. No request body field can set it; a body carrying `"performedBy": 9` reaches no
  code that reads it.
- **AZ-6** A recruiter reading `GET /api/pipeline` sees counts across **all** roles, including
  `CLOSED` ones — a role closed with people still in flight is exactly the situation a pipeline view
  must surface. `?roleId=` narrows it; nothing hides it.
- **AZ-7** `404` versus `403`: a recruiter requesting a nonexistent application gets `404`. Since
  every non-recruiter is already `403` at the route, there is no enumeration oracle here — the only
  actor who can distinguish "missing" from "exists" is the one permitted to see all of them.

---

## Validation

| Endpoint            | Field                   | Rule                                                | Failure                       |
| ------------------- | ----------------------- | --------------------------------------------------- | ----------------------------- |
| all writes          | `applicationId` (param) | `z.coerce.number().int().positive()`                | `400` `details.applicationId` |
| `…/stage`           | `toStage`               | `z.enum(PipelineStage)`, required                   | `400` `details.toStage`       |
| `…/stage-override`  | `toStage`               | `z.enum(PipelineStage)`, required                   | `400` `details.toStage`       |
| `…/stage-override`  | `reason`                | `z.string().trim().min(10).max(1000)`, **required** | `400` `details.reason`        |
| `…/outcome`         | `status`                | `z.enum(['HIRED', 'REJECTED'])`, required           | `400` `details.status`        |
| `…/outcome`         | `reason`                | `z.string().trim().max(1000)`, optional             | `400` `details.reason`        |
| `GET /api/pipeline` | `roleId`                | `z.coerce.number().int().positive()`, optional      | `400` `details.roleId`        |
| `GET /api/pipeline` | `stage`                 | `z.enum(PipelineStage)`, optional                   | `400` `details.stage`         |

- **VAL-1** **A stage that is not in the enum is rejected before any business logic runs.** This is
  the brief's §6 check — _"a stage transition naming a stage that isn't defined"_ — and a zod enum
  at the route boundary is where it is satisfied. `{ "toStage": "PROBATION" }` never reaches
  `pipeline.rules`, never reaches Prisma, and produces no log line other than the request's own.
- **VAL-2** **`reason` on an override is required and is 10 characters minimum after trim** (D-4).
  A whitespace-only reason is a `400`, not an empty recorded reason. The minimum is deliberate: it
  makes `"ok"` and `"."` fail, which is the difference between recording a reason and recording a
  keystroke.
- **VAL-3** The minimum does **not** apply to `reason` on an outcome (FR-3.6), which is optional
  free text. Rejecting at the end of a stage is not an exception to the process; skipping one is.
- **VAL-4** `{ "status": "ACTIVE" }` on the outcome endpoint is a `400`, not a resurrection. The zod
  enum is the two terminal values only. Un-rejecting a candidate is out of scope, and a validation
  error is a clearer statement of that than a `409` would be.
- **VAL-5** Unknown body keys are stripped by zod, matching every shipped endpoint. A body of
  `{ toStage: 'SCREEN', currentStage: 'OFFER', performedBy: 9 }` reaches the service as
  `{ toStage: 'SCREEN' }` — the tampered fields are not rejected, they simply do not exist by the
  time any code could read them.
- **VAL-6** Validation runs **after** `requireAuth` and `requireRole` (BE-6). A candidate sending a
  malformed override gets `403` and learns nothing about the body contract.
- **VAL-7** `toStage === currentStage` on the **override** endpoint is a `400` (FR-4.4), while on
  the **stage** endpoint it is a `409` (FR-2.5). The difference is real: the override endpoint's
  contract is "change the stage to something else", which the body violates; the stage endpoint's
  contract is "make this legal move", which the graph refuses. Both are stated so the asymmetry is
  not read as an inconsistency.

---

## Error Handling

The shipped envelope, unchanged: `{ code, message, details? }`.

| `code`                     | Status | Raised when                                              | New?    |
| -------------------------- | ------ | -------------------------------------------------------- | ------- |
| `VALIDATION_ERROR`         | `400`  | Any Validation-table rule fails                          | no      |
| `UNAUTHENTICATED`          | `401`  | No/invalid/expired token                                 | no      |
| `FORBIDDEN`                | `403`  | Not a recruiter                                          | no      |
| `NOT_FOUND`                | `404`  | No application with that id                              | no      |
| `INVALID_STAGE_TRANSITION` | `409`  | Well-formed stage, illegal move (FR-2.4, FR-2.5, FR-3.3) | **yes** |
| `APPLICATION_NOT_ACTIVE`   | `409`  | Application is `HIRED` or `REJECTED` (D-11)              | **yes** |
| `STAGE_CONFLICT`           | `409`  | Another request moved it first (FR-6.2)                  | **yes** |
| `INTERNAL_ERROR`           | `500`  | Anything unhandled                                       | no      |

- **ERR-1** `INVALID_STAGE_TRANSITION` carries `details.allowed` — the array of stages actually
  reachable from the current one. The client renders the legal moves from this rather than owning a
  second copy of the graph (XFE-2).
- **ERR-2** `STAGE_CONFLICT` and `INVALID_STAGE_TRANSITION` are **separate codes** (FR-6.4). One
  means "refetch and try again", the other means "this is not allowed". Collapsing them makes the
  client's message wrong half the time.
- **ERR-3** `APPLICATION_NOT_ACTIVE` is `409`, not `400`. The request is well-formed; the resource
  is in a state that refuses it. That is the definition of a conflict.
- **ERR-4** A nonexistent application is `404` for a recruiter. There is no `403`-vs-`404`
  enumeration concern here because every non-recruiter is already refused at the route (AZ-7).
- **ERR-5** No Prisma error code, SQL fragment or stack trace reaches the client. `P2025`,
  `P2003` and any raw-SQL error are caught and mapped or become `INTERNAL_ERROR`; the shipped
  `errorHandler` answers `{"code":"INTERNAL_ERROR","message":"Something went wrong"}`.
- **ERR-6** A failed `recordAudit` aborts the whole transaction (audit FR-3.4). The endpoint answers
  `500` and **the stage does not change** — the client sees a failure and the database agrees with
  it.

---

## Edge Cases

| ID        | Case                                                                                                             | Behaviour                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EC-01** | Two recruiters `PATCH …/stage` on the same application **concurrently**                                          | Exactly one `200`. The other's guarded `updateMany` matches 0 rows and it gets `409 STAGE_CONFLICT`. `psql` shows exactly **one** new `StageHistory` row (FR-6.2, D-10)    |
| **EC-02** | Two overrides fired **concurrently** on the same application                                                     | Exactly one `201`. The loser's `StageOverride` insert is rolled back with its transaction, so **no orphan override row exists** for a move that did not happen (FR-6.5)    |
| **EC-03** | An override and a stage move fired **concurrently**                                                              | Exactly one succeeds; the other is `409 STAGE_CONFLICT`. Both guard on `currentStage`, so the order they arrive in does not matter                                         |
| **EC-04** | An outcome and a stage move fired **concurrently**                                                               | Exactly one succeeds. The outcome guards on `status: ACTIVE`, the move guards on both `status` and `currentStage`, so whichever commits second finds its guard unsatisfied |
| **EC-05** | `toStage` is a stage the enum does not contain                                                                   | `400` before any service call, any DB read, any rules evaluation (VAL-1, brief §6)                                                                                         |
| **EC-06** | `applicationId` is `abc` or `-1`                                                                                 | `400` from `validateParams`, before the service (VAL table)                                                                                                                |
| **EC-07** | Override with `reason: "   "`                                                                                    | `400` — trimmed to empty, fails `min(10)` (VAL-2). **No row is written**                                                                                                   |
| **EC-08** | Override where `toStage` is one step forward (a legal move)                                                      | `201`, recorded, `skipped: 0` (FR-4.5). Permitted so the client need not re-derive the graph to pick an endpoint                                                           |
| **EC-09** | `PATCH …/outcome` with `HIRED` from `SCREEN`                                                                     | `409 INVALID_STAGE_TRANSITION` with `details.allowed: ["REJECTED"]`. Hiring requires reaching `OFFER` first, by override if necessary (FR-3.1)                             |
| **EC-10** | Any write against a `HIRED` or `REJECTED` application                                                            | `409 APPLICATION_NOT_ACTIVE` (D-11). Terminal is terminal                                                                                                                  |
| **EC-11** | A role with no applications at all                                                                               | Appears in `GET /api/pipeline` with four zero-count stages and null ageing (FR-7.7). Absent rows from `GROUP BY` are densified by the service, not by the client           |
| **EC-12** | An application created one second ago                                                                            | `avgDaysInStage` is `0.0`, not null. Null means _no candidates_, zero means _no time_ (XFE-7)                                                                              |
| **EC-13** | `?roleId=` names a role that does not exist                                                                      | `200` with `roles: []`. Not `404` — the filter matched nothing, which is a valid answer to a question about counts                                                         |
| **EC-14** | A `CLOSED` role still has live applications                                                                      | It appears in the pipeline with its counts (AZ-6). Hiding it is how people get forgotten                                                                                   |
| **EC-15** | `GET /api/pipeline` at 200 roles × 4 stages                                                                      | 800 cells, one SQL statement, one response. Bounded by roles, not by candidates (FR-7.9, PERF-5)                                                                           |
| **EC-16** | `recordAudit` throws inside a transition                                                                         | The transaction aborts: no stage change, no history row, no override row, `500` to the client (ERR-6)                                                                      |
| **EC-17** | A pre-existing application from before this migration                                                            | Has exactly one backfilled `StageHistory` row for its entry into `APPLIED` (MIG-5), so its timeline is not blank                                                           |
| **EC-18** | Two concurrent requests both read `currentStage: APPLIED`, one moves to `SCREEN`, the other overrides to `OFFER` | The second's guard `{ currentStage: 'APPLIED' }` matches 0 rows → `409 STAGE_CONFLICT`. **No lost update, and no override row left behind**                                |

---

## Security Requirements

- **SEC-1** Every endpoint here is recruiter-gated at the route (AZ-2). There is no row-level
  fallback, so the guard is the whole control and must not be widened.
- **SEC-2** The actor on every written row is `req.user.id` from a verified token (AZ-5). A
  client-supplied actor is stripped by zod before any code could read it (VAL-5), so a forged
  attribution on an override — the exact record the brief wants trustworthy — is not possible.
- **SEC-3** **The raw SQL in `pipeline.repository.ts` is tagged-template interpolated**
  (`$queryRaw` with `${}`), never string-concatenated, and its only interpolated values are a
  `roleId` that zod has already coerced to a positive integer and a `stage` zod has already
  constrained to the enum. This is the only raw SQL in the codebase; the rule is absolute and
  `$queryRawUnsafe` is not used anywhere (BE-4).
- **SEC-4** No endpoint in this feature returns a candidate's name, email or phone (contract
  invariant 1–3). The board is counts; the people behind them are the candidate-access feature, where the
  role-aware selects live.
- **SEC-5** The override `reason` is recruiter free text. It is stored, returned to recruiters, and
  recorded in audit metadata — and it is in the pino `redact` list (audit FR-8.3), so it never
  reaches stdout.
- **SEC-6** A `409 STAGE_CONFLICT` reveals only that the application changed. It does not name the
  other actor, which would tell a recruiter who is working on what without an access decision
  having been made.
- **SEC-7** No stage change is possible without an authenticated recruiter, satisfying the brief's
  §6 requirement that _"every action is tied to a real, authenticated user"_. There is no seed path,
  admin path, or unguarded route that moves a candidate.
- **SEC-8** **Known accepted gaps.** (a) A recruiter can override any application on any role —
  there is no per-role ownership model, because there is no hiring-manager actor in this POC, so a
  recruiter's authority is global. (b) `reason` is stored and returned verbatim with no length-based
  abuse protection beyond 1000 characters and no content moderation. (c) There is no rate limit on
  the write endpoints, so an authenticated recruiter can generate unbounded history rows. (d) The
  aggregate is not cached, so a recruiter refreshing rapidly runs the `GROUP BY` each time — bounded
  by PERF-1 but not free. All four are accepted for a localhost POC and **must be revisited before
  this is reachable from anywhere but localhost.**

---

## Performance Requirements

- **PERF-1** `GET /api/pipeline` p95 < 300 ms at the brief's simulated scale — **200 open roles and
  20 000 candidates**. `EXPLAIN ANALYZE` on the aggregate must show an **index scan** on
  `Application_status_roleId_currentStage_idx` and **no sequential scan** on `Application`.
- **PERF-2** **The aggregate is one SQL statement.** The endpoint issues exactly one `$queryRaw`
  plus one indexed `Role` read for titles and statuses — two queries total, independent of the
  number of candidates. **It must never issue a query per role, per stage, or per candidate.**
- **PERF-3** **No endpoint in this feature loads applications into Node.** The brief forbids it by
  name (§6). Verification is mechanical: `grep -rn "application.findMany" src/modules/pipeline/`
  returns nothing.
- **PERF-4** `GET /api/pipeline/summary` is ~~six~~ **seven** indexed `count` queries in one
  `$transaction` (FR-8.3), p95 < 120 ms at the same scale. **No `findMany().length` anywhere.** The
  seventh is served by `Interview_status_scheduledAt_idx` and adds < 10 ms (interviews PERF-7);
  measured at 33 ms total against 40,011 rounds.
- **PERF-5** The pipeline response is bounded by `roles × 4`, not by candidates (FR-7.9). At 200
  roles that is 800 cells, roughly 90 KB of JSON. **If roles are ever expected to exceed 500, this
  endpoint must paginate** — that is the documented threshold, not a vague "if it gets slow".
- **PERF-6** Every write is **one transaction containing at most four statements**: the guarded
  update, the history insert, the override insert where applicable, and the audit insert. No write
  path reads the application twice, and none performs a count.
- **PERF-7** The pre-transaction read that FR-3/BE-3 requires is a single
  `findUnique({ where: { id }, select: { id, status, currentStage, roleId } })` — an index lookup on
  the primary key selecting four columns, not the whole row and not its relations.
- **PERF-8** `StageHistory` reads are always keyed by `applicationId` and served by
  `StageHistory_applicationId_createdAt_idx`. There is no unfiltered history read in this feature or
  the ones that follow it.

---

## Acceptance Criteria

Verified by hand with `curl` and `psql`. There is no test suite. `$R` is a recruiter's access token,
`$I` an interviewer's, `$C` a candidate's — all from `npm run db:seed`. `$APP` is a seeded `ACTIVE`
application id at `APPLIED`.

### Legal transitions

- **AC-B01** — **Given** `$APP` at `APPLIED`, **when** `PATCH /api/applications/$APP/stage` is sent
  with `{"toStage":"SCREEN"}` and `$R`, **then** the response is `200` with
  `application.currentStage === "SCREEN"`, and `psql` shows `stageEnteredAt` updated to within a
  second of now (FR-2.7).
- **AC-B02** — **Given** the same request succeeded, **when** `psql` counts `StageHistory` for that
  application, **then** there is exactly one new row with `fromStage='APPLIED'`,
  `toStage='SCREEN'`, `overrideId IS NULL`, and `changedByUserId` equal to the recruiter's id
  (FR-5.1, AZ-5).
- **AC-B03** — **Given** the same, **when** `GET /api/audit?entityType=APPLICATION&entityId=$APP` is
  called with `$R`, **then** the newest entry is `CANDIDATE_STAGE_CHANGED` with
  `metadata: {"fromStage":"APPLIED","toStage":"SCREEN"}` (FR-2.7, audit FR-4.1).

### Illegal transitions — the brief's §7.1 walkthrough

- **AC-B04** — **Given** `$APP` at `APPLIED`, **when** `{"toStage":"OFFER"}` is sent, **then** the
  response is `409 INVALID_STAGE_TRANSITION` with `details.allowed` equal to `["SCREEN"]`, and
  `psql` shows **no** new `StageHistory` row and an unchanged `currentStage` (FR-2.4, ERR-1).
- **AC-B05** — **Given** `$APP` at `SCREEN`, **when** `{"toStage":"APPLIED"}` is sent, **then** the
  response is `409 INVALID_STAGE_TRANSITION` — the graph is forward-only (FR-2.1).
- **AC-B06** — **Given** `$APP` at `SCREEN`, **when** `{"toStage":"SCREEN"}` is sent, **then** the
  response is `409 INVALID_STAGE_TRANSITION`, **not** `200` (FR-2.5).
- **AC-B07** — **Given** `$APP`, **when** `{"toStage":"PROBATION"}` is sent, **then** the response
  is `400 VALIDATION_ERROR` with `details.toStage`, and the server log contains **no**
  `pipeline.*` event — the request never reached business logic (VAL-1, brief §6).
- **AC-B08** — **Given** a `HIRED` application, **when** any `{"toStage":…}` is sent, **then** the
  response is `409 APPLICATION_NOT_ACTIVE` (FR-2.6, EC-10).

### Overrides — the brief's §7.2 walkthrough

- **AC-B09** — **Given** `$APP` at `APPLIED`, **when**
  `POST /api/applications/$APP/stage-override` is sent with
  `{"toStage":"INTERVIEW","reason":"Completed equivalent external screening."}` and `$R`, **then**
  the response is `201`, `application.currentStage === "INTERVIEW"`, and `override.skipped === 1`
  (FR-4.7, FR-4.8).
- **AC-B10** — **Given** that succeeded, **when** `psql` reads `StageOverride`, **then** there is
  exactly one row whose `reason` is the submitted text and whose `performedByUserId` is the
  recruiter's id — **both non-null** (FR-4.3, brief §3.3).
- **AC-B11** — **Given** that succeeded, **when** `psql` reads `StageHistory`, **then** the newest
  row's `overrideId` equals that override's id (FR-5.4).
- **AC-B12** — **Given** `$APP`, **when** an override is sent with **no `reason` key at all**,
  **then** the response is `400 VALIDATION_ERROR` with `details.reason`, and `psql` shows **no** new
  `StageOverride` row and an unchanged `currentStage`. _This is the brief's §6 check that an
  override without a recorded reason is rejected_ (VAL-2, EC-07).
- **AC-B13** — **Given** `$APP`, **when** an override is sent with `{"reason":"   ","toStage":"OFFER"}`,
  **then** the response is `400` — a whitespace reason is not a reason (VAL-2).
- **AC-B14** — **Given** `$APP`, **when** an override is sent with `{"reason":"short","toStage":"OFFER"}`,
  **then** the response is `400` — under the 10-character minimum (VAL-2).
- **AC-B15** — **Given** `$APP` at `APPLIED`, **when** an override to `SCREEN` (a legal move) is
  sent with a valid reason, **then** the response is `201` with `override.skipped === 0` (FR-4.5,
  EC-08).
- **AC-B16** — **Given** an override succeeded, **when**
  `GET /api/audit?action=STAGE_OVERRIDE_CREATED` is called with `$R`, **then** the newest entry's
  `metadata` contains `reason`, `overrideId` and `skipped`, and its `actor.name` is the recruiter's
  (audit FR-4.1, FR-4.5).

### Outcomes

- **AC-B17** — **Given** an application at `OFFER`, **when**
  `PATCH /api/applications/$APP/outcome` is sent with `{"status":"HIRED"}` and `$R`, **then** the
  response is `200`, `application.status === "HIRED"` and **`currentStage` is still `"OFFER"`**
  (FR-3.5).
- **AC-B18** — **Given** an application at `SCREEN`, **when** `{"status":"HIRED"}` is sent, **then**
  the response is `409 INVALID_STAGE_TRANSITION` with `details.allowed` equal to `["REJECTED"]`
  (FR-3.1, EC-09).
- **AC-B19** — **Given** an application at `APPLIED`, **when** `{"status":"REJECTED"}` is sent,
  **then** the response is `200` — rejection is legal from any live stage (FR-3.1).
- **AC-B20** — **Given** any application, **when** `{"status":"ACTIVE"}` is sent, **then** the
  response is `400 VALIDATION_ERROR` with `details.status` (VAL-4).
- **AC-B21** — **Given** a `REJECTED` application, **when** `{"status":"HIRED"}` is sent, **then**
  the response is `409 APPLICATION_NOT_ACTIVE` (EC-10).

### Concurrency — fired concurrently, not sequentially

- **AC-B22** — **Given** `$APP` at `APPLIED`, **when** **two** `PATCH …/stage` requests with
  `{"toStage":"SCREEN"}` are **fired concurrently** (`curl … & curl … & wait`), **then** exactly one
  returns `200` and the other returns `409 STAGE_CONFLICT`, and `psql` shows **exactly one** new
  `StageHistory` row (EC-01, FR-6.2).
- **AC-B23** — **Given** `$APP` at `APPLIED`, **when** two **overrides** to different stages are
  **fired concurrently**, **then** exactly one returns `201`, the other `409 STAGE_CONFLICT`, and
  `psql` shows **exactly one** `StageOverride` row — **no orphan** for the losing request (EC-02,
  FR-6.5).
- **AC-B24** — **Given** `$APP` at `APPLIED`, **when** a stage move and an override are **fired
  concurrently**, **then** exactly one succeeds, `psql` shows exactly one new `StageHistory` row,
  and `currentStage` matches whichever succeeded (EC-03, EC-18).
- **AC-B25** — **Given** an application at `OFFER`, **when** an outcome and a stage move are
  **fired concurrently**, **then** exactly one succeeds and the other is `409` (EC-04).

### The aggregate

- **AC-B26** — **Given** a seeded database, **when** `GET /api/pipeline` is called with `$R`,
  **then** the response is `200` and **every** role's `stages` array has exactly four entries in the
  order `APPLIED, SCREEN, INTERVIEW, OFFER` (FR-7.7, FR-7.8).
- **AC-B27** — **Given** a role with no applications, **when** the same call is made, **then** that
  role appears with four `candidateCount: 0` entries whose `avgDaysInStage` and `maxDaysInStage` are
  **`null`**, not `0` (EC-11, XFE-7).
- **AC-B28** — **Given** an application whose `stageEnteredAt` is backdated 30 days by `psql`,
  **when** the aggregate is read, **then** that cell's `maxDaysInStage` is approximately `30.0`
  (FR-7.3).
- **AC-B29** — **Given** `$R`, **when** `GET /api/pipeline?roleId=<a real id>` is called, **then**
  only that role is returned (FR-7.2).
- **AC-B30** — **Given** `$R`, **when** `GET /api/pipeline?roleId=999999` is called, **then** the
  response is `200` with `roles: []` — **not** `404` (EC-13).
- **AC-B31** — **Given** `$R`, **when** `GET /api/pipeline?stage=BANANA` is called, **then** the
  response is `400` with `details.stage` (VAL-1).
- **AC-B32** — **Given** a `HIRED` application, **when** the aggregate is read, **then** it is
  counted in **no** stage cell — only `ACTIVE` rows appear on the board (FR-7.6).
- **AC-B33** — **REVISED by the interviews feature.** **Given** `$R`, **when**
  `GET /api/pipeline/summary` is called, **then** the response is `200` with exactly the **seven**
  keys in FR-8.2, **including** `interviews`, whose value equals the `SCHEDULED` round count in
  `psql` (interviews FR-6.1, AC-B42). The original form — six keys and no `interviews` — no longer
  holds and must not be re-asserted.

### Performance — the brief's §6 scale check

- **AC-B34** — **Given** a database loaded to 200 roles and 20 000 applications, **when**
  `EXPLAIN ANALYZE` is run on the aggregate SQL, **then** the plan shows an **index scan** on
  `Application_status_roleId_currentStage_idx` and **no sequential scan** on `Application`
  (PERF-1).
- **AC-B35** — **Given** the same database, **when** `GET /api/pipeline` is timed ten times, **then**
  the p95 is under 300 ms (PERF-1).
- **AC-B36** — **Given** the repository, **when**
  `grep -rn "findMany" src/modules/pipeline/` is run, **then** it returns **no** match against
  `application` — no endpoint here loads candidates into Node (PERF-3, brief §6).
- **AC-B37** — **Given** the repository, **when** `grep -rn "queryRawUnsafe" src/` is run, **then**
  it returns nothing (SEC-3).

### Authorization

- **AC-B38** — **Given** no token, **when** any of the five endpoints is called, **then** the
  response is `401` (AZ-1).
- **AC-B39** — **Given** `$I`, **when** `PATCH /api/applications/$APP/stage` is called, **then** the
  response is `403` and `psql` shows the application unchanged (AZ-2).
- **AC-B40** — **Given** `$I`, **when** `POST /api/applications/$APP/stage-override` is called with
  a valid body, **then** the response is `403` — **only recruiters override** (AZ-3, brief §3.3).
- **AC-B41** — **Given** `$C` whose own application is `$APP`, **when** any write here is called,
  **then** the response is `403`, not `200` (AZ-4).
- **AC-B42** — **Given** `$C`, **when** `GET /api/pipeline` is called, **then** the response is
  `403` (AZ-2).
- **AC-B43** — **Given** `$I`, **when** `PATCH /api/applications/$APP/stage` is sent with
  `{"toStage":"BANANA"}`, **then** the response is `403`, **not** `400` — the role guard precedes
  validation (VAL-6).
- **AC-B44** — **Given** `$R`, **when** a write is sent with
  `{"toStage":"SCREEN","performedBy":9,"currentStage":"OFFER"}`, **then** the response is `200` and
  `psql` shows `changedByUserId` equal to **the recruiter's own id**, not 9 (VAL-5, AZ-5).
- **AC-B45** — **Given** `$R`, **when** `PATCH /api/applications/999999/stage` is called, **then**
  the response is `404 NOT_FOUND` (AZ-7).

### Cross-cutting invariants

- **AC-B46** — **Given** `$R`, **when** all five endpoints are exercised and every response body is
  searched, **then** the strings `"email"` and `"phone"` appear **zero** times (contract invariants
  1–2, SEC-4).
- **AC-B47** — **Given** `$R`, **when** `GET /api/pipeline` and `GET /api/pipeline/summary` bodies
  are searched, **then** no candidate name appears and no array of candidates is present — the only
  `name` that may occur anywhere in this feature's responses is `override.performedBy.name`
  (contract invariant 3, XFE-8).
- **AC-B48** — **Given** the shipped candidate endpoints, **when** `GET /api/applications` is called
  with `$C` after this feature ships, **then** the response shape is byte-identical to before —
  `{ id, status, currentStage, createdAt, role: { id, title } }` with no history and no actor
  (FR-9.2).
- **AC-B49** — **Given** a fresh database, **when** `npm run db:seed` is run and `psql` counts
  `StageHistory`, **then** every `Application` row has at least one history row (MIG-5, FR-10.3).
- **AC-B50** — **Given** `NODE_ENV=production` and a forced raw-SQL error, **when** the aggregate is
  called, **then** the body is exactly `{"code":"INTERNAL_ERROR","message":"Something went wrong"}`
  with no SQL text (ERR-5, contract invariant 5).

---

## Out of Scope

| Excluded                                         | Why                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate self-withdrawal                        | `ApplicationStatus` has no `WITHDRAWN` value; the candidate spec removed it because no code path writes it, and none does here either                                                 |
| Un-rejecting or reopening a terminal application | Terminal is terminal (D-11). A reversal path needs its own audit semantics and a decision nobody has made                                                                             |
| Configurable per-role stage graphs               | The brief asks for _"a defined, finite set"_ and says the exact list can be configured "according to the POC requirements". One graph, in code, is that configuration                 |
| Bulk stage moves                                 | A batch endpoint multiplies the concurrency surface (FR-6) for a convenience nobody asked for                                                                                         |
| A history-reading endpoint                       | History is read on the recruiter candidate detail, owned by the candidate-access feature (FR-5.6). A second endpoint returning the same rows in a new envelope is how a contract rots |
| Widening `GET /api/applications` to recruiters   | A recruiter's view of applications is `GET /api/candidates`, scoped for the purpose (D-13)                                                                                            |
| ~~Interview counts on the dashboard~~            | **No longer out of scope** — shipped by the interviews feature as a Revision to this spec (interviews FR-6.1)                                                                         |
| "Stuck beyond N days" alert view                 | Brief §8 optional work. The aggregate returns `maxDaysInStage`, which is the input such a view would need                                                                             |
| Caching the aggregate                            | Accepted as a gap (SEC-8d) rather than half-built; a cache needs an invalidation story that five write paths would all have to honour                                                 |
| Per-role recruiter ownership                     | There is no hiring-manager actor in this POC, so recruiter authority is global (SEC-8a)                                                                                               |
| Time-in-each-past-stage analytics                | `StageHistory` records enough to compute it later; no endpoint exposes it, because nothing in the requirements asks for it                                                            |

---

## Dependencies

**Blocked by:** [../audit/spec.md](../audit/spec.md) — every write here calls `recordAudit` inside
its transaction, so the writer and table must exist first.
[../candidate/spec.md](../candidate/spec.md) (implemented) — `Application`, `PipelineStage`,
`ApplicationStatus` and `stageEnteredAt` all ship there.
[../roles/spec.md](../roles/spec.md) (implemented) — the aggregate joins `Role` for titles.

**Blocks:** [../interviews/spec.md](../interviews/spec.md) — `Interview.stage` is a `PipelineStage`
and rounds are created against `ACTIVE` applications.
[../candidate-access/spec.md](../candidate-access/spec.md) — the recruiter candidate detail renders the
`StageHistory` timeline this feature writes.

**New npm packages:** **none.** `$queryRaw` is Prisma 7 core.

**New environment variables:** **none.**

**New files**

| Path                                          | Purpose                                                |
| --------------------------------------------- | ------------------------------------------------------ |
| `src/modules/pipeline/pipeline.rules.ts`      | `STAGE_ORDER`, both maps, pure predicates (BE-2)       |
| `src/modules/pipeline/pipeline.repository.ts` | The raw SQL aggregate and the guarded updates (BE-4)   |
| `src/modules/pipeline/pipeline.service.ts`    | The four write transactions and the two reads          |
| `src/modules/pipeline/pipeline.controller.ts` | HTTP concerns only                                     |
| `src/modules/pipeline/pipeline.routes.ts`     | Two exported routers (BE-5)                            |
| `src/modules/pipeline/pipeline.schema.ts`     | Body, param and query schemas                          |
| `src/modules/pipeline/pipeline.select.ts`     | `PIPELINE_APPLICATION_SELECT`, `STAGE_OVERRIDE_SELECT` |

**Modified existing files**

| Path                                                                                                            | Change                                                                            |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`prisma/schema.prisma`](../../../prisma/schema.prisma)                                                         | `StageHistory`, `StageOverride`, one new `Application` index, four back-relations |
| [`src/lib/errors.ts`](../../../src/lib/errors.ts)                                                               | Three new `ErrorCode` values + their `AppError` subclasses (FR-9.3)               |
| [`src/app.ts`](../../../src/app.ts)                                                                             | Mount `pipelineRouter` at `/api/pipeline`                                         |
| [`src/modules/applications/applications.routes.ts`](../../../src/modules/applications/applications.routes.ts)   | Mount the three write routes (BE-5)                                               |
| [`src/modules/applications/applications.service.ts`](../../../src/modules/applications/applications.service.ts) | Write the entry `StageHistory` row inside the existing transaction (FR-9.1)       |
| [`prisma/seed.ts`](../../../prisma/seed.ts)                                                                     | History, one override, matching audit rows (FR-10.3)                              |
| [`CLAUDE.md`](../../../CLAUDE.md)                                                                               | Feature table row; the stage-transition and pipeline-query bullets now point here |

**External services:** none.

**Cross-repo:** this backend and the Next.js client share one API contract. A change to the five
endpoints, the three new error codes, the densified pipeline shape, or the summary's field list must
be made in
[../../../../frontend/specs/features/pipeline/spec.md](../../../../frontend/specs/features/pipeline/spec.md)
in the same pass.

---

## Revisions

Recorded during implementation, per this repo's rule that a spec proven wrong is corrected rather
than left to drift from the code.

### R-1 — `AuditEntry` gains an optional `reason` on `APPLICATION_OUTCOME_SET`

**FR-3.6** requires an outcome's optional `reason` to be recorded in the audit event's metadata.
The shipped `AuditEntry` union had no field for it: the audit spec's FR-4.5 called an override's
`reason` _"the one free-text field any `metadata` may hold"_, and its own acceptance criteria assert
that no other free text appears anywhere in the trace.

**Resolution: FR-3.6 wins and the union is widened**, with `reason?: string` added to
`ApplicationOutcomeSetEntry`. Accepting the field at the boundary and then silently discarding it
was the alternative, and a contract that validates input it never stores is worse than a widened
exemption. The exemption is the same in substance — a recruiter's own words about a process
decision, not a fact about a person — and the rule that actually carries the privacy guarantee
(audit FR-4.4: no email, phone, name or feedback `notes` in any `metadata`) is untouched. Like an
override's reason it is in pino's `redact` list and reaches no log line.

**Consequence for the audit spec:** its FR-4.1 metadata table and its "only free-text value" claim
now name two fields rather than one, and should be amended in the next pass over it.

### R-2 — AC-B34's query plan does not hold, and the index is still correct

**AC-B34** asks for an index scan on `Application_status_roleId_currentStage_idx` and no sequential
scan on `Application`, at 200 roles / 20 000 applications. Measured, it is a **sequential scan**,
and Postgres is right to choose one:

- `WHERE status = 'ACTIVE'` matches ~100% of rows on a live board, so the predicate is not
  selective. An index that returns every row is slower than reading the table.
- The aggregate reads `stageEnteredAt`, which the index does not cover, so an index-**only** scan
  is unavailable and every index path pays for 20 000 heap fetches. At this scale the heap is
  ~1.5 MB / 187 pages, which a sequential scan reads in ~2 ms.
- Adding `stageEnteredAt` to the index was tried. It did not change the plan, for the same reason.

The index is not redundant, and the claim MIG-6 makes for it is verifiable: with
`enable_seqscan=off` the planner uses it as an **index-only scan with `Heap Fetches: 0`**, and it is
chosen unforced as soon as the predicate is selective — which is every `?roleId=` request.

**Resolution: AC-B34 is replaced by the measurable requirement it was a proxy for.** PERF-1's
p95 < 300 ms is the criterion, and it passes at **96 ms** (worst of ten, 200 roles / 20 000
applications, 83 KB response). A future reader should not "fix" the plan with an index hint or a
second index; the aggregate is 15 ms of a 96 ms request.
