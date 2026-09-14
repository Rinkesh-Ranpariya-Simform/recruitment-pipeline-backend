# Implementation Plan — Authentication (Backend)

> **Derived from:** [spec.md](./spec.md) — approved
> **Counterpart:** [../../../../frontend/specs/features/authentication/plan.md](../../../../frontend/specs/features/authentication/plan.md)
> **Status:** Ready for review

---

## Architecture Impact

This feature converts `backend/` from a single-file scaffold into a layered application. It is the largest structural change the project will take, because every later feature inherits this shape.

**New layers** (none exist today):

| Layer | Owns |
|---|---|
| `config/` | Env parsing and validation at boot. Throws before the port is bound. |
| `lib/` | Cross-cutting singletons and pure helpers: Prisma client, logger, error classes, password hashing, token minting. |
| `middleware/` | The request pipeline: request id → auth → role → validation → error handling. |
| `modules/<domain>/` | `routes` → `controller` → `service` → `schema` per domain. Business logic lives in the service, never the handler. |

**Middleware order in `server.ts`** — order is load-bearing, not cosmetic:

```
requestId
  → cors({ origin: FRONTEND_ORIGIN, credentials: true })
  → express.json()
  → cookieParser()
  → routers        (each route composes: requireAuth → requireRole → validate → controller)
  → notFound       (404 in the standard error shape)
  → errorHandler   (last; converts AppError → { code, message, details? })
```

`requireAuth` is composed **before** `validate` on protected routes (PERF-7), so an unauthenticated request is rejected without paying body-parsing cost.

**Patterns this establishes for every later feature:** the `AppError` hierarchy and error middleware, the `validate(schema)` boundary, `req.user` typing, and the explicit-`select` discipline. Later features extend these; they do not re-invent them.

**Changes to an existing pattern:** `console.log` is replaced by `pino` throughout, and `src/server.ts` loses its inline route.

---

## Frontend Changes

This is a backend plan. The frontend work is planned in [../../../../frontend/specs/features/authentication/plan.md](../../../../frontend/specs/features/authentication/plan.md). Recorded here only as obligations this backend creates for the client:

| What the frontend must do | Because of |
|---|---|
| Send `credentials: 'include'` on every call | The refresh cookie is `HttpOnly` and cross-origin (`:3001` → `:3000`) |
| Attach `Authorization: Bearer <token>` | The access token is returned in the body, never set as a cookie |
| Key its cookie-presence middleware on the name `refresh_token` | BE-7.3 fixes that name |
| Treat `401` as refresh-and-retry, `403` as terminal | AZ-2 — the two are never interchanged |
| Map `body.details` onto form fields | VAL-5 keys `details` by request-body field name |
| Render `body.message` verbatim | ERR-1 guarantees user-safe copy |

**No frontend change is required by this plan beyond the above** — the client has no existing auth code to migrate.

---

## Backend Changes

All paths relative to `backend/`. Every entry is **NEW** unless marked MODIFIED.

### Configuration

**`src/config/env.ts`** — NEW
- **Responsibility:** parse and validate `process.env` once, at import time, and export a frozen typed object.
- **Validation:** zod schema — `DATABASE_URL` (url), `PORT` (coerce number, default 3000), `FRONTEND_ORIGIN` (url), `JWT_SECRET` (**min 32 chars, no default**), `ACCESS_TOKEN_TTL` (default `'15m'`), `REFRESH_TOKEN_TTL_DAYS` (coerce number, default 1), `COOKIE_SECURE` (coerce boolean, default false), `SEED_PASSWORD` (optional).
- **Required modification:** on parse failure, print the formatted zod error and `process.exit(1)` **before** anything binds a port (EC-10, AC-B33).

### Library

**`src/lib/prisma.ts`** — NEW
- Single `PrismaClient` instance imported from `../generated/prisma/client.js` (Prisma 7 `prisma-client` generator output — **not** `@prisma/client`).
- Exports `prisma` and a `disconnect()` for graceful shutdown.

**`src/lib/logger.ts`** — NEW
- `pino` instance; `pino-pretty` transport when `NODE_ENV !== 'production'`.
- Exports `logger` and `child({ requestId })`.
- **Responsibility:** a `redact` list covering `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, `password`, `passwordHash`, `token`, `accessToken`, `refreshToken` — belt-and-braces on top of never logging them deliberately (BE-9).

**`src/lib/errors.ts`** — NEW
- `AppError extends Error` carrying `status`, `code`, optional `details`.
- Named constructors: `ValidationError`, `InvalidCredentialsError`, `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `EmailTakenError`.
- **Responsibility:** the only way a handler signals a client-visible failure.

