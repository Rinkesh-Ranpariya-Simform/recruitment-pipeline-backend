# Candidate Access — Recruiter & Interviewer Views of a Candidate (Backend)

> **Status:** Draft — awaiting approval. `plan.md` is a later artifact and does not exist yet.
> **Feature slug:** `candidate-access`
> **Scope:** `backend/` — Express 5 + Prisma 7 + PostgreSQL
> **Counterpart:** [../../../../frontend/specs/features/candidate-access/spec.md](../../../../frontend/specs/features/candidate-access/spec.md)
> **Depends on:** [../audit/spec.md](../audit/spec.md) · [../pipeline/spec.md](../pipeline/spec.md) · [../interviews/spec.md](../interviews/spec.md) · [../feedback/spec.md](../feedback/spec.md) — all must ship first
> **Parent brief:** [../../../../recruitment-pipeline.md](../../../../recruitment-pipeline.md) §3.2, §3.6, §4, §6, §7.3

---

## Goal

1. Give recruiters a **complete view of a candidate** — contact details, every application, stage
   history, rounds, feedback — behind one scoped read.
2. Give interviewers a view of **only the candidates they are assigned to**, resolved by a
   predicate **inside the database query**, so a candidate outside their assignment is refused at
   the query and not filtered out of a list.
3. Make candidate contact details **structurally unreachable** for an interviewer: a separate table
   the interviewer's select never joins, so there is no column to strip and nothing a future call
   site can accidentally include.
4. Give recruiters somewhere to **record a candidate's phone and location**, since `User` carries
   only a name and an email today.
5. Answer the brief's §7.3 walkthrough question with a file a reviewer can read in one sitting:
   *are contact details excluded at the query or filtered after fetching?*

Success means: a recruiter opens John Smith and sees his phone, his applications and every rating
he received; an interviewer assigned to his technical round opens the same id and sees `John Smith`
and nothing else; and an interviewer **not** assigned to him types his id into the URL and gets a
`404` produced by a query that returned no row.

---

## Background / Context

This is the feature the brief is checked on. Its §4 asks the question this spec must answer with a
file path:

> The question worth sitting with before you write any code: when an interviewer's feedback endpoint
> returns candidate data, **is the restricted contact information ever present in the row your
> database returned to your application code**, or does it only get stripped out in the response
> mapping afterward? A design that fetches everything and hides fields at the edge is one bug away
> from leaking them; a design that never selects those columns for an interviewer's request in the
> first place can't leak what it never fetched. **Pick one, and be ready to show which it is.**

And §6 names the test:

> This is the sharpest test in this POC: an interviewer requesting a candidate they are not assigned
> to, **directly by ID, must be refused at the point of the query.** Write a test that attempts
> exactly that and confirm it fails, not merely that the UI doesn't link to it.

The request that prompted this spec gives the shape:

> Avoid a generic candidate endpoint that exposes every field to every role. Instead, create
> role-aware queries: `getRecruiterCandidate()`, `getInterviewerCandidate()` — or explicitly scoped
> repository methods.

**This feature is written last and is the one the brief names first.** That ordering is deliberate:
`getInterviewerCandidate()` walks `applications → interviews → assignments`, and writing it before
those tables existed would have meant writing the authorization predicate against an imaginary
schema and correcting it later — which is exactly how a leak ships.

### Current state of `backend/`

|                | Today, assuming the four preceding features have shipped |
| -------------- | ------ |
| A candidate | A `User` with `role: CANDIDATE`, created only by `POST /api/auth/signup` |
| Contact data | `User.email` only. **There is no `phone` column anywhere in the schema** |
| `SAFE_USER_SELECT` | `{ id, name, email, role, createdAt }` — serves `/api/auth/me`, signup, login, seed |
| `GET /api/users` | Recruiter-gated, returns **interviewers only**. The interviews feature gave it its first frontend caller |
| Applications | `Application` per (candidate, role), unique, with `currentStage`, `status`, `stageEnteredAt` |
| History | `StageHistory` + `StageOverride`, written by pipeline |
| Rounds | `Interview` + `InterviewAssignment`, with `@@index([interviewerId, createdAt])` |
| Feedback | `Feedback`, `@@unique([interviewId, interviewerId])` |
| Scoping precedents | `buildRoleWhere` (roles), `buildInterviewWhere` (interviews), the feedback insert's scoped `findFirst` |
| Candidate endpoints | **none.** No `/api/candidates` route exists |

### Decisions settled during the interview

| # | Question | Decision | Recorded in |
|---|---|---|---|
| D-1 | Is there a `POST /api/candidates`? | **No.** Candidates exist only via `POST /api/auth/signup` + `POST /api/applications`. The endpoint list in the request included one; it is dropped, because a recruiter-created candidate is an account with no password and an invite flow nobody asked for | FR-1.4, Out of Scope |
| D-2 | Where do contact details live? | **A new `CandidateProfile` table**, 1:1 with `User` (D-2 is the whole security design — see MIG-2) | FR-2, MIG-2 |
| D-3 | Why not `phone` on `User`? | Because `User` serves recruiters and interviewers too, and every select in every module would need auditing forever. **A separate table makes "the interviewer's query cannot reach it" a structural fact rather than a review discipline** | MIG-2, SEC-1 |
| D-4 | How is the profile created? | **Lazily, by `PATCH`**, as an upsert. There is no create endpoint and no row until a recruiter records something | FR-4.3 |
| D-5 | Who may edit a candidate? | **Recruiters only**, and only profile fields. `name`, `email` and `role` are not editable through this surface | FR-4.2, AZ-4 |
| D-6 | Can a candidate edit their own profile? | **No.** `403`. Self-service profile editing is a candidate-feature surface nobody has specified | AZ-5 |
| D-7 | Two functions or one with a branch? | **Two explicitly scoped repository functions**, `getRecruiterCandidate` and `getInterviewerCandidate`, with two separate select constants. A single function with a role branch is one edit away from the wrong branch | FR-5, BE-2 |
| D-8 | What does an interviewer see? | **`{ id, name }` and the rounds they are assigned to.** No email, no phone, no other applications, no stage history, no other interviewers' feedback | FR-6 |
| D-9 | Unassigned interviewer, by id? | **`404`**, from the query itself. Not `403` | FR-6.5, ERR-1 |
| D-10 | Does `GET /api/candidates` paginate? | **Yes**, on the shipped envelope. It is the only endpoint in this system whose result set scales with people | FR-3.5, PERF-3 |
| D-11 | Can a recruiter search candidates? | **Yes**, `?q=` over name **and email**. It is a recruiter-only endpoint and email is the field recruiters actually search by | FR-3.4, SEC-6 |
| D-12 | Does the recruiter detail include feedback notes? | **Yes.** A recruiter may read feedback on any round (feedback AZ-3); denying it here would be an inconsistency, not a protection | FR-5.4 |
| D-13 | Is deleting a candidate in scope? | **No.** No endpoint, and `AuditLog.actor`/`Feedback.interviewer` are `Restrict` anyway | Out of Scope |

---

## Users / Actors

| Actor | May do, after this feature |
|---|---|
| Anonymous | Nothing. `401` |
| Candidate | Nothing. `403` — including on their own record |
| Interviewer | List candidates **they are assigned to**; read one **assigned** candidate — name only, plus their own rounds |
| Recruiter | List and search all candidates; read any candidate in full; record a candidate's contact profile |

**Deliberate POC trade-offs, so they are not read as oversights:**

- **A candidate cannot read or edit their own record here.** Their surface is `GET /api/auth/me` and
  `GET /api/applications`, both shipped. A self-service profile is a candidate-feature decision
  nobody has specified, and adding one here would mean deciding what a candidate may see of a
  recruiter's notes.
- **An interviewer learns a candidate's name.** That is itself personal data. The brief restricts
  *contact details* specifically (§3.6), and an interview cannot happen without a name.
- **An interviewer sees only the rounds they are on**, not the candidate's other applications,
  stage history, or rounds with other panels. Their scope is the assignment, not the person.
- **There is no `POST`** (D-1). Recruiters cannot create candidates; only signup can.
- **`name` and `email` are not editable by anyone.** Identity belongs to the account, and the
  account is the candidate's.

---

## User Stories

