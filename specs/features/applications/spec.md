# Applications — The Recruiter's Application Surface & the Stage Timeline (Backend)

> **Status:** ✅ approved · implemented
> **Feature slug:** `applications`
> **Scope:** `backend/` — Express 5 + Prisma 7 + PostgreSQL
> **Counterpart:** [../../../../frontend/specs/features/applications/spec.md](../../../../frontend/specs/features/applications/spec.md)
> **Depends on:** [../candidate/spec.md](../candidate/spec.md) · [../pipeline/spec.md](../pipeline/spec.md) · [../interviews/spec.md](../interviews/spec.md) · [../audit/spec.md](../audit/spec.md) — all shipped
> **Parent brief:** [../../../../recruitment-pipeline.md](../../../../recruitment-pipeline.md) §3.1, §3.5, §6

---

## Goal

1. Give recruiters **a list of applications** — who applied, to what, how far along — which the API
   did not have. `GET /api/applications` was candidate-only, so the only recruiter-facing view of
   people was the pipeline board's counts.
2. Let a recruiter **start the first round with one click and no date**, from that list.
3. Record a **verdict at each round** — selected or rejected — and let that one action move the
   candidate, in one transaction.
4. Publish a **stage transition timeline** that both audiences read:
   `Applied → Screened (phone screen) → Interview (technical) → Interview (system design) → Rejected`.
5. Show that timeline **to the candidate as well**, which is the brief's §3.5 complaint answered for
   the person it is actually about.

Success means: a recruiter opens Applications, clicks **Start phone screen** on a row, opens the
round that appears, clicks **Select**, and sees the candidate's timeline gain a green node and the
application move to `SCREEN` — while the candidate, on their own page, sees the same node appear.

---

## Background / Context

The brief opens with the complaint this feature closes:

> Candidate progress lives in one recruiter's head… nobody — not even the hiring manager — can
> easily tell where a role is stuck or how long a candidate has been sitting at a given stage.

Before this feature the API could answer that only in aggregate. `GET /api/pipeline` returns counts
and ageing per role per stage and **deliberately no candidate list** (pipeline XFE-8). `GET
/api/interviews` returns rounds, so one candidate appears once per round. `GET /api/applications`
was `CANDIDATE`-only. There was no endpoint that answered *"who has applied, and where are they?"*

### Current state before this feature

|                       | Before                                                                         |
| --------------------- | ------------------------------------------------------------------------------ |
| `GET /api/applications` | `CANDIDATE`-only, unpaged, `{ id, status, currentStage, createdAt, role }`   |
| by-id read            | **none** — deliberately absent (candidate FR-6.8)                              |
| `Interview.scheduledAt` | `NOT NULL`                                                                   |
| Round verdict         | **none.** `InterviewStatus` said whether it happened, never how it went        |
| Stage moves           | `PATCH /api/applications/:id/stage`, by hand, unrelated to any round           |
| Timeline              | `StageHistory` rows, written but read by no endpoint (pipeline FR-5.6)         |

### Decisions settled during the interview

| #    | Question                                                       | Decision                                                                                                                                                                                | Recorded in    |
| ---- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| D-1  | A new `/api/candidates`, or widen `/api/applications`?         | **Widen.** The row a recruiter wants is an application — a person *against a requisition* — not a person. `candidate-access` still owns the person                                     | FR-1, AZ-1     |
| D-2  | One role-aware endpoint, or two paths?                         | **One endpoint, two projections**, chosen from the verified token before the query runs. The construction `GET /api/interviews` already uses                                            | FR-1.1, BE-2   |
| D-3  | Is the timeline `StageHistory`?                                | **No.** Two rounds at one stage — technical, then system design — are two nodes and one `StageHistory` row. The round is the unit of a process                                          | FR-5.1         |
| D-4  | Where is the timeline built?                                   | **Server-side, one pure function**, used by both audiences. Two builders would tell the two sides different stories about one process                                                    | FR-5.5, BE-3   |
| D-5  | Can a round be created without a date?                         | **Yes**, `scheduledAt` becomes nullable. A recruiter decides to run a round before agreeing a time; defaulting to `now()` puts a lie in the column                                       | FR-2.3, MIG-1  |
| D-6  | Is rescheduling back in scope?                                 | **Yes**, reversing interviews D-11. "There is no reschedule" only held while every round had a date from birth                                                                           | FR-2.4         |
| D-7  | Where does the verdict live?                                   | **`Interview.outcome`**, with `decidedAt` + `decidedByUserId`, all three moved together by a CHECK constraint                                                                            | MIG-1, FR-3.2  |
| D-8  | Merge the verdict into `InterviewStatus`?                      | **No.** `COMPLETED` says the round happened; `SELECTED` says the candidate passed it. One enum makes "completed, verdict not yet entered" unrepresentable                                | MIG-1          |
| D-9  | One endpoint for the verdict, or three client calls?           | **One.** A client doing PATCH-round, PATCH-stage, PATCH-outcome can fail between any two and leave a candidate marked as having passed a round they were never advanced past             | FR-3.3         |
| D-10 | Does `SELECTED` always move the candidate?                     | **No** — only when the round's stage differs from theirs. A second `INTERVIEW` round advances nobody, and that is correct                                                                | FR-3.4         |
| D-11 | What if the move would skip a stage?                           | **`409 INVALID_STAGE_TRANSITION`.** The path is a stage override, with a reason — the brief's §3.1, holding for this endpoint too                                                        | FR-3.4         |
| D-12 | Can a decision be edited?                                      | **No.** `409 DECISION_ALREADY_RECORDED`. It already moved the candidate; undoing it is an override                                                                                       | FR-3.6, ERR-1  |
| D-13 | Is the by-id read added back for candidates?                   | **Yes**, reversing candidate FR-6.8 — there is now something on a detail page worth showing, and the scoping is `where: { id, candidateUserId }`, one statement                          | FR-4.3         |
| D-14 | Does an interviewer see the verdict?                           | **No.** An interviewer who can see it before writing feedback is being told the answer. Absent from their select, not removed after                                                      | SEC-2          |
| D-15 | Does an interviewer reach any endpoint here?                   | **No.** `403` on all three. Their scope is the round, not the person's whole process                                                                                                    | AZ-1           |