**`src/lib/password.ts`** — NEW
- `hashPassword(plain)` → `bcrypt.hash(plain, 12)`.
- `verifyPassword(plain, hash)` → `bcrypt.compare`.
- `verifyDummyPassword(plain)` → compares against a module-level constant hash, for the unknown-email path (BE-3.3, SEC-3).
- **Responsibility:** the only module that imports `bcrypt`. Cost factor is defined here once.

**`src/lib/tokens.ts`** — NEW
- `signAccessToken({ sub, role })` → `jsonwebtoken.sign(..., { expiresIn: env.ACCESS_TOKEN_TTL })`.
- `verifyAccessToken(token)` → `jwt.verify(..., { clockTolerance: 30 })` (EC-12), returns typed claims or throws.
- `generateRefreshToken()` → `crypto.randomBytes(32).toString('base64url')`.
- `hashRefreshToken(raw)` → `crypto.createHash('sha256').update(raw).digest('hex')`.
- **Responsibility:** the only module that imports `jsonwebtoken` and `node:crypto`. Raw refresh tokens exist only as return values here and in the `Set-Cookie` header.

**`src/lib/cookies.ts`** — NEW
- `setRefreshCookie(res, rawToken)` / `clearRefreshCookie(res)`.
- **Responsibility:** the single definition of the cookie's attributes — name `refresh_token`, `httpOnly`, `sameSite: 'lax'`, `path: '/api/auth'`, `maxAge`, `secure: env.COOKIE_SECURE` (BE-7.3, BE-7.4). No other file sets this cookie.

### Types

**`src/types/express.d.ts`** — NEW
- Declaration merging: `Express.Request.user?: { id: number; role: Role }`.
- **Responsibility:** makes `req.user` typed everywhere without casts.

### Middleware

**`src/middleware/requestId.ts`** — NEW
- Assigns `crypto.randomUUID()` to `req.id`, attaches a child logger, echoes it as the `X-Request-Id` response header.

**`src/middleware/validate.ts`** — NEW
- `validate(schema)` — parses `req.body`, **replaces `req.body` with the parsed (and transformed) result**, so downstream code receives the normalised email (VAL-3).
- On failure throws `ValidationError` with `details` flattened to `Record<string, string[]>` keyed by field (VAL-5).
- **Responsibility:** invalid input never reaches a service (BE-2.2).

**`src/middleware/requireAuth.ts`** — NEW
- Reads `Authorization`, requires exactly `Bearer <token>` (EC-15), verifies it, then **loads the user from the database** and 401s if absent (EC-11, AC-B16).
- Sets `req.user = { id, role }`. Exactly one DB query (PERF-4).
- Any failure → `UnauthenticatedError`; never leaks the verification reason (AC-B14).

**`src/middleware/requireRole.ts`** — NEW
- `requireRole(...roles)` — 403 on mismatch, logs `authz.denied`. Assumes `requireAuth` ran first.

**`src/middleware/notFound.ts`** — NEW
- Terminal 404 in the standard error shape, replacing Express's HTML default (EC-16, AC-B35).

**`src/middleware/errorHandler.ts`** — NEW
- Express 5 error middleware. `AppError` → its status/code/message/details. Anything else → log at `error` with the stack, respond `500 INTERNAL_ERROR` with a generic message (ERR-3, AC-B34).
- **Responsibility:** the only place a response body is built for a failure.

### Auth module

**`src/modules/auth/auth.schema.ts`** — NEW
- `signupSchema` — `{ name, email, password, role }`; email `.trim().toLowerCase()` via `.transform()`; password `.min(8).max(72)`; role `z.nativeEnum(Role)`; **required, no default** (EC-13).
- `loginSchema` — `{ email, password }`; **shape-only**, no length minimum (VAL-6, AC-B08).
- All schemas strip unknown keys.

**`src/modules/auth/auth.service.ts`** — NEW
- `signup(input)` — hash, `prisma.user.create` with explicit `select` of safe columns. Catches Prisma `P2002` → `EmailTakenError` (ERR-4, EC-06).
- `login(email, password)` — `findUnique` selecting `id, name, email, role, createdAt, passwordHash`; on miss calls `verifyDummyPassword` then throws `InvalidCredentialsError`; on hit verifies and throws the **same** error on mismatch (SEC-2). Creates a new family: `familyId = randomUUID()`, inserts one `RefreshToken`, returns `{ user, accessToken, rawRefreshToken }`.
- `refresh(rawToken)` — the whole of **BE-5** inside `prisma.$transaction`: hash → lookup by `tokenHash` → if `revokedAt` set, `updateMany` revoking the whole `familyId`, log `auth.refresh.reuse_detected`, throw → if expired, throw → else revoke the presented row, insert a successor sharing `familyId`, return new tokens.
- `logout(rawToken)` — revoke every unrevoked row in the family; swallow "not found" and return normally (FR-5.7, AC-B24).
- **Responsibility:** all password, token and rotation logic. The controller performs none of it.