| ID | Story |
|---|---|
| **US-01** | As a recruiter, I want a candidate's full record on one screen — contact, applications, stages, rounds, feedback — so that I can make a decision without opening five things. |
| **US-02** | As a recruiter, I want to record a candidate's phone number, so that "call them" does not require finding the original email. |
| **US-03** | As a recruiter, I want to search candidates by name or email, so that finding one is a keystroke rather than paging. |
| **US-04** | As a recruiter, I want to see the applicants for one role, so that the job → applicants step is one filtered call. |
| **US-05** | As an interviewer, I want to see who I am interviewing, so that I can prepare. |
| **US-06** | As an interviewer, I want no way at all to reach a candidate I am not assigned to, including by typing their id. |
| **US-07** | As a security reviewer, I want to open one file and confirm the interviewer's query never names a contact column, rather than trusting that a mapping step removes it. |
| **US-08** | As a hiring manager, I want a candidate's stage history and every rating visible together, so that "how was this person assessed" has one answer. |

---

## Functional Requirements

### FR-1 — What a candidate is

- **FR-1.1** A candidate is a `User` with `role: UserRole.CANDIDATE`. This feature adds no new
  identity model.
- **FR-1.2** Every query in this feature carries `role: UserRole.CANDIDATE` **in the `where`**, so
  `/api/candidates/:id` naming a recruiter's or interviewer's id answers `404`. The endpoint is not
  a generic user reader wearing a different path.
- **FR-1.3** A candidate with no applications still exists and is still listed. Signing up is what
  makes someone a candidate; applying is what puts them in a pipeline.
- **FR-1.4** **There is no `POST /api/candidates`** (D-1). Provisioning remains
  `POST /api/auth/signup` (anonymous, candidates only) and `npm run db:seed`. **The absence is the
  guarantee** — the shipped codebase has no HTTP path that creates a privileged account, and adding
  a creation endpoint here would be the second one. Do not add it without a spec change.

### FR-2 — The contact profile

- **FR-2.1** A new table, `CandidateProfile`, 1:1 with `User` on `userId` as primary key:
  `{ userId, phone, location, headline, updatedAt }`. All three data fields nullable.
- **FR-2.2** **This table exists to make contact data structurally unreachable for an interviewer**
  (D-2, D-3). `User.email` already exists and cannot be moved without breaking authentication, so
  the interviewer's select simply does not name it; `phone` is new, and putting it on `User` would
  mean every select in every module needs auditing forever. **A relation the interviewer's query
  never joins cannot leak, and a reviewer can verify that by reading one select constant.**
- **FR-2.3** `phone` is stored as the recruiter typed it, trimmed. No normalisation, no country-code
  inference, no validation beyond length — a POC that rejects a valid international number is worse
  than one that stores a string.
- **FR-2.4** There is no unique constraint on `phone`. Two candidates may share a landline, and a
  unique index would make that a `409` nobody could resolve.
- **FR-2.5** A candidate with no profile row is normal (D-4). The recruiter response carries
  `profile: { phone: null, location: null, headline: null }` rather than `profile: null`, so a
  client never has to distinguish "no row" from "no value" — a distinction with no meaning here.

### FR-3 — Listing candidates

- **FR-3.1** `GET /api/candidates` — role-aware, following the `buildRoleWhere` and
  `buildInterviewWhere` precedents.
- **FR-3.2** One function owns the scope decision:

  ```ts
  export function buildCandidateWhere(
    query: Pick<ListCandidatesQuery, 'q' | 'roleId' | 'stage' | 'status'>,
    actorRole: UserRole,
    actorId: number,
  ): Prisma.UserWhereInput;
  ```

  It always ANDs `{ role: UserRole.CANDIDATE }`. For an **interviewer** it additionally ANDs the
  assignment chain (FR-6.2). Predicates are **ANDed, never overwritten**, so a filter narrows and
  can never widen.
- **FR-3.3** The same `where` serves the page, the pager's `count` **and** the single read (FR-5.2,
  FR-6.3). One decision, three call sites. **If a third candidates read is ever added, it routes
  through `buildCandidateWhere`** — a second copy of this decision is how the rule rots.
- **FR-3.4** Recruiter filters: `q` (case-insensitive `contains` over **name or email** — D-11),
  `roleId` (candidates with an application to that role — this is US-04, the job → applicants step),
  `stage`, `status`. All optional, all ANDed.
- **FR-3.5** Paginated on the shipped `{ page, pageSize, total, totalPages }` envelope, ordered
  `[{ createdAt: 'desc' }, { id: 'desc' }]`. `pageSize` defaults to 20, max 100; `?pageSize=101` is
  a `400`, never a clamp. **This is the only endpoint in the system whose result set scales with the
  number of people**, which is why it is the only one that must paginate (PERF-3).
- **FR-3.6** The **recruiter** list row carries `{ id, name, email, createdAt, phone,
  applicationCount, applications: [{ id, currentStage, status, stageEnteredAt, role: { id, title } }] }`.
  Enough for the applicants table in the walkthrough without a second call.
- **FR-3.7** The **interviewer** list row carries `{ id, name }` and nothing else (FR-6.4). No
  contact fields, no application list, no counts.
- **FR-3.8** An interviewer's filters are limited to `roleId` and `stage`. `q` is **rejected for an
  interviewer** with `400` — searching a set of three assigned people is not a feature, and a search
  box over candidates is exactly the affordance this feature exists to deny them (VAL-5).
- **FR-3.9** An empty result is `200` with `candidates: []`, never `404`.

### FR-4 — Recording contact details

- **FR-4.1** `PATCH /api/candidates/:candidateId` with any of `{ phone, location, headline }`, at
  least one present. Recruiter-only.
- **FR-4.2** **`name`, `email` and `role` are not accepted** (D-5). They are stripped by zod, so a
  body carrying `{"email":"x@y.z"}` succeeds and changes nothing. Identity belongs to the account.
- **FR-4.3** The write is an **upsert** on `CandidateProfile.userId` (D-4): the row is created on
  first use and updated thereafter. There is no separate create endpoint and no "profile not found"
  state a client must handle.
- **FR-4.4** The target is resolved by
  `findFirst({ where: { id: candidateId, role: UserRole.CANDIDATE }, select: { id: true } })` inside
  the transaction — **the role requirement is in the `where`** (FR-1.2). A recruiter's or
  interviewer's id answers `404`, and their user row is never loaded.
- **FR-4.5** Writes `recordAudit(tx, { action: 'CANDIDATE_CONTACT_UPDATED', entityType: 'CANDIDATE',
  entityId: candidateId, metadata: { fields: ['phone', 'location'] } })` — **the names of the
  changed fields, never their values** (audit FR-4.1, FR-4.4). The audit feed records that a phone
  number was recorded; it does not record the phone number.
- **FR-4.6** An explicit `null` clears a field; an omitted key leaves it unchanged. The two are
  distinguished, so "remove this number" is expressible.
- **FR-4.7** Responds `200` with the recruiter candidate detail, so a client needs no refetch.

### FR-5 — The recruiter read

- **FR-5.1** `GET /api/candidates/:candidateId` for a recruiter calls
  **`getRecruiterCandidate(candidateId)`** (D-7).
- **FR-5.2** It uses `RECRUITER_CANDIDATE_SELECT`, which names:
  `id`, `name`, `email`, `createdAt`;
  `candidateProfile: { phone, location, headline, updatedAt }`;
  `applications: { id, status, currentStage, stageEnteredAt, createdAt, role: { id, title, status },
  stageHistory: { …, override: { reason, createdAt, performedBy: { id, name } } },
  interviews: { …, assignments: { interviewer: { id, name } },
  feedback: { rating, notes, createdAt, interviewer: { id, name } } } }`.
- **FR-5.3** Applications are ordered `createdAt desc`; stage history `createdAt asc` (a timeline
  reads forwards); rounds `scheduledAt desc`; feedback `createdAt desc`.
- **FR-5.4** Feedback **notes** are included (D-12). A recruiter may read feedback on any round
  (feedback AZ-3), and withholding it on this surface would be an inconsistency rather than a
  protection.
- **FR-5.5** Override reasons are included, with the performing recruiter's name. This is the
  surface where the brief's §3.3 record is actually read.
- **FR-5.6** A nonexistent candidate, or a user who is not a candidate, is `404` (FR-1.2).
- **FR-5.7** The whole detail is **one query**. Prisma's nested `select` produces a bounded set of
  joined statements; the service issues no second call and no per-application loop (PERF-2).

### FR-6 — The interviewer read — the brief's sharpest test

