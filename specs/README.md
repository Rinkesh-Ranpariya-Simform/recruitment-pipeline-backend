# Backend specs — Recruitment Pipeline

Feature specifications for the Express + Prisma + PostgreSQL API. Parent brief:
[../../recruitment-pipeline.md](../../recruitment-pipeline.md). Conventions and the standing rules
every spec inherits: [../CLAUDE.md](../CLAUDE.md).

This project follows Spec-Driven Development. Each feature owns a folder under `features/`
holding `spec.md` (what & why) and, once the spec is approved, `plan.md` (how). A spec is
approved before its plan is written; a plan is approved before code is written. If implementation
proves the spec wrong, the spec is corrected and re-approved — code and spec do not drift.

---

## Status

| #   | Feature                                               | spec        | plan                                           | code           |
| --- | ----------------------------------------------------- | ----------- | ---------------------------------------------- | -------------- |
| 1   | [authentication](features/authentication/spec.md)     | ✅ approved | [✅ approved](features/authentication/plan.md) | ✅ implemented |
| 2   | [roles](features/roles/spec.md)                       | ✅ approved | [✅ drafted](features/roles/plan.md)           | ✅ implemented |
| 3   | [candidate](features/candidate/spec.md)               | ✅ approved | ⬜ skipped                                     | ✅ implemented |
| 4   | [audit](features/audit/spec.md)                       | ✅ approved | ⬜ skipped                                     | ✅ implemented |
| 5   | [pipeline](features/pipeline/spec.md)                 | ✅ approved | ⬜ skipped                                     | ✅ implemented |
| 6   | [interviews](features/interviews/spec.md)             | ✅ approved | ⬜ skipped                                     | ✅ implemented |
| 7   | [feedback](features/feedback/spec.md)                 | ✅ approved | ⬜ skipped                                     | ✅ implemented |
| 8   | [candidate-access](features/candidate-access/spec.md) | ✅ approved | ⬜ skipped                                     | ✅ implemented |
| 9   | [applications](features/applications/spec.md)         | ✅ approved | ⬜ skipped                                     | ✅ implemented |

**Features 1–9 have shipped**, `candidate-access` last of all. The sentence that stood here described
6–8 as what remained; they were the half of the brief that carries its stated centre of gravity —
_restricted data excluded at the query, not filtered after the fact_ — and they now do so in code.

---

## Build order, and why it is not negotiable

```
                      ┌──────────────────────────────────────────────┐
                      │  1 authentication  ·  2 roles  ·  3 candidate │   shipped
                      └───────────────────────┬──────────────────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │     4 audit       │  AuditLog + recordAudit(tx, …)
                                    └─────────┬─────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │    5 pipeline     │  StageHistory · StageOverride · ageing
                                    └─────────┬─────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │   6 interviews    │  Interview · InterviewAssignment
                                    └─────────┬─────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │    7 feedback     │  Feedback
                                    └─────────┬─────────┘
                                              │
                                   ┌──────────▼──────────┐
                                   │  8 candidate-access │  CandidateProfile + the two scoped reads
                                   └─────────────────────┘
```

| Feature          | Must come after                | Because                                                                                                                                                                       |
| ---------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| audit            | candidate                      | It is written by everything below it. A feature that writes an audit event in the same transaction as its state change cannot be built before the table and the writer exist. |
| pipeline         | audit                          | Every transition, override and outcome writes an `AuditLog` row inside its own transaction.                                                                                   |
| interviews       | pipeline                       | A round is scheduled _for a stage_; `Interview.stage` is a `PipelineStage` and rounds are created against an `ACTIVE` application whose stage rules pipeline owns.            |
| feedback         | interviews                     | Feedback is authorized by an `InterviewAssignment` row. Without that table there is nothing to join.                                                                          |
| candidate-access | interviews, feedback, pipeline | `getInterviewerCandidate()` joins `InterviewAssignment`. The recruiter candidate view renders stage history, rounds and feedback. It composes all three.                      |

**`candidate-access` is the feature the brief names first and the one built last.** That is deliberate,
not an oversight: the sharpest requirement in the POC — an interviewer requesting a candidate they
are not assigned to, by ID, refused _at the query_ — cannot be specified before the table the query
joins against exists. Writing it first would have meant writing the authorization predicate against
an imaginary schema and correcting it later, which is how a leak gets shipped.

---

## What each feature owns

