# Feedback — Assignment-Gated Structured Feedback (Backend)

> **Status:** Draft — awaiting approval. `plan.md` is a later artifact and does not exist yet.
> **Feature slug:** `feedback`
> **Scope:** `backend/` — Express 5 + Prisma 7 + PostgreSQL
> **Counterpart:** [../../../../frontend/specs/features/feedback/spec.md](../../../../frontend/specs/features/feedback/spec.md)
> **Depends on:** [../audit/spec.md](../audit/spec.md) · [../pipeline/spec.md](../pipeline/spec.md) · [../interviews/spec.md](../interviews/spec.md) — all must ship first
> **Blocks:** [../candidate-access/spec.md](../candidate-access/spec.md)
> **Parent brief:** [../../../../recruitment-pipeline.md](../../../../recruitment-pipeline.md) §3.2, §3.4, §3.6, §6

---

## Goal

1. Let an assigned interviewer submit **structured feedback** — a bounded rating and free-text notes
   — tied to one round and one interviewer.
2. Authorize the submission **by the assignment, inside the query that resolves the round** — never
   by comparing `feedback.interviewerId` to the caller's id, which authorizes nothing.
3. Settle the brief's §3.4 concurrency question with a **documented, database-enforced policy**:
   one row per interviewer per round, so a panel's submissions all persist and a double-submit is
   refused rather than silently merged or lost.
4. Fix the brief's opening complaint — _"interviewers can't see prior feedback before their round"_ —
   by letting an **assigned** interviewer read the round's feedback, through the same scoped query.
5. Ensure a feedback response **carries no candidate contact detail**, closing the leak path the
   brief names by name: _"including through a feedback-submission endpoint that happens to also
   carry candidate data."_

Success means: two interviewers on one panel hit Submit at the same instant, both get `201`, both
rows are in the table, and neither has overwritten the other — while a third interviewer who is not
on that round gets `404` from a query that never loaded it.

---

## Background / Context

Three parts of the brief converge on this one module.

> After each round, the assigned interviewer submits structured feedback (e.g. a rating plus notes)
> tied to that round and that candidate.
> — §3.2

> Two interviewers may submit feedback for the same round at close to the same time (e.g. a panel
> interview). Decide and document whether both submissions are kept, whether one overwrites the
> other, or whether the system merges them — and make sure whichever you choose **actually holds
> under two near-simultaneous submissions**, not just one after the other.
> — §3.4

> Candidate contact details (e.g. email, phone) are visible to recruiters only — never to
> interviewers, under any circumstance, **including through a feedback-submission endpoint that
> happens to also carry candidate data**.
> — §3.6

And the request that prompted this spec states the authorization rule in the negative, which is the
clearer way to state it:

> Never authorize feedback submission only by checking `interviewerId === currentUser.id`.
> The interviewer must actually be assigned to the interview.

That check is not weak — it is **vacuous**. `interviewerId` is whatever the service is about to
write, so comparing it to the caller compares a value to itself. The only fact that authorizes
anything is an `InterviewAssignment` row, and this spec resolves it inside the query.

### Current state of `backend/`