- **FR-6.1** `GET /api/candidates/:candidateId` for an interviewer calls
  **`getInterviewerCandidate(candidateId, interviewerId)`** (D-7). A different function, not a
  branch inside one.
- **FR-6.2** **The authorization is the `where`:**

  ```ts
  prisma.user.findFirst({
    where: {
      id: candidateId,
      role: UserRole.CANDIDATE,
      applications: {
        some: {
          interviews: {
            some: {
              assignments: {
                some: { interviewerId },
              },
            },
          },
        },
      },
    },
    select: INTERVIEWER_CANDIDATE_SELECT,
  });
  ```

  **If no authorized row exists, Postgres returns nothing.** The restricted data is never retrieved
  into application memory, so there is no moment at which the service holds a row it had no right
  to. This is the design §4 asks to be picked, and this is the file to show.
- **FR-6.3** The identical predicate is used by the list (FR-3.2) and by the single read. **There is
  no code path in this module of the form `fetch candidate; if (!assigned) throw`** — and a reviewer
  can confirm it by grep (AC-B31).
- **FR-6.4** `INTERVIEWER_CANDIDATE_SELECT` is:

  ```ts
  export const INTERVIEWER_CANDIDATE_SELECT = {
    id: true,
    name: true,
  } as const;
  ```

  **It names no `email`. It joins no `candidateProfile`. It reaches no `applications`.** There is
  nothing in this shape to strip, because nothing restricted was ever selected (D-8, SEC-1).
- **FR-6.5** A candidate the interviewer is not assigned to answers **`404 NOT_FOUND`**, byte-
  identical to a candidate that does not exist (D-9). **Not `403`** — a `403` confirms the candidate
  exists, which is the enumeration oracle this whole design closes.
- **FR-6.6** The interviewer's detail response also carries `interviews` — **their own assigned
  rounds with this candidate only**, as `{ id, type, stage, scheduledAt, status, role: { id, title } }`.
  It is produced by a **second, separately scoped query** against `Interview` with the assignment
  predicate, not by widening `INTERVIEWER_CANDIDATE_SELECT` to reach `applications` (FR-6.4). Two
  narrow queries beat one wide one whose reach must then be constrained.
- **FR-6.7** That second query returns **only** rounds this interviewer is assigned to. A candidate
  interviewed by three panels shows one interviewer their own round and nothing about the others.

### FR-7 — Structure of the role split

- **FR-7.1** `candidate.repository.ts` exports exactly four functions —
  `buildCandidateWhere`, `listCandidates`, `getRecruiterCandidate`, `getInterviewerCandidate` — and
  the two select constants. **There is no fifth, generic `getCandidate`.**
- **FR-7.2** The controller passes `req.user.role` and `req.user.id` to the service; the service
  dispatches to one of the two functions **before** any query runs. The role decides *which query
  is issued*, never *which fields are removed from a result* (BE-2).
- **FR-7.3** There is no function named `sanitise`, `strip`, `redact`, `filterCandidate` or
  `toPublicCandidate` in this module. **Their absence is the design**, and it is checkable by grep
  (AC-B32).

### FR-8 — Logging and seed

- **FR-8.1** New pino events: `candidate.listed`, `candidate.read`, `candidate.contact_updated`,
  `candidate.scoped_read_miss`.
- **FR-8.2** Ids and counts only. **No name, no email, no phone, no search term** — `q` is a
  recruiter's search string and may contain a candidate's email, so it is never logged.
- **FR-8.3** [`prisma/seed.ts`](../../../prisma/seed.ts) gains a `CandidateProfile` for the seeded
  candidate with a phone and location, plus **a second seeded candidate with applications but no
  interviews at all** — so that an interviewer has a real candidate they are not assigned to, which
  is what AC-B22 fires against.

---

## Frontend Requirements

The obligations this backend places on the Next.js client. The rest of the frontend design lives in
[../../../../frontend/specs/features/candidate-access/spec.md](../../../../frontend/specs/features/candidate-access/spec.md).

- **XFE-1** `GET /api/candidates` and `GET /api/candidates/:id` return **two different shapes**,
  chosen by the caller's role. The client needs **two TypeScript types**, not one with optional
  contact fields. A type with `email?: string` invites a component to render it, and the whole point
  is that an interviewer's component has nothing to render.
- **XFE-2** An interviewer's candidate payload contains **no `email`, no `phone`, no `applications`,
  no `stageHistory`, no other interviewers' `feedback`** (FR-6.4). **If any of these ever appears,
  that is a backend bug to report, not a field to hide client-side.**
- **XFE-3** An interviewer requesting an unassigned candidate gets **`404`, not `403`** (FR-6.5).
  The client renders its not-found view; there is no `403` to catch on this route.
- **XFE-4** `PATCH /api/candidates/:id` is **recruiter-only**. It accepts only `phone`, `location`
  and `headline`; **`name` and `email` are silently stripped** (FR-4.2), so a form that submits them
  will appear to succeed while changing nothing. The client must not offer them as editable.
- **XFE-5** An explicit `null` clears a field; an omitted key leaves it unchanged (FR-4.6). A form
  that sends `""` for an untouched input will store an empty string, not a null — the client must
  send `null` to clear.
- **XFE-6** `profile` is always an object on a recruiter response, never `null`, with three possibly
  null fields (FR-2.5). The client renders `—` per field, not a "no profile" empty state.
- **XFE-7** `GET /api/candidates?roleId=` is the **job → applicants** call (US-04). The role detail
  page uses it rather than inventing a nested route.
- **XFE-8** `?q=` is **recruiter-only**; an interviewer sending it gets `400` (FR-3.8). The client
  must not render a search box on an interviewer's candidate list.
- **XFE-9** The list is paginated with the shipped envelope, so the existing `RolesPagination`
  component's props are reusable.
- **XFE-10** `PATCH` responds `200` with the **full recruiter detail** (FR-4.7), so the client can
  write it straight into its detail query cache without a refetch — matching the `useWriteSuccess`
  pattern already used by roles.
- **XFE-11** A recruiter detail may carry feedback `notes` (FR-5.4). This is the one surface where
  an interviewer's written assessment reaches a recruiter's screen through *this* feature; the
  feedback feature's own endpoints are the other.

---

## Backend Requirements

- **BE-1 — Structure.** A new module, `src/modules/candidates/`:
  `candidate.repository.ts`, `candidate.service.ts`, `candidate.controller.ts`,
  `candidate.routes.ts`, `candidate.schema.ts`, `candidate.select.ts`.
  This matches the folder shape the request asked for; `candidate.select.ts` holds what the request
  called explicitly scoped projections.
- **BE-2 — The role decides which query runs, before it runs** (FR-7.2, D-7). Two functions, two
  select constants, no runtime branch inside a single select and **no post-fetch mapping step**.
  `candidate.repository.ts` is the file a reviewer opens to answer the brief's §7.3 question, and it
  must answer it without them following anything.
- **BE-3 — `buildCandidateWhere` is the only place the interviewer scope is expressed** (FR-3.2),
  mirroring `buildRoleWhere` and `buildInterviewWhere` in shape, naming and ANDing discipline. No
  handler composes that predicate.
- **BE-4 — Middleware order:** `requireAuth` → `requireRole(…)` → `validateParams` →
  `validate`/`validateQuery`. The two reads carry `requireRole(RECRUITER, INTERVIEWER)` and scope in
  the query; `PATCH` carries `requireRole(RECRUITER)`.
- **BE-5 — `req.validatedQuery` and `req.validatedParams`, never `req.query`/`req.params`** — Express
  5 makes `req.query` a getter, which is why the shipped middleware assigns elsewhere.
- **BE-6 — One transaction for the write**, containing the scoped lookup, the upsert and the
  `recordAudit` call.
- **BE-7 — Service signature convention.** `log: Logger` last.
- **BE-8 — No new dependencies, no new environment variables.**

**How each of these is built — the file layout, the two select constants in full, the transaction
shape and the log field table — is `plan.md § Backend Changes`.** This section states only what must
be true.

---

## API Contract

### `GET /api/candidates` — Bearer · `RECRUITER` or `INTERVIEWER`

Query: `q` (recruiter only) · `roleId` · `stage` · `status` · `page` · `pageSize` (1–100, default 20).