**`src/modules/auth/auth.controller.ts`** — NEW
- `signup` → 201 `{ user }`, **no cookie** (AC-B01).
- `login` → `setRefreshCookie`, 200 `{ user, accessToken, expiresIn: 900 }`.
- `refresh` → reads `req.cookies.refresh_token`, 401 if absent (AC-B19); sets the rotated cookie, 200 `{ accessToken, expiresIn }`.
- `logout` → `clearRefreshCookie`, 204, always.
- `me` → 200 `{ user }` from an explicit `select` keyed on `req.user.id`.

**`src/modules/auth/auth.routes.ts`** — NEW

| Method | Path | Chain |
|---|---|---|
| POST | `/signup` | `validate(signupSchema)` → controller |
| POST | `/login` | `validate(loginSchema)` → controller |
| POST | `/refresh` | controller (cookie only, no body) |
| POST | `/logout` | controller |
| GET | `/me` | `requireAuth` → controller |

### Users module

**`src/modules/users/users.schema.ts`** — NEW
- `createInterviewerSchema` — `{ name, email, password }`. **No `role` key**, unknown keys stripped (FR-3.3, AC-B26).

**`src/modules/users/users.service.ts`** — NEW
- `createInterviewer(input)` — reuses `auth.service`'s hashing helper, `prisma.user.create({ data: { ...input, role: 'INTERVIEWER' } })` with `role` **literal in the service, never from input**. Same `P2002` → `EmailTakenError` translation.
- `listInterviewers()` — `findMany({ where: { role: 'INTERVIEWER' }, orderBy: { createdAt: 'desc' }, select: SAFE_USER_SELECT })` (AC-B30).

**`src/modules/users/users.controller.ts`** / **`users.routes.ts`** — NEW
- `POST /` → `requireAuth` → `requireRole('RECRUITER')` → `validate(createInterviewerSchema)` → controller → 201.
- `GET /` → `requireAuth` → `requireRole('RECRUITER')` → controller → 200 `{ users }`.

### Shared select constant

**`src/modules/users/user.select.ts`** — NEW
- `export const SAFE_USER_SELECT = { id: true, name: true, email: true, role: true, createdAt: true } as const;`
- **Responsibility:** the single definition of the safe user projection. Imported by both modules. `passwordHash` is absent by construction, satisfying FR-6.3 — this is the mechanism that makes AC-B32 hold, and the same discipline candidate contact fields will need later.

### App wiring

**`src/server.ts`** — MODIFIED
- **Remove:** the inline `GET /` handler, the `console.log`, the inline `PORT`/`FRONTEND_ORIGIN` reads.
- **Add:** `import { env } from './config/env.js'` as the **first** import (so a bad env fails before anything else), the middleware order above, `cookieParser()`, `credentials: true` on CORS, `app.use('/api/auth', authRouter)`, `app.use('/api/users', usersRouter)`, `notFound`, `errorHandler`.
- **Keep:** `GET /` as a health check — the frontend's `ApiStatusCard` already polls it.
- **Split:** export `app` from a new `src/app.ts` and keep `server.ts` as the listener only, so the wired app can be imported without binding a port.

### Seed

**`prisma/seed.ts`** — NEW
- `upsert` by email × 3: `recruiter@demo.test` (RECRUITER), `interviewer1@demo.test`, `interviewer2@demo.test` (INTERVIEWER), password from `env.SEED_PASSWORD`.
- Idempotent — safe to run repeatedly (FR-8.1, AC-B36).

### Config files

**`package.json`** — MODIFIED
- Dependencies: `zod`, `bcrypt`, `jsonwebtoken`, `cookie-parser`, `pino`.
- Dev: `@types/bcrypt`, `@types/jsonwebtoken`, `@types/cookie-parser`, `pino-pretty`.
- Scripts: `"db:seed": "tsx prisma/seed.ts"`, `"typecheck": "tsc --noEmit"`. The placeholder `"test"` script is left as it is — this feature adds no test suite (see § Verification Commands).

**`tsconfig.json`** — MODIFIED
- `"types": ["node"]` (currently `[]`, so `crypto`/`process` have no typings).