| Feature          | Models                                                                 | Endpoints                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| audit            | `AuditLog`, `AuditAction`, `AuditEntityType`                           | `GET /api/audit`                                                                                                                                                                                                                    |
| pipeline         | `StageHistory`, `StageOverride`                                        | `PATCH /api/applications/:applicationId/stage` · `POST /api/applications/:applicationId/stage-override` · `PATCH /api/applications/:applicationId/outcome` · `GET /api/pipeline` · `GET /api/pipeline/summary`                      |
| interviews       | `Interview`, `InterviewAssignment`, `InterviewType`, `InterviewStatus` | `POST`/`GET /api/applications/:applicationId/interviews` · `GET /api/interviews` · `GET /api/interviews/:interviewId` · `POST /api/interviews/:interviewId/assignments` · `DELETE /api/interviews/:interviewId/assignments/:userId` |
| feedback         | `Feedback`                                                             | `POST`/`GET`/`PATCH /api/interviews/:interviewId/feedback`                                                                                                                                                                          |
| candidate-access | `CandidateProfile`                                                     | `GET /api/candidates` · `GET /api/candidates/:candidateId` · `PATCH /api/candidates/:candidateId`                                                                                                                                   |
| applications     | `InterviewOutcome`, `Interview.outcome`/`decidedAt`/`decidedByUserId`  | `GET /api/applications` (recruiter projection) · `GET /api/applications/:applicationId` · `POST /api/interviews/:interviewId/decision`                                                                                              |

Endpoints none of features 4–8 widen: `GET /api/roles` keeps `buildRoleWhere`; `GET /api/users` keeps
returning interviewers only.

**`GET /api/applications` is the one exception, and feature 9 is the exception.** It was
candidate-scoped and unpaged through features 4–8, as the line above used to say without
qualification. The applications feature makes it role-aware — two projections behind one endpoint,
chosen from the verified token before either query runs — because a recruiter had no way to see who
had applied. **The candidate's half is unchanged**: still `where: { candidateUserId }`, still
unpaged, still taking no filters. See [applications FR-1.6](features/applications/spec.md).

---

## The three rules these five specs exist to satisfy

1. **Authorization lives in the `where`.** Not in an `if` after the row is fetched. Three functions
   own it and no handler duplicates them: `buildRoleWhere` (shipped),
   `buildInterviewWhere` (interviews), and the pair `getRecruiterCandidate` /
   `getInterviewerCandidate` (candidate-access). A restricted row is never loaded into Node.
2. **A recorded fact beats an inferred one.** `StageOverride.reason` is `NOT NULL`;
   `AuditLog.actorUserId` is a real foreign key with `onDelete: Restrict`. Neither can be
   reconstructed from a timestamp and a guess.
3. **Conflicts are decided by Postgres.** `@@unique([interviewId, interviewerId])`,
   `@@unique([applicationId, roleId])` (shipped) and a stage-guarded `updateMany` resolve every
   race in these specs. There is no check-then-write anywhere in them, because a check-then-write
   loses to the second request.

---

## The schema after all five features

Shipped today: `User`, `RefreshToken`, `Role`, `Application` — plus the enums `UserRole`,
`RoleStatus`, `PipelineStage`, `ApplicationStatus`.

```
User ─┬─< RefreshToken
      ├─< Application >─── Role
      ├─< InterviewAssignment
      ├─< Feedback
      ├─< AuditLog                (actor)
      └─1 CandidateProfile

Application ─┬─< StageHistory ─0..1─ StageOverride
             └─< Interview ─┬─< InterviewAssignment
                            └─< Feedback
```

The interviewer authorization path — the one the brief is checked on — is the chain read
right-to-left:

```
InterviewAssignment.interviewerId
        └─► Interview.applicationId
                └─► Application.candidateUserId
                        └─► the candidate this interviewer may see, and no other
```

---

## Reading order for a reviewer

1. This file.
2. [features/candidate-access/spec.md](features/candidate-access/spec.md) § _Authentication / Authorization_ —
   the query the whole POC is judged on.
3. [features/feedback/spec.md](features/feedback/spec.md) § _Edge Cases_ — the concurrent-panel case.
4. [features/pipeline/spec.md](features/pipeline/spec.md) § _Performance Requirements_ — the ageing
   aggregate and why nothing is computed in Node.
5. [features/audit/spec.md](features/audit/spec.md) § _Functional Requirements_ — what a hiring
   manager can reconstruct.

The frontend counterparts live at [../../frontend/specs/README.md](../../frontend/specs/README.md).
The two repos share one API contract: a change to an endpoint, a response shape, an error code, or
a cookie/header name must be made in both.