---

## Users / Actors

| Actor       | May do, after this feature                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Anonymous   | Nothing. `401`                                                                                        |
| Interviewer | **Nothing here.** `403` on all three routes                                                           |
| Candidate   | List their own applications; read one of their own by id. Both carry their timeline                   |
| Recruiter   | List and filter every application; read any one in full; start a round; record a verdict on a round   |

**Deliberate POC trade-offs, so they are not read as oversights:**

- **A recruiter's list carries no contact detail**, for any role. Email and phone are
  `candidate-access`'s surface, with its own authorization story.
- **A decision cannot be edited or undone through this feature.** The path is a stage override,
  which records who and why (pipeline FR-4).
- **There is no candidate search here.** `?q=` over names belongs to `candidate-access`, where the
  people are the resource.

---

## Functional requirements

### FR-1 — The recruiter's application list

- **FR-1.1** `GET /api/applications` is role-aware: `requireRole(CANDIDATE, RECRUITER)`, dispatching
  to one of two service functions before either query runs. An interviewer is `403`.
- **FR-1.2** A recruiter's row is
  `{ id, status, currentStage, stageEnteredAt, createdAt, role: { id, title }, candidate: { id, name }, interviewCount }`.
  **No `email`, no `phone`, no `candidateProfile` join.**
- **FR-1.3** `interviewCount` comes from Prisma's `_count`, a correlated subquery — not from loading
  every round of every application to count them, which is the shape the brief's §6 forbids by name.
- **FR-1.4** Filters: `?roleId=`, `?stage=`, `?status=`, `?hasInterviews=true|false`, plus `?page=`
  and `?pageSize=`. `hasInterviews` compiles to `EXISTS` / `NOT EXISTS`, and is what lets one
  endpoint serve both the Applications tab and the Interviews tab.
- **FR-1.5** Paged, unlike the candidate's list, because it is the only read in this module whose
  result set grows with the 20,000 candidates the brief names.
- **FR-1.6** A candidate's list is **unchanged in scope**: `where: { candidateUserId }`, unpaged, no
  filters. `validateQuery` runs for both roles because middleware cannot branch on one, and the
  candidate service takes no query argument — so no filter can reach that `where`.

### FR-2 — Starting a round, and dating it later

- **FR-2.1** `POST /api/applications/:applicationId/interviews` is unchanged except for FR-2.3.
- **FR-2.2** The "start phone screen" action is **not a new endpoint**: it is that `POST` with
  `{ type: 'PHONE_SCREEN', stage: 'SCREEN' }` and no date. It does **not** move the stage — the
  candidate is at `APPLIED` until they pass the screen.
- **FR-2.3** `scheduledAt` is optional on create and the column is nullable. `null` and an absent key
  are the same intent and both accepted; `0`, `""` and a non-ISO string are still `400`.
- **FR-2.4** `PATCH /api/interviews/:interviewId` now accepts `{ status?, scheduledAt? }`, at least
  one. `scheduledAt: null` clears the date. Both are `SCHEDULED`-only, guarded in the update's own
  `where`. An empty body is `400`.

### FR-3 — The verdict

- **FR-3.1** `POST /api/interviews/:interviewId/decision`, body `{ decision: 'SELECTED' | 'REJECTED' }`,
  `requireRole(RECRUITER)`.