**`.env.example`** — MODIFIED
- Add `JWT_SECRET`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS`, `COOKIE_SECURE`, `SEED_PASSWORD`.

---

## Database Changes

### Schema changes

Add to `prisma/schema.prisma` exactly as specified in [spec.md § Data Model Changes](./spec.md#data-model-changes): the `Role` enum, four new `User` fields (`passwordHash`, `role`, `updatedAt`, `refreshTokens`), and the `RefreshToken` model.

### Migrations

One migration: **`add_auth`**, created with

```
npx prisma migrate dev --name add_auth
```

**This migration is destructive.** `passwordHash` and `role` are non-nullable additions to an existing table, so Prisma will generate a `TRUNCATE`/drop-and-recreate step. Required actions:

1. Confirm the `User` table holds no real data (it is scaffold-only — the placeholder model has never been written to by application code).
2. **Add a comment at the top of the generated SQL** stating that existing `User` rows are destroyed and why (MIG-1).
3. State it in the PR description.
4. Do **not** hand-edit the migration beyond that comment.

If a non-empty `User` table ever exists in a deployed environment, this becomes three migrations instead: add nullable → backfill → set not-null.

### Indexes

| Index | Serves |
|---|---|
| `User.email @unique` | Login lookup; the `EMAIL_TAKEN` constraint (already exists from `init`) |
| `RefreshToken.tokenHash @unique` | Every `/refresh` and `/logout` lookup (PERF-2, PERF-5) |
| `RefreshToken.familyId` index | Family revocation on reuse detection and logout |
| `RefreshToken.userId` index | FK integrity and future per-user queries |

### Data migration requirements

**None.** There is no existing data to preserve or backfill — the sole `User` row source is an unused scaffold. Post-migration the table is empty and `npm run db:seed` populates it.

**Rollback:** `npx prisma migrate resolve --rolled-back add_auth` plus a manual drop of `RefreshToken`, `Role` and the new `User` columns. Since no data is preserved, re-running the migration and re-seeding is the faster recovery path.

---

## API Changes

All **NEW** — no existing endpoint changes shape, so nothing here is BREAKING.

| Endpoint | Method | Request | Response | Errors | Auth |
|---|---|---|---|---|---|
| `/api/auth/signup` | POST | `{ name, email, password, role }` | `201 { user }` | 400, 409, 500 | anonymous |
| `/api/auth/login` | POST | `{ email, password }` | `200 { user, accessToken, expiresIn }` + `Set-Cookie` | 400, 401, 500 | anonymous |
| `/api/auth/refresh` | POST | — (cookie) | `200 { accessToken, expiresIn }` + rotated `Set-Cookie` | 401, 500 | refresh cookie |
| `/api/auth/logout` | POST | — (cookie) | `204` + cleared cookie | — (never errors) | refresh cookie |
| `/api/auth/me` | GET | — | `200 { user }` | 401 | Bearer |
| `/api/users` | POST | `{ name, email, password }` | `201 { user }` | 400, 401, 403, 409, 500 | Bearer + RECRUITER |
| `/api/users` | GET | — | `200 { users: [] }` | 401, 403, 500 | Bearer + RECRUITER |

`GET /` is **MODIFIED** only in that it moves into `app.ts`; its `{ message }` response is unchanged, so the frontend's existing `ApiStatusCard` keeps working.

Full bodies and headers: [spec.md § API Contract](./spec.md#api-contract).

---

## Shared Types / Contracts

`backend/` and `frontend/` are **separate git repositories**. Nothing is shared by import — only by agreement, so each item below must be changed in both places or it breaks silently.

| Contract item | Owned by | Breaks on the frontend if changed |
|---|---|---|
| Safe user shape `{ id, name, email, role, createdAt }` | Backend | `User` type in `features/auth/types.ts`; every rendered field |
| `Role` values `INTERVIEWER` \| `RECRUITER` | Backend (Prisma enum) | Route matrix, landing-page redirect, `RequireRole` |
| Error shape `{ code, message, details? }` | Backend | `ApiError` reads `data.message`; all `code` branching |
| Error `code` strings | Backend | Every `switch` on `body.code` in error handling |
| `details` keyed by body field name | Backend | `setError` field mapping in forms |
| Cookie name `refresh_token` | Backend | `middleware.ts` cookie-presence check |
| Cookie `Path=/api/auth` | Backend | Whether the cookie is sent at all on refresh/logout |
| `Authorization: Bearer` scheme | Backend | `apiFetch` header construction |
| `expiresIn: 900` | Backend | Any client-side expiry assumption (currently none — the client is reactive) |
| `401` = recoverable, `403` = terminal | Backend | The refresh interceptor's entire branch logic |
| `GET /api/users` returns `{ users: [] }` not `404` | Backend | Empty-state rendering |

**Recommended practice:** when any row above changes, update both specs in the same PR pair and note the cross-repo dependency in both descriptions.

---

## Verification Commands

Run in order from `backend/`. Postgres must be running.

```bash
# 1. Dependencies
npm install
#    proves: all new packages resolve, including native bcrypt on this platform

