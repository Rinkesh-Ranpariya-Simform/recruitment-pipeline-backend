# Backend — Recruitment Pipeline

Express + TypeScript + Prisma + PostgreSQL API for the Recruitment Pipeline POC. Full spec: [../recruitment-pipeline.md](../recruitment-pipeline.md).

## What this system is

Candidates move through a fixed pipeline (applied → screen → interview → offer →
hired/rejected) against open roles. Interviewers leave structured feedback per round.
Recruiters see the full pipeline and can override a candidate's stage. The whole design
center is **restricted data excluded at the query, not filtered after the fact** — see
"Authorization & data exposure" below before adding any endpoint that returns candidate data.

## Actors

| Role | Can do |
|---|---|
| Interviewer | View/submit feedback only for candidates+rounds they're assigned to |
| Recruiter | Full pipeline visibility, assign interviewers, stage overrides, contact details |
| Hiring manager (stretch) | View pipeline/ageing for their own open roles |

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

## Domain model to build out

`schema.prisma` currently only has a placeholder `User`. At minimum the schema needs:

- **Role** — an open req
- **Candidate** — linked to the role(s) they're being considered for
- **PipelineStage** — a small, finite, explicit set (don't model stage as a free-text column)
- Candidate's **current stage** + enough history to compute ageing (time at current stage)
- **InterviewRound** — tied to a candidate + role, with assigned interviewer(s)
- **Feedback** — tied to a specific round, a specific interviewer, a rating + notes
- **StageOverride** — who performed it, when, and why (recruiter-only unless documented
  otherwise); this must be a real recorded row, never inferred from a stage change alone
- An audit/event trail for stage transitions, overrides, and feedback submissions — a hiring
  manager needs to be able to reconstruct how a candidate was assessed

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

- **Stage transitions**: validate against the defined stage graph before touching the DB; skip
  a stage only via an explicit override row (actor + reason required — reject an override
  without both).
- **Bad input**: a feedback submission against a nonexistent round, or a transition naming an
  undefined stage, must be rejected by input validation before it reaches business logic (zod
  or equivalent at the route boundary, matching the frontend's validation approach).
- **Concurrent feedback**: decide and document whether two interviewers submitting feedback for
  the same round near-simultaneously both persist, one wins, or they merge — then enforce it at
  the DB layer (e.g. a unique constraint + explicit conflict handling, or a transaction), not a
  check-then-write race in application code. It must hold under two requests that actually
  overlap, not just two sequential ones.
- **Pipeline/ageing queries**: counts per stage per role, and ageing at current stage, must be
  computed as indexed SQL aggregates — never by loading every candidate into memory. Expect this
  to be verified against simulated scale (200 roles / 20,000 candidates).

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

| Feature | spec | plan | code |
|---|---|---|---|
| [authentication](specs/features/authentication/spec.md) | ✅ approved | [✅ approved](specs/features/authentication/plan.md) | ✅ implemented |

**No authenticated user can create an account.** There is no `POST /api/users`; all provisioning is
`POST /api/auth/signup` (curl/Postman) or `npm run db:seed`. `GET /api/users` exists, recruiter-gated,
but has no frontend caller. Note **SEC-11.1** in the spec — signup is anonymous and role-accepting, and
is the *only* creation path, so anyone who can reach the API can mint a recruiter. That must be closed
before this API is reachable from anywhere but localhost.

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