|                                 | Today, assuming audit, pipeline and interviews have shipped                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Interview`                     | `{ id, applicationId, type, stage, scheduledAt, status, … }`                                                                                                                                                                    |
| `InterviewAssignment`           | `{ id, interviewId, interviewerId, assignedByUserId, createdAt }`, `@@unique([interviewId, interviewerId])`, `@@index([interviewerId, createdAt])`                                                                              |
| Scoped reads                    | `buildInterviewWhere(query, actorRole, actorId)` pushes `{ assignments: { some: { interviewerId } } }` into an interviewer's `where`                                                                                            |
| Precedent for this exact shape  | `applications.service.createApplication` resolves its parent with `tx.role.findFirst({ where: { id, status: OPEN }, select: { id: true } })` **inside** the transaction — the eligibility rule and the lookup are one statement |
| Precedent for conflict handling | `P2002` on `Application`'s `@@unique([candidateUserId, roleId])` → `409 ALREADY_APPLIED`, caught **outside** the transaction callback                                                                                           |
| Feedback                        | **none.** No model, no endpoint                                                                                                                                                                                                 |

The two precedents above are not analogies — this feature is built by composing them.

### Decisions settled during the interview

| #    | Question                                                      | Decision                                                                                                                                                                                                                                              | Recorded in                                        |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| D-1  | **The §3.4 policy**                                           | **Both kept, one row per interviewer per round.** `@@unique([interviewId, interviewerId])`. Two different interviewers firing together → two `201`s. The same interviewer twice → `201` + `409`, never a lost update                                  | FR-3, MIG-3, EC-01                                 |
| D-2  | Why not append-only?                                          | A round would accumulate several submissions from one person with no defined current answer. A recruiter reading "4/5 and 2/5 from Ivan" cannot act on it                                                                                             | FR-3.2                                             |
| D-3  | Why not last-write-wins?                                      | Under two concurrent submissions from one person, an upsert silently discards one. §3.4 asks the outcome to be _documented and to hold_; "one of them vanished" is not an outcome anyone chose                                                        | FR-3.3                                             |
| D-4  | Is feedback editable?                                         | **Yes — `PATCH`.** Not in the original endpoint list, but the `Feedback` model carries `updatedAt` and D-1 makes a second `POST` a `409`. Without an edit path, `updatedAt` is a column nothing writes, which this repo treats as a lie in the schema | FR-4, and flagged in Out of Scope for easy removal |
| D-5  | Who may edit?                                                 | **The author only**, and only their own row. A recruiter may not edit an interviewer's assessment — that would make the record worthless                                                                                                              | AZ-5                                               |
| D-6  | Is there a deadline on editing?                               | **No.** A time window is a policy nobody asked for, and the audit trail records every edit                                                                                                                                                            | FR-4.5                                             |
| D-7  | What is `rating`?                                             | **An integer 1–5.** Bounded, so it aggregates; validated by zod at the boundary and by a `CHECK` constraint in the migration                                                                                                                          | FR-2.3, MIG-4                                      |
| D-8  | Who may read feedback?                                        | **Recruiters (any round) and interviewers assigned to that round.** The brief's opening paragraph names "interviewers can't see prior feedback before their round" as the problem being fixed                                                         | FR-5, AZ-3                                         |
| D-9  | Can an interviewer read feedback before submitting their own? | **Yes.** Fixing the stated problem is the point. The bias risk is named as an accepted gap rather than half-mitigated with a rule nobody asked for                                                                                                    | FR-5.4, SEC-7                                      |
| D-10 | Unassigned interviewer submits or reads?                      | **`404`**, from the same query that would have returned the round. Not `403`                                                                                                                                                                          | FR-1.4, ERR-1                                      |
| D-11 | Must the round be `COMPLETED` first?                          | **No.** Requiring it would mean an interviewer cannot file notes until a recruiter updates a status — a coupling that produces lost feedback, not discipline                                                                                          | FR-2.6                                             |
| D-12 | Can feedback be submitted on a `CANCELLED` round?             | **No.** `409 INTERVIEW_CANCELLED`. A cancelled round did not happen                                                                                                                                                                                   | FR-2.7                                             |
| D-13 | Does unassignment delete feedback?                            | **No.** The assessment happened. `Feedback` has no foreign key to `InterviewAssignment` for exactly this reason                                                                                                                                       | FR-6.4, MIG-6                                      |
| D-14 | Is there a `DELETE`?                                          | **No.** Retracting an assessment without a trace is the opposite of what §6 asks for. An interviewer who changes their mind edits, and the edit is audited                                                                                            | FR-6.1                                             |

---

## Users / Actors

| Actor       | May do, after this feature                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous   | Nothing. `401`                                                                                                                  |
| Candidate   | Nothing. `403` — including on feedback about themselves                                                                         |
| Interviewer | Submit feedback on a round **they are assigned to**; edit **their own**; read that round's feedback. Nothing on any other round |
| Recruiter   | Read feedback on any round. **Cannot submit and cannot edit**                                                                   |

**Deliberate POC trade-offs, so they are not read as oversights:**

- **A recruiter cannot write or edit feedback.** They did not conduct the interview. An assessment a
  recruiter can rewrite is not an assessment, and the whole point of §6's audit requirement is that
  a hiring manager can trust what they read.
- **A candidate never sees feedback about themselves.** The walkthrough gives candidates Jobs and My
  Applications. Disclosure to candidates is a product and legal decision this POC does not make.
- **An interviewer sees their panel colleagues' submissions**, including before writing their own
  (D-9). That is the brief's stated problem being fixed, and the anchoring risk it creates is named
  in SEC-7 rather than mitigated by a rule nobody asked for.
- **Nothing aggregates ratings into a decision.** There is no average, no threshold, no
  auto-advance. Feedback informs a recruiter; it does not move a candidate.

---

## User Stories

| ID        | Story                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **US-01** | As an interviewer, I want to submit a rating and notes for my round, so that my assessment is on the record rather than in a Slack thread.                |
| **US-02** | As an interviewer, I want to read what my fellow panellists wrote, so that I am not the third person to ask the same question.                            |
| **US-03** | As an interviewer, I want to correct a rating I mis-clicked, so that the record is right — and I accept that the correction is visible.                   |
| **US-04** | As an interviewer on a panel, I want my colleague's simultaneous submission not to overwrite mine, so that a panel produces two assessments and not one.  |
| **US-05** | As a recruiter, I want every panellist's feedback on a round in one place, so that I can decide with all of it in front of me.                            |
| **US-06** | As a hiring manager, I want every submission and every edit recorded with an actor and a time, so that "how was this candidate assessed" has an answer.   |
| **US-07** | As a security reviewer, I want to confirm the feedback endpoints never return a candidate's contact details, since §3.6 names this endpoint specifically. |

---

## Functional Requirements

### FR-1 — The authorization rule

- **FR-1.1** Feedback may be submitted only by an interviewer who has an `InterviewAssignment` row
  for that round. This is the whole rule.
- **FR-1.2** It is resolved **inside the write transaction, in the `where`**, using the shape
  `applications.service.createApplication` already established:

  ```ts
  const interview = await tx.interview.findFirst({
    where: {
      id: interviewId,
      assignments: { some: { interviewerId: actorId } },
    },
    select: { id: true, status: true },
  });
  if (interview === null) throw new NotFoundError();
  ```

  **The eligibility rule and the lookup are one statement.** There is no window between checking and
  using, and no unauthorized row is ever loaded into application memory.

- **FR-1.3** **`feedback.interviewerId === currentUser.id` is never used as an authorization check**,
  anywhere in this module. `interviewerId` is a value the service is about to write, so comparing it
  to the caller compares a value to itself and authorizes nothing. The comparison appears **only**
  in `PATCH`, where it answers a different question — _is this row mine to edit_ — and even there it
  is expressed as a `where` clause (FR-4.2), not an `if`.
- **FR-1.4** A round that does not exist, and a round the caller is not assigned to, both answer
  **`404 NOT_FOUND`** with byte-identical bodies (D-10). A `403` would confirm the round exists,
  turning the endpoint into an enumeration oracle.
- **FR-1.5** The same predicate governs the **read** (FR-5.3). One rule, expressed the same way on
  both verbs.

### FR-2 — Submitting

- **FR-2.1** `POST /api/interviews/:interviewId/feedback` with `{ rating, notes }`. Interviewer-only
  at the route; assignment-scoped in the query.
- **FR-2.2** A `Feedback` row is `{ id, interviewId, interviewerId, rating, notes, createdAt,
updatedAt }`.
- **FR-2.3** `rating` is an **integer 1–5** (D-7), enforced by zod at the boundary and by a database
  `CHECK` constraint (MIG-4). Bounded so that a recruiter can compare rounds; integer so that
  "3.5 out of 5" is not a thing anyone has to interpret.
- **FR-2.4** `notes` is required, trimmed, 1–5000 characters. Feedback with a rating and no words is
  not structured feedback — it is a number, and a hiring manager cannot act on a number.
- **FR-2.5** `interviewerId` is **always** `req.user.id`. It is not a body field; a body carrying
  one is stripped by zod before any code could read it (VAL-4).
- **FR-2.6** The round need **not** be `COMPLETED` (D-11). Requiring it would mean an interviewer
  cannot file notes until a recruiter updates a status — a coupling that produces lost feedback
  rather than discipline.
- **FR-2.7** The round must not be `CANCELLED`: `409 INTERVIEW_CANCELLED` (D-12). The status is read
  by the same scoped `findFirst` that authorizes (FR-1.2), so this costs no extra query.
- **FR-2.8** A successful submission, in **one** transaction: the scoped round lookup, the
  `Feedback` insert, then
  `recordAudit(tx, { action: 'FEEDBACK_SUBMITTED', entityType: 'FEEDBACK', entityId,
metadata: { interviewId, rating } })`. **`notes` is not in the metadata** — the audit feed is
  recruiter-readable and the notes belong on the feedback record, where the read rules already live
  (audit FR-4.4).
- **FR-2.9** Responds `201` with the created row and its author expanded to `{ id, name }`.

### FR-3 — The concurrency policy (brief §3.4)

- **FR-3.1** **The policy: both submissions are kept.** One row per `(interviewId, interviewerId)`,
  enforced by `@@unique([interviewId, interviewerId])` (D-1).
- **FR-3.2** **Two different interviewers submitting at the same instant both succeed.** Their
  unique-key tuples differ, so there is nothing to contend on — no lock, no retry, no merge. This is
  the panel case the brief describes, and the design makes it a non-event rather than a race that
  happens to resolve correctly.
- **FR-3.3** **The same interviewer submitting twice at the same instant produces one `201` and one
  `409 FEEDBACK_ALREADY_SUBMITTED`.** Postgres rejects the second insert; the service catches
  `P2002` **outside** the transaction callback and maps it, matching the shipped handling of
  `ALREADY_APPLIED`. **There is no preceding `findFirst` to detect the duplicate** — a
  read-then-write check loses to two overlapping requests and would let both commit, or worse, let
  one silently overwrite the other (D-3).
- **FR-3.4** The refused request's transaction rolls back entirely: **no orphan audit row** exists
  for a submission that did not persist.
- **FR-3.5** The remedy for a `409` is `PATCH` (FR-4), and the error message says so.
- **FR-3.6** This policy holds for **three** simultaneous panellists as readily as two — the brief's
  §8 harder variant. Three distinct tuples, three inserts, no contention. A recruiter issuing a
  stage override at the same instant touches `Application`, a different table, guarded by its own
  `updateMany` (pipeline FR-6.2); the two writes do not interact, and the end state is both
  feedback rows and whichever stage change won its own race.

### FR-4 — Editing

- **FR-4.1** `PATCH /api/interviews/:interviewId/feedback` with `{ rating?, notes? }`, at least one
  present. The author's own row only (D-5).
- **FR-4.2** The update is a **guarded `updateMany`**, not a read-then-write:

  ```ts
  const { count } = await tx.feedback.updateMany({
    where: { interviewId, interviewerId: actorId },
    data: patch,
  });
  if (count === 0) throw new NotFoundError();
  ```

  Ownership is in the `where`. `count === 0` means either no feedback exists or it is not theirs —
  both `404`, and the two are indistinguishable, as they should be.

- **FR-4.3** A recruiter calling `PATCH` is `403` at the route (AZ-5). An assessment a recruiter can
  rewrite is not an assessment.
- **FR-4.4** An edit writes
  `recordAudit(… FEEDBACK_UPDATED, metadata: { interviewId, fromRating, toRating })` in the same
  transaction. The previous rating is recorded because a changed score is the thing a hiring manager
  would ask about; the previous **notes text is not** (audit FR-4.4).
- **FR-4.5** There is **no edit deadline** (D-6). A time window is a policy nobody asked for, and
  every edit is audited.
- **FR-4.6** `updatedAt` is Prisma's `@updatedAt`. After this feature, it is a column that code
  actually writes — which is the reason `PATCH` exists rather than being deferred (D-4).

### FR-5 — Reading

- **FR-5.1** `GET /api/interviews/:interviewId/feedback` returns every feedback row on that round,
  newest first.
- **FR-5.2** **Recruiters** may read any round's feedback. **Interviewers** may read a round they
  are assigned to (D-8). Candidates are `403`.
- **FR-5.3** The interviewer's read uses the **same scoped predicate as the write** (FR-1.5):
  the round is resolved by `findFirst` with `assignments: { some: { interviewerId: actorId } }`, and
  a miss is `404`. One rule, one expression, two verbs.
- **FR-5.4** An assigned interviewer sees **all** feedback on the round, including their
  colleagues', including before submitting their own (D-9). This is the brief's opening complaint
  being fixed: _"Interviewers can't see prior feedback before their round."_
- **FR-5.5** Each row expands its author to `{ id, name }`. An interviewer learns who wrote what —
  which is the point of reading a panel's notes, and is the disclosure the interviews feature
  deliberately withheld from a round payload (interviews FR-5.3) so that it happens here, once,
  where it is specified.
- **FR-5.6** **The response carries no candidate data at all** — no name, no id, no email, no phone.
  Not because it is stripped, but because `FEEDBACK_SELECT` names `interview: false` and reaches no
  candidate relation. §3.6 names this endpoint specifically; the answer is that there is nothing to
  leak in the shape (SEC-1).
- **FR-5.7** Unpaginated. A round's panel is a single-digit number of people, bounded by
  `@@unique([interviewId, interviewerId])` and by how many interviewers a recruiter assigns.
- **FR-5.8** A round with no feedback is `200` with `feedback: []`, never `404` — provided the
  caller may see the round at all.

### FR-6 — What this feature does not do

- **FR-6.1** There is **no `DELETE`** (D-14). Retracting an assessment without a trace is the
  opposite of what §6 asks for. The absence is the guarantee; do not add one without a spec change.
- **FR-6.2** There is no `GET /api/feedback` and no `GET /api/feedback/:id`. Feedback is always
  reached through its round, so the authorization question is always the same question.
- **FR-6.3** Nothing here changes an application's stage or status. Feedback informs a recruiter's
  decision; it does not make one.
- **FR-6.4** **Unassigning an interviewer does not delete their feedback** (D-13). The assessment
  happened, and erasing it because a seat was reassigned would erase a fact. `Feedback` has no
  foreign key to `InterviewAssignment` for exactly this reason (MIG-6). The consequence, named: an
  unassigned interviewer's feedback remains visible to recruiters and to the remaining panel, while
  the author themselves loses read access (their scoped query no longer matches).

### FR-7 — Logging and seed

- **FR-7.1** New pino events: `feedback.submitted`, `feedback.updated`,
  `feedback.duplicate_refused`, `feedback.scoped_write_miss`, `feedback.scoped_read_miss`.
- **FR-7.2** Ids and ratings only. **`notes` is never logged**, and `notes` is added to the pino
  `redact` list alongside the `reason` entry the audit feature added.
- **FR-7.3** [`prisma/seed.ts`](../../../prisma/seed.ts) gains one feedback row from `interviewer1`
  on the seeded panel round — leaving `interviewer2` assigned to the same round **without**
  feedback, so that a fresh database demonstrates both the "read a colleague's prior feedback" case
  and the "submit your own" case without any setup.

---

## Frontend Requirements

The obligations this backend places on the Next.js client. The rest of the frontend design lives in
[../../../../frontend/specs/features/feedback/spec.md](../../../../frontend/specs/features/feedback/spec.md).

- **XFE-1** `POST` and `PATCH` are **interviewer-only**; a recruiter gets `403` (AZ-5). The client
  must render the feedback form for interviewers only, and render a recruiter's view as read-only.
- **XFE-2** An unassigned interviewer gets **`404`, not `403`**, on both verbs and on the read
  (FR-1.4). The client renders its not-found view; there is no `403` to catch here.
- **XFE-3** `409 FEEDBACK_ALREADY_SUBMITTED` means _you have already filed feedback on this round_.
  **Its remedy is `PATCH`.** The client should load the existing row and switch the form to edit
  mode rather than showing a dead end.
- **XFE-4** `409 INTERVIEW_CANCELLED` means the round was cancelled. The client should not offer a
  feedback form once `interview.status === 'CANCELLED'` — **but the client check is UX and the
  `409` is the control.**
- **XFE-5** `rating` is an **integer 1–5** (FR-2.3). A client sending `4.5` or `0` gets `400` with
  `details.rating`. The star control must emit integers.
- **XFE-6** `notes` is **required** (FR-2.4). An empty or whitespace-only notes field is a `400`
  with `details.notes`; the client should require it before enabling Submit.
- **XFE-7** The feedback response contains **no candidate data whatsoever** — no name, no id, no
  contact fields (FR-5.6). The client renders the candidate's name from the **interview** payload,
  which carries `{ id, name }` for an assigned interviewer. **If a candidate field ever appears in a
  feedback response, that is a backend bug to report, not a field to hide client-side.**
- **XFE-8** Each feedback row carries `interviewer: { id, name }` (FR-5.5). The client can therefore
  label a panel's entries without a second call.
- **XFE-9** `GET` is unpaginated and returns `{ feedback: [...] }` — no pagination envelope
  (FR-5.7). The client must not expect one.
- **XFE-10** There is **no `DELETE`** (FR-6.1). The client must not offer a delete affordance; a
  `DELETE` request answers `404` from the shipped `notFound` handler.
- **XFE-11** After a successful `POST`, the round's feedback list has one more entry. The client may
  invalidate its feedback query rather than reading the `201` body — but the `201` body is complete
  enough to append optimistically if it chooses not to.

---

## Backend Requirements

- **BE-1 — Structure.** A new module, `src/modules/feedback/`:
  `feedback.service.ts`, `feedback.repository.ts` (the scoped round resolution and the guarded
  update), `feedback.controller.ts`, `feedback.routes.ts`, `feedback.schema.ts`,
  `feedback.select.ts`.
- **BE-2 — One scoped resolver, used by all three verbs.**
  `resolveWritableInterview(tx, interviewId, actorId)` performs the `findFirst` of FR-1.2 and is the
  only place the assignment predicate appears on the write path. The read path uses the same
  predicate through `feedback.repository.ts`. **No handler composes it.**
- **BE-3 — Routes mount under `/api/interviews/:interviewId/feedback`**, from
  `feedback.routes.ts`, and are attached to the interviews router. Feedback is always reached
  through its round (FR-6.2), so the path shape is the authorization model made visible.
- **BE-4 — Middleware order:** `requireAuth` → `requireRole(…)` → `validateParams` → `validate`.
  `POST` and `PATCH` carry `requireRole(UserRole.INTERVIEWER)`; `GET` carries
  `requireRole(UserRole.INTERVIEWER, UserRole.RECRUITER)` and does its scoping in the query.
- **BE-5 — Conflicts come from constraints.** `P2002` → `409 FEEDBACK_ALREADY_SUBMITTED`, caught
  **outside** the transaction callback (FR-3.3). **There is no `findFirst` preceding the insert for
  duplicate detection**, and a reviewer can confirm it by reading `feedback.service.ts`.
- **BE-6 — One projection.** `FEEDBACK_SELECT` names `id`, `rating`, `notes`, `createdAt`,
  `updatedAt` and `interviewer: { select: { id: true, name: true } }`. **It names no `interview`
  relation and therefore reaches no candidate** (FR-5.6, SEC-1). Both roles receive the same shape,
  because neither may see more than the other on this resource.
- **BE-7 — Every write is one transaction** containing the scoped lookup, the row change and the
  `recordAudit` call.
- **BE-8 — Service signature convention.** `log: Logger` last.
- **BE-9 — No new dependencies, no new environment variables.**

**How each of these is built — the file layout, the resolver body, the transaction shapes and the
log field table — is `plan.md § Backend Changes`.** This section states only what must be true.

---

## API Contract

### `POST /api/interviews/:interviewId/feedback` — Bearer · `INTERVIEWER` (assigned)

```jsonc
// request
{
  "rating": 4,
  "notes": "Strong backend fundamentals. Good understanding of PostgreSQL indexing; less confident on concurrency.",
}
```

```jsonc
// 201 Created — no candidate data anywhere in this body (FR-5.6)
{
  "feedback": {
    "id": 31,
    "interviewId": 7,
    "rating": 4,
    "notes": "Strong backend fundamentals. Good understanding of PostgreSQL indexing; less confident on concurrency.",
    "createdAt": "2026-09-24T11:02:14.331Z",
    "updatedAt": "2026-09-24T11:02:14.331Z",
    "interviewer": { "id": 4, "name": "Ivan Interviewer" },
  },
}
```

```jsonc
// 409 Conflict — the same interviewer, twice
{
  "code": "FEEDBACK_ALREADY_SUBMITTED",
  "message": "You have already submitted feedback for this round. Edit it instead.",
}
```

```jsonc
// 404 Not Found — not assigned. Byte-identical to a round that does not exist.
{ "code": "NOT_FOUND", "message": "Resource not found" }
```

| Status | `code`                       | When                                                                                       |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `201`  | —                            | Submitted                                                                                  |
| `400`  | `VALIDATION_ERROR`           | `rating` absent/non-integer/outside 1–5; `notes` absent/empty/over 5000; bad `interviewId` |
| `401`  | `UNAUTHENTICATED`            | No token                                                                                   |
| `403`  | `FORBIDDEN`                  | Recruiter or candidate                                                                     |
| `404`  | `NOT_FOUND`                  | No such round **or** the caller is not assigned — indistinguishable                        |
| `409`  | `FEEDBACK_ALREADY_SUBMITTED` | `P2002` on `(interviewId, interviewerId)`                                                  |
| `409`  | `INTERVIEW_CANCELLED`        | The round's status is `CANCELLED`                                                          |

### `PATCH /api/interviews/:interviewId/feedback` — Bearer · `INTERVIEWER` (author)

```jsonc
// request — at least one of rating, notes
{ "rating": 5 }
```

`200 { "feedback": { … } }` with `updatedAt` advanced.

| Status        | `code`             | When                                                                                        |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `200`         | —                  | Updated                                                                                     |
| `400`         | `VALIDATION_ERROR` | Both fields absent (`details._`), or either invalid                                         |
| `401` / `403` |                    | Anonymous / recruiter or candidate                                                          |
| `404`         | `NOT_FOUND`        | No feedback by this caller on this round — including because they are not assigned (FR-4.2) |

### `GET /api/interviews/:interviewId/feedback` — Bearer · `INTERVIEWER` (assigned) or `RECRUITER`

```jsonc
// 200 OK — a panel's two entries. Still no candidate data.
{
  "feedback": [
    {
      "id": 32,
      "interviewId": 7,
      "rating": 5,
      "notes": "Excellent system design instincts.",
      "createdAt": "2026-09-24T11:04:50.117Z",
      "updatedAt": "2026-09-24T11:04:50.117Z",
      "interviewer": { "id": 5, "name": "Ingrid Interviewer" },
    },
    {
      "id": 31,
      "interviewId": 7,
      "rating": 4,
      "notes": "Strong backend fundamentals…",
      "createdAt": "2026-09-24T11:02:14.331Z",
      "updatedAt": "2026-09-24T11:02:14.331Z",
      "interviewer": { "id": 4, "name": "Ivan Interviewer" },
    },
  ],
}
```

| Status | `code`             | When                                                     |
| ------ | ------------------ | -------------------------------------------------------- |
| `200`  | —                  | Success, including `feedback: []`                        |
| `400`  | `VALIDATION_ERROR` | Bad `interviewId`                                        |
| `401`  | `UNAUTHENTICATED`  | No token                                                 |
| `403`  | `FORBIDDEN`        | Candidate                                                |
| `404`  | `NOT_FOUND`        | No such round, **or** an interviewer who is not assigned |

### Contract invariants — what must appear in **zero** responses

1. **No `email`, in any response from any of the three endpoints, for any role.** §3.6 names this
   endpoint by name.
2. **No `phone`, anywhere.**
3. **No candidate field of any kind** — no `candidate`, no `candidateUserId`, no candidate `name`.
   The feedback resource does not reach the candidate relation at all (FR-5.6).
4. No `interviewerId` raw foreign key — the expanded `interviewer` object replaces it.
5. No `assignments` array, and no `assignedByUserId`.
6. No route deletes feedback. `DELETE` on either path answers `404` from the shipped `notFound`
   handler (FR-6.1).
7. No `403` is ever returned for _right role, wrong round_. That case is always `404` (FR-1.4).

---

## Data Model Changes

```prisma
/// NEW. One interviewer's assessment of one round (FR-2.2).
///
/// The §3.4 policy, made structural: ONE ROW PER INTERVIEWER PER ROUND.
/// Two panellists submitting at the same instant have different unique-key
/// tuples, so they do not contend — both persist. One panellist submitting
/// twice at the same instant is rejected by Postgres, so nothing is lost and
/// nothing is silently merged (D-1, FR-3).
model Feedback {
  id          Int @id @default(autoincrement())
  interviewId Int

  /// Always `req.user.id` (FR-2.5). Never a request field.
  ///
  /// NOTE: comparing this to the caller is NOT an authorization check — it is a
  /// value the service is about to write, compared to itself. Authorization is
  /// the `assignments: { some: { interviewerId } }` predicate in the round
  /// lookup (FR-1.2, FR-1.3).
  interviewerId Int

  /// 1–5, integer. Bounded so it aggregates; integer so nobody has to interpret
  /// "3.5 out of 5". Enforced by zod at the boundary AND by a CHECK constraint
  /// added in this migration (MIG-4).
  rating Int

  /// Required, 1–5000 chars (FR-2.4). A rating with no words is a number, and a
  /// hiring manager cannot act on a number.
  ///
  /// NEVER logged, NEVER placed in audit metadata (FR-7.2, audit FR-4.4).
  notes String

  createdAt DateTime @default(now())

  /// Written by PATCH (FR-4). It exists because an edit path exists — a column
  /// no code writes is a lie in the schema, which is why D-4 added the verb
  /// rather than the column alone.
  updatedAt DateTime @updatedAt

  interview   Interview @relation(fields: [interviewId], references: [id], onDelete: Cascade)

  /// `Restrict`, matching `AuditLog.actor`. An assessment whose author a
  /// deletion can erase is not an assessment.
  interviewer User @relation("FeedbackAuthor", fields: [interviewerId], references: [id], onDelete: Restrict)

  /// The §3.4 policy. The rule is HERE, in the database, not as a `findFirst`
  /// in the service: a read-then-write check loses to two overlapping requests
  /// and would let both commit or let one overwrite the other. The service maps
  /// the resulting `P2002` to `409 FEEDBACK_ALREADY_SUBMITTED` (FR-3.3).
  @@unique([interviewId, interviewerId])

  @@index([interviewId, createdAt]) // a round's panel, newest first — FR-5.1
  @@index([interviewerId])          // "everything this interviewer has written"
}