- **FR-3.2** Writes `outcome`, `decidedAt`, `decidedByUserId` and `status: COMPLETED`. The actor is
  `req.user.id`; there is no body field for it.
- **FR-3.3** **One transaction** holds the round update, the stage or outcome move, the
  `StageHistory` row and every audit row. Any failure rolls back all of it.
- **FR-3.4** On `SELECTED`, the application moves to the **round's own stage**, unless it is already
  there (D-10). A move the graph refuses is `409 INVALID_STAGE_TRANSITION`; `canTransition` is
  imported from `pipeline.rules`, never re-derived.
- **FR-3.5** On `REJECTED`, `status: REJECTED` and **`currentStage` untouched** (pipeline FR-3.5):
  "rejected at Screen" and "rejected at Offer" are different outcomes.
- **FR-3.6** Refusals: `409 DECISION_ALREADY_RECORDED` (guarded on `outcome: null`, so it holds
  under concurrency), `409 INTERVIEW_CANCELLED`, `409 APPLICATION_NOT_ACTIVE`, `409 STAGE_CONFLICT`.
- **FR-3.7** Audit: one `INTERVIEW_DECISION_RECORDED` naming the round, **plus** the
  `CANDIDATE_STAGE_CHANGED` or `APPLICATION_OUTCOME_SET` row for whatever moved. Three actions, not
  one, because they answer three questions — collapsing them makes *"which round advanced this
  candidate?"* unanswerable from the feed.

### FR-4 — The by-id read

- **FR-4.1** `GET /api/applications/:applicationId`, `requireRole(CANDIDATE, RECRUITER)`.
- **FR-4.2** A recruiter gets the application, its `timeline`, and every round with its panel. Still
  no `email`, and no `feedback`: a round's assessments are read through the feedback module, where
  its own authorization applies.
- **FR-4.3** A candidate gets their own, by `where: { id, candidateUserId }` — **one statement, no
  fetch-then-check**. Another candidate's id is `404`, from the same query a nonexistent id hits.
  Never `403`, which would confirm the row exists.

### FR-5 — The stage transition timeline

- **FR-5.1** Built from `Interview` rows, not `StageHistory` (D-3). The first node is the
  application's creation; one node per non-cancelled round, in **creation order**; a final node once
  the application is terminal.
- **FR-5.2** A node is
  `{ key, kind, stage, interviewType, status, state, at, interviewId }`, where `state` is
  `PASSED | REJECTED | PENDING`. The server sends facts; the client makes the words and the colours.
- **FR-5.3** `CANCELLED` rounds are omitted: a cancelled round did not happen.
- **FR-5.4** It carries **no interviewer, rating, note or override reason**, on either path. Those
  are not columns the timeline selects, so there is nothing to strip.
- **FR-5.5** **One builder for both audiences** (`applications/timeline.ts`). The difference between
  a recruiter's timeline and a candidate's is what the caller selected before reaching it, not what
  the builder does with it.

---

## API contract

| Method | Path                                    | Roles                 | Body / query                                    | 200/201                             |
| ------ | --------------------------------------- | --------------------- | ----------------------------------------------- | ----------------------------------- |
| GET    | `/api/applications`                     | CANDIDATE             | —                                               | `{ applications }`                  |
| GET    | `/api/applications`                     | RECRUITER             | `roleId, stage, status, hasInterviews, page, pageSize` | `{ applications, pagination }` |
| GET    | `/api/applications/:id`                 | CANDIDATE (own)       | —                                               | `{ application }` with `timeline`   |
| GET    | `/api/applications/:id`                 | RECRUITER             | —                                               | `{ application }` with `timeline`, `interviews` |
| POST   | `/api/applications/:id/interviews`      | RECRUITER             | `{ type, stage, scheduledAt? }`                 | `201 { interview }`                 |
| PATCH  | `/api/interviews/:id`                   | RECRUITER             | `{ status?, scheduledAt? }`                     | `{ interview }`                     |
| POST   | `/api/interviews/:id/decision`          | RECRUITER             | `{ decision }`                                  | `{ interview }`                     |

### New error code

| Code                        | Status | When                                        |
| --------------------------- | ------ | ------------------------------------------- |
| `DECISION_ALREADY_RECORDED` | 409    | A verdict already exists on that round      |

---

## Schema changes (MIG-1)

Two migrations, deliberately separate: `ALTER TYPE … ADD VALUE` is permitted inside a transaction on
PostgreSQL 12+ but the new value cannot be *used* by the same one, and Prisma wraps each file in one
transaction.