# 2. Environment — copy and fill JWT_SECRET (min 32 chars)
cp .env.example .env

# 3. Migration
npx prisma migrate dev --name add_auth
#    proves: the schema applies; review the generated SQL for the TRUNCATE before confirming

# 4. Seed
npm run db:seed && npm run db:seed
#    proves: AC-B36 — idempotent, exits 0 twice, one row per account

# 5. Type check
npm run typecheck
#    proves: strict mode, exactOptionalPropertyTypes and req.user augmentation all hold

# 6. Lint + format
npm run lint && npm run format:check

# 7. Boot failure
JWT_SECRET= npm run dev
#    proves: AC-B33 — exits with a clear message, binds no port

# 8. Manual acceptance pass — server running via `npm run dev`
```

**This repo has no automated test suite.** Every acceptance criterion is signed off by hand in step 8, with `curl -i` against the running API and `psql $DATABASE_URL` wherever the proof is database state. § Acceptance Criteria Mapping is the script: work down it row by row.

Seeded accounts, password from `SEED_PASSWORD`:

| Account | Role |
|---|---|
| `recruiter@demo.test` | RECRUITER |
| `interviewer1@demo.test`, `interviewer2@demo.test` | INTERVIEWER |

The shape of the pass — capture a token once, reuse it:

```bash
# Log in and keep both credentials
curl -i -c cookies.txt -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"recruiter@demo.test","password":"Password123!"}'
#    proves: 200, Set-Cookie has HttpOnly + SameSite=Lax + Path=/api/auth,
#            body has accessToken and NO passwordHash

TOKEN=<accessToken from above>

curl -i -H "Authorization: Bearer $TOKEN" localhost:3000/api/auth/me
#    proves: AC-B12 — 200 with the right user and role

curl -i localhost:3000/api/auth/me
#    proves: AC-B13 — 401 UNAUTHENTICATED with no Authorization header

curl -i -X POST localhost:3000/api/users \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <interviewer token>" \
  -d '{"name":"X","email":"x@y.z","password":"password123"}'