model Interview {
  // …unchanged…
  feedback Feedback[] // MODIFIED — the back-relation the interviews spec previewed (interviews MIG-7)
}

model User {
  // …unchanged…
  feedback Feedback[] @relation("FeedbackAuthor") // MODIFIED
}
```

### Migration notes

- **MIG-1** Migration name: `add_feedback`. **Additive only.** One table, one unique index, two
  indexes, one `CHECK` constraint, two back-relations that produce no SQL. No existing column is
  altered.
- **MIG-2** This migration also adds the `Interview.feedback` back-relation that the interviews spec
  wrote into its diff for shape but deliberately excluded from its own migration (interviews MIG-7).
  Prisma requires both sides of a relation to exist, so the pair ships together, here.
- **MIG-3** `@@unique([interviewId, interviewerId])` **is the §3.4 policy.** It is a database
  constraint, not a service check, and that distinction is the whole of the brief's requirement that
  the chosen outcome _"actually holds under two near-simultaneous submissions"_. A `findFirst`
  before a `create` does not hold: two overlapping requests both read "no feedback yet" and both
  insert. Postgres cannot be raced this way.
- **MIG-4** A raw `CHECK ("rating" >= 1 AND "rating" <= 5)` is added by hand in the generated
  migration SQL. Prisma has no schema-level attribute for it, and relying on zod alone would leave
  the seed, a future admin path and `psql` free to write a 0 or a 99. **This is the one place in
  this codebase where generated migration SQL is extended**, and it is extended, never rewritten —
  the appended statement is documented in `plan.md`.
- **MIG-5** `interviewer` is `onDelete: Restrict`, matching `AuditLog.actor` and
  `StageOverride.performedBy`. An assessment whose author a deletion can erase is not an assessment.
  `interview` is `Cascade` — feedback on a deleted round is meaningless.
- **MIG-6** **`Feedback` has no foreign key to `InterviewAssignment`** (D-13). This is deliberate:
  unassigning an interviewer must not cascade away their assessment, and a foreign key would make
  that cascade the natural implementation. The assignment authorizes the _write_, at write time;
  it does not own the row afterwards.
- **MIG-7** Row growth: at most one row per (round, interviewer). At 40 000 rounds with two
  panellists each, ~80 000 rows — bounded by the assignment table and fully indexed for both access
  patterns.

---

## Authentication / Authorization

### Endpoint × role matrix

| Endpoint                             | Anonymous | Candidate | Interviewer (assigned) | Interviewer (not assigned) | Recruiter    |
| ------------------------------------ | --------- | --------- | ---------------------- | -------------------------- | ------------ |
| `POST /api/interviews/:id/feedback`  | `401`     | `403`     | ✅                     | **`404`**                  | **`403`**    |
| `PATCH /api/interviews/:id/feedback` | `401`     | `403`     | ✅ own row             | **`404`**                  | **`403`**    |
| `GET /api/interviews/:id/feedback`   | `401`     | `403`     | ✅                     | **`404`**                  | ✅ any round |

### Non-negotiable rules

- **AZ-1** `401` and `403` are never interchanged. `requireAuth` precedes every guard.
- **AZ-2** **The authorization is the assignment, resolved in the query** (FR-1.2). It is not
  `feedback.interviewerId === currentUser.id`, which authorizes nothing (FR-1.3). A reviewer can
  confirm the predicate lives in exactly one file, `feedback.repository.ts`, by grep (AC-B27).
- **AZ-3** A **recruiter reads any round's feedback without an assignment predicate** (D-8). Their
  role is the whole authorization for the read, and there is no row filter behind it. Stated so that
  nobody later assumes one exists.
- **AZ-4** An **interviewer reads only rounds they are assigned to**, through the same predicate as
  the write (FR-5.3). The read and the write cannot drift, because they are one expression used
  twice.
- **AZ-5** **A recruiter cannot submit or edit feedback** — `403` at the route. They did not conduct
  the interview, and an assessment a recruiter can rewrite is not an assessment. This is the rule
  that makes the audit trail worth reading.
- **AZ-6** **An interviewer may edit only their own row**, and ownership is expressed as a `where`
  clause on `updateMany` (FR-4.2), never as an `if` after a fetch. A row that is not theirs is never
  loaded.
- **AZ-7** A scoped miss is **`404`, never `403`** (FR-1.4, D-10), on all three verbs. This is the
  same rule the interviews feature applies to rounds, and for the same reason.
- **AZ-8** `interviewerId` on a written row is always `req.user.id` (FR-2.5). No body field sets it;
  zod strips any that tries.
- **AZ-9** Access is evaluated **per request** against the assignment table. An interviewer removed
  from a round loses read access on their next request — while their already-submitted feedback
  remains (FR-6.4). The asymmetry is deliberate and is named rather than left to be discovered.
- **AZ-10** A candidate is `403` on all three endpoints, including feedback about themselves.

---

## Validation

| Endpoint | Field                 | Rule                                                                | Failure                     |
| -------- | --------------------- | ------------------------------------------------------------------- | --------------------------- |
| all      | `interviewId` (param) | `z.coerce.number().int().positive()`                                | `400` `details.interviewId` |
| `POST`   | `rating`              | `z.number().int().min(1).max(5)`, **required**                      | `400` `details.rating`      |
| `POST`   | `notes`               | `z.string().trim().min(1).max(5000)`, **required**                  | `400` `details.notes`       |
| `PATCH`  | `rating`              | same, optional                                                      | `400` `details.rating`      |
| `PATCH`  | `notes`               | same, optional                                                      | `400` `details.notes`       |
| `PATCH`  | —                     | `.refine(keys.length > 0, 'Provide at least one of rating, notes')` | `400` `details._`           |

- **VAL-1** `rating` is `z.number().int()`, **not** `z.coerce.number()`. A body of
  `{"rating":"4"}` is a `400`. Coercion is right for query strings and path params, which are always
  text; it is wrong for a JSON body, where a string rating means the client is confused about its
  own contract.
- **VAL-2** `rating: 0`, `rating: 6` and `rating: 4.5` are all `400` (FR-2.3). The database `CHECK`
  (MIG-4) is the second line, not the first.
- **VAL-3** `notes` is **required on `POST`** and trimmed before the length check, so `"   "` is a
  `400` rather than a stored blank (FR-2.4).
- **VAL-4** Unknown body keys are stripped by zod. A body of
  `{"rating":4,"notes":"…","interviewerId":9,"id":1}` reaches the service as `{ rating, notes }` —
  the tampered fields do not exist by the time any code could read them (FR-2.5, AZ-8).
- **VAL-5** A `PATCH` with an empty object is a `400` keyed `_`, matching the shipped
  `updateRoleSchema` refinement and the `zod-details` convention for a path-less issue.
- **VAL-6** Validation runs **after** `requireAuth` and `requireRole` (BE-4). A recruiter POSTing a
  malformed body gets `403`, not a `400` that would teach them a contract they may not use.
- **VAL-7** **Validation runs before the assignment lookup.** A malformed body from an unassigned
  interviewer is `400`, not `404`. This is a deliberate ordering: the body shape is not a secret,
  and the brief requires bad input to be rejected _before_ business logic (§6). The round's
  existence is still not revealed, because the `400` is identical whether the round exists or not.

---

## Error Handling

| `code`                       | Status | Raised when                                                          | New?    |
| ---------------------------- | ------ | -------------------------------------------------------------------- | ------- |
| `VALIDATION_ERROR`           | `400`  | Any Validation-table rule fails                                      | no      |
| `UNAUTHENTICATED`            | `401`  | No/invalid/expired token                                             | no      |
| `FORBIDDEN`                  | `403`  | Candidate anywhere; recruiter on `POST`/`PATCH`                      | no      |
| `NOT_FOUND`                  | `404`  | No such round, caller not assigned, or no feedback of theirs to edit | no      |
| `FEEDBACK_ALREADY_SUBMITTED` | `409`  | `P2002` on `(interviewId, interviewerId)`                            | **yes** |
| `INTERVIEW_CANCELLED`        | `409`  | Submitting against a `CANCELLED` round                               | **yes** |
| `INTERNAL_ERROR`             | `500`  | Anything unhandled                                                   | no      |

- **ERR-1** An unassigned interviewer's request — on any verb — is `404 NOT_FOUND`, **byte-identical**
  to the response for a round that does not exist (FR-1.4, AZ-7). No header, no message difference,
  nothing that distinguishes them.
- **ERR-2** `403` means _wrong role for this route_; `404` means _right role, wrong round_. The two
  are never mixed, because mixing them turns the endpoint into an existence oracle.
- **ERR-3** `FEEDBACK_ALREADY_SUBMITTED` carries a message that names the remedy — _"Edit it
  instead."_ — because the remedy is a different verb on the same path and a client that does not
  know that will show a dead end (FR-3.5, XFE-3).
- **ERR-4** `FEEDBACK_ALREADY_SUBMITTED` is produced by catching `P2002` **outside** the transaction
  callback, matching `applications.service`. **No `findFirst` precedes the insert** (BE-5).
- **ERR-5** `INTERVIEW_CANCELLED` is `409`, not `400`: the request is well-formed, and the resource
  is in a state that refuses it.
- **ERR-6** No Prisma code, SQL or stack trace reaches the client, in any environment.
- **ERR-7** A failed `recordAudit` aborts the transaction (audit FR-3.4): no feedback row, `500` to
  the client, and the client's retry is a fresh attempt rather than a duplicate.

---

## Edge Cases

| ID        | Case                                                                                                  | Behaviour                                                                                                                                                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EC-01** | **Two different interviewers on one panel submit concurrently**                                       | **Both `201`.** Different unique-key tuples, nothing to contend on. `psql` shows two rows. _This is the brief's §3.4 case, and the documented outcome is "both are kept"_ (FR-3.2, D-1)                                                                                                                                    |
| **EC-02** | **The same interviewer submits twice concurrently**                                                   | Exactly one `201`, one `409 FEEDBACK_ALREADY_SUBMITTED` from `P2002`. `psql` shows **one** row, and it is whichever body won — never a merge, never a silent overwrite (FR-3.3)                                                                                                                                            |
| **EC-03** | **Three panellists submit at once, while a recruiter fires a stage override on the same application** | Three `201`s and one stage result. The feedback rows touch `Feedback`; the override touches `Application` under its own guarded `updateMany` (pipeline FR-6.2). They do not interact, and the end state is three assessments plus whichever stage write won its own race. _This is the brief's §8 harder variant_ (FR-3.6) |
| **EC-04** | Two concurrent `PATCH`es from one interviewer                                                         | Both `200`; the later commit wins the column values. `updateMany` holds a row lock, so there is no torn write — one of the two bodies is the final state, entirely (FR-4.2)                                                                                                                                                |
| **EC-05** | **An unassigned interviewer POSTs feedback with a valid body**                                        | `404`. The round is never loaded: the assignment predicate is in the `where` (FR-1.2). `psql` shows no row (AZ-2)                                                                                                                                                                                                          |
| **EC-06** | An unassigned interviewer GETs a round's feedback                                                     | `404`, identical to a round that does not exist (ERR-1)                                                                                                                                                                                                                                                                    |
| **EC-07** | An interviewer PATCHes feedback that is not theirs                                                    | `404`. `updateMany`'s `where` includes `interviewerId: actorId`, so `count === 0` (FR-4.2, AZ-6)                                                                                                                                                                                                                           |
| **EC-08** | An interviewer PATCHes before submitting anything                                                     | `404` — the same response as EC-07, so "you wrote nothing" and "that is not yours" are indistinguishable (FR-4.2)                                                                                                                                                                                                          |
| **EC-09** | A recruiter POSTs feedback                                                                            | `403` at the route, before the body is read (AZ-5)                                                                                                                                                                                                                                                                         |
| **EC-10** | Feedback on a `CANCELLED` round                                                                       | `409 INTERVIEW_CANCELLED` (D-12, FR-2.7). The status is read by the same lookup that authorizes, so no extra query                                                                                                                                                                                                         |
| **EC-11** | Feedback on a `SCHEDULED` round, before it happens                                                    | `201`. Requiring `COMPLETED` first would couple an interviewer's notes to a recruiter's status update (D-11, FR-2.6)                                                                                                                                                                                                       |
| **EC-12** | An interviewer is unassigned **after** submitting                                                     | Their row remains and stays visible to recruiters and the remaining panel; **the author loses read access** on their next request. Asymmetric, deliberate, named (FR-6.4, AZ-9)                                                                                                                                            |
| **EC-13** | An interviewer reads the round before writing their own                                               | `200` with their colleagues' entries. _This is the brief's opening complaint being fixed_ (FR-5.4, D-9)                                                                                                                                                                                                                    |
| **EC-14** | A round with no feedback, read by an assigned interviewer                                             | `200` with `feedback: []`. Never `404` — the round is visible to them (FR-5.8)                                                                                                                                                                                                                                             |
| **EC-15** | `rating: 0` or `rating: 6`                                                                            | `400` from zod; the `CHECK` constraint never sees it (VAL-2)                                                                                                                                                                                                                                                               |
| **EC-16** | A seed or `psql` writes `rating: 99`                                                                  | Postgres rejects it — the `CHECK` constraint is the second line of defence that zod cannot provide (MIG-4)                                                                                                                                                                                                                 |
| **EC-17** | `notes: "   "`                                                                                        | `400` — trimmed to empty, fails `min(1)` (VAL-3)                                                                                                                                                                                                                                                                           |
| **EC-18** | `DELETE /api/interviews/:id/feedback`                                                                 | `404` from the shipped `notFound` handler. There is no delete (FR-6.1, contract invariant 6)                                                                                                                                                                                                                               |
| **EC-19** | A round is cancelled after feedback exists                                                            | The feedback remains and is readable. Cancelling a round does not unmake the assessment already written for it (FR-2.7 governs new submissions only)                                                                                                                                                                       |
| **EC-20** | `recordAudit` throws during a submission                                                              | The transaction aborts: no feedback row, `500` to the client, and the retry is a fresh attempt rather than a duplicate (ERR-7)                                                                                                                                                                                             |
| **EC-21** | A recruiter reads feedback on a round with no assignments at all                                      | `200` with `feedback: []`. A recruiter's read is not scoped by assignment (AZ-3)                                                                                                                                                                                                                                           |

---

## Security Requirements

- **SEC-1** **The feedback resource reaches no candidate relation.** `FEEDBACK_SELECT` names
  `interviewer` and nothing else — not `interview`, not `application`, not `candidate` (BE-6,
  FR-5.6). §3.6 names this endpoint specifically as a leak path; the answer is that the row Postgres
  returns contains no candidate column at all, so there is nothing to strip and nothing a future
  call site can accidentally include.
- **SEC-2** **Authorization is the assignment, in the `where`** (AZ-2, FR-1.2). An unassigned
  interviewer's request produces no row — the service has nothing to check and nothing to forget to
  check. There is no `sanitise`, `strip` or `redact` function in this module.
- **SEC-3** **`feedback.interviewerId === currentUser.id` is never used to authorize** (FR-1.3). The
  request that prompted this spec calls the pattern out by name, and the reason is that it is
  vacuous rather than merely weak.
- **SEC-4** A scoped miss is `404`, byte-identical to a nonexistent round (ERR-1), closing the
  enumeration oracle. An interviewer cannot walk the id space to learn which rounds exist.
- **SEC-5** `notes` is **never logged** and **never placed in audit metadata** (FR-7.2, FR-2.8). It
  is added to the pino `redact` list. An interviewer's assessment of a person is exactly the kind of
  text that must not end up in stdout, and the audit feed's readers are not always the round's
  readers.
- **SEC-6** A recruiter cannot write or edit an assessment (AZ-5). This is what makes the audit
  trail worth reading: a rating in the table was typed by the person who conducted the interview.
- **SEC-7** **Known accepted gaps.** (a) **Anchoring bias**: an interviewer can read their
  colleagues' ratings before writing their own (D-9). Fixing the brief's stated problem creates
  this, and a "blind until submitted" rule would be a product decision nobody asked for — it is
  named here rather than silently mitigated. (b) `notes` is stored in plaintext with no encryption
  at rest beyond whatever Postgres is configured with. (c) There is no rate limit on submission, so
  an assigned interviewer can `PATCH` unboundedly, generating unbounded audit rows. (d) An
  unassigned interviewer's feedback remains readable by the rest of the panel (FR-6.4) — deliberate,
  but it means removing someone from a round does not retract what they said. (e) There is no
  `DELETE`, so a submission made in error can be corrected but never withdrawn; this is intentional
  (D-14) and is a gap only if a legal retraction requirement ever appears. All five are accepted for
  a localhost POC; **(c) must be addressed before this is reachable from anywhere but localhost.**

---

## Performance Requirements

- **PERF-1** `POST` is **three statements in one transaction**: the scoped round lookup, the insert,
  the audit insert. **No pre-check `findFirst` for duplicates** — the unique index does that work
  (MIG-3), and adding a check would cost a query and still be wrong under concurrency.
- **PERF-2** The scoped round lookup is a single `findFirst` whose plan enters through
  `InterviewAssignment_interviewerId_createdAt_idx` (interviews MIG-4). **The authorization costs
  one index lookup**, not a scan, and not a separate round trip from the fetch.
- **PERF-3** `GET` is one query, served by `Feedback_interviewId_createdAt_idx` for a recruiter, and
  by that index plus the assignment check for an interviewer. p95 < 50 ms at 80 000 feedback rows.
- **PERF-4** The `interviewer` expansion is a Prisma relation `select`, which joins. It is **not** an
  N+1 lookup per row; `EXPLAIN ANALYZE` on the generated SQL must confirm a join.
- **PERF-5** `PATCH` is **two statements**: the guarded `updateMany` and the audit insert. It
  performs **no preceding read** — ownership is in the `where` (FR-4.2), and reading first would be
  both slower and racier.
- **PERF-6** `GET` is unpaginated because a round's panel is bounded by
  `@@unique([interviewId, interviewerId])` and by how many interviewers a recruiter assigns —
  single digits in practice. **If a round ever exceeds 25 assignments, this endpoint must
  paginate**; that is the documented threshold.
- **PERF-7** No endpoint in this feature loads a candidate, an application or a role. The query plan
  touches `Feedback`, `InterviewAssignment`, `Interview` and `User` — and nothing else.

---

## Acceptance Criteria

Verified by hand with `curl` and `psql`. `$R` is a recruiter's token, `$I1` and `$I2` the two seeded
interviewers', `$C` a candidate's. `$IV` is a round **both** interviewers are assigned to; `$IV_SOLO`
is a round **only `$I1`** is assigned to (interviews FR-7.3).

### Submitting

- **AC-B01** — **Given** `$I1` assigned to `$IV` with no feedback, **when**
  `POST /api/interviews/$IV/feedback` is sent with `{"rating":4,"notes":"Strong fundamentals."}`,
  **then** the response is `201`, `feedback.interviewer.id` is `$I1`'s id, and `psql` shows one row
  (FR-2.8).
- **AC-B02** — **Given** that succeeded, **when** `GET /api/audit?action=FEEDBACK_SUBMITTED` is
  called with `$R`, **then** the newest entry carries `metadata.interviewId` and `metadata.rating`
  and **no `notes` key** (FR-2.8, SEC-5).
- **AC-B03** — **Given** `$I1` already has feedback on `$IV`, **when** the same `POST` is repeated,
  **then** the response is `409 FEEDBACK_ALREADY_SUBMITTED`, the message names editing as the
  remedy, and `psql` still shows **one** row (FR-3.3, ERR-3).
- **AC-B04** — **Given** `$I1`, **when** `{"rating":0,…}` is sent, **then** the response is `400`
  with `details.rating` (VAL-2, EC-15).
- **AC-B05** — **Given** `$I1`, **when** `{"rating":"4",…}` is sent, **then** the response is `400`
  — a string rating is not coerced (VAL-1).
- **AC-B06** — **Given** `$I1`, **when** `{"rating":4,"notes":"   "}` is sent, **then** the response
  is `400` with `details.notes` and `psql` shows no row (VAL-3, EC-17).
- **AC-B07** — **Given** a `CANCELLED` round `$I1` is assigned to, **when** valid feedback is
  submitted, **then** the response is `409 INTERVIEW_CANCELLED` (FR-2.7, EC-10).
- **AC-B08** — **Given** a `SCHEDULED` round `$I1` is assigned to, **when** valid feedback is
  submitted, **then** the response is `201` — `COMPLETED` is not required (FR-2.6, EC-11).
- **AC-B09** — **Given** `$I1`, **when** a body carrying
  `{"rating":4,"notes":"…","interviewerId":<$I2's id>}` is sent, **then** the response is `201` and
  `psql` shows `interviewerId` equal to **`$I1`'s own id** (VAL-4, AZ-8, FR-2.5).
- **AC-B10** — **Given** the database, **when** `psql` attempts
  `INSERT INTO "Feedback" (… rating …) VALUES (… 99 …)`, **then** Postgres rejects it on the `CHECK`
  constraint (MIG-4, EC-16).

### The §3.4 concurrency policy — fired concurrently, not sequentially

- **AC-B11** — **Given** `$IV` with both `$I1` and `$I2` assigned and no feedback, **when** **both**
  submit **concurrently** (`curl … & curl … & wait`), **then** **both** return `201` and `psql`
  shows **exactly two** rows with distinct ids and distinct `interviewerId`s. _This is the brief's
  §3.4 case, and the outcome is the documented one: both are kept_ (EC-01, FR-3.2, D-1).
- **AC-B12** — **Given** `$IV` with `$I1` assigned and no feedback, **when** **two identical**
  submissions from `$I1` are **fired concurrently**, **then** exactly one returns `201`, the other
  `409 FEEDBACK_ALREADY_SUBMITTED`, and `psql` shows **exactly one** row (EC-02, FR-3.3).
- **AC-B13** — **Given** the same, **when** `GET /api/audit?action=FEEDBACK_SUBMITTED` is read,
  **then** there is **exactly one** entry for that round — the refused request left no orphan
  (FR-3.4).
- **AC-B14** — **Given** a round with **three** assigned interviewers, **when** all three submit
  **and** a recruiter fires `POST /api/applications/:id/stage-override` for the same candidate, all
  **concurrently**, **then** all three feedback rows persist, the override either succeeds or is
  `409 STAGE_CONFLICT`, and `psql` shows a consistent state: three feedback rows, and the
  application at exactly one stage with one matching `StageHistory` row. _This is the brief's §8
  harder variant_ (EC-03, FR-3.6).
- **AC-B15** — **Given** the repository, **when**
  `grep -rn "feedback.findFirst\|feedback.findUnique" src/modules/feedback/feedback.service.ts` is
  run, **then** no match precedes a `feedback.create` — the duplicate check is the index, not a read
  (BE-5, PERF-1).

### The assignment gate — the brief's core hard case

- **AC-B16** — **Given** `$I2` **not** assigned to `$IV_SOLO`, **when**
  `POST /api/interviews/$IV_SOLO/feedback` is sent with a **valid** body, **then** the response is
  **`404 NOT_FOUND`**, byte-identical to `POST /api/interviews/999999/feedback`, and `psql` shows
  **no** new row. _An interviewer cannot file feedback against another round by manipulating an id_
  (FR-1.2, EC-05, AZ-2).
- **AC-B17** — **Given** the same request, **when** the server log is read, **then** a
  `feedback.scoped_write_miss` line is present and the response was **not** `403` (SEC-4, FR-7.1).
- **AC-B18** — **Given** `$I2` not assigned to `$IV_SOLO`, **when**
  `GET /api/interviews/$IV_SOLO/feedback` is called, **then** the response is `404` (EC-06, ERR-1).
- **AC-B19** — **Given** `$I2` not assigned, **when** `PATCH /api/interviews/$IV_SOLO/feedback` is
  sent, **then** the response is `404` (EC-07).
- **AC-B20** — **Given** `$I1` assigned to `$IV_SOLO` but having written nothing, **when** `PATCH`
  is sent, **then** the response is `404` — **the same as AC-B19**, so "not yours" and "not there"
  are indistinguishable (EC-08, FR-4.2).
- **AC-B21** — **Given** `$I1` with feedback on `$IV_SOLO`, **when** `$R` unassigns `$I1` and `$I1`
  immediately calls `GET /api/interviews/$IV_SOLO/feedback`, **then** the response is `404` —
  **and** `psql` shows `$I1`'s feedback row **still present** (EC-12, FR-6.4, AZ-9).
- **AC-B22** — **Given** that same state, **when** `$R` calls
  `GET /api/interviews/$IV_SOLO/feedback`, **then** the response is `200` and `$I1`'s row is in it
  (FR-6.4).

### Reading

- **AC-B23** — **Given** `$IV` with feedback from `$I1`, **when** `$I2` (assigned, having written
  nothing) calls `GET /api/interviews/$IV/feedback`, **then** the response is `200` and `$I1`'s
  entry is present with `interviewer.name`. _This is the brief's opening complaint being fixed_
  (FR-5.4, FR-5.5, EC-13, D-9).
- **AC-B24** — **Given** `$R`, **when** the same call is made for any round, **then** the response
  is `200` without any assignment requirement (AZ-3).
- **AC-B25** — **Given** an assigned interviewer and a round with no feedback, **when** `GET` is
  called, **then** the response is `200` with `feedback: []` — not `404` (FR-5.8, EC-14).
- **AC-B26** — **Given** `$C`, **when** any of the three endpoints is called, **then** the response
  is `403` (AZ-10).

### Editing

- **AC-B27** — **Given** `$I1` with feedback rated 4 on `$IV`, **when**
  `PATCH /api/interviews/$IV/feedback` is sent with `{"rating":5}`, **then** the response is `200`,
  the rating is 5, and `updatedAt` is later than `createdAt` (FR-4.1, FR-4.6).
- **AC-B28** — **Given** that succeeded, **when** `GET /api/audit?action=FEEDBACK_UPDATED` is
  called with `$R`, **then** the entry carries `metadata.fromRating: 4` and `metadata.toRating: 5`
  and **no notes text** (FR-4.4).
- **AC-B29** — **Given** `$I1`, **when** `PATCH` is sent with `{}`, **then** the response is `400`
  with `details._` (VAL-5).
- **AC-B30** — **Given** `$R`, **when** `PATCH` is sent against any feedback, **then** the response
  is `403` — a recruiter cannot rewrite an assessment (AZ-5, FR-4.3).
- **AC-B31** — **Given** `$R`, **when** `POST` is sent, **then** the response is `403` (AZ-5,
  EC-09).
- **AC-B32** — **Given** `$R`, **when** `POST` is sent with a **malformed** body, **then** the
  response is `403`, **not** `400` — the role guard precedes validation (VAL-6).

### Contact-detail exclusion — brief §3.6

- **AC-B33** — **Given** `$I1`, **when** `POST /api/interviews/$IV/feedback` succeeds and the
  **entire** `201` body is searched, **then** the strings `"email"`, `"phone"`, `"candidate"` and
  `"candidateUserId"` appear **zero** times. _§3.6 names the feedback-submission endpoint
  specifically_ (contract invariants 1–3, SEC-1).
- **AC-B34** — **Given** `$I1`, **when** `GET /api/interviews/$IV/feedback` returns a two-entry
  panel and the whole body is searched, **then** the same four strings appear **zero** times
  (contract invariants 1–3).
- **AC-B35** — **Given** `$R`, **when** the same read is made, **then** the same four strings appear
  **zero** times — the rule has **no recruiter exception on this resource**; contact details live on
  `GET /api/candidates` (contract invariants 1–3).
- **AC-B36** — **Given** the codebase, **when** `FEEDBACK_SELECT` in `feedback.select.ts` is read,
  **then** it names `interviewer` and **no** `interview`, `application` or `candidate` relation
  (BE-6, FR-5.6).
- **AC-B37** — **Given** the repository, **when**
  `grep -rn "interviewerId === \|interviewerId ==" src/modules/feedback/` is run, **then** no match
  is an authorization decision on `POST` or `GET`; the only occurrence is inside the `updateMany`
  `where` of `PATCH` (FR-1.3, SEC-3).
- **AC-B38** — **Given** the repository, **when**
  `grep -rniE "sanitis|sanitiz|strip|redact" src/modules/feedback/` is run, **then** it returns
  nothing (SEC-2).
- **AC-B39** — **Given** any submission, **when** the server log is read, **then** no line contains
  the notes text, and a `notes` field appears as `[redacted]` if present at all (SEC-5, FR-7.2).

### Absence guarantees

- **AC-B40** — **Given** `$I1` with feedback, **when** `DELETE /api/interviews/$IV/feedback` is
  sent, **then** the response is `404` from the shipped `notFound` handler and `psql` shows the row
  present (FR-6.1, contract invariant 6).
- **AC-B41** — **Given** `$R`, **when** `GET /api/feedback` is called, **then** the response is
  `404` — feedback is always reached through its round (FR-6.2).
- **AC-B42** — **Given** the repository, **when** `grep -rn "feedback.delete" src/` is run, **then**
  it returns nothing (FR-6.1).

### Performance

- **AC-B43** — **Given** a database at 80 000 feedback rows and 80 000 assignments, **when**
  `EXPLAIN ANALYZE` is run on the interviewer's scoped `GET`, **then** the plan shows index scans on
  `Feedback_interviewId_createdAt_idx` and `InterviewAssignment_interviewerId_createdAt_idx`, and
  **no sequential scan** (PERF-2, PERF-3).
- **AC-B44** — **Given** a successful `POST`, **when** the query log is read, **then** exactly three
  statements ran inside the transaction (PERF-1).
- **AC-B45** — **Given** a successful `PATCH`, **when** the query log is read, **then** exactly two
  statements ran — no preceding read (PERF-5).

---

## Out of Scope

| Excluded                                                      | Why                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`PATCH` itself, if you want it gone**                       | It is in scope here by D-4, and it was not in the original endpoint list. It exists because `updatedAt` plus a `409`-on-repeat policy otherwise leaves a column nothing writes. Removing it means removing `updatedAt`, `FEEDBACK_UPDATED`, FR-4 and AC-B27…AC-B30 together — it is deliberately isolated so that is a clean cut |
| `DELETE`                                                      | D-14. Retracting an assessment without a trace is the opposite of what §6 asks for                                                                                                                                                                                                                                               |
| Structured competency scores (per-skill ratings)              | The brief asks for _"a rating plus notes"_. A rubric is a product decision nobody has made                                                                                                                                                                                                                                       |
| A hire/no-hire recommendation field                           | Same reason. A rating already carries the signal, and a second opinion field invites disagreement between the two                                                                                                                                                                                                                |
| Aggregating ratings into a decision or auto-advancing a stage | FR-6.3. Feedback informs a recruiter; it does not move a candidate                                                                                                                                                                                                                                                               |
| Candidate access to feedback about themselves                 | A legal and product decision this POC does not make                                                                                                                                                                                                                                                                              |
| Blind feedback (hidden until you submit your own)             | Would undo the brief's opening complaint. The bias risk is named in SEC-7 instead                                                                                                                                                                                                                                                |
| Editing deadlines                                             | D-6. A time window is a policy nobody asked for                                                                                                                                                                                                                                                                                  |
| Attachments, code samples, recordings                         | No storage layer exists in this POC                                                                                                                                                                                                                                                                                              |
| Notifying a recruiter that feedback arrived                   | No notification channel exists                                                                                                                                                                                                                                                                                                   |
| A cross-round feedback list per interviewer                   | `@@index([interviewerId])` supports it; no requirement asks for it, and an endpoint with no reader is how a surface grows                                                                                                                                                                                                        |

---

## Dependencies

**Blocked by:** [../interviews/spec.md](../interviews/spec.md) — `InterviewAssignment` **is** the
authorization for this feature; there is nothing to join without it.
[../audit/spec.md](../audit/spec.md) — `FEEDBACK_SUBMITTED` and `FEEDBACK_UPDATED` are declared
there and written here. [../pipeline/spec.md](../pipeline/spec.md) — `INTERVIEW_CANCELLED` sits
beside the conflict codes that feature added, and EC-03 composes with its override race.

**Blocks:** [../candidate-access/spec.md](../candidate-access/spec.md) — the recruiter candidate detail renders
the feedback this feature writes.

**New npm packages:** **none.**

**New environment variables:** **none.**

**New files**

| Path                                          | Purpose                                                 |
| --------------------------------------------- | ------------------------------------------------------- |
| `src/modules/feedback/feedback.repository.ts` | The scoped round resolver and the guarded update (BE-2) |
| `src/modules/feedback/feedback.service.ts`    | Submit, edit, list — one transaction each               |
| `src/modules/feedback/feedback.controller.ts` | HTTP concerns only                                      |
| `src/modules/feedback/feedback.routes.ts`     | Three routes, attached to the interviews router (BE-3)  |
| `src/modules/feedback/feedback.schema.ts`     | Body and param schemas                                  |
| `src/modules/feedback/feedback.select.ts`     | `FEEDBACK_SELECT` — names no candidate relation (BE-6)  |

**Modified existing files**

| Path                                                    | Change                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`prisma/schema.prisma`](../../../prisma/schema.prisma) | `Feedback`, its unique index, the `Interview` and `User` back-relations                         |
| the generated migration SQL                             | One appended `CHECK ("rating" >= 1 AND "rating" <= 5)` (MIG-4) — appended, never rewritten      |
| [`src/lib/errors.ts`](../../../src/lib/errors.ts)       | `FEEDBACK_ALREADY_SUBMITTED`, `INTERVIEW_CANCELLED` + subclasses                                |
| [`src/lib/logger.ts`](../../../src/lib/logger.ts)       | `redact` gains `notes`, `*.notes` (FR-7.2)                                                      |
| `src/modules/interviews/interviews.routes.ts`           | Mount `feedbackRouter` under `/:interviewId/feedback`                                           |
| [`prisma/seed.ts`](../../../prisma/seed.ts)             | One feedback row from `interviewer1`, leaving `interviewer2` without one (FR-7.3)               |
| [`CLAUDE.md`](../../../CLAUDE.md)                       | Feature table row; the concurrent-feedback bullet now states the decided policy and points here |

**External services:** none.

**Cross-repo:** a change to the three endpoints, the two new error codes, the rating bounds, or the
`FEEDBACK_SELECT` shape must be made in
[../../../../frontend/specs/features/feedback/spec.md](../../../../frontend/specs/features/feedback/spec.md)
in the same pass.