| Migration                                    | Change                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `…_add_interview_decision_audit_action`      | `AuditAction += INTERVIEW_DECISION_RECORDED`                           |
| `…_add_interview_decisions`                  | `InterviewOutcome` enum; `Interview.scheduledAt` → nullable; `outcome`, `decidedAt`, `decidedByUserId` + FK `RESTRICT`; `@@index([applicationId, createdAt])`; CHECK constraint |

The CHECK constraint is appended by hand — Prisma has no schema attribute for one — and makes the
three decision columns move together. An `outcome` with no actor behind it is the "recorded, not
inferred" failure the brief names for overrides, applied to rounds.

The new index exists because `scheduledAt` is now nullable and therefore cannot order a timeline:
undated rounds would collapse to one end of a sequence meant to be the order things happened in.

---

## Security & authorization

- **SEC-1** No select in this module names `email` or `phone`, **for any role**. The module gained a
  recruiter audience without gaining one field of contact detail.
- **SEC-2** `outcome` is absent from `INTERVIEWER_INTERVIEW_SELECT`, not removed after fetching. An
  interviewer who can see a verdict before writing their feedback is being told the answer.
- **SEC-3** `POST /decision` is recruiter-only, and that guard is load-bearing: an interviewer able
  to advance or reject a candidate they are assessing is the conflict of interest the whole
  separation exists to prevent (pipeline AZ-3).
- **SEC-4** A candidate's by-id read is scoped **in the `where`**. There is no fetch-then-check, so
  there is no window and nothing to forget.
- **SEC-5** Log lines carry ids and enum values only — never a name, an email, or a date a round
  moved to.

---

## Amendments to shipped specs

| Spec             | Was                                                     | Now                                                                              |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| candidate FR-6.8 | No `GET /api/applications/:id`; the absence is the guarantee | The route exists, and the guarantee is the `candidateUserId` predicate instead (D-13) |
| candidate FR-6.x | `GET /api/applications` is CANDIDATE-only               | Role-aware, two projections (D-1, D-2)                                            |
| interviews D-11  | Rescheduling out of scope                               | `PATCH` accepts `scheduledAt` (D-6)                                               |
| interviews FR-1.7| `scheduledAt` required                                  | Optional; the column is nullable (D-5)                                            |
| interviews FR-2.1| `PATCH` takes `{ status }` only                         | `{ status?, scheduledAt? }`, at least one                                         |
| audit FR-4.1     | Nine actions                                            | Ten — `INTERVIEW_DECISION_RECORDED`                                               |

---

## Acceptance criteria

| #      | Check                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------- |
| AC-B01 | `GET /api/applications` as an interviewer → `403`                                                     |
| AC-B02 | As a recruiter → `{ applications, pagination }`, every row carrying `candidate.name` and no `email`   |
| AC-B03 | As a candidate → `{ applications }`, own rows only, each with `timeline`                              |
| AC-B04 | `?hasInterviews=true` returns only applications with ≥1 round; `=false` only those with none          |
| AC-B05 | `?pageSize=101` → `400`, not a clamp                                                                  |
| AC-B06 | `GET /api/applications/:id` for another candidate's id, as a candidate → `404`, never `403`           |
| AC-B07 | `POST …/interviews` with no `scheduledAt` → `201`, `scheduledAt: null`, application stage unchanged   |
| AC-B08 | The resulting audit row has **no** `scheduledAt` key                                                  |
| AC-B09 | `PATCH /api/interviews/:id` with `{}` → `400`                                                         |
| AC-B10 | `PATCH` with `{ scheduledAt: null }` on a `SCHEDULED` round clears the date; on a terminal one → `409` |
| AC-B11 | `POST …/decision` `SELECTED` on a `SCREEN` round from `APPLIED` → round `COMPLETED`, application `SCREEN`, three audit rows |
| AC-B12 | The same on a second `INTERVIEW` round from `INTERVIEW` → round decided, **stage unchanged**, two audit rows |
| AC-B13 | `SELECTED` where the move would skip a stage → `409 INVALID_STAGE_TRANSITION`, nothing written        |
| AC-B14 | `REJECTED` → application `REJECTED`, `currentStage` unchanged                                          |
| AC-B15 | A second decision on the same round → `409 DECISION_ALREADY_RECORDED`                                  |
| AC-B16 | Two concurrent decisions on one round: exactly one commits, the other gets that `409`                 |
| AC-B17 | `POST …/decision` as an interviewer → `403`                                                            |
| AC-B18 | An interviewer's `GET /api/interviews/:id` payload contains no `outcome` key                          |
| AC-B19 | A cancelled round is absent from the timeline; its feedback and panel are untouched                   |
| AC-B20 | `grep -rE "email\|phone" src/modules/applications` matches no select                                  |

---

## Out of scope

- Candidate search (`?q=`) — `candidate-access`
- Contact details of any kind — `candidate-access`
- Editing or undoing a decision — a stage override, which already exists
- Bulk actions on the applications table