#    proves: AC-B27 — 403 FORBIDDEN, not 401, and no row created
```

### Checks needing particular care

These are the criteria a careless `curl` will appear to pass while the guarantee is actually broken.

- **AC-B08 (no enumeration)** — save both responses to files (`curl -is … -o unknown.txt` and `-o wrongpw.txt`) and `diff` them. Status, body **and** headers must match. Eyeballing that both say `401` does not prove the requirement.
- **AC-B15 (expired token)** — mint a token with a negative TTL using the real `tokens.ts` (`npx tsx -e "…signAccessToken with expiresIn: '-1s'…"`) rather than waiting 15 minutes.
- **AC-B18 (reuse detection)** — three steps: refresh once to rotate, replay the original, then check that the **successor** is also dead *and* that every row in the family has `revokedAt` set (`psql`: `SELECT "revokedAt" FROM "RefreshToken" WHERE "familyId" = …`). Seeing only the `401` misses the point.
- **AC-B21 (concurrent refresh)** — fire both in one shell so they genuinely overlap, then read the database:
  ```bash
  curl -s -o a.txt -w '%{http_code}\n' -b cookies.txt -X POST localhost:3000/api/auth/refresh &
  curl -s -o b.txt -w '%{http_code}\n' -b cookies.txt -X POST localhost:3000/api/auth/refresh &
  wait
  psql "$DATABASE_URL" -c 'SELECT count(*) FROM "RefreshToken" WHERE "familyId" = '"'"'…'"'"' AND "revokedAt" IS NULL;'
  ```
  Expect one `200`, one `401`, and a count of **≤ 1**. Two sequential requests prove nothing. This is the pattern the later concurrent-feedback requirement will reuse.
- **AC-B32 (no `passwordHash` anywhere)** — pipe every response in the pass through one file (`curl -s … >> responses.log`), then `grep -c passwordHash responses.log` once at the end. Expect `0`. Checking endpoint by endpoint is how an endpoint added later slips through.
- **AC-B33 (boot failure)** — run `JWT_SECRET= npm run dev` in its own shell; confirm a non-zero exit and that nothing is listening (`curl localhost:3000` refuses).
- **AC-B36 (idempotent seed)** — run `npm run db:seed` twice, then `SELECT count(*) FROM "User";`.

### Frontend verification

None is forced by this plan. The frontend plan owns its own manual pass.

---

## Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-1 | **Destructive migration.** `role`/`passwordHash` are non-nullable additions; Prisma will drop existing `User` rows. | Data loss if the table is ever non-empty. | Confirm the table is scaffold-only before running. Comment the generated SQL. Flag it in the PR. Documented as MIG-1. |
| R-2 | **TypeScript is aliased to `@typescript/typescript6` (TS6 preview)** in `devDependencies`, with `@typescript/native` alongside. `@types/bcrypt` and `@types/jsonwebtoken` are written against TS5. | Type errors or resolution failures unrelated to the code. | Run `npm run typecheck` immediately after install, before writing code. If it breaks, pin to stable `typescript@5` for this feature and raise it separately — do not work around it with `any`. |
| R-3 | **ESM + `module: nodenext`.** Every relative import needs an explicit `.js` extension, including `./config/env.js`. | Confusing runtime `ERR_MODULE_NOT_FOUND` that type-checks cleanly. | Use `.js` extensions from the first file. `verbatimModuleSyntax` is on, so `import type` is required for type-only imports. |
| R-4 | **`bcrypt` is a native module** and must compile on the machine and in the eventual Docker image. | `npm install` or `docker compose up` fails on a machine without build tools. | If it fails, swap to `bcryptjs` (pure JS, same API, slower). Isolated in `lib/password.ts`, so it is a one-file change. |
| R-5 | **Strict tsconfig.** `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. | `req.user?`, env access and `details` records need careful typing. | Type `req.user` via declaration merging, not casts. Never loosen the tsconfig to make code compile. |
| R-6 | **The concurrency check (AC-B21) is easy to fake.** Two `curl`s run back to back do not overlap, and a check that only reads the two status codes proves nothing about the database. | A check that passes while the guarantee is broken. | Fire both in one shell with `&` and `wait` so they genuinely overlap, then **query the database**: unrevoked rows in the family must be ≤ 1. Status codes alone are not the proof. |
| R-7 | **Nothing here is automated.** With no test suite, a regression in rotation, reuse detection or the safe-`select` discipline is caught only by someone repeating the manual pass. | Silent breakage as later features build on `req.user` and the error contract. | Treat § Acceptance Criteria Mapping as a standing manual script and re-run it in full before any merge touching `src/modules/auth/` or `src/lib/`. Revisit a test runner once the auth surface stops changing. |
| R-8 | **Manual verification mutates the development database.** Several criteria need a deleted user, a revoked family, or an emptied table. | Losing the seeded state mid-pass, and checks that no longer start from a known baseline. | `npm run db:seed` is idempotent (AC-B36) — re-run it to restore the baseline between checks, and do destructive checks last. |
| R-9 | **Prisma 7 `prisma-client` generator**, not `prisma-client-js`. Output is `src/generated/prisma` and gitignored. | Imports from `@prisma/client` fail; CI without a `prisma generate` step fails. | Import from `../generated/prisma/client.js`. Add `prisma generate` to a `postinstall` script. |
| R-10 | **Cookie `Path=/api/auth`** means the cookie is not sent to other endpoints — correct, but easy to misread as a bug when debugging. | Time lost chasing a non-issue. | Comment it in `lib/cookies.ts` referencing BE-7.4. |
| R-11 | **Anonymous role-accepting signup** is a real privilege-escalation path. | Anyone reaching the API can mint a RECRUITER. | Accepted and documented (SEC-11). Not mitigated by this plan. If the POC is ever exposed beyond localhost, this must be closed first. |

---

## Implementation Order

Each step should leave the repo type-checking and the existing `GET /` working.

