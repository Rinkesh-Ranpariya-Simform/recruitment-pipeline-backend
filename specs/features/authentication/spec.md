# Authentication — Login & User Provisioning (Backend)

> **Status:** Approved — ready for `plan.md`
> **Feature slug:** `authentication`
> **Scope:** `backend/` — Express 5 + Prisma 7 + PostgreSQL
> **Counterpart:** [../../../../frontend/specs/features/authentication/spec.md](../../../../frontend/specs/features/authentication/spec.md)
> **Parent brief:** [../../../../recruitment-pipeline.md](../../../../recruitment-pipeline.md)

---

## Goal

Give the API a trustworthy identity layer so that **every request carries a real, authenticated user and a server-verified role**, and no candidate data can ever be reached anonymously.

This backend must:

1. Authenticate a user by email + password and issue credentials.
2. Store credentials so that neither a database dump nor an XSS bug in the client yields a reusable secret.
3. Expose the authenticated user's identity and role.
4. Reject every unauthenticated request to a protected endpoint with `401`.
5. Reject every authenticated-but-unauthorized request with `403`.
6. Provision every account — both roles — from the API itself (curl/Postman/seed), with **no client-facing account-creation path**.
7. Never emit a password, password hash, or raw token in any response body or log line.

Success means: from the moment this ships, `req.user = { id, role }` is a guaranteed precondition for every subsequent pipeline endpoint, and the query-level authorization the POC's core hard case depends on (brief §3.2) has something real to parameterise on.

---

## Background / Context

The POC brief states in §6:

> Every action is tied to a real, authenticated user; there's no anonymous path through viewing or acting on a candidate.

and in §3.2:

> An interviewer can view and act on only the candidates and rounds they are assigned to — this is the core hard case of this POC. Requesting a candidate outside their assignment, directly by ID, must be refused at the point of the query.

Neither is expressible without identity. _"The candidates they are assigned to"_ is a `WHERE` clause parameterised by `req.user.id`; _"contact details are recruiter-only"_ (§3.6) is a branch on `req.user.role`. **This feature is therefore the blocking prerequisite for every other backend feature in the POC.**

### Current state of `backend/`

|                | Today                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack          | Express 5.2, TypeScript ESM (`"type": "module"`), Prisma 7.10, PostgreSQL, `tsx` for dev                                                                         |
| Source         | A single [`src/server.ts`](../../../src/server.ts) with one `GET /` route returning `{ message }`                                                                |
| Structure      | Flat — no `routes/`, `services/`, `middleware/`, `lib/` or `schemas/` directories                                                                                |
| Schema         | [`prisma/schema.prisma`](../../../prisma/schema.prisma) — placeholder `User { id, name, email, createdAt }`, one migration `20260914094336_init`                 |
| Validation     | **none** — `zod` is not a backend dependency                                                                                                                     |
| Error handling | **none** — no error middleware, no error shape                                                                                                                   |
| Logging        | `console.log` on server start                                                                                                                                    |
| Tests          | **none** — `"test": "echo \"Error: no test specified\" && exit 1"`, and none planned. Verification for this POC is manual; automated testing is a later decision |

This spec therefore introduces the first zod schemas, the first middleware chain, the first service layer, the first structured error contract, and the first migration beyond `init`.

### Scope decisions taken before writing this spec

Settled, not open:

- **Two roles only** — `INTERVIEWER` and `RECRUITER`. `HIRING_MANAGER` (the brief's optional stretch actor) is excluded from this POC entirely, including from the enum.
- **Every account of either role is provisioned from the backend** — the seed script, or a direct `POST /api/auth/signup` from curl/Postman. There is no in-product account creation, and no endpoint exists whose purpose is to let one user create another.
- **Split-token model** — a short-lived access token the client holds only in memory, and a long-lived opaque refresh token in an `HttpOnly` cookie with server-side revocation.
- **No signup UI exists**, so `POST /api/auth/signup` issues no session — it creates a record only.
- **`GET /api/users` is retained but has no client.** It stays `RECRUITER`-gated and exists so an operator can list interviewers over HTTP; the frontend never calls it.

---

## Users / Actors

| Actor                           | Authenticated?             | Can do against this API                                                                                                                                       |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anonymous caller**            | No                         | `POST /api/auth/login` and `POST /api/auth/signup` only. Every other endpoint returns `401`.                                                                  |
| **Interviewer** (`INTERVIEWER`) | Yes                        | Log in, refresh, read own identity via `/api/auth/me`, log out. **Cannot** list users — `403`. Cannot create a user by any route.                             |
| **Recruiter** (`RECRUITER`)     | Yes                        | Everything an interviewer can do, plus list existing interviewers via `GET /api/users`. **Creates no accounts** — provisioning is not a recruiter capability. |
| **Operator / developer**        | N/A (shell or HTTP client) | **The only account-creating actor.** Provisions every user of either role via `npm run db:seed` or `POST /api/auth/signup` from curl/Postman.                 |

**Deliberate POC trade-off, stated explicitly:** `POST /api/auth/signup` is anonymous, accepts a `role`, and is the **only** way to create an account over HTTP. Anyone who can reach the API can therefore create a `RECRUITER` and see candidate contact details. This is acceptable **only** because the POC runs locally and the endpoint exists solely as an operator tool. It is called out here so it is not mistaken for an oversight, and tracked as **SEC-11.1** — the single item that must be closed before this API is reachable from anywhere but localhost.

---

## User Stories

**US-01** — As a **recruiter**, I want to authenticate with email and password so that the pipeline data I receive is scoped to a real account rather than a role I asserted in a request.

**US-02** — As an **interviewer**, I want the API to know who I am on every request so that it can refuse candidates I'm not assigned to at the query.

**US-03** — As **any user**, I want my session to survive a quiet hour of work without re-sending my password.

**US-04** — As **any user**, I want logout to actually revoke my session server-side, not merely clear a client cookie.

**US-05** — As an **operator**, I want a single API call that creates an account of either role so that I can provision the whole panel from Postman without touching the database by hand.

**US-06** — As a **recruiter**, I want to list existing interviewers over the API so that I can confirm who has an account before asking an operator to provision another.

**US-07** — As a **security reviewer**, I want a stolen refresh token to be detectable, so the POC has a defensible answer to "what happens if a token leaks?"

**US-08** — As a **developer**, I want a seeded set of known accounts per role so that a fresh database plus one command gives me a demoable system.

---

## Functional Requirements

### FR-1 — User records

- **FR-1.1** A user is `{ id, name, email, passwordHash, role, createdAt, updatedAt }`.
- **FR-1.2** `email` is globally unique, case-insensitively. It is **normalised to lowercase and trimmed before persistence and before every lookup**. Uniqueness is enforced by a database constraint, not an application-level read-then-write check.
- **FR-1.3** `role` is one of `INTERVIEWER` | `RECRUITER`, stored as a Postgres enum — never a free-text column.
- **FR-1.4** A plaintext password is **never** persisted. Only a bcrypt hash (cost 12) is stored.

### FR-2 — Account creation (the only path)

- **FR-2.1** `POST /api/auth/signup` accepts `{ name, email, password, role }`, is anonymous, and creates a user. It is the **sole** account-creation endpoint for both roles.
- **FR-2.2** It **creates only** — it issues no access token and sets no cookie. The created user logs in normally afterwards.
- **FR-2.3** A duplicate email returns `409 EMAIL_TAKEN`.
- **FR-2.4** It returns the **safe user representation** (FR-6) with `201`.
- **FR-2.5** **No frontend page calls this endpoint, and none ever will** — it exists for curl/Postman/seed use only. The frontend has no account-creation surface of any kind (XFE-6).
- **FR-2.6** **There is no authenticated user-creation endpoint.** No role, recruiter included, can create another user through the API. An account exists because an operator called this endpoint or ran the seed.

### FR-3 — User listing

- **FR-3.1** `GET /api/users` requires an authenticated user whose role is `RECRUITER`.
- **FR-3.2** It returns all users with role `INTERVIEWER`, ordered by `createdAt` descending, each as a safe user representation (FR-6).
- **FR-3.3** A non-recruiter receives `403 FORBIDDEN`; an unauthenticated caller receives `401 UNAUTHENTICATED`.
- **FR-3.4** An empty result is `200 { "users": [] }` — never `404`.
- **FR-3.5** **This endpoint has no frontend caller.** It is retained as an operator/verification tool and as the one place `requireRole` is exercised in this feature. Adding a UI for it is a later, separate decision.

### FR-4 — Login

- **FR-4.1** `POST /api/auth/login` accepts `{ email, password }`.
- **FR-4.2** Flow: validate input → normalise email → find user by email → verify password against the stored hash → create a refresh-token family → issue an access token → return user + access token and set the refresh cookie.
- **FR-4.3** On success: `200` with `{ user, accessToken, expiresIn }` plus a `Set-Cookie` carrying the refresh token.
- **FR-4.4** Unknown email and wrong password produce a **byte-identical** `401 INVALID_CREDENTIALS` response (see SEC-2).
- **FR-4.5** A successful login always starts a **new** refresh-token family and does **not** revoke families created on other devices — a user may hold several concurrent sessions.

### FR-5 — Session lifecycle

- **FR-5.1** The **access token** is a signed JWT with a **15-minute** lifetime, returned in the login/refresh response body. The server never sets it as a cookie.
- **FR-5.2** It is presented on protected requests as `Authorization: Bearer <token>`.
- **FR-5.3** The **refresh token** is a cryptographically random opaque string with a **1-day** lifetime, delivered as an `HttpOnly; SameSite; Secure-in-prod` cookie. It never appears in a response body.
- **FR-5.4** The server stores **only the SHA-256 hash** of the refresh token. The raw value exists in the cookie and nowhere else.
- **FR-5.5** `POST /api/auth/refresh` reads the cookie, validates the token, **rotates** it (issues a new one, revokes the presented one), and returns a fresh access token.
- **FR-5.6** **Reuse detection:** if an already-revoked refresh token is presented, the server revokes **every token in that family** and responds `401`. This is the stolen-token tripwire.
- **FR-5.7** `POST /api/auth/logout` revokes the presented token's **entire family** and clears the cookie. It responds `204` even when no valid cookie was presented (idempotent).
- **FR-5.8** **Expired refresh tokens are deleted, not kept forever (added during review).** Rotation only ever wrote rows and revoked them, so an active session grew the table by roughly one row per access-token lifetime — about 96 a day — with nothing removing any of it. `login` now deletes that user's rows whose `expiresAt` has passed.
  - **Only expired rows.** A revoked but still-unexpired row is what a replayed token is matched against; removing those would turn a detected theft into an ordinary `unknown` 401 and leave the stolen family alive (FR-5.6).
  - Knowingly given up: a token replayed _after its own expiry_ no longer revokes its family. It is refused on its expiry regardless, so only the detection of an already-futile replay is lost.
  - Placed at login, not refresh — login already pays ~200 ms of bcrypt, and `refresh` answers to a 50 ms budget (PERF-2). A failure is logged and swallowed: housekeeping never costs a user their login.
- **FR-5.8** There is **no sliding access-token window and no server-driven refresh scheduling.** Refresh is client-initiated and reactive.

### FR-6 — Safe user representation

- **FR-6.1** Exactly one shape is returned wherever a user appears in a response:

  ```jsonc
  {
    "id": 1,
    "name": "Jane Doe",
    "email": "jane@example.com",
    "role": "INTERVIEWER",
    "createdAt": "2026-09-14T10:00:00.000Z",
  }
  ```

- **FR-6.2** `passwordHash` **must never appear in any response body, at any layer, under any code path.**
- **FR-6.3** This is enforced by an **explicit Prisma `select`** listing the safe columns — _not_ by fetching the full row and deleting keys afterwards. This mirrors the contact-details rule in [../../../CLAUDE.md](../../../CLAUDE.md): a query that never selects a column cannot leak it, and the same discipline that will protect candidate email/phone is established here first.
- **FR-6.4** Refresh tokens, token hashes, and the JWT secret are likewise never serialised into a response.

### FR-7 — Request authentication & authorization

- **FR-7.1** A `requireAuth` middleware verifies the Bearer JWT, resolves `{ id, role }`, and attaches it to the request. Missing, malformed, or expired → `401 UNAUTHENTICATED`.
- **FR-7.2** A `requireRole(...roles)` middleware runs **after** `requireAuth` and produces `403 FORBIDDEN` on mismatch.
- **FR-7.3** Every endpoint added by future features is authenticated by default. Adding an anonymous endpoint is a deliberate, spec-level decision — there are exactly three today (`signup`, `login`, `refresh`).
- **FR-7.4** **Authorization is enforced here, on every request.** The client's route guards are a UX affordance and are never the control.

### FR-8 — Seed data

- **FR-8.1** `prisma/seed.ts`, run via `npm run db:seed`, creates a known demo account per role, idempotently (`upsert` by email, safe to re-run).
- **FR-8.2** Seeded accounts: `recruiter@demo.test` (RECRUITER), `interviewer1@demo.test`, `interviewer2@demo.test` (INTERVIEWER), all with a documented password sourced from `SEED_PASSWORD`.
- **FR-8.3** Seed credentials are documented in `.env.example` and are POC-only.

---

## Frontend Requirements

Full frontend behaviour is specified in [../../../../frontend/specs/features/authentication/spec.md](../../../../frontend/specs/features/authentication/spec.md). Only the obligations this backend **depends on or must accommodate** are recorded here:

- **XFE-1** The client holds the access token **in memory only** and sends it as `Authorization: Bearer`. The backend therefore must **not** rely on a cookie for access-token transport, and must not assume the client can recover a token after a page reload — that is what `POST /api/auth/refresh` is for.
- **XFE-2** The client sends credentialed cross-origin requests (`credentials: 'include'`), so CORS must be configured with an explicit origin and `credentials: true` (BE-7).
- **XFE-3** The client treats any `401` as "refresh once, then replay once". The backend must therefore make `401` genuinely recoverable via `/refresh` and must not return `401` for authorization failures — those are `403` (AZ-2).
- **XFE-4** The client maps `details` from a `400 VALIDATION_ERROR` onto individual form fields, so `details` must be keyed by **request-body field name** (VAL-5). **The login form is the only form in the client**, so in practice this applies to `POST /api/auth/login` alone — but the rule is a contract-wide guarantee, not a login-specific one.
- **XFE-5** The client renders `message` verbatim to end users, so every `message` must be user-safe copy (ERR-1).
- **XFE-6** **The client has no account-creation surface at all** — no signup page, no password reset, no interviewer-provisioning page. It calls exactly four endpoints: `login`, `refresh`, `me`, `logout`. `POST /api/auth/signup` and `GET /api/users` have **no client caller** and must not be shaped around one.
- **XFE-7** The client's route guard reads only the **presence** of the refresh cookie. The cookie name is therefore part of the contract: `refresh_token`.
- **XFE-8** The client renders a 403 view when any call returns `403 FORBIDDEN`, even on a route it believed was permitted. `403` must therefore stay distinct from `401` (AZ-2) even though no endpoint the client calls is role-gated today.

---

## Backend Requirements

### BE-1 — Structure

`server.ts` currently holds everything. This feature introduces the layering [../../../CLAUDE.md](../../../CLAUDE.md) calls for:

```
backend/src/
├── server.ts                  # app wiring only
├── config/env.ts              # validated env (fails fast)
├── lib/{prisma,logger,errors}.ts
├── middleware/{requireAuth,requireRole,validate,errorHandler,requestId}.ts
├── modules/
│   ├── auth/{auth.routes,auth.controller,auth.service,auth.schema}.ts
│   └── users/{users.routes,users.controller,users.service}.ts   # read-only: no schema, no body to validate
└── prisma/seed.ts
```

**Route handlers contain no business logic** — they validate, delegate to a service, and shape a response. Services own hashing, token issuance, rotation and Prisma access.

### BE-2 — Validation boundary

- **BE-2.1** `zod` is added as a backend dependency (it does not exist there today) so backend and frontend validate against mirrored rules.
- **BE-2.2** A `validate(schema)` middleware parses the body **before the controller runs**. Invalid input never reaches business logic — an explicit check in brief §6.
- **BE-2.3** Schemas strip unknown keys, so an unexpected field is dropped rather than passed into a Prisma `data` object. `signupSchema` is the only schema that accepts a `role`, and it accepts it deliberately (FR-2.1).

### BE-3 — Password handling

- **BE-3.1** `bcrypt`, cost factor 12.
- **BE-3.2** Hashing happens in the service layer; the plaintext never leaves request scope, is never logged, and is never assigned to a Prisma field except through `hash()`.
- **BE-3.3** On login with an **unknown** email, the server still performs a bcrypt comparison against a **constant dummy hash** before returning, so response timing does not distinguish "no such user" from "wrong password".

### BE-4 — Token issuance

- **BE-4.1** Access token: `jsonwebtoken.sign({ sub, role }, JWT_SECRET, { expiresIn: '15m' })`. Claims carry `sub` (user id) and `role` and nothing sensitive.
- **BE-4.2** Refresh token: `crypto.randomBytes(32).toString('base64url')`. The row stores `sha256(raw)`.
- **BE-4.3** `requireAuth` trusts the JWT's `role` claim for the token's 15-minute lifetime. A role change therefore takes up to 15 minutes to propagate — harmless because no role-change endpoint exists in this POC (see Out of Scope).

### BE-5 — Refresh rotation

On `POST /api/auth/refresh`, inside a **single transaction**:

1. Hash the presented raw token; look the row up by `tokenHash`.
2. Not found → `401`.
3. Found **but `revokedAt` is set** → revoke **every row sharing its `familyId`**, log `auth.refresh.reuse_detected` at `error`, return `401`.
4. Found but `expiresAt` is past → `401`.
5. Otherwise → mark the presented row revoked, insert a new row with the **same `familyId`**, return a new access token and set the new refresh cookie.

The transaction means two concurrent refreshes presenting the same token cannot both succeed.

### BE-6 — Error contract & handler

A single Express error middleware converts every thrown `AppError` into the flat shape in [Error Handling](#error-handling). It **never** emits a stack trace, a Prisma error code, a SQL fragment, or an internal message to the client. Unrecognised errors are logged at `error` with full detail and returned as a generic `500 INTERNAL_ERROR`.

### BE-7 — CORS & cookies

- **BE-7.1** `cors({ origin: FRONTEND_ORIGIN, credentials: true, maxAge: 600 })` — an explicit origin, never `*` (which is incompatible with credentialed requests anyway). `maxAge` was **added during review**: every call this API serves carries `Authorization` or `Content-Type: application/json`, neither CORS-safelisted, so each is preceded by an `OPTIONS`. With no `maxAge` the browser's own default applies — 5 seconds in Chrome — so in practice every request paid two round trips. It caches the preflight for 10 minutes and widens nothing.
- **BE-7.2** `cookie-parser` is added to read the refresh cookie.
- **BE-7.3** Cookie attributes: name `refresh_token`, `HttpOnly`, `SameSite=Lax`, `Path=/api/auth`, `Max-Age=86400`, and `Secure` whenever `NODE_ENV === 'production'`.
- **BE-7.4** `Path=/api/auth` scopes the cookie so it is not attached to ordinary API calls — only to `refresh` and `logout`.
- **BE-7.5** **Deployment note:** `localhost:3000` and `localhost:3001` are the same site, so `SameSite=Lax` works in local development. If backend and frontend are ever served from different registrable domains, the cookie must become `SameSite=None; Secure` — and the CSRF posture in SEC-6 must be revisited at the same time.

### BE-8 — Environment configuration

`config/env.ts` validates all env vars with zod **at boot** and throws if any are missing or malformed. **A missing or short `JWT_SECRET` must prevent the server from starting** — it must never fall back to a default.

### BE-9 — Logging

`pino` replaces `console.log`. A `requestId` middleware assigns a per-request id, included on every log line. Auth events emitted:

| Event                         | Level     | Fields                                                                                                                          |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `auth.login.success`          | info      | `userId`, `role`, `requestId`                                                                                                   |
| `auth.login.failure`          | warn      | `email`, `reason: 'invalid_credentials'`, `requestId`                                                                           |
| `auth.refresh.rotated`        | info      | `userId`, `familyId`, `requestId`                                                                                               |
| `auth.refresh.reuse_detected` | **error** | `userId`, `familyId`, `action: 'family_revoked'`                                                                                |
| `auth.logout`                 | info      | `userId`, `familyId`                                                                                                            |
| `user.created`                | info      | `createdUserId`, `role`, `source: 'signup' \| 'seed'` — **there is no actor**, because no authenticated user can create another |
| `authz.denied`                | warn      | `userId`, `role`, `method`, `path`                                                                                              |

**Never logged, at any level:** plaintext passwords, bcrypt hashes, raw or hashed refresh tokens, access tokens, `Cookie` / `Set-Cookie` / `Authorization` header values, `JWT_SECRET`.

---

## API Contract

All endpoints are JSON and prefixed `/api`. Every error response uses the shape in [Error Handling](#error-handling).

### `POST /api/auth/signup` — anonymous · operator only · **the only way to create an account**

```jsonc
// Request
{
  "name": "Ada Recruiter",
  "email": "ada@example.com",
  "password": "correct horse",
  "role": "RECRUITER",
}
```

```jsonc
// 201 Created — no Set-Cookie, no token
{
  "user": {
    "id": 1,
    "name": "Ada Recruiter",
    "email": "ada@example.com",
    "role": "RECRUITER",
    "createdAt": "2026-09-14T10:00:00.000Z",
  },
}
```

Errors: `400 VALIDATION_ERROR` · `409 EMAIL_TAKEN` · `500 INTERNAL_ERROR`

### `POST /api/auth/login` — anonymous

```jsonc
// Request
{ "email": "ada@example.com", "password": "correct horse" }
```

```jsonc
// 200 OK
{
  "user": {
    "id": 1,
    "name": "Ada Recruiter",
    "email": "ada@example.com",
    "role": "RECRUITER",
    "createdAt": "2026-09-14T10:00:00.000Z",
  },
  "accessToken": "<jwt>",
  "expiresIn": 900,
}
```

```http
Set-Cookie: refresh_token=<opaque>; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=86400
```

Errors: `400 VALIDATION_ERROR` · `401 INVALID_CREDENTIALS` · `500 INTERNAL_ERROR`

### `POST /api/auth/refresh` — refresh cookie

No request body. Requires the `refresh_token` cookie.

```jsonc
// 200 OK
{ "accessToken": "<new jwt>", "expiresIn": 900 }
```

```http
Set-Cookie: refresh_token=<new opaque>; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=86400
```

Errors: `401 UNAUTHENTICATED` (missing / unknown / expired / revoked-and-reused) · `500 INTERNAL_ERROR`

### `POST /api/auth/logout` — refresh cookie

No request body. `204 No Content` with `Set-Cookie: refresh_token=; Max-Age=0; Path=/api/auth`.

Returns `204` **even when no cookie was sent or the token was already invalid** — idempotent, never `401`.

### `GET /api/auth/me` — Bearer

```jsonc
// 200 OK
{
  "user": {
    "id": 1,
    "name": "Ada Recruiter",
    "email": "ada@example.com",
    "role": "RECRUITER",
    "createdAt": "2026-09-14T10:00:00.000Z",
  },
}
```

Errors: `401 UNAUTHENTICATED` (missing / malformed / expired token, or the user no longer exists)

### `GET /api/users` — Bearer · `RECRUITER` · no frontend caller

```jsonc
// 200 OK — interviewers only, newest first
{
  "users": [
    {
      "id": 7,
      "name": "Ivan Interviewer",
      "email": "ivan@example.com",
      "role": "INTERVIEWER",
      "createdAt": "2026-09-14T11:00:00.000Z",
    },
  ],
}
```

An empty result is `{ "users": [] }` with `200` — never `404`.

Errors: `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `500 INTERNAL_ERROR`

### Removed endpoint

**`POST /api/users` no longer exists.** A request to it returns `404 NOT_FOUND` in the standard error shape, like any other unknown route (EC-16). It is not a `405`, and it is not a stub — the route is simply not registered. Account creation is `POST /api/auth/signup` only (FR-2.1, FR-2.6).

### Contract invariants

1. `passwordHash` appears in **zero** response bodies.
2. Raw or hashed refresh tokens appear in **zero** response bodies — the refresh token exists only in the `Set-Cookie` header.
3. The user object shape is identical across all **four** endpoints that return one (`signup`, `login`, `me`, `users`).
4. Every non-2xx response body matches `{ code, message, details? }`.
5. **Exactly one endpoint writes a `User` row**: `POST /api/auth/signup`. Nothing else in the API creates, edits, or deletes a user.

---

## Data Model Changes

Additive migration on top of `20260914094336_init`. The existing `User` table is altered, not recreated; `id` remains `Int @default(autoincrement())`.

```prisma
enum Role {
  INTERVIEWER
  RECRUITER
}

model User {
  id           Int      @id @default(autoincrement())
  name         String
  email        String   @unique          // stored lowercased + trimmed
  passwordHash String                    // bcrypt, cost 12 — never selected into a response
  role         Role
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  refreshTokens RefreshToken[]
}

model RefreshToken {
  id        String    @id @default(uuid())
  userId    Int
  tokenHash String    @unique            // sha256 of the raw token; the raw value is never stored
  familyId  String                       // rotation lineage — one family per login
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([familyId])
}
```

### Migration notes

- **MIG-1** `passwordHash` and `role` are non-nullable additions to a table that may already contain rows. Because the only existing row source is a placeholder scaffold with no real data, the migration may `TRUNCATE "User"` — but the generated SQL must say so in a comment and the operator must be warned in the PR description. If a non-empty deployed `User` table ever exists, this becomes a three-step migration (add nullable → backfill → set not-null).
- **MIG-2** `role` has **no default**. Every creation path sets it explicitly, so an accidental default can never silently mint a privileged account.
- **MIG-3** `email` already carries `@unique` from `init`; no schema change is needed, but the application must lowercase before writing for the constraint to be a genuine case-insensitive guard.
- **MIG-4** `tokenHash @unique` is both a correctness constraint and the lookup index for `/refresh`.
- **MIG-5** `onDelete: Cascade` means deleting a user removes their tokens. No user-deletion endpoint exists here; this is a safety property for future work.
- **MIG-6** Expired `RefreshToken` rows are not garbage-collected in this POC. Growth is bounded by logins × rotations and is acceptable at POC scale; cleanup is Out of Scope.

---

## Authentication / Authorization

### Credentials

| Credential    | Form                              | Lifetime | Server-side storage            | Transport                           |
| ------------- | --------------------------------- | -------- | ------------------------------ | ----------------------------------- |
| Access token  | Signed JWT (`sub`, `role`, `exp`) | 15 min   | none (stateless)               | `Authorization: Bearer`             |
| Refresh token | Opaque random 32 bytes            | 1 day    | SHA-256 hash in `RefreshToken` | `HttpOnly` cookie, `Path=/api/auth` |

**Rationale, for the walkthrough:** the access token is attached to most requests, so it is the credential most exposed to client-side compromise — keeping it short-lived and stateless limits the blast radius. The refresh token is long-lived, so it is kept where script cannot reach it (`HttpOnly`) and where the server _can_ revoke it (a database row). Neither credential is ever persisted in browser storage.

### Authorization matrix

| Endpoint                 | Anonymous              | INTERVIEWER  | RECRUITER    |
| ------------------------ | ---------------------- | ------------ | ------------ |
| `POST /api/auth/signup`  | ✅                     | ✅           | ✅           |
| `POST /api/auth/login`   | ✅                     | ✅           | ✅           |
| `POST /api/auth/refresh` | cookie-gated           | cookie-gated | cookie-gated |
| `POST /api/auth/logout`  | ✅ (204)               | ✅           | ✅           |
| `GET /api/auth/me`       | ❌ 401                 | ✅           | ✅           |
| `GET /api/users`         | ❌ 401                 | ❌ **403**   | ✅           |
| `POST /api/users`        | ❌ 404 — route removed | ❌ 404       | ❌ 404       |

### Non-negotiable rules

- **AZ-1** Every endpoint enforces its own rule independently of any client-side guard. AC-B27 proves it by calling `GET /api/users` directly with an interviewer's token — the client never calls that endpoint at all, so the server is provably the only thing enforcing it.
- **AZ-2** `401` means _"we don't know who you are"_; `403` means _"we know, and you may not"_. They are never interchanged.
- **AZ-3** A role is read from the verified JWT claim. It is never read from a request body, query parameter, or client-supplied header.
- **AZ-4** This feature establishes `req.user` only. The query-level scoping the brief demands (interviewer → only assigned candidates) is built on top of it by later features.

---

## Validation

These rules are authoritative; the frontend mirrors them for responsiveness only.

| Field                | Rule                                                    |
| -------------------- | ------------------------------------------------------- |
| `name`               | required, trimmed, 1–100 chars                          |
| `email`              | required, trimmed, lowercased, valid email, ≤ 254 chars |
| `password`           | required, ≥ 8 chars, ≤ 72 **bytes**                     |
| `role` (signup only) | required, `INTERVIEWER` \| `RECRUITER`                  |

- **VAL-1** The 72-byte password ceiling is bcrypt's silent truncation point. It is enforced, not ignored — otherwise two different long passwords could authenticate the same account.
- **VAL-2** No composition requirements (uppercase/digit/symbol) — length only, deliberately, to keep the POC demoable.
- **VAL-3** Email normalisation (`trim().toLowerCase()`) happens inside the zod schema via `.transform()`, so every downstream consumer receives the normalised value and no code path can forget to normalise.
- **VAL-4** There are exactly **two** body schemas in this feature — `signupSchema` and `loginSchema`. `GET /api/users` takes no body and therefore no `validate()` in its chain. Any later endpoint that writes a user must add its own schema; none exists today.
- **VAL-5** Validation failures return **all** field errors at once, keyed by request-body field name, so the client can display every problem in one pass.
- **VAL-6** `POST /api/auth/login` validates **shape only** (`email` looks like an email, `password` is a non-empty string). It does **not** apply the 8-character minimum — doing so would reveal that no account can have a short password, and would return `400` where `401` belongs.

---

## Error Handling

### Response shape

```jsonc
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid request body",
  "details": { "email": ["Enter a valid email address"] },
}
```

Flat, with `message` at the top level — chosen so the frontend's existing `apiFetch` error path (which reads `data.message`) works unchanged. `details` is present only on `VALIDATION_ERROR`.

### Code catalogue

| HTTP | `code`                | `message`                                   | Raised when                                                                                           |
| ---- | --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`    | "Invalid request body"                      | zod rejects the payload                                                                               |
| 401  | `INVALID_CREDENTIALS` | "Invalid email or password"                 | Login: unknown email **or** wrong password                                                            |
| 401  | `UNAUTHENTICATED`     | "Authentication required"                   | Missing/malformed/expired access token; invalid/expired/reused refresh token                          |
| 403  | `FORBIDDEN`           | "You do not have access to this resource"   | Authenticated, wrong role — `GET /api/users` as an interviewer is the only case today                 |
| 404  | `NOT_FOUND`           | "Resource not found"                        | Unknown route — **including `POST /api/users`**, which no longer exists                               |
| 409  | `EMAIL_TAKEN`         | "An account with this email already exists" | Unique constraint violation on `User.email` — reachable only via `POST /api/auth/signup` and the seed |
| 500  | `INTERNAL_ERROR`      | "Something went wrong"                      | Anything unhandled                                                                                    |

### Rules

- **ERR-1** `message` is user-safe copy the client may render verbatim. It never contains an internal identifier, a table name, or an exception message.
- **ERR-2** Prisma errors are caught in the service layer and translated (`P2002` on `email` → `EMAIL_TAKEN`). A raw Prisma error object never reaches the error middleware's output.
- **ERR-3** Stack traces are logged server-side at `error` and never serialised into a response, in any environment.
- **ERR-4** `EMAIL_TAKEN` is derived from the **database constraint violation**, not from a preceding `findUnique` — check-then-insert loses under a race.
- **ERR-5** `code` is the stable machine-readable contract; `message` copy may change without being a breaking change.

---

## Edge Cases

| #     | Case                                                                                    | Required behaviour                                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EC-01 | Access token presented after expiry                                                     | `401 UNAUTHENTICATED`. Recoverable via `/refresh`.                                                                                                                                         |
| EC-02 | Refresh token expired (> 1 day)                                                         | `401`; no new token issued; the row is left revoked/expired.                                                                                                                               |
| EC-03 | Revoked refresh token replayed                                                          | Entire family revoked, `auth.refresh.reuse_detected` logged at `error`, `401` returned.                                                                                                    |
| EC-04 | Two concurrent `/refresh` calls with the same token                                     | The transaction (BE-5) serialises them: one rotates, the other presents a now-revoked token and trips EC-03. **Accepted and documented** — correctness (reuse detection) over convenience. |
| EC-05 | Logout with no or invalid cookie                                                        | `204`. Never an error.                                                                                                                                                                     |
| EC-06 | Two identical signups race                                                              | One succeeds; the other hits the unique constraint → `409` (ERR-4). Never two rows, never a `500`.                                                                                         |
| EC-07 | `"  Ada@Example.COM "` vs `"ada@example.com"`                                           | Same account. Normalisation in the schema (VAL-3) means login and creation agree.                                                                                                          |
| EC-08 | 100-character password                                                                  | `400` with an explicit message — not silently truncated to 72 bytes by bcrypt (VAL-1).                                                                                                     |
| EC-09 | Any caller `POST`s to `/api/users`                                                      | `404 NOT_FOUND` in the standard error shape. The route is not registered at all, so there is no privilege check to get wrong. **Must be checked explicitly (AC-B26).**                     |
| EC-10 | `JWT_SECRET` missing or shorter than 32 chars at boot                                   | Process **exits with a clear message** and binds no port. Never a default or generated secret.                                                                                             |
| EC-11 | Valid JWT whose user row was deleted                                                    | `requireAuth` resolves the user, finds none, returns `401`. A token is never trusted to imply existence.                                                                                   |
| EC-12 | Clock skew between issuer and verifier                                                  | `jsonwebtoken` verification allows `clockTolerance: 30` seconds. Beyond that it is a normal `401`.                                                                                         |
| EC-13 | Signup body omits `role`                                                                | `400 VALIDATION_ERROR`. There is no default role (MIG-2).                                                                                                                                  |
| EC-14 | Operator signs up an `INTERVIEWER` using an email that already belongs to a `RECRUITER` | `409 EMAIL_TAKEN`. Emails are globally unique **across** roles, not per role — one person cannot hold two accounts.                                                                        |
| EC-15 | `Authorization` header present but not `Bearer <token>`                                 | `401`, never `500`, and the response never explains why parsing failed.                                                                                                                    |
| EC-16 | Request to an unknown route                                                             | `404 NOT_FOUND` in the standard error shape — not Express's default HTML page.                                                                                                             |

---

## Security Requirements

- **SEC-1 — No credential is ever returned or logged.** `passwordHash` is excluded at the `select`, not stripped afterwards (FR-6.3). Raw tokens exist only in `Set-Cookie`. The never-log list in BE-9 is binding.
- **SEC-2 — No account enumeration.** Unknown email and wrong password return byte-identical `401 INVALID_CREDENTIALS` bodies with identical headers. **Both responses must be captured and compared in full — status, body and headers — not merely confirmed to be `401`.**
- **SEC-3 — Timing equalisation.** A bcrypt comparison against a constant dummy hash runs on the unknown-email path (BE-3.3).
- **SEC-4 — Credential storage limits blast radius.** The access token is stateless and short-lived; the refresh token is `HttpOnly` and script-unreadable. The API never instructs the client to persist a credential.
- **SEC-5 — Refresh-token theft is detectable.** Rotation plus family revocation (FR-5.6) means a stolen token's use invalidates the legitimate session, making theft visible rather than silent.
- **SEC-6 — CSRF posture.** The only cookie-authenticated endpoints are `/api/auth/refresh` and `/api/auth/logout`. Both are `POST`; `SameSite=Lax` blocks cross-site `POST` cookie attachment; and `Path=/api/auth` keeps the cookie off ordinary API calls. All other state-changing endpoints authenticate by `Authorization` header, which a cross-site form cannot set. **If the cookie ever becomes `SameSite=None`, a CSRF token or origin check becomes mandatory** — recorded here so the change cannot be made casually.
- **SEC-7 — Strict CORS.** Explicit `origin`, `credentials: true`, never a wildcard.
- **SEC-8 — Secrets from the environment only.** `JWT_SECRET` is validated at boot with a minimum length and has no fallback (EC-10). `.env` is gitignored; `.env.example` carries placeholders only.
- **SEC-9 — Hashing.** bcrypt cost 12, per-password salt (bcrypt's default), verified with `bcrypt.compare` and never a string equality check.
- **SEC-10 — No authenticated write path to `User`.** No endpoint lets one authenticated user create, modify, or delete another. The attack surface for privilege escalation _through an authenticated session_ is therefore empty: there is no body to tamper with, because there is no such request. Note what this does **not** cover — the anonymous creation path, which is SEC-11.1 below.
- **SEC-11 — Known accepted gaps** (stated so a reviewer need not find them):
  - **SEC-11.1 — The sole account-creation endpoint is anonymous and role-accepting.** `POST /api/auth/signup` takes a `role` from an unauthenticated request body. Anyone who can reach the API can mint a `RECRUITER` and, once later features land, read candidate contact details. **This is the single most serious gap in the feature.** There is no lower-privileged alternative to prefer: this one endpoint is the whole of account provisioning, not merely a bootstrap beside a safer path.
    **Mitigating conditions this depends on:** the API binds only to localhost, it is never port-forwarded or tunnelled, and `FRONTEND_ORIGIN` is a local origin.
    **Required before any non-localhost exposure** — not optional, and not a later nicety: gate `POST /api/auth/signup` behind a shared operator secret (an `X-Bootstrap-Token` header compared against an env var, rejecting with `404` rather than `401` so the endpoint's existence is not advertised), **or** remove the endpoint entirely and make `npm run db:seed` the only provisioning route. Either is a small change; the point is that it must be a deliberate one, made before exposure and not after.
  - No rate limiting or lockout on login — online brute force is unmitigated in this POC. Combined with SEC-11.1, an exposed instance is trivially compromised.
  - A leaked access token is valid for up to 15 minutes and cannot be revoked early.
  - Logout revokes the refresh family but does not invalidate already-issued access tokens.

---

## Performance Requirements

- **PERF-1** `POST /api/auth/login` completes in **< 400 ms** p95 locally. bcrypt cost 12 dominates (~150–250 ms) and that cost is intentional.
- **PERF-2** `POST /api/auth/refresh` completes in **< 50 ms** p95 — one indexed lookup on `tokenHash @unique`, one update, one insert, in a single transaction. **No bcrypt on this path.**
- **PERF-3** `GET /api/auth/me` completes in **< 30 ms** p95 — one primary-key lookup with an explicit `select`.
- **PERF-4** `requireAuth` performs **at most one** database query per request. JWT verification is in-process.
- **PERF-5** Every refresh-token lookup uses the `tokenHash` unique index; family revocation uses the `familyId` index. **No query in this feature sequentially scans `RefreshToken`.**
- **PERF-6** `GET /api/users` returns interviewers unpaginated. Acceptable at POC scale (tens of users), and doubly so now that no UI polls it. Explicitly **not** the pattern for candidate-scale endpoints, which the brief requires to be indexed aggregates.
- **PERF-7** Middleware ordering puts `requireAuth` before `validate` on protected routes, so an unauthenticated request is rejected without paying parsing cost.

---

## Acceptance Criteria

Given/When/Then. **There is no automated test suite for this POC** — every criterion below is signed off by hand with a `curl` against the running API, plus a `psql` query wherever the proof is database state (see [plan.md § Verification Commands](./plan.md#verification-commands) for the exact commands).

Checking against the **real PostgreSQL database** is not optional: the query-level guarantees are the point, and nothing short of the real query proves them.

### Account creation

- **AC-B00** — **Given** the running API, **when** every registered route is enumerated, **then** `POST /api/users` is **absent**, and `POST /api/auth/signup` is the only route that writes a `User` row (contract invariant 5).
- **AC-B01** — **Given** no user exists with `ada@example.com`, **when** `POST /api/auth/signup` is called with a valid name, email, password and `role: "RECRUITER"`, **then** the response is `201`, the body is `{ user: { id, name, email, role: "RECRUITER", createdAt } }`, **no** `Set-Cookie` header is present, and the body contains no `passwordHash` and no token.
- **AC-B02** — **Given** a user already exists with `ada@example.com`, **when** `POST /api/auth/signup` is called with that email, **then** the response is `409 EMAIL_TAKEN` and exactly one user row exists.
- **AC-B03** — **Given** a signup request with `password: "short"`, **when** it is submitted, **then** the response is `400 VALIDATION_ERROR`, `details.password` is non-empty, and no user row is created.
- **AC-B04** — **Given** a signup request omitting `role`, **when** it is submitted, **then** the response is `400` — no role is defaulted.
- **AC-B05** — **Given** a signup with email `"  Ada@Example.COM  "`, **when** it succeeds, **then** the persisted email is exactly `ada@example.com`, and a later login with `ADA@example.com` authenticates that same user.

### Login

- **AC-B06** — **Given** a recruiter exists with a known password, **when** `POST /api/auth/login` is called with correct credentials, **then** the response is `200`, the body contains `user`, `accessToken` and `expiresIn: 900`, and a `Set-Cookie` for `refresh_token` is present with `HttpOnly`, `SameSite=Lax` and `Path=/api/auth`.
- **AC-B07** — **Given** that user, **when** login is attempted with the wrong password, **then** the response is `401` with `{ code: "INVALID_CREDENTIALS", message: "Invalid email or password" }` and no `Set-Cookie`.
- **AC-B08** — **Given** no user exists with `nobody@example.com`, **when** login is attempted with that email, **then** the response status and body are **deep-equal** to the AC-B07 response — the two cases are indistinguishable.
- **AC-B09** — **Given** a successful login, **when** the response body is inspected, **then** it contains no `passwordHash`, no `refreshToken`, and no refresh-token value anywhere outside the `Set-Cookie` header.
- **AC-B10** — **Given** a successful login, **when** the issued access token is decoded, **then** it carries `sub` and `role`, carries no email or hash, and expires 15 minutes after issuance.
- **AC-B11** — **Given** a user logs in twice from two clients, **when** both sessions are used, **then** both refresh tokens remain valid — a second login does not revoke the first session.

### Identity

- **AC-B12** — **Given** a valid access token, **when** `GET /api/auth/me` is called with `Authorization: Bearer <token>`, **then** the response is `200` with the safe user representation and the correct `role`.
- **AC-B13** — **Given** no `Authorization` header, **when** `GET /api/auth/me` is called, **then** the response is `401 UNAUTHENTICATED`.
- **AC-B14** — **Given** a malformed or tampered token, **when** `GET /api/auth/me` is called, **then** the response is `401` — never `500` — and never reveals why verification failed.
- **AC-B15** — **Given** an access token issued more than 15 minutes ago, **when** it is used, **then** the response is `401`.
- **AC-B16** — **Given** a valid token whose user row has been deleted, **when** `GET /api/auth/me` is called, **then** the response is `401`, not `200` with a fabricated user.

### Refresh & rotation

- **AC-B17** — **Given** a valid refresh cookie, **when** `POST /api/auth/refresh` is called, **then** the response is `200` with a **new** access token and a `Set-Cookie` carrying a refresh token **different** from the one presented.
- **AC-B18** — **Given** a refresh token that has been rotated away, **when** it is presented again, **then** the response is `401`, **and** every `RefreshToken` row sharing its `familyId` has a non-null `revokedAt`, **and** the previously valid rotated token is now also rejected.
- **AC-B19** — **Given** no refresh cookie, **when** `POST /api/auth/refresh` is called, **then** the response is `401`.
- **AC-B20** — **Given** a refresh token whose `expiresAt` is in the past, **when** it is presented, **then** the response is `401` and no new token is issued.
- **AC-B21** — **Given** a valid refresh token, **when** two `POST /api/auth/refresh` requests are fired **concurrently** with that same token, **then** at most one succeeds, the other returns `401`, and the database contains no two simultaneously-unrevoked tokens for that family.

### Logout

- **AC-B22** — **Given** an authenticated session, **when** `POST /api/auth/logout` is called, **then** the response is `204`, the cookie is cleared with `Max-Age=0`, and every `RefreshToken` row in that family has `revokedAt` set.
- **AC-B23** — **Given** a logged-out session, **when** its refresh cookie is presented to `POST /api/auth/refresh`, **then** the response is `401`.
- **AC-B24** — **Given** no cookie at all, **when** `POST /api/auth/logout` is called, **then** the response is `204` — never an error.

### Authorization

- **AC-B25** — **Given** an operator with no session at all, **when** `POST /api/auth/signup` is called with `role: "INTERVIEWER"`, **then** the response is `201` and the created user's role is `INTERVIEWER` — provisioning needs no authenticated actor.
- **AC-B26** — **Given** a **recruiter's** access token, **when** `POST /api/users` is called with `{ name, email, password }`, **then** the response is `404 NOT_FOUND` in the standard error shape and **no user row is created**. The endpoint is gone, not merely forbidden (EC-09).
- **AC-B27** — **Given** an **interviewer's** access token, **when** `GET /api/users` is called, **then** the response is `403 FORBIDDEN`. This is the criterion that proves server-side role enforcement, since no client ever calls this endpoint (AZ-1).
- **AC-B28** — **Given** no access token, **when** `GET /api/users` is called, **then** the response is `401` — not `403`, and not `404`.
- **AC-B29** — **Given** a recruiter's access token, **when** `GET /api/users` is called, **then** the response is `200` and every returned user has `role: "INTERVIEWER"`.
- **AC-B30** — **Given** a recruiter's access token and three existing interviewers plus two recruiters, **when** `GET /api/users` is called, **then** exactly the three interviewers are returned, newest first, and no recruiter appears.
- **AC-B31** — **Given** a recruiter's access token and no interviewers, **when** `GET /api/users` is called, **then** the response is `200` with `{ users: [] }` — not `404`.

### Cross-cutting invariants

- **AC-B32** — **Given** every endpoint in this feature is exercised in turn, **when** each response body is inspected, **then** the substring `passwordHash` appears in **none** of them.
- **AC-B33** — **Given** `JWT_SECRET` is unset, **when** the server starts, **then** it exits with a descriptive error and binds no port.
- **AC-B34** — **Given** a request that triggers an unexpected internal exception, **when** the response is inspected, **then** it is `500 INTERNAL_ERROR` with a generic message and contains no stack trace, no Prisma error code, and no SQL.
- **AC-B35** — **Given** a request to an undefined route, **when** the response is inspected, **then** it is `404 NOT_FOUND` in the standard error shape, not Express's default HTML.
- **AC-B36** — **Given** `npm run db:seed` is run twice in a row, **when** the users table is inspected, **then** it contains exactly one row per seeded account and the command exits `0` both times.

---

## Out of Scope

Explicitly excluded. Each is a deliberate decision, not an omission.

| Excluded                                                             | Note                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authenticated user provisioning (`POST /api/users`)**              | No role can create an account through the API. Provisioning is `POST /api/auth/signup` or `npm run db:seed`, both operator actions.                                                                     |
| **Protecting `POST /api/auth/signup`**                               | It stays anonymous and role-accepting in this POC. An operator token / bootstrap secret is specified as the _required_ fix before non-localhost exposure (SEC-11.1) but is **not built here**.          |
| **Password reset / forgot password**                                 | No reset tokens, no email. A forgotten password means recreating the account.                                                                                                                           |
| **Email verification**                                               | Accounts are usable immediately on creation.                                                                                                                                                            |
| **MFA / TOTP**                                                       | Email + password only.                                                                                                                                                                                  |
| **SSO / OAuth / SAML**                                               | No third-party identity providers.                                                                                                                                                                      |
| **User edit**                                                        | No endpoint to change a name, email, or password after creation.                                                                                                                                        |
| **Role change**                                                      | No promotion or demotion endpoint — which is why BE-4.3's 15-minute role-claim staleness is harmless.                                                                                                   |
| **Account deactivation / deletion**                                  | No soft-delete flag, no delete endpoint.                                                                                                                                                                |
| **`HIRING_MANAGER` role**                                            | Excluded from the POC entirely, including from the `Role` enum. Adding it later requires an enum migration.                                                                                             |
| **Rate limiting / account lockout**                                  | Recorded as a known gap in SEC-11.                                                                                                                                                                      |
| **"Remember me" / configurable session length**                      | Fixed 15 min / 1 day.                                                                                                                                                                                   |
| **`logout-all-devices`**                                             | Logout revokes one family, not every family for the user.                                                                                                                                               |
| **Refresh-token garbage collection**                                 | Expired rows accumulate; acceptable at POC scale (MIG-6).                                                                                                                                               |
| **Session listing / device management endpoints**                    | No "active sessions" API.                                                                                                                                                                               |
| **Audit table for auth events**                                      | Auth events go to structured logs, not a DB table. The domain audit trail belongs to later pipeline features.                                                                                           |
| **Pipeline authorization rules**                                     | Interviewer-scoped candidate queries and the contact-details restriction are later features. This spec only guarantees a trustworthy `req.user`.                                                        |
| **`docker-compose.yml`**                                             | Required by brief §6 but tracked as its own infrastructure task.                                                                                                                                        |
| **Automated tests of any kind** (Vitest, Supertest, a test database) | Every criterion above is verified manually against the running API and database. A test runner and suite are a deliberate later decision — no test dependency, config or file is added by this feature. |

---

## Dependencies

### Blocks

**Every other backend feature in this POC.** Candidates, roles, assignments, feedback, stage overrides and the pipeline/ageing endpoints all require `req.user.{id, role}`. None can be implemented — or correctly specified — before this ships.

### New npm dependencies

| Package                                    | Purpose                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `zod`                                      | Route-boundary validation (BE-2) — **not currently a backend dependency** |
| `bcrypt` (+ `@types/bcrypt`)               | Password hashing, cost 12                                                 |
| `jsonwebtoken` (+ `@types/jsonwebtoken`)   | Access-token sign/verify                                                  |
| `cookie-parser` (+ `@types/cookie-parser`) | Read the refresh cookie                                                   |
| `pino` (+ `pino-pretty` dev)               | Structured JSON logging                                                   |
| `tsx` (already present)                    | Runs `prisma/seed.ts`                                                     |

`@types/node` must be added to `tsconfig.json`'s `types` array (currently `[]`) for `crypto` and `process` typings.

### New environment variables (`.env.example`)

```
JWT_SECRET="change-me-to-a-long-random-string"   # required, min 32 chars, no default
ACCESS_TOKEN_TTL="15m"
REFRESH_TOKEN_TTL_DAYS=1
COOKIE_SECURE=false                               # true in production
SEED_PASSWORD="Password123!"                      # POC demo accounts only
```

`DATABASE_URL`, `PORT` and `FRONTEND_ORIGIN` already exist and are unchanged.

### Modified existing files

| File                                                    | Change                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`src/server.ts`](../../../src/server.ts)               | Reduced to app wiring; adds `cookie-parser`, `credentials: true` on CORS, request-id + error middleware, and the auth/users routers |
| [`prisma/schema.prisma`](../../../prisma/schema.prisma) | `Role` enum, `User` extended, `RefreshToken` added                                                                                  |
| `package.json`                                          | New deps; `db:seed` and `typecheck` scripts (the placeholder `test` script is left as-is — this feature adds no test suite)         |
| `tsconfig.json`                                         | `types: ["node"]`                                                                                                                   |
| `.env.example`                                          | New variables above                                                                                                                 |

### Infrastructure

A running PostgreSQL instance. **No separate test database is needed** — verification is manual against the development database, using the seeded demo accounts.

### External dependencies

**None.** No email provider, no identity provider, no external service. The feature runs entirely against the local PostgreSQL instance.