```jsonc
// 200 — RECRUITER
{
  "candidates": [
    {
      "id": 21,
      "name": "John Smith",
      "email": "john@email.test",
      "phone": "+91 98765 43210",
      "createdAt": "2026-09-02T08:11:00.000Z",
      "applicationCount": 2,
      "applications": [
        {
          "id": 12,
          "status": "ACTIVE",
          "currentStage": "INTERVIEW",
          "stageEnteredAt": "2026-09-16T11:02:40.117Z",
          "role": { "id": 3, "title": "Senior Backend Engineer" }
        }
      ]
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

```jsonc
// 200 — INTERVIEWER. Assigned candidates only. Two keys per row, and that is all.
{
  "candidates": [{ "id": 21, "name": "John Smith" }],
  "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

Errors: `400 VALIDATION_ERROR` (including `?q=` from an interviewer) · `401` · `403` (candidate) ·
`500`.

### `GET /api/candidates/:candidateId` — Bearer · `RECRUITER` or `INTERVIEWER`

```jsonc
// 200 — RECRUITER. getRecruiterCandidate().
{
  "candidate": {
    "id": 21,
    "name": "John Smith",
    "email": "john@email.test",
    "createdAt": "2026-09-02T08:11:00.000Z",
    "profile": { "phone": "+91 98765 43210", "location": "Ahmedabad", "headline": "Backend engineer, 6y", "updatedAt": "2026-09-18T07:00:00.000Z" },
    "applications": [
      {
        "id": 12,
        "status": "ACTIVE",
        "currentStage": "INTERVIEW",
        "stageEnteredAt": "2026-09-16T11:02:40.117Z",
        "createdAt": "2026-09-02T08:12:00.000Z",
        "role": { "id": 3, "title": "Senior Backend Engineer", "status": "OPEN" },
        "stageHistory": [
          { "id": 40, "fromStage": null, "toStage": "APPLIED", "toStatus": "ACTIVE", "createdAt": "2026-09-02T08:12:00.000Z", "changedBy": { "id": 21, "name": "John Smith" }, "override": null },
          { "id": 41, "fromStage": "APPLIED", "toStage": "SCREEN", "toStatus": "ACTIVE", "createdAt": "2026-09-14T09:00:00.000Z", "changedBy": { "id": 1, "name": "Rhea Recruiter" }, "override": null },
          { "id": 42, "fromStage": "SCREEN", "toStage": "INTERVIEW", "toStatus": "ACTIVE", "createdAt": "2026-09-16T11:02:40.117Z", "changedBy": { "id": 1, "name": "Rhea Recruiter" },
            "override": { "id": 4, "reason": "Completed equivalent external screening.", "createdAt": "2026-09-16T11:02:40.117Z", "performedBy": { "id": 1, "name": "Rhea Recruiter" } } }
        ],
        "interviews": [
          {
            "id": 7, "type": "TECHNICAL", "stage": "INTERVIEW",
            "scheduledAt": "2026-09-24T09:30:00.000Z", "status": "SCHEDULED",
            "assignments": [
              { "id": 14, "interviewer": { "id": 4, "name": "Ivan Interviewer" } },
              { "id": 15, "interviewer": { "id": 5, "name": "Ingrid Interviewer" } }
            ],
            "feedback": [
              { "id": 31, "rating": 4, "notes": "Strong backend fundamentals…", "createdAt": "2026-09-24T11:02:14.331Z", "interviewer": { "id": 4, "name": "Ivan Interviewer" } }
            ]
          }
        ]
      }
    ]
  }
}
```

```jsonc
// 200 — INTERVIEWER. getInterviewerCandidate(). Their own rounds, nothing else.
{
  "candidate": { "id": 21, "name": "John Smith" },
  "interviews": [
    {
      "id": 7,
      "type": "TECHNICAL",
      "stage": "INTERVIEW",
      "scheduledAt": "2026-09-24T09:30:00.000Z",
      "status": "SCHEDULED",
      "role": { "id": 3, "title": "Senior Backend Engineer" }
    }
  ]
}
```

```jsonc
// 404 Not Found — an interviewer who is not assigned to this candidate.
// Byte-identical to GET /api/candidates/999999.
{ "code": "NOT_FOUND", "message": "Resource not found" }
```

| Status | `code` | When |
|---|---|---|
| `200` | — | Found, and the caller is permitted |
| `400` | `VALIDATION_ERROR` | `candidateId` not a positive integer |
| `401` | `UNAUTHENTICATED` | No token |
| `403` | `FORBIDDEN` | Candidate |
| `404` | `NOT_FOUND` | No such candidate, the id is not a candidate, **or** the interviewer is not assigned — all indistinguishable |

### `PATCH /api/candidates/:candidateId` — Bearer · `RECRUITER`

```jsonc
// request — name/email are stripped, not rejected (FR-4.2)
{ "phone": "+91 98765 43210", "location": "Ahmedabad" }
```

`200` with the full recruiter detail (FR-4.7).

| Status | `code` | When |
|---|---|---|
| `200` | — | Updated |
| `400` | `VALIDATION_ERROR` | No editable field present (`details._`), or a field over its length |
| `401` / `403` | | Anonymous / not a recruiter |
| `404` | `NOT_FOUND` | No such candidate, or the id is not a `CANDIDATE` |

### Contract invariants — what must appear in **zero** responses

1. **No `email` in any interviewer-role response**, from either read, at any page, under any filter
   combination. This is the invariant the POC is judged on.
2. **No `phone` in any interviewer-role response.**
3. **No `applications`, `stageHistory`, `override`, `assignments` or `feedback` array in any
   interviewer-role candidate payload.** The interviewer detail's `interviews` array is a separate,
   separately scoped key (FR-6.6) and carries no feedback.
4. **No `passwordHash`** in any response from any endpoint, for any role.
5. **No `403` for an unassigned interviewer's by-id read.** The only answer is `404` (FR-6.5).
6. **No non-candidate user** is ever returned by any endpoint here — `role: CANDIDATE` is in every
   `where` (FR-1.2).
7. **No `POST /api/candidates` exists.** It answers `404` from the shipped `notFound` handler
   (FR-1.4).
8. `metadata` on a `CANDIDATE_CONTACT_UPDATED` audit row contains **field names, never field
   values** — no phone number ever reaches the audit feed (FR-4.5).

---

## Data Model Changes

```prisma
/// NEW. A candidate's contact details, in a table of their own.
///
/// THIS TABLE IS THE SECURITY DESIGN (D-2, D-3). `phone` could have been a
/// column on `User`. It is not, because `User` also serves recruiters and
/// interviewers, and every select in every module would then need auditing
/// forever against a rule a reviewer has to remember.
///
/// Here, the rule is structural: `INTERVIEWER_CANDIDATE_SELECT` does not join
/// this relation, so an interviewer's query CANNOT reach `phone` — not "does
/// not currently", cannot. Verifying it is reading one constant
/// (`candidate.select.ts`), not auditing every call site.
///
/// `email` is the exception and it is stated rather than hidden: it lives on
/// `User` because authentication needs it there and moving it would break
/// login. The interviewer's select simply does not name it — the same
/// guarantee by a weaker mechanism, which is why `phone` was not put beside it.
model CandidateProfile {
  /// The primary key IS the foreign key: one profile per user, enforced by the
  /// key itself rather than by a separate unique index.
  userId Int @id

  /// Stored as typed, trimmed (FR-2.3). No normalisation and no unique
  /// constraint (FR-2.4) — two candidates may share a landline, and a POC that
  /// rejects a valid international number is worse than one that stores a string.
  phone    String?
  location String?
  headline String?

  updatedAt DateTime @updatedAt

  /// `Cascade`: a profile without its user is meaningless. This is the opposite
  /// of the `Restrict` used on every ACTOR reference in this schema, and the
  /// distinction is the point — an actor reference is a historical fact, a
  /// profile is current data about a living account.
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model User {
  // …unchanged fields…

  /// MODIFIED — back-relation only. No column is added to `User`, deliberately.
  candidateProfile CandidateProfile?
}
```

### Migration notes

- **MIG-1** Migration name: `add_candidate_profile`. **Additive only.** One table, one back-relation
  that produces no SQL. No existing column is altered, no existing row is touched, and no index on
  an existing table changes.
- **MIG-2** **The table is the design, not a normalisation preference** (D-2, D-3). Putting `phone`
  on `User` would have been one fewer join and a permanent review obligation on every select in the
  codebase. A separate relation converts that obligation into a fact a reviewer can check by reading
  `INTERVIEWER_CANDIDATE_SELECT` and observing that it contains two lines.
- **MIG-3** `userId` is the primary key **and** the foreign key. The 1:1 relationship is enforced by
  the key itself; no separate unique index is created, and no autoincrement `id` exists to be
  confused with a `userId`.
- **MIG-4** `onDelete: Cascade`, unlike every actor reference in this schema, which is `Restrict`.
  The distinction is deliberate and is the general rule this schema follows: **an actor reference is
  a historical fact and must survive; current data about a live account is not.**
- **MIG-5** All three data columns are nullable and there is **no backfill**. A candidate with no
  recorded phone is the normal state, not a gap to fill, and inventing rows would create profiles a
  recruiter never entered.
- **MIG-6** **No index is added.** `CandidateProfile` is only ever reached by primary key from a
  recruiter's candidate query — there is no "find candidate by phone" path, and adding an index for
  a query nobody issues is cost without benefit. `?q=` searches `User.name` and `User.email`
  (FR-3.4), not this table.
- **MIG-7** **No new index on `User` either.** `?q=` is a case-insensitive `contains`, which no
  B-tree index serves; the honest position is stated in PERF-4 rather than papered over with an
  index that would not be used.
- **MIG-8** Row growth: at most one row per candidate, and only for candidates a recruiter has
  recorded something about. Bounded below the user count.

---

## Authentication / Authorization

### Endpoint × role matrix

| Endpoint | Anonymous | Candidate | Interviewer | Recruiter |
|---|---|---|---|---|
| `GET /api/candidates` | `401` | **`403`** | ✅ **assigned only, 2 fields** | ✅ all, full rows |
| `GET /api/candidates/:id` | `401` | **`403`** | ✅ **assigned only → else `404`** | ✅ all |
| `PATCH /api/candidates/:id` | `401` | **`403`** | **`403`** | ✅ |
| `POST /api/candidates` | `404` | `404` | `404` | `404` — **does not exist** (FR-1.4) |

### Non-negotiable rules

- **AZ-1** `401` and `403` are never interchanged. `requireAuth` precedes every guard.
- **AZ-2** **The interviewer's scope is inside the database query** (FR-6.2, FR-3.2). The predicate
  `applications.some.interviews.some.assignments.some.interviewerId` is part of the `where` on the
  list, the pager's `count` and the single read alike. **No handler filters a fetched list, and no
  service fetches a candidate and then checks an assignment.** This is the answer to the brief's
  §7.3 walkthrough question, and `candidate.repository.ts` is the file that shows it.
- **AZ-3** **Restricted columns are excluded at the query, not after it** (FR-6.4, FR-7.2).
  `INTERVIEWER_CANDIDATE_SELECT` names `id` and `name`. `phone` is in a table it does not join;
  `email` is a column it does not name. **The row Postgres returns to Node contains neither**, so
  there is no mapping step that could forget to remove them and no log line that could print them.
  This is the other half of the §7.3 answer.
- **AZ-4** **Only recruiters write** (D-5), and only to `phone`, `location`, `headline`. `name`,
  `email` and `role` are not editable through this surface — identity belongs to the account.
- **AZ-5** **A candidate is `403` on every endpoint here, including their own record** (D-6). Their
  surface is `GET /api/auth/me` and `GET /api/applications`, both shipped and both already scoped.
- **AZ-6** An unassigned interviewer's by-id read is **`404`, never `403`** (FR-6.5). A `403` would
  confirm the candidate exists. This is the same rule the interviews and feedback features apply,
  and it is applied here for the third time deliberately: one rule, three features, no exceptions.
- **AZ-7** `role: UserRole.CANDIDATE` is in every `where` (FR-1.2), so this surface cannot be used
  to read a recruiter or an interviewer. It is not a generic user endpoint behind a candidate-shaped
  path.
- **AZ-8** Access is evaluated **per request** against the assignment chain. An interviewer removed
  from every round with a candidate loses access on their next request, without re-authenticating.
- **AZ-9** A recruiter has **no per-row scoping** — they see every candidate. There is no fallback
  filter behind the role guard, stated so nobody later widens the guard assuming one exists.

---

## Validation

| Endpoint | Field | Rule | Failure |
|---|---|---|---|
| reads, `PATCH` | `candidateId` (param) | `z.coerce.number().int().positive()` | `400` `details.candidateId` |
| `GET` list | `q` | `z.string().trim().max(120)`, `''` → `undefined`, optional | `400` `details.q` |
| `GET` list | `roleId` | `z.coerce.number().int().positive()`, optional | `400` `details.roleId` |
| `GET` list | `stage` | `z.enum(PipelineStage)`, optional | `400` `details.stage` |
| `GET` list | `status` | `z.enum(ApplicationStatus)`, optional | `400` `details.status` |
| `GET` list | `page` / `pageSize` | `min(1).default(1)` / `min(1).max(100).default(20)` | `400` |
| `PATCH` | `phone` | `z.string().trim().max(40).nullable()`, optional | `400` `details.phone` |
| `PATCH` | `location` | `z.string().trim().max(120).nullable()`, optional | `400` `details.location` |
| `PATCH` | `headline` | `z.string().trim().max(200).nullable()`, optional | `400` `details.headline` |
| `PATCH` | — | `.refine(keys.length > 0, 'Provide at least one of phone, location, headline')` | `400` `details._` |

- **VAL-1** `q` follows the shipped `listRolesQuerySchema` convention exactly: trimmed, max 120,
  empty string becomes `undefined` so `?q=` renders an unfiltered list rather than searching for
  nothing.
- **VAL-2** `?pageSize=101` is a `400`, never a clamp (matching roles).
- **VAL-3** `PATCH` with `{}` is a `400` keyed `_`, matching `updateRoleSchema` and the `zod-details`
  convention for a path-less issue.
- **VAL-4** **`name`, `email` and `role` in a `PATCH` body are stripped, not rejected** (FR-4.2). A
  body of `{"phone":"…","email":"attacker@evil.test","role":"RECRUITER"}` succeeds with `200` and
  changes only the phone. This matches the shipped decision on signup, where a `role` field in the
  body is stripped and the endpoint answers `201` with a candidate account. **Rejecting would tell
  an attacker which fields exist; stripping tells them nothing and changes nothing.**
- **VAL-5** **`?q=` from an interviewer is a `400`**, not a silently ignored parameter (FR-3.8). A
  search box over candidates is precisely the affordance this feature exists to deny an interviewer,
  and silently dropping it would leave a client believing it worked.
- **VAL-6** Every field is nullable so that `null` clears it (FR-4.6). `undefined` — an omitted key
  — leaves it unchanged. The two are distinguished by the schema, not by a sentinel string.
- **VAL-7** Validation runs **after** `requireAuth` and `requireRole` (BE-4). A candidate sending a
  malformed `PATCH` gets `403` and learns nothing about the body contract.
- **VAL-8** `stage` and `status` come from the shipped enums, so `?stage=PROBATION` is a `400` before
  any query — the brief's §6 requirement that bad input is rejected before business logic.

---

## Error Handling

| `code` | Status | Raised when | New? |
|---|---|---|---|
| `VALIDATION_ERROR` | `400` | Any Validation-table rule fails, including an interviewer's `?q=` | no |
| `UNAUTHENTICATED` | `401` | No/invalid/expired token | no |
| `FORBIDDEN` | `403` | Candidate anywhere; interviewer on `PATCH` | no |
| `NOT_FOUND` | `404` | No such candidate, the id is not a candidate, or the interviewer is not assigned | no |
| `INTERNAL_ERROR` | `500` | Anything unhandled | no |

**This feature adds no new error code.** Worth stating: the sharpest authorization boundary in the
system is expressed entirely in existing codes, because the correct answer to "you may not see this"
is the same as the answer to "this is not here".

- **ERR-1** An unassigned interviewer's by-id read is `404 NOT_FOUND`, **byte-identical** to
  `GET /api/candidates/999999` and to a request for a recruiter's user id (FR-1.2, FR-6.5). No
  header, no message difference, nothing the service does differently.
- **ERR-2** `403` means *wrong role for this route*. `404` means *right role, wrong row*. The two
  are never mixed — mixing them turns this endpoint into a directory of everyone in the company.
- **ERR-3** A `PATCH` against a user who exists but is an interviewer is `404`, not `403` — the same
  answer as a nonexistent id, so this endpoint cannot be used to enumerate roles (AZ-7).
- **ERR-4** No Prisma code, SQL or stack trace reaches the client, in any environment.
- **ERR-5** A failed `recordAudit` aborts the transaction (audit FR-3.4): the profile is not
  written, and the client sees `500`.

---

## Edge Cases

| ID | Case | Behaviour |
|---|---|---|
| **EC-01** | **An interviewer requests a candidate they are not assigned to, by id** | **`404`.** The row is never fetched — the assignment chain is in the `where` (FR-6.2). *This is the brief's §6 sharpest test* |
| **EC-02** | An interviewer lists candidates | Only candidates they have a round with appear, at any page, under any filter (FR-3.2, contract invariant 1) |
| **EC-03** | An interviewer passes `?roleId=` for a role they have no round on | `200` with `candidates: []`. Their scope predicate ANDs with the filter; a filter narrows and cannot widen (FR-3.2) |
| **EC-04** | An interviewer passes `?q=` | `400`, not a silently dropped parameter (VAL-5, FR-3.8) |
| **EC-05** | An interviewer is unassigned from their only round with a candidate | Their **next** request for that candidate is `404`, without re-authenticating (AZ-8) |
| **EC-06** | An interviewer is assigned to a round on a `REJECTED` application | The candidate remains visible to them. The assignment is the authorization, and the application's outcome does not revoke it — a panel member may need to look back at who they interviewed |
| **EC-07** | A candidate is interviewed by two separate panels | Each interviewer's detail shows **only their own rounds** (FR-6.7). Neither learns the other exists through this surface |
| **EC-08** | `GET /api/candidates/:id` naming a **recruiter's** user id | `404` for everyone, including a recruiter — `role: CANDIDATE` is in the `where` (FR-1.2, AZ-7) |
| **EC-09** | A candidate with no applications | Listed, and readable by a recruiter with an empty `applications` array. Invisible to every interviewer, because no assignment chain reaches them (FR-1.3) |
| **EC-10** | A candidate with no `CandidateProfile` row | Recruiter response carries `profile: { phone: null, location: null, headline: null }`, never `profile: null` (FR-2.5) |
| **EC-11** | First `PATCH` for a candidate | The profile row is created by upsert; no separate create call, and no "profile not found" state (FR-4.3, D-4) |
| **EC-12** | `PATCH` with `{"phone": null}` | The stored phone is cleared. Distinguished from an omitted key, which leaves it unchanged (FR-4.6, VAL-6) |
| **EC-13** | `PATCH` carrying `"email"` or `"role"` | `200`, and neither changes. Stripped by zod before any code reads them (VAL-4) |
| **EC-14** | **Two recruiters `PATCH` the same candidate concurrently** | Both `200`; the later commit wins the column values. An upsert on a primary key cannot produce two rows, and there is no lost-update hazard worth a version column because the fields are independent free text |
| **EC-15** | A `PATCH` and an audit write where the audit fails | The transaction aborts; the profile is unchanged and the client sees `500` (ERR-5) |
| **EC-16** | Two candidates share a phone number | Both store it. No unique constraint, deliberately (FR-2.4) |
| **EC-17** | `?q=` matching an email fragment | Recruiter-only, matches `User.email` case-insensitively (FR-3.4, D-11). The search term is **never logged** (FR-8.2) |
| **EC-18** | `?page=999` on a small result set | `200`, empty array, accurate pagination — matching the shipped roles behaviour |
| **EC-19** | `POST /api/candidates` | `404` from the shipped `notFound` handler. The route does not exist (FR-1.4, contract invariant 7) |
| **EC-20** | A recruiter reads a candidate with 3 applications, 5 rounds and 8 feedback rows | One query with nested selects, bounded by that candidate's own data (FR-5.7, PERF-2) |

---

## Security Requirements

- **SEC-1** **Contact details are excluded at the query.** `INTERVIEWER_CANDIDATE_SELECT` is
  `{ id: true, name: true }`. `phone` lives in `CandidateProfile`, a relation it does not join;
  `email` is a column it does not name (FR-6.4, MIG-2). **The row Postgres returns to Node contains
  neither**, so there is no mapping step that could forget to remove them, no serializer that could
  include them, and no log line that could print them. *This is the answer to brief §7.3, and
  `candidate.select.ts` is where a reviewer reads it.*
- **SEC-2** **Authorization is in the `where`, not after the fetch** (AZ-2, FR-6.2). An unassigned
  interviewer's request produces no row. There is no `if (!assigned) throw` in this module, and
  a reviewer can confirm it by grep (AC-B31).
- **SEC-3** **There is no generic `getCandidate`** (FR-7.1, D-7). Two functions, two selects, chosen
  before the query runs. A single function with a role parameter is one edit away from the wrong
  branch, and the leak that edit causes is silent.
- **SEC-4** **There is no `sanitise`, `strip`, `redact`, `filterCandidate` or `toPublicCandidate`
  function in this module** (FR-7.3). Their absence is the design and is checkable by grep
  (AC-B32). A codebase that has one has decided to fetch everything and trust itself to remove it.
- **SEC-5** A scoped miss is `404`, byte-identical to a nonexistent id and to a non-candidate id
  (ERR-1, ERR-3, AZ-6). An interviewer cannot walk the id space to learn how many candidates exist,
  which ids are live, or which users are recruiters.
- **SEC-6** `?q=` searches email and is **recruiter-only** (D-11, FR-3.8). An interviewer sending it
  gets `400` rather than a silently unfiltered list — a search over people is the affordance this
  feature exists to deny them.
- **SEC-7** **No search term, name, email or phone is ever logged** (FR-8.2). `q` in particular may
  contain a candidate's email, so it is excluded by name rather than by hoping no log line includes
  the query object.
- **SEC-8** The audit row for a contact update records **field names, never values** (FR-4.5,
  contract invariant 8). A phone number must not reach the recruiter-readable audit feed, which has
  a different and broader set of readers than this endpoint.
- **SEC-9** `name`, `email` and `role` are not editable here (AZ-4, VAL-4), so this endpoint cannot
  be used to change a login identity or escalate a role. A body attempting it answers `200` and
  changes nothing — which tells an attacker less than a `400` would.
- **SEC-10** **Known accepted gaps.** (a) An interviewer learns a candidate's **name**, which is
  personal data; the brief restricts contact details specifically and an interview cannot happen
  without a name. (b) An interviewer retains access to a candidate after the application is
  `REJECTED` (EC-06) — the assignment is the authorization and nothing revokes it but unassignment.
  (c) There is no rate limit on the by-id read, so an authenticated interviewer can probe the id
  space as fast as the server answers `404`; the responses are indistinguishable but the timing is
  not formally constant. (d) `phone` is stored in plaintext with no encryption at rest beyond
  Postgres's own. (e) There is no per-role recruiter ownership — any recruiter sees every candidate,
  because there is no hiring-manager actor in this POC. All five are accepted for a localhost POC,
  and **(c) must be addressed before this is reachable from anywhere but localhost.**

---

## Performance Requirements

- **PERF-1** The interviewer's scoped read p95 < 100 ms at the brief's scale — **20 000 candidates,
  40 000 rounds, 80 000 assignments**. `EXPLAIN ANALYZE` must show the plan entering through
  `InterviewAssignment_interviewerId_createdAt_idx` (interviews MIG-4) and show **no sequential
  scan** on `User`, `Application`, `Interview` or `InterviewAssignment`.
- **PERF-2** The recruiter detail is **one Prisma call**. Its nested `select` produces a bounded set
  of joined statements; the service issues no second call and **no per-application loop**
  (FR-5.7). `EXPLAIN ANALYZE` on the generated SQL must confirm joins, not an N+1.
- **PERF-3** `GET /api/candidates` is the **only** endpoint in this system whose result set scales
  with the number of people, which is why it is the only one that paginates (D-10, FR-3.5). The page
  and the pager's `count` run in one `$transaction` sharing one `where`, matching
  `roles.service.listRoles`. p95 < 250 ms at 20 000 candidates.
- **PERF-4** **`?q=` is a case-insensitive `contains`, which no B-tree index serves.** At 20 000
  candidates this is a sequential scan on `User`, and it is accepted at this scale rather than
  papered over with an index Postgres would not use (MIG-7). **If the user table is expected to
  exceed 100 000 rows, this search must move to a `pg_trgm` GIN index** — that is the documented
  threshold, not a vague "if it gets slow".
- **PERF-5** The interviewer's list projection is two columns (FR-3.7). It must never be built by
  selecting the recruiter shape and narrowing it afterwards — that would fetch contact data for
  every row on every page, which is the leak this whole feature is designed around, made worse by
  volume.
- **PERF-6** `PATCH` is **three statements** in one transaction: the scoped lookup, the upsert, the
  audit insert.
- **PERF-7** The interviewer's detail is **two queries** (FR-6.6): the scoped candidate and the
  scoped rounds. Two narrow queries are chosen over one wide one whose reach would then need
  constraining — and each carries its own assignment predicate, so neither can be the one that
  forgets.
- **PERF-8** `?roleId=` is served by the shipped `Application_roleId_currentStage_idx`. The
  applicants-for-a-role call (US-04) must not degrade to a scan.

---

## Acceptance Criteria

Verified by hand with `curl` and `psql`. `$R` is a recruiter's token, `$I1` and `$I2` the two seeded
interviewers', `$C` a candidate's. `$CAND` is a seeded candidate **`$I1` is assigned to** via a
round; `$CAND_OTHER` is a seeded candidate with applications but **no interviews at all** (FR-8.3).

### The sharpest test — brief §6

- **AC-B01** — **Given** `$I1` is **not** assigned to any round with `$CAND_OTHER`, **when**
  `GET /api/candidates/$CAND_OTHER` is called with `$I1` — **the candidate's id supplied directly**
  — **then** the response is **`404 NOT_FOUND`** with a body byte-identical to
  `GET /api/candidates/999999`. *This is the brief's §6 sharpest check: an interviewer requesting a
  candidate they are not assigned to, directly by ID, refused at the point of the query* (FR-6.2,
  EC-01, AZ-2).
- **AC-B02** — **Given** the same request, **when** the server log is read, **then** a
  `candidate.scoped_read_miss` line is present, the response was **not** `403`, and no candidate
  name or email appears in any log line (SEC-5, SEC-7, FR-8.2).
- **AC-B03** — **Given** `$I1`, **when** `GET /api/candidates` is called, **then** `$CAND_OTHER`
  does **not** appear at any page, under any filter combination (EC-02, contract invariant 1).
- **AC-B04** — **Given** `$I1`, **when**
  `GET /api/candidates?roleId=<the role $CAND_OTHER applied to>` is called, **then** the response is
  `200` with `candidates: []` — the filter narrowed within their scope and could not widen it
  (EC-03, FR-3.2).
- **AC-B05** — **Given** `$I1` assigned to `$CAND`, **when** `$R` deletes that assignment and `$I1`
  immediately re-requests `GET /api/candidates/$CAND`, **then** the response is `404` — without
  `$I1` re-authenticating (EC-05, AZ-8).
- **AC-B06** — **Given** `$I1`, **when** `GET /api/candidates/<a recruiter's user id>` is called,
  **then** the response is `404` — the same as a nonexistent id (EC-08, AZ-7, ERR-3).
- **AC-B07** — **Given** `$R`, **when** `GET /api/candidates/<an interviewer's user id>` is called,
  **then** the response is `404`. `role: CANDIDATE` is in the `where` for **every** role, including
  a recruiter's (FR-1.2, contract invariant 6).

### Contact-detail exclusion — brief §3.6 and §7.3

- **AC-B08** — **Given** `$I1` assigned to `$CAND`, **when** `GET /api/candidates/$CAND` is called
  and the **entire** response body is searched, **then** the strings `"email"` and `"phone"` appear
  **zero** times (contract invariants 1–2, SEC-1).
- **AC-B09** — **Given** the same response, **when** `candidate` is inspected, **then** it has
  **exactly** the keys `id` and `name` (FR-6.4).
- **AC-B10** — **Given** the same response, **when** it is inspected, **then** there is **no**
  `applications`, `stageHistory`, `override`, `assignments` or `feedback` key anywhere (contract
  invariant 3).
- **AC-B11** — **Given** `$I1`, **when** `GET /api/candidates?pageSize=100` is called and the whole
  body is searched, **then** `"email"` and `"phone"` appear **zero** times, at every page
  (contract invariants 1–2, PERF-5).
- **AC-B12** — **Given** `$CAND` has a recorded phone, **when** `$I1` calls **both** candidate
  endpoints **and** `GET /api/interviews/:id` **and** `GET /api/interviews/:id/feedback`, **then**
  the phone string appears in **none** of the four response bodies. *This is the cross-cutting
  invariant: the contact detail appears in no response from any endpoint, to any interviewer*
  (SEC-1, and interviews/feedback contract invariants).
- **AC-B13** — **Given** the codebase, **when** `candidate.select.ts` is read, **then**
  `INTERVIEWER_CANDIDATE_SELECT` is exactly `{ id: true, name: true }` — it names no `email`, joins
  no `candidateProfile`, and reaches no `applications` (FR-6.4, SEC-1).
- **AC-B14** — **Given** the codebase, **when** `candidate.repository.ts` is read, **then** the two
  exported read functions are `getRecruiterCandidate` and `getInterviewerCandidate`, and **there is
  no generic `getCandidate`** (FR-7.1, SEC-3, D-7).

### The recruiter view

- **AC-B15** — **Given** `$R`, **when** `GET /api/candidates/$CAND` is called, **then** the response
  is `200` carrying `email`, `profile`, `applications`, each application's `stageHistory`,
  `interviews`, and each round's `assignments` and `feedback` (FR-5.2).
- **AC-B16** — **Given** a candidate whose application was overridden, **when** `$R` reads them,
  **then** the relevant `stageHistory` entry carries a non-null `override` with its `reason` and
  `performedBy.name`. *This is where the brief's §3.3 record is actually read* (FR-5.5).
- **AC-B17** — **Given** a round with feedback, **when** `$R` reads the candidate, **then** the
  feedback entries carry `rating`, `notes` and `interviewer.name` (FR-5.4, D-12).
- **AC-B18** — **Given** `$R`, **when** `GET /api/candidates?q=<an email fragment>` is called,
  **then** matching candidates are returned, and the server log contains **no** occurrence of the
  search term (FR-3.4, SEC-7, EC-17).
- **AC-B19** — **Given** `$R`, **when** `GET /api/candidates?roleId=<a role id>` is called, **then**
  only candidates with an application to that role are returned. *This is the job → applicants step*
  (US-04, FR-3.4).
- **AC-B20** — **Given** `$R`, **when** `GET /api/candidates?stage=SCREEN&status=ACTIVE` is called,
  **then** filters AND — the result is a subset of each filter applied alone (FR-3.4).
- **AC-B21** — **Given** a candidate with no applications, **when** `$R` reads them, **then** the
  response is `200` with `applications: []` (FR-1.3, EC-09).
- **AC-B22** — **Given** the same candidate, **when** any interviewer lists candidates, **then**
  they do **not** appear — no assignment chain reaches them (EC-09).
- **AC-B23** — **Given** `$R`, **when** `?pageSize=101` is sent, **then** the response is `400` with
  `details.pageSize` (VAL-2).
- **AC-B24** — **Given** `$R`, **when** `?stage=PROBATION` is sent, **then** the response is `400`
  before any query (VAL-8).

### Recording contact details

- **AC-B25** — **Given** a candidate with no profile row, **when**
  `PATCH /api/candidates/$CAND` is sent with `{"phone":"+91 98765 43210"}` and `$R`, **then** the
  response is `200` carrying the full detail, and `psql` shows one new `CandidateProfile` row
  (FR-4.3, FR-4.7, EC-11).
- **AC-B26** — **Given** that succeeded, **when**
  `GET /api/audit?action=CANDIDATE_CONTACT_UPDATED` is called with `$R`, **then** the entry's
  `metadata` is `{"fields":["phone"]}` — **the field name, and no phone number anywhere in the
  entry** (FR-4.5, contract invariant 8, SEC-8).
- **AC-B27** — **Given** a stored phone, **when** `{"phone": null}` is PATCHed, **then** `psql`
  shows it `NULL`; **when** `{"location":"X"}` is PATCHed instead, **then** the phone is unchanged
  (FR-4.6, EC-12, VAL-6).
- **AC-B28** — **Given** `$R`, **when**
  `{"phone":"+1","email":"attacker@evil.test","role":"RECRUITER","name":"X"}` is PATCHed, **then**
  the response is `200`, and `psql` shows the candidate's `email`, `role` and `name` **unchanged**
  (VAL-4, SEC-9, EC-13).
- **AC-B29** — **Given** `$R`, **when** `PATCH` is sent with `{}`, **then** the response is `400`
  with `details._` (VAL-3).
- **AC-B30** — **Given** `$R`, **when** `PATCH /api/candidates/<an interviewer's id>` is sent,
  **then** the response is `404`, **not** `403` (FR-4.4, ERR-3).

### Structure — the grep checks a reviewer can run

- **AC-B31** — **Given** the repository, **when**
  `grep -rnE "if ?\(.*assign|assignments\.some" src/modules/candidates/` is run, **then** every
  `assignments.some` match is inside a Prisma `where` in `candidate.repository.ts`, and **no match
  is a JavaScript `if`** (FR-6.3, SEC-2, AZ-2).
- **AC-B32** — **Given** the repository, **when**
  `grep -rniE "sanitis|sanitiz|strip|redact|toPublic|filterCandidate" src/modules/candidates/` is
  run, **then** it returns **nothing** (FR-7.3, SEC-4).
- **AC-B33** — **Given** the repository, **when** `candidate.service.ts` is read, **then** the role
  dispatch happens **before** any query is issued, and neither branch re-selects or narrows the
  other's result (FR-7.2, BE-2).
- **AC-B34** — **Given** the repository, **when**
  `grep -rn "buildCandidateWhere" src/` is run, **then** every call site is inside
  `candidate.repository.ts` (FR-3.3, BE-3).

### Authorization

- **AC-B35** — **Given** no token, **when** any endpoint here is called, **then** the response is
  `401` (AZ-1).
- **AC-B36** — **Given** `$C`, **when** `GET /api/candidates/<their own id>` is called, **then** the
  response is `403`, **not** `200` (AZ-5, D-6).
- **AC-B37** — **Given** `$C`, **when** `GET /api/candidates` is called, **then** the response is
  `403` (AZ-5).
- **AC-B38** — **Given** `$I1`, **when** `PATCH /api/candidates/$CAND` is sent — **for a candidate
  they are assigned to** — **then** the response is `403`, not `200`, and `psql` shows no profile
  change (AZ-4).
- **AC-B39** — **Given** `$I1`, **when** `?q=john` is sent on the list, **then** the response is
  `400`, **not** a silently unfiltered `200` (VAL-5, FR-3.8, EC-04).
- **AC-B40** — **Given** `$C`, **when** a malformed `PATCH` is sent, **then** the response is `403`,
  **not** `400` — the role guard precedes validation (VAL-7).
- **AC-B41** — **Given** any role, **when** `POST /api/candidates` is sent, **then** the response is
  `404` from the shipped `notFound` handler (FR-1.4, EC-19, contract invariant 7).
- **AC-B42** — **Given** any response from any endpoint here, **when** the body is searched, **then**
  `"passwordHash"` appears **zero** times (contract invariant 4).

### Performance — the brief's §6 scale check

- **AC-B43** — **Given** a database at 20 000 candidates, 40 000 rounds and 80 000 assignments,
  **when** `EXPLAIN ANALYZE` is run on the interviewer's scoped by-id read, **then** the plan enters
  through `InterviewAssignment_interviewerId_createdAt_idx` and shows **no sequential scan** on
  `User`, `Application`, `Interview` or `InterviewAssignment` (PERF-1).
- **AC-B44** — **Given** the same database, **when** the recruiter's candidate detail is called and
  the query log is read, **then** the statement count is **independent of the number of
  applications** on that candidate — no per-application loop (PERF-2).
- **AC-B45** — **Given** the same database, **when** `GET /api/candidates` is timed ten times as a
  recruiter, **then** the p95 is under 250 ms (PERF-3).
- **AC-B46** — **Given** `$I1` with three assigned candidates, **when** the query log for
  `GET /api/candidates` is read, **then** exactly two statements ran — the page and the count
  (PERF-3).
- **AC-B47** — **Given** `$I1`, **when** the query log for their by-id read is examined, **then**
  exactly two statements ran — the scoped candidate and the scoped rounds — and **both** carry an
  `interviewerId` predicate (PERF-7, FR-6.6).

---

## Out of Scope

| Excluded | Why |
|---|---|
| **`POST /api/candidates`** | D-1. A recruiter-created candidate is an account with no password and an invite flow nobody asked for. The shipped codebase has exactly one account-creation path and this feature does not add a second |
| Editing `name`, `email` or `role` | Identity belongs to the account, and this is a recruiter's surface (AZ-4) |
| Candidate self-service profile editing | D-6. Requires deciding what a candidate may see and change, which no requirement covers |
| Deleting or anonymising a candidate | D-13. `AuditLog.actor` and `Feedback.interviewer` are `Restrict`, so a delete would fail anyway — and a GDPR-shaped anonymise is a real feature, not a `DELETE` |
| Résumé or document upload | No storage layer exists in this POC |
| Candidate notes or tags by recruiters | A separate record with its own authorization question; feedback already covers assessment |
| Merging duplicate candidates | Requires a merge policy for applications, feedback and audit rows |
| Phone normalisation or validation | FR-2.3. A POC that rejects a valid international number is worse than one that stores a string |
| Searching by phone | No requirement asks for it, and `CandidateProfile` is deliberately unindexed (MIG-6) |
| Full-text or trigram search | PERF-4 names the threshold at which `?q=` must move to `pg_trgm`; below it, an index Postgres would not use is cost without benefit |
| Interviewer access to a candidate's other rounds or applications | FR-6.7. Their scope is the assignment, not the person |
| A `hiringManager` actor with per-role candidate visibility | Optional in the brief (§2) and absent from the requirements this pass covers |

---

## Dependencies

**Blocked by:** [../interviews/spec.md](../interviews/spec.md) — `InterviewAssignment` is the middle
of the authorization chain and `getInterviewerCandidate` cannot be written without it.
[../feedback/spec.md](../feedback/spec.md) — the recruiter detail renders feedback.
[../pipeline/spec.md](../pipeline/spec.md) — the recruiter detail renders `StageHistory` and
`StageOverride`. [../audit/spec.md](../audit/spec.md) — `CANDIDATE_CONTACT_UPDATED` is declared
there and written here, closing the last of the nine action values (audit MIG-3, D-10).
[../candidate/spec.md](../candidate/spec.md) (implemented) — candidates and their applications
exist there.

**Blocks:** nothing. This is the last feature in the sequence; see [../README.md](../../README.md).

**New npm packages:** **none.**

**New environment variables:** **none.**

**New files**

| Path | Purpose |
|---|---|
| `src/modules/candidates/candidate.repository.ts` | `buildCandidateWhere`, `listCandidates`, `getRecruiterCandidate`, `getInterviewerCandidate` (BE-2, FR-7.1) |
| `src/modules/candidates/candidate.select.ts` | `RECRUITER_CANDIDATE_SELECT`, `INTERVIEWER_CANDIDATE_SELECT` — **the file a reviewer opens for brief §7.3** |
| `src/modules/candidates/candidate.service.ts` | Role dispatch + the `PATCH` transaction |
| `src/modules/candidates/candidate.controller.ts` | HTTP concerns only |
| `src/modules/candidates/candidate.routes.ts` | Three routes, guarded per BE-4 |
| `src/modules/candidates/candidate.schema.ts` | Body, param and query schemas |

**Modified existing files**

| Path | Change |
|---|---|
| [`prisma/schema.prisma`](../../../prisma/schema.prisma) | `CandidateProfile` + the `User` back-relation |
| [`src/app.ts`](../../../src/app.ts) | Mount `candidatesRouter` at `/api/candidates` |
| [`prisma/seed.ts`](../../../prisma/seed.ts) | A profile for the seeded candidate, plus a second candidate with applications and no rounds (FR-8.3) |
| [`CLAUDE.md`](../../../CLAUDE.md) | Feature table row; the "Authorization & data exposure" section now names `candidate.select.ts` as the file that answers §7.3 |

**External services:** none.

**Cross-repo:** a change to the three endpoints, the two projections, the `?q=` role restriction, or
the `PATCH` field list must be made in
[../../../../frontend/specs/features/candidate-access/spec.md](../../../../frontend/specs/features/candidate-access/spec.md)
in the same pass.