1. **Dependencies + tsconfig.** Install everything; set `types: ["node"]`; add scripts. Run `npm run typecheck` — this is where R-2 surfaces, and finding it now is much cheaper than later.
2. **`config/env.ts` + `.env.example`.** Verify the boot-failure behaviour by hand (AC-B33) before anything depends on it.
3. **Schema + migration.** Edit `schema.prisma`, run `prisma migrate dev --name add_auth`, review the SQL for the TRUNCATE, add the comment. `prisma generate` runs automatically.
4. **`lib/` primitives** — `prisma`, `logger`, `errors`, `password`, `tokens`, `cookies`. All pure or singleton; no HTTP yet.
5. **Middleware** — `requestId`, `errorHandler`, `notFound`, `validate`. Wire into `app.ts` and confirm by hand that `GET /` still returns `{ message }` and an unknown route returns the JSON 404 (AC-B35).
6. **`app.ts` / `server.ts` split.** Export `app`; `server.ts` only listens.
7. **Auth module — signup + login.** Schemas, service, controller, routes. Walk AC-B01–AC-B11 with `curl` as soon as the routes respond — this confirms the safe-`select` discipline early, while the surface is still small.
8. **`requireAuth` + `GET /me`.** Then AC-B12–AC-B16. Establishes `req.user` for everything downstream.
9. **Refresh + rotation + logout.** The hardest part: the transaction, family revocation, reuse detection. Then AC-B17–AC-B24, including the concurrency check (AC-B21) — see § Verification Commands for how to fire it properly.
10. **`requireRole` + users module.** Then AC-B25–AC-B31 — especially AC-B26 (`role` ignored) and AC-B27 (403 vs 401).
11. **Seed script.** Then AC-B36.
12. **Cross-cutting invariants.** AC-B32's response sweep and AC-B34.
13. **Full manual acceptance pass.** Every command in § Verification Commands, then every row of § Acceptance Criteria Mapping, against a freshly seeded database.

Every step is sequential — each depends on the one before.

---

## Acceptance Criteria Mapping

