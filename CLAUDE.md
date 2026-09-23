# Backend — Recruitment Pipeline

Express + TypeScript + Prisma + PostgreSQL API for the Recruitment Pipeline POC. Full spec: [../recruitment-pipeline.md](../recruitment-pipeline.md).

## What this system is

Candidates move through a fixed pipeline (applied → screen → interview → offer →
hired/rejected) against open roles. Interviewers leave structured feedback per round.
Recruiters see the full pipeline and can override a candidate's stage. The whole design
center is **restricted data excluded at the query, not filtered after the fact** — see
"Authorization & data exposure" below before adding any endpoint that returns candidate data.

## Actors

| Role                     | Can do                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate                | Read `OPEN` requisitions only · apply to one · list **their own** applications. The only role `POST /api/auth/signup` can create                        |
| Interviewer              | View/submit feedback only for candidates+rounds they're assigned to. May **read** requisitions (`OPEN` only); the three roles writes are recruiter-only |
| Recruiter                | Full pipeline visibility, assign interviewers, stage overrides, contact details                                                                         |
| Hiring manager (stretch) | View pipeline/ageing for their own open roles                                                                                                           |

Every request must resolve to a real authenticated user — there is no anonymous read or
write path onto a candidate.

## Stack & commands

- Runtime: Node + TypeScript (`tsx` for dev), ESM (`"type": "module"`)
- Framework: Express 5
- DB: PostgreSQL via Prisma 7 (`@prisma/client` generated into `src/generated/prisma` — never
  hand-edit generated output)
- `npm run dev` — start with tsx, `npm run build` / `npm start` — compiled run
- `npm run lint` / `lint:fix`, `npm run format` / `format:check`
- Prisma: edit `prisma/schema.prisma`, then `npx prisma migrate dev` to create a migration
  (migrations live in `prisma/migrations/`, already committed)
- `.env` is gitignored; `.env.example` documents `DATABASE_URL`, `PORT`, `FRONTEND_ORIGIN`.
  The project must come up with `docker compose up` and no manual setup beyond a documented
  `.env` — keep a `docker-compose.yml` (Postgres + API) in sync with this as it's built out.

## TypeScript conventions

- **Arrays are `Array<T>`, never `T[]`** — and `ReadonlyArray<T>`, never `readonly T[]`. This
  holds everywhere a type is written: rest parameters (`...roles: Array<UserRole>`), returns
  (`Promise<Array<SafeUser>>`), locals (`const and: Array<Prisma.RoleWhereInput> = []`) and
  nested positions (`Record<string, Array<string>>`).
- **An object shape is an `interface`, never `type X = { … }`** — service return shapes,
  middleware bodies, envelope types. `type` stays for what an interface genuinely can't express,
  and only for that: unions (`ErrorCode`, `RotationOutcome`), and types derived from a value or
  another type (`z.infer<typeof schema>`, `Omit<Role, 'updatedAt'>`, `typeof logger`).
- Both are enforced by `@typescript-eslint/array-type` (`generic`) and
  `@typescript-eslint/consistent-type-definitions` in `eslint.config.mjs`, and both are
  autofixable — `npm run lint:fix`.
- These are style rules with no bearing on the wire: `Array<T>` and `T[]` are the same type, so
  nothing here changes a request or response shape. The frontend carries the identical pair of
  rules, so a contract type mirrored in both repos is written the same way on both sides.

## Domain model to build out

`schema.prisma` currently only has a placeholder `User`. At minimum the schema needs:

- **Role** — an open req
- **Candidate** — linked to the role(s) they're being considered for
- **PipelineStage** — a small, finite, explicit set (don't model stage as a free-text column)
- Candidate's **current stage** + enough history to compute ageing (time at current stage)
- **Built** — `Interview` (a round, tied to an **application**, not a candidate) and
  `InterviewAssignment` (the panel). See
  [specs/features/interviews/spec.md](specs/features/interviews/spec.md) and the "Interviewer
  scoping" section below, which every interviewer-facing read is bound by
- **Feedback** — tied to a specific round, a specific interviewer, a rating + notes
- **StageOverride** — who performed it, when, and why (recruiter-only unless documented
  otherwise); this must be a real recorded row, never inferred from a stage change alone
- **Built** — the audit/event trail: `AuditLog`, plus the `AuditAction` and `AuditEntityType`
  enums. See [specs/features/audit/spec.md](specs/features/audit/spec.md) and the "Audit trail"
  section below, which every later feature is bound by

## Authorization & data exposure (read before writing any query)

This is the sharpest requirement in the POC: an interviewer requesting a candidate they are
not assigned to, **by ID, directly**, must be refused at the query itself — not filtered out
of a list response. Every interviewer-scoped read must join/where against the assignment table
in the same query that fetches the candidate; don't fetch-then-check in application code.

Candidate contact details (email, phone) must never reach an interviewer, including through a
feedback-submission response that also happens to carry candidate data. Prefer Prisma `select`
that simply omits contact columns for interviewer-facing queries over fetching the full row and
stripping fields before sending the response — a shape that never selects the columns can't leak
them; a shape that redacts them after fetching is one missed call site away from doing so.

## Business rules to enforce server-side

- **Stage transitions**: **shipped by the [pipeline feature](specs/features/pipeline/spec.md).**
  The graph is `ALLOWED_STAGE_TRANSITIONS` in `src/modules/pipeline/pipeline.rules.ts` — a pure
  file that imports the Prisma enums and nothing else, so it is the one place to read to answer
  "where is the progression rule enforced?". It is consulted **before** the transaction opens, so
  an illegal move costs one read and no write. A skip goes through
  `POST /api/applications/:id/stage-override` only, which writes a `StageOverride` row whose
  `reason` is `NOT NULL` and whose `performedByUserId` is `req.user.id` — both required, neither
  inferrable. Overrides and stage moves are **recruiter-only**; there is no per-row scoping behind
  that guard.
- **Bad input**: a feedback submission against a nonexistent round, or a transition naming an
  undefined stage, must be rejected by input validation before it reaches business logic (zod
  or equivalent at the route boundary, matching the frontend's validation approach).
- **Concurrent feedback**: decide and document whether two interviewers submitting feedback for
  the same round near-simultaneously both persist, one wins, or they merge — then enforce it at
  the DB layer (e.g. a unique constraint + explicit conflict handling, or a transaction), not a
  check-then-write race in application code. It must hold under two requests that actually
  overlap, not just two sequential ones.
- **Pipeline/ageing queries**: **shipped** as `GET /api/pipeline`. One `$queryRaw` `GROUP BY`
  over `Application` plus one indexed `Role` read — two queries regardless of scale, and nothing
  is counted or aged in Node. The raw SQL is confined to
  `src/modules/pipeline/pipeline.repository.ts`, is tagged-template interpolated, and
  `$queryRawUnsafe` appears nowhere in `src/`. Verified at 200 roles / 20,000 applications:
  p95 96 ms against a 300 ms budget. See the note under the feature table on what the query plan
  actually does at that scale.

## Audit trail (read before adding any state-changing endpoint)

Shipped by the [audit feature](specs/features/audit/spec.md). Pipeline, interviews, feedback and
candidate-access all write through it; none of them may invent a second way.

- **One writer.** `recordAudit(tx, entry, log)` in `src/modules/audit/audit.service.ts` is the only
  thing that creates an `AuditLog` row. The module exports exactly two functions — that one and
  `listAuditEntries`. There is no update and no delete, and the absence is the immutability
  guarantee: don't add a `PATCH /api/audit/:id` or an `auditLog.update` call anywhere.
- **It takes the transaction client, and it must be called inside the same `prisma.$transaction`
  as the state change it records.** Passing the global `prisma` is a compile error (the parameter
  is `Prisma.TransactionClient & { $connect?: never }` — the bare Prisma type is _not_ enough,
  because `PrismaClient` structurally satisfies it).
- **A failed audit write aborts the transaction.** `recordAudit` does not catch. The state change
  rolls back with it and the endpoint answers `500`. An action that could not be recorded did not
  happen — don't wrap a call in `try/catch` to "keep the endpoint working".
- **`AuditEntry` is a discriminated union over `action`**, so the metadata each action must carry
  is enforced at the call site. Writing `STAGE_OVERRIDE_CREATED` without a `reason` does not
  compile — that is how the brief's §3.3 rule is enforced, not by a runtime check.
- **`metadata` never carries personal text**: no email, no phone, no name, no title, and never the
  `notes` of a feedback submission. An override's `reason` is the one free-text value permitted
  anywhere in it. `reason` is also on the pino `redact` list, so a log line that includes it prints
  `[redacted]` — note this also redacts the pre-existing `role.delete.refused` line's constant.
- **The actor is always `req.user.id`.** No body, query parameter or header supplies one. The seed
  is the single documented exception (it is also the only caller outside an HTTP request, and the
  only code that deletes audit rows — its delete-then-create reset, scoped to the ids it owns).
- **`GET /api/audit` is recruiter-only, and the role guard is the whole authorization.** There is
  no per-row scoping behind it. Widening the guard leaks the entire trace; there is no partial view.
- `AuditLog.entityId` is deliberately **not** a foreign key — it addresses four tables. It may name
  a row that no longer exists; treat it as a historical reference, not a join target.
- All nine `AuditAction` values already exist in the schema although only three are written today.
  That is the documented exception to "an enum value no code writes is a lie in the schema", and it
  closes when the candidate-access feature ships. Don't add a fifth enum migration.

## Verification expectations

**This project has no automated test suite.** Verification is manual — `curl` against the running
API, plus `psql` where the proof is database state. Automated tests are a deliberate later
decision; do not add a test runner, test files, or test dependencies unless asked.

Manual verification must specifically cover, not just exercise happy paths:

1. An interviewer fetching a candidate outside their assignment, by ID, is refused at the query.
2. An override without a recorded actor + reason is rejected.
3. Two interviewers submitting feedback for the same round concurrently (fired concurrently, not
   sequentially) behave exactly per the documented policy.
4. Invalid stage transitions / feedback against a nonexistent round are rejected before business
   logic runs.

## Development process (Spec-Driven Development)

Feature specs live in `specs/features/<feature>/`, each holding `spec.md` (what & why) and
`plan.md` (how). Phases run in that order and each is approved before the next begins; if implementation reveals
the spec is wrong, update the spec and get it re-approved rather than letting code and spec drift.

| Feature                                                 | spec        | plan                                                 | code                                                                                                                                                                                     |
| ------------------------------------------------------- | ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [authentication](specs/features/authentication/spec.md) | ✅ approved | [✅ approved](specs/features/authentication/plan.md) | ✅ implemented                                                                                                                                                                           |
| [roles](specs/features/roles/spec.md)                   | ✅ approved | [✅ drafted](specs/features/roles/plan.md)           | ⬜ not started                                                                                                                                                                           |
| [candidate](specs/features/candidate/spec.md)           | ✅ approved | ⬜ skipped (implemented straight from the spec)      | ✅ implemented — all 55 acceptance criteria verified by hand against the running API                                                                                                     |
| [audit](specs/features/audit/spec.md)                   | ✅ approved | ⬜ skipped (implemented straight from the spec)      | ✅ implemented — 27 acceptance criteria verified by hand (`curl` + `psql` + `EXPLAIN ANALYZE` at 120k rows)                                                                              |
| [pipeline](specs/features/pipeline/spec.md)             | ✅ approved | ⬜ skipped (implemented straight from the spec)      | ✅ implemented — 50 acceptance criteria verified by hand (`curl` + `psql` + concurrent requests at 20k rows)                                                                             |
| [interviews](specs/features/interviews/spec.md)         | ✅ approved | ⬜ skipped (implemented straight from the spec)      | ✅ implemented — 83 checks verified by hand (`curl` + `psql` + concurrent requests + `EXPLAIN ANALYZE` at 40k rounds / 80k assignments); four criteria deviate, all recorded in the spec |

**Pipeline**, the feature the brief's §3.1/§3.3/§3.5 are about. Five endpoints, two new tables
(`StageHistory`, `StageOverride`), and three new `ErrorCode` values —
`INVALID_STAGE_TRANSITION`, `APPLICATION_NOT_ACTIVE`, `STAGE_CONFLICT`. Two things about it are
worth knowing before touching anything nearby:

- **Concurrency is a guarded `updateMany`, not a lock and not a read-then-compare.** The stage the
  caller observed is part of the `where`; a `count` of 0 means someone moved first and becomes
  `409 STAGE_CONFLICT`. Verified under genuinely concurrent `curl`s: exactly one winner, exactly
  one `StageHistory` row, and **no orphan `StageOverride`** for the request that lost.
- **AC-B34 does not hold as written, and the index is still right.** The spec asks for an index
  scan and no sequential scan on the unfiltered aggregate. At 200 roles / 20,000 applications
  Postgres picks a **sequential scan**, correctly: `status = 'ACTIVE'` matches ~100% of rows and
  the table is ~1.5 MB, so a seq scan is cheaper than any index path — and the aggregate reads
  `stageEnteredAt`, which the index does not cover, so an index-only scan is unavailable. Forcing
  `enable_seqscan=off` shows the planner does use
  `Application_status_roleId_currentStage_idx` as an index-only scan with `Heap Fetches: 0`, and
  it is chosen unforced once the predicate is selective (`?roleId=`). Adding `stageEnteredAt` to
  the index was tried and did not change the unfiltered plan. **The measurable requirement —
  PERF-1's p95 under 300 ms — passes at 96 ms.** Don't "fix" this by adding an index hint or a
  redundant index.

## Interviewer scoping (read before adding any interviewer-facing read)

Shipped by the [interviews feature](specs/features/interviews/spec.md). This is the brief's §3.2
"core hard case", and `InterviewAssignment` is the table that answers it.

- **One function expresses the scope.** `buildInterviewWhere(query, actorRole, actorId)` in
  `src/modules/interviews/interviews.repository.ts` is the only place in `src/` that writes
  `assignments: { some: … }` — confirm with `grep -rn "assignments: { some" src/`, which returns
  exactly one line. It serves the page, the pager's `count` **and** the by-id read. **A third
  interviews read routes through it**; a second copy of that decision is how this rule rots. It
  mirrors `buildRoleWhere` deliberately, down to the `!== RECRUITER` test that fails closed.
- **The predicate is in the `where`, so an unassigned interviewer's row is never fetched.** There is
  no fetch-then-check and no `if (interview.assignments.some(...))` anywhere in the module.
- **A scoped miss is `404`, never `403`.** A `403` confirms the round exists and turns the endpoint
  into an enumeration oracle. The body is byte-identical to a nonexistent id's. The miss is logged
  as `interview.scoped_read_miss` — the line worth watching for someone probing the id space.
- **Two selects, chosen by role BEFORE the query runs.** `INTERVIEWER_INTERVIEW_SELECT` does not
  name `email`, joins no `candidateProfile` and carries no `assignments` list; the recruiter's is a
  different object, not a runtime branch. `grep -rniE "sanitis|sanitiz|strip|redact"
src/modules/interviews/` returns nothing, and that absence is the design. `toInterviewerView` is
  **not** an exception: it re-nests three already-selected values because Prisma cannot flatten a
  relation and the published contract is flat. **If a field must be kept from an interviewer, take
  it out of the select — never out of that function.**
- **Only recruiters write to `InterviewAssignment`.** Both the `POST` and the `DELETE` are
  `requireRole(RECRUITER)`. An interviewer who could create an assignment could grant themselves
  access to any candidate in the system; **the entire scoping model rests on this one guard.**
- **Access is evaluated per request, not captured in a token**, so an unassignment takes effect on
  the interviewer's very next call rather than their next login.
- **The two reads carry `requireRole(RECRUITER, INTERVIEWER)`**, which the spec's BE-5 said they
  would not. Without it a candidate gets a scoped `200 { interviews: [] }` instead of the `403`
  AZ-9 and AC-B35 require. The guard narrows an interviewer's rows by nothing.

Three more things worth knowing before touching anything nearby:

- **`GET /api/applications/:id/interviews` has no interviewer path at all** — reaching rounds by
  application id would bypass the assignment predicate, so the route is recruiter-only and there is
  nothing to bypass. Do not add one "for convenience".
- **Duplicate assignment is a database constraint**, `@@unique([interviewId, interviewerId])` →
  `P2002` → `409 ALREADY_ASSIGNED`. Verified under genuinely concurrent `curl`s: one `201`, one
  `409`, exactly one row. **There is no `findFirst` before that create and must not be one.** A
  missing round on the same insert is the FK's `P2003` → `404`, also at no extra statement.
- **`GET /api/pipeline/summary` now returns SEVEN keys**, including `interviews`. This reverses
  pipeline FR-8.4, XFE-9 and D-12, which are struck through in that spec rather than deleted.

Two acceptance criteria in the interviews spec do not hold as written — AC-B22's grep is
over-broad, and AC-B43's named index is not the plan's entry point although the plan is correct and
PERF-1 passes at 29.4 ms against 80 ms. Both, plus the BE-5 and PERF-5 deviations, are written up
under "Deviations recorded at implementation" at the foot of
[the interviews spec](specs/features/interviews/spec.md). **Don't re-derive them, and don't "fix"
the index.**

The **candidate** feature added a third `UserRole`, made signup candidate-only, and introduced
`Application`. It **deliberately reversed two rules that used to be stated below**; both paragraphs are now
rewritten to match the code. No `plan.md` was written — it was implemented straight from the spec.

The roles plan renames the `Role` **enum** to `UserRole` so the name `Role` can mean _open requisition_.
From that point on: **`UserRole` is who you are; `Role` is an open req.** `requireRole` keeps its name — it
gates on the caller's `UserRole`. The rename changes no API contract; the column, the values and the JWT
claim are all untouched.

**The three `/api/roles` WRITES carry `requireRole(UserRole.RECRUITER)`. The two READS carry only
`requireAuth`** (candidate spec FR-4.1/FR-4.2, which reversed the earlier recruiter-only rule). A candidate
browsing open positions IS the job-list surface, one-for-one with `GET /api/roles?status=OPEN`, so a second
module would have been the same query behind a second name.

**What widened is the route guard, not the query.** `buildRoleWhere` in `roles.service.ts` forces
`status: OPEN` into a non-recruiter's `where` — for the page, for the pager's `count`, and for the single
read — and their projection is `PUBLIC_ROLE_SELECT`. A `CLOSED` requisition is never fetched, never counted,
and answers `404` indistinguishably from one that never existed. **If you add a third roles read, route it
through `buildRoleWhere`**; a second copy of that decision is how this rule rots.

The cost, named: an interviewer regained a requisition read they were previously denied. The rounds feature
should still carry the role title on its own **assignment-scoped** response rather than making a second call
here — that is now a convention rather than something the API enforces.

**No authenticated user can create an account.** There is no `POST /api/users`; all provisioning is
`POST /api/auth/signup` (anonymous, **candidates only**) or `npm run db:seed` (everyone else).
`GET /api/users` exists, recruiter-gated, but has no frontend caller.

**SEC-11.1 is CLOSED** (candidate spec SEC-1). `signupSchema` has no `role` field and `auth.service.signup`
writes the `CANDIDATE` literal, so no request value reaches that column — a body carrying
`"role":"RECRUITER"` answers `201` with a candidate account. **There is now no HTTP path at all that creates
an `INTERVIEWER` or a `RECRUITER`**; both come from the seed. Do not reintroduce a role field or a second
creation path.

What is still accepted, and still localhost-only: signup has no rate limit, no CAPTCHA and no email
verification, so anyone who can reach it can create unlimited _candidate_ accounts. A candidate can also
apply to the same requisition without limit — there is deliberately no unique constraint on
`(candidateUserId, roleId)` (candidate spec SEC-11).

Authentication blocks everything else — §6 requires every action to be tied to a real
authenticated user, and the query-level scoping above has nothing to parameterise on without it.
The frontend counterpart is
[../frontend/specs/features/authentication/spec.md](../frontend/specs/features/authentication/spec.md);
the two share one API contract, so a change to endpoints, the error shape, or the cookie name
must be made in both.

[recruitment-pipeline.md](../recruitment-pipeline.md) (and an approved spec/plan, where one
exists) is the source of truth for behavior. Where an approved spec is more specific than the
brief, the spec wins; where it is silent, the brief governs. Before implementing, re-read the relevant part
of the spec and inspect existing code for a route/service/pattern that already fits — don't assume
a model, middleware, or utility exists without checking. Flag ambiguities instead of guessing at
unspecified behavior (e.g. who besides recruiters can override, exact concurrent-feedback policy —
these must be decided and documented, not left implicit).

**Layering**: keep business logic (stage-transition rules, authorization scoping, audit writes)
out of route handlers as this grows past the current single `server.ts` — handlers should own HTTP
concerns, a service/domain layer should own the rules. Don't duplicate the same authorization
query in multiple handlers; extract it once assignment-scoped queries exist in more than one place.

**Security is non-negotiable, not a nice-to-have**: never hard-code secrets (use `.env`, already
gitignored), never trust a client-supplied role/ID for authorization, never log credentials or
raw feedback/contact data, and never disable a validation or authorization check to make a check or
a demo pass. If a requested change would create one of these, stop and say so rather than
implementing it.

**Errors**: return consistent, structured API errors; never leak a raw stack trace, Prisma error,
or internal detail to the client. Don't swallow errors silently — an audit trail is only useful if
failures are visible too.

**Database changes**: inspect the current schema and migrations before altering them; every schema
change should trace back to a spec requirement (§4); never hand-edit a generated migration or drop
existing data as a shortcut. Use `prisma migrate dev` to create migrations, don't edit
`src/generated/prisma` directly.

**Scope discipline**: implement only what's approved — no unrelated refactors, no speculative
endpoints, no new dependencies unless the existing stack (Express, Prisma, zod-equivalent) can't
already do it. Preserve existing behavior in code you touch unless the spec explicitly changes it.

**Before calling it done**: run lint and type-check, then verify against the spec by hand
(including the query-level-exclusion requirement above); and report what changed, what was
verified, and any deviation or unresolved ambiguity — don't paper over a gap between the spec and
what got built.