Every criterion in [spec.md](./spec.md#acceptance-criteria) appears below. Implementation entries use the paths from § Backend Changes.

The third column is the **manual check** — this repo has no automated tests. Run the whole pass against a freshly seeded database with the server up on `:3000`, using `curl -i` and `psql "$DATABASE_URL"`. § Verification Commands covers the seven checks that are easy to fake.

| Acceptance Criterion | Implementation | Manual Verification |
|---|---|---|
| AC-B01 — signup returns 201, safe user, no cookie | `auth.service.signup`, `auth.controller.signup`, `user.select.ts` | `POST /api/auth/signup` with a fresh email → `201`, body is the safe user, **no** `Set-Cookie`, no `passwordHash`, no token |
| AC-B02 — duplicate email → 409, one row | `auth.service.signup` P2002 catch, `lib/errors.ts` | Repeat the same signup → `409 EMAIL_TAKEN`; `psql`: `SELECT count(*) FROM "User" WHERE email = …` returns `1` |
| AC-B03 — short password → 400, no row | `auth.schema.signupSchema`, `middleware/validate.ts` | Signup with a 4-character password → `400`; no new row in `"User"` |
| AC-B04 — missing role → 400 | `auth.schema.signupSchema` (required, no default) | Signup with `role` omitted → `400 VALIDATION_ERROR` |
| AC-B05 — email normalised, case-insensitive login | `auth.schema` `.transform()`, `validate.ts` body replacement | Sign up `"  Ada@Example.COM "`, then log in as `ada@example.com` → `200`; the stored email is lowercased and trimmed |
| AC-B06 — login 200 + cookie attributes | `auth.service.login`, `lib/cookies.ts` | `curl -i .../login` → read the `Set-Cookie` line: `HttpOnly`, `SameSite=Lax`, `Path=/api/auth` all present |
| AC-B07 — wrong password → 401 | `auth.service.login`, `InvalidCredentialsError` | Correct email, wrong password → `401 INVALID_CREDENTIALS` |
| AC-B08 — unknown email response **deep-equals** AC-B07 | `auth.service.login` dummy-hash path, `lib/password.ts` | Save both responses with `curl -is -o` and `diff` them — status, body and headers identical (see § Verification Commands) |
| AC-B09 — no hash or token in login body | `user.select.ts` `SAFE_USER_SELECT` | `grep passwordHash` over the login response → no match |
| AC-B10 — token claims + 15 min expiry | `lib/tokens.signAccessToken` | Paste the `accessToken` into jwt.io (or `base64 -d` the payload) → `sub`, `role`, and `exp - iat == 900` |
| AC-B11 — second login doesn't kill the first session | `auth.service.login` (new `familyId` per login) | Log in twice, keeping both cookie jars → refresh with the **first** jar still returns `200` |
| AC-B12 — `/me` 200 with correct role | `middleware/requireAuth.ts`, `auth.controller.me` | `curl -H "Authorization: Bearer $TOKEN" .../me` → `200` with the right `role` |
| AC-B13 — no header → 401 | `requireAuth.ts` | `curl -i .../me` with no header → `401 UNAUTHENTICATED` |
| AC-B14 — malformed token → 401, no reason leaked | `requireAuth.ts`, `errorHandler.ts` | Flip a character in the token → `401`, never `500`, and the body says nothing about why verification failed |
| AC-B15 — expired token → 401 | `lib/tokens.verifyAccessToken` | Mint a token with `expiresIn: '-1s'` via `tsx` and use it → `401` (see § Verification Commands) |
| AC-B16 — deleted user → 401 | `requireAuth.ts` DB lookup | Log in, `DELETE FROM "User" WHERE id = …`, reuse the still-valid token → `401`, not a fabricated `200` |
| AC-B17 — refresh rotates both tokens | `auth.service.refresh` transaction | `curl -i -b cookies.txt -c cookies.txt .../refresh` → `200`, a new `accessToken`, and a `Set-Cookie` **different** from the one sent |
| AC-B18 — replay revokes the whole family | `auth.service.refresh` reuse branch | Rotate once, replay the original cookie → `401`; then confirm the successor is dead **and** every family row has `revokedAt` set in `psql` |
| AC-B19 — no cookie → 401 | `auth.controller.refresh` | `curl -i -X POST .../refresh` with no cookie jar → `401` |
| AC-B20 — expired refresh → 401 | `auth.service.refresh` expiry branch | `UPDATE "RefreshToken" SET "expiresAt" = now() - interval '1 day'` for the row, then refresh → `401`, no new token issued |
| AC-B21 — **concurrent** refresh: ≤ 1 succeeds | `prisma.$transaction` in `auth.service.refresh` | Fire both with `&` + `wait`, then count unrevoked family rows in `psql` → one `200`, one `401`, count ≤ 1 (see § Verification Commands) |
| AC-B22 — logout 204, cookie cleared, family revoked | `auth.service.logout`, `lib/cookies.clearRefreshCookie` | `curl -i -b cookies.txt .../logout` → `204`, `Set-Cookie` with `Max-Age=0`; every family row shows `revokedAt` |
| AC-B23 — logged-out cookie → 401 on refresh | `auth.service.refresh` | Reuse the pre-logout cookie jar against `/refresh` → `401` |
| AC-B24 — logout with no cookie → 204 | `auth.controller.logout` | `curl -i -X POST .../logout` with no cookie → `204`, not an error |
| AC-B25 — recruiter creates INTERVIEWER | `users.service.createInterviewer` | `POST /api/users` with the recruiter's token → `201`; the created row's `role` is `INTERVIEWER` |
| AC-B26 — `role` in body **ignored** | `users.schema` (no `role` key), literal role in service | Send `"role":"RECRUITER"` in the body → `201` and the row is still `INTERVIEWER` (EC-09) |
| AC-B27 — interviewer → 403, no row | `middleware/requireRole.ts` | `POST /api/users` with an interviewer's token → `403 FORBIDDEN`; `SELECT count(*)` unchanged |
| AC-B28 — no token → 401, not 403 | `requireAuth` before `requireRole` in `users.routes.ts` | `POST /api/users` with no header → `401`, never `403` |
| AC-B29 — `GET /users` as interviewer → 403 | `requireRole('RECRUITER')` | `GET /api/users` with an interviewer's token → `403` |
| AC-B30 — only interviewers, newest first | `users.service.listInterviewers` where + orderBy | `GET /api/users` as the recruiter → no `RECRUITER` in the list, `createdAt` descending |
| AC-B31 — empty list → `200 { users: [] }` | `users.controller` | Delete all interviewers, then `GET /api/users` → `200` with `{ "users": [] }`, not `404` |
| AC-B32 — `passwordHash` in **no** response | `user.select.ts` (explicit select everywhere) | Append every response in the pass to one log, then `grep -c passwordHash` → `0` (see § Verification Commands) |
| AC-B33 — missing `JWT_SECRET` → exit, no port | `config/env.ts` | `JWT_SECRET= npm run dev` → non-zero exit with a clear message; `curl localhost:3000` refuses the connection |
| AC-B34 — unexpected error → generic 500 | `middleware/errorHandler.ts` | Stop Postgres mid-request → `500 INTERNAL_ERROR` with a generic message, no stack trace, no Prisma code, no SQL |
| AC-B35 — unknown route → JSON 404 | `middleware/notFound.ts` | `curl -i localhost:3000/nope` → `404 NOT_FOUND` in the standard JSON error shape, not Express's HTML |
| AC-B36 — seed idempotent | `prisma/seed.ts` upserts | `npm run db:seed && npm run db:seed` → exit `0` both times; `SELECT count(*) FROM "User"` shows one row per seeded account |
