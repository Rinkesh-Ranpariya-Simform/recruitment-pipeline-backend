# Implementation Plan — Roles (Backend)

> **Derived from:** [spec.md](./spec.md) — approved
> **Counterpart:** [../../../../frontend/specs/features/roles/plan.md](../../../../frontend/specs/features/roles/plan.md)
> **Builds on:** [../authentication/plan.md](../authentication/plan.md) — implemented
> **Status:** Ready for review

**The whole feature in one line:** one Prisma enum is renamed `UserRole` so the name `Role` can mean
_open requisition_, a `Role` model and five endpoints are added behind `requireAuth`, **all five**
gated by `requireRole(UserRole.RECRUITER)`, and the API learns to validate path parameters and query
strings for the first time.

**Revised after implementation:** the two reads were originally open to any authenticated user and are
now recruiter-only, so requisitions are a recruiter surface end to end. The reasoning and the full list
of edited requirements are in the spec's
[Revision](./spec.md#revision--reads-became-recruiter-only); this plan is updated to match.

**Revised a second time:** `DELETE /api/roles/:roleId` now exists — a **hard** delete, refused with
`409 ROLE_NOT_CLOSED` on any role that is not already `CLOSED`. The original plan registered no delete
at all. The reasoning, and why a soft delete was rejected, are in the spec's
[Revision 2](./spec.md#revision-2--delete-exists-restricted-to-closed-roles). **No migration is
required** — that is the point of choosing a hard delete over a `deletedAt` column. Implementation
order for it is [step 9](#step-9--delete-added-in-revision-2) below.

**One pre-existing defect is fixed here, not in a drive-by:** `validate()` has never populated
`details`, so every `400 VALIDATION_ERROR` this API has returned carried `details: {}`. This feature's
forms are its first real consumer (spec BE-5, AC-B22).

---

## Architecture Impact

| What                                | Change                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First domain model**              | `src/modules/roles/` is the first module that is not auth or user plumbing. It sets the module shape every later feature copies: `routes` → `controller` → `service` → `schema` + a `select` constant.  |
| **First path parameter**            | No route in the API has ever had one. `GET`/`PATCH /api/roles/:roleId` introduce `src/middleware/validateParams.ts`.                                                                                    |
| **First query string**              | `GET /api/roles?status=&page=&pageSize=` introduces `src/middleware/validateQuery.ts`.                                                                                                                  |
| **First paginated list**            | `{ roles, pagination }` with `{ page, pageSize, total, totalPages }` becomes the envelope every later list endpoint uses. `GET /api/users` stays unpaginated as the documented exception (spec PERF-4). |
| **Longest middleware chain so far** | `requireAuth` → `requireRole` → `validateParams` → `validateQuery` → `validate` → controller.                                                                                                           |

### The one change that alters an existing pattern

Everything above _extends_. This does not:

**`enum Role` is renamed `enum UserRole` across the whole codebase.** Prisma models and enums share
one namespace, so `model Role` and `enum Role` cannot coexist — it is a hard schema error, not a
preference. Eight backend files change. The convention from here on is **`UserRole` is who you are;
`Role` is an open req**, and `requireRole` keeps its name because it gates on the caller's `UserRole`.

The rename is **internal to the schema and the TypeScript types**. The column stays `role`, the values
stay `INTERVIEWER`/`RECRUITER`, the JWT claim is untouched, and no request or response field moves — a
live session must survive it (spec MIG-2, AC-B26).

### Cross-cutting

- **Shared zod-issue reduction.** `validate`, `validateParams` and `validateQuery` all need the same
  issues → `ErrorDetails` fold. It is extracted once into `src/middleware/zod-details.ts` so the BE-5
  fix exists in one place rather than being fixed in one file and copied into two new ones.
- **No new error codes, no new dependencies, no new environment variables.** The auth feature's
  catalogue and the installed Express/Prisma/zod/pino stack cover all of it.

---

## Frontend Changes

This is a backend plan. The actual frontend plan is
[../../../../frontend/specs/features/roles/plan.md](../../../../frontend/specs/features/roles/plan.md).
Only what the frontend is **forced** to change by this backend work is recorded here.

| What the frontend must do                                                                                                                          | Because of                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rename its exported `Role` type to `UserRole` in `features/auth/types.ts` and its three importers                                                  | Naming convention parity. **No request or response field changes** — `/api/auth/me` still returns `role: "RECRUITER" \| "INTERVIEWER"` (MIG-2). This is cosmetic on the client and could be skipped without breaking anything; it is done so the two repos read the same way.                                                                                      |
| Add `features/roles/types.ts` mirroring the role shape — six fields, **no user reference of any kind**                                             | FR-7.1, FR-7.2                                                                                                                                                                                                                                                                                                                                                     |
| Call **five** endpoints, including `DELETE /api/roles/:roleId` — _(revised; there were four)_                                                      | FR-6.6                                                                                                                                                                                                                                                                                                                                                             |
| Offer the delete affordance **only on a `CLOSED` role**, and treat `409 ROLE_NOT_CLOSED` as a real, distinct outcome rather than a generic failure | FR-6.7, ERR-6, XFE-9                                                                                                                                                                                                                                                                                                                                               |
| **Change `ApiErrorBody.details` from `Record<string, string>` to `Record<string, string[]>`** and render the array                                 | **Load-bearing — see R-3.** The backend has always declared `ErrorDetails = Record<string, string[]>` ([`src/lib/errors.ts`](../../../src/lib/errors.ts)). The frontend declares a `string`. The mismatch is invisible only because BE-5 keeps `details` empty. Fixing BE-5 makes it visible, and the login form would start rendering `["Password is required"]`. |
| Read `pagination.totalPages` rather than inferring whether more pages exist                                                                        | FR-2.3                                                                                                                                                                                                                                                                                                                                                             |
| Treat a `400` on a bad `?status=`/`?page=` as real — the parameter is rejected, never silently ignored                                             | XFE-2, EC-02                                                                                                                                                                                                                                                                                                                                                       |

No other frontend change is required by this plan.

---

## Backend Changes

All paths relative to `backend/`. Every entry is **NEW** unless marked MODIFIED.

### Middleware

**`src/middleware/zod-details.ts`** — NEW

- `toErrorDetails(issues: z.core.$ZodIssue[]): ErrorDetails` — folds zod issues into
  `Record<string, string[]>`, keyed by `issue.path.join('.')`, falling back to `'_'` for a
  whole-object issue (the `.refine()` on the patch schema lands here).
- **The BE-5 fix lives here.** `noUncheckedIndexedAccess: true` is on, so the assignment must bind:
  ```ts
  const bucket = (details[key] ??= []);
  bucket.push(issue.message);
  ```
  The shipped `(details[key] ?? []).push(...)` creates a temporary array, pushes into it, and discards
  it — the key is never assigned.
- **Responsibility:** the single definition of how a zod failure becomes an API error body. Three
  middlewares consume it; none reimplements it.

**`src/middleware/validate.ts`** — MODIFIED

- **Remove:** the inline `for (const issue of result.error.issues)` loop and its defective
  `(details[key] ?? []).push(...)` line.
- **Add:** `next(new ValidationError(toErrorDetails(result.error.issues)))`.
- **Keep:** everything else, including `req.body = result.data`. `req.body` **is** assignable in
  Express 5; only `req.query` is not.
- **Responsibility:** unchanged — parse `req.body`, replace it with the parsed value, or fail.

**`src/middleware/validateParams.ts`** — NEW

- `validateParams(schema: z.ZodType)` parses `req.params` and assigns the result to
  `req.validatedParams`.
- **Responsibility:** path-parameter validation, so a controller never sees a raw string or calls
  `parseInt` itself.

**`src/middleware/validateQuery.ts`** — NEW

- `validateQuery(schema: z.ZodType)` parses `req.query` and assigns the result to
  `req.validatedQuery`.
- **Why a new property and not `req.query = …`:** **in Express 5 `req.query` is a getter and cannot be
  reassigned.** The `validate()` trick does not transfer. Controllers read `req.validatedQuery` and
  **never** re-read `req.query` — the un-coerced values are not to be trusted downstream (BE-2.2).
- **Responsibility:** query-string validation, coercion and defaulting.

Both new middlewares produce the identical `400 VALIDATION_ERROR` body as body validation. A caller
cannot tell from the _shape_ which part of the request was wrong, only from the `details` keys
(BE-2.3, ERR-3).

### Types

**`src/types/express.d.ts`** — MODIFIED

- **Change:** `import type { Role }` → `import type { UserRole }`, and `user?: { id: number; role: UserRole }`.
- **Add:** `validatedParams?: unknown;` and `validatedQuery?: unknown;`.
- **Why `unknown` and not a generic:** a single global `declare global` augmentation cannot be typed
  per route, and `exactOptionalPropertyTypes: true` rules out the usual escapes. Controllers cast at
  the point of use — `req.validatedParams as RoleIdParam` — which is exactly the existing
  `req.body as SignupInput` idiom in [`auth.controller.ts`](../../../src/modules/auth/auth.controller.ts).
  The cast is safe because the route that reaches the controller is the route that installed the
  schema.

### Roles module

**`src/modules/roles/role.select.ts`** — NEW

```ts
export const ROLE_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;
```

- **Responsibility:** the one role projection (FR-7.3). Every query in the module uses it, so a field
  cannot be returned by one endpoint and not another. Mirrors `SAFE_USER_SELECT` in
  [`src/modules/users/user.select.ts`](../../../src/modules/users/user.select.ts).
- Listing columns explicitly rather than returning the row is the habit that matters when candidate
  contact fields arrive; it costs nothing to keep sharp on a model with no restricted data.

**`src/modules/roles/roles.schema.ts`** — NEW

Exports `createRoleSchema`, `updateRoleSchema`, `roleIdParamSchema`, `listRolesQuerySchema` and the
four inferred input types. Private `titleField` / `descriptionField`, shared between create and patch
so the two cannot drift.

| Schema                 | Shape                                                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRoleSchema`     | `{ title, description }` — **no `status`.** Unknown keys are stripped by zod's default object behaviour, so `status`, `id`, `createdAt` never reach a Prisma `data` object (VAL-3, SEC-3, EC-06).                                                     |
| `updateRoleSchema`     | all three optional, then `.refine((v) => Object.keys(v).length > 0, 'Provide at least one of title, description, status')`. The refine runs **after** unknown-key stripping, so `{ "nonsense": 1 }` is an empty patch and is rejected (VAL-4, EC-05). |
| `roleIdParamSchema`    | `{ roleId: z.coerce.number(...).int(...).positive(...) }` — the controller receives a real `number` (BE-2.4).                                                                                                                                         |
| `listRolesQuerySchema` | `status` optional; `page` default `1`; `pageSize` default `20`, `.min(1).max(100)`. **101 is a `400`, not a clamp** (VAL-5).                                                                                                                          |

- `title`: `z.string().trim().min(1, …).max(120, …)`. `description`: the same with `.max(5000, …)`.
  **Trimming happens inside the schema**, so every downstream consumer gets the normalised value and
  no service can forget (VAL-1); `"   "` fails `min(1)` _after_ the trim (VAL-2, EC-12).
- **zod is v4** (`^4.6.5`). Use `z.enum(RoleStatus, 'Status must be one of OPEN, CLOSED')` — the
  object-plus-string form already shipped in
  [`auth.schema.ts`](../../../src/modules/auth/auth.schema.ts). **Not** `z.nativeEnum`, and **not**
  `{ message: … }`. The authentication _plan_ says `nativeEnum`; the shipped code does not — follow
  the code.
- `z.coerce.number().int().positive()` is already proven in
  [`src/config/env.ts`](../../../src/config/env.ts). Note `.default()` short-circuits `undefined`
  before coercion runs, so an omitted `page` yields `1` and never `NaN`.

**`src/modules/roles/roles.service.ts`** — NEW

`listRoles`, `getRole`, `createRole`, `updateRole`. **No other export** (BE-4.1). Services take
`req.log` as an argument, matching `authService.signup(input, req.log)`.

- `listRoles(query)` — **one `$transaction`** carrying the page query and its `count`, so `total`
  cannot describe a different snapshot than the rows beside it (BE-4.2, PERF-5):
  ```ts
  const where = query.status === undefined ? {} : { status: query.status };
  const [roles, total] = await prisma.$transaction([
    prisma.role.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: ROLE_SELECT,
    }),
    prisma.role.count({ where }),
  ]);
  ```
  The `id desc` tiebreak makes the ordering **total**, so paging cannot repeat or skip a row when two
  roles share a `createdAt` (FR-2.4, PERF-6). `totalPages` is `Math.ceil(total / pageSize)` — and is
  `0`, not `1`, for an empty result. A `page` past the end returns `[]` with a truthful `pagination`,
  never an error (FR-2.6, EC-04).
- `getRole(roleId)` — `findUnique` with `ROLE_SELECT`; `null` → `NotFoundError` (FR-3.3).
- `createRole(input, actorId, log)` — `prisma.role.create({ data: { ...input, status: RoleStatus.OPEN }, select: ROLE_SELECT })`.
  **The service sets `OPEN` explicitly** rather than leaning on a column default, so the rule lives
  where it can be read (FR-4.3, MIG-3). Logs `role.created`.
- `updateRole(roleId, patch, actorId, log)` — reads the current `status` and writes the new row **in
  one interactive transaction**, so the `from` it logs is the value the update actually moved off
  (BE-4.3):
  ```ts
  const { role, previousStatus } = await prisma.$transaction(async (tx) => {
    const existing = await tx.role.findUnique({ where: { id: roleId }, select: { status: true } });
    const updated = await tx.role.update({
      where: { id: roleId },
      data: patch,
      select: ROLE_SELECT,
    });
    return { role: updated, previousStatus: existing?.status };
  });
  ```
  The `404` is derived from **the update failing**, not from the preceding read (FR-5.5) — the read
  exists only to supply `from`. A check-then-write loses under a race and turns a clean `404` into a
  `500` (ERR-2).
- **Prisma error translation, at this layer only** (BE-4.4): catch
  `Prisma.PrismaClientKnownRequestError` with `error.code === 'P2025'` → `throw new NotFoundError()`;
  rethrow anything else. Mirrors the `P2002` → `EmailTakenError` translation in
  [`auth.service.ts`](../../../src/modules/auth/auth.service.ts). `Prisma` is a **value** import from
  `../../generated/prisma/client.js`, not from `@prisma/client`. A raw Prisma error never reaches the
  error middleware's output.
- **Only the keys present are written**, so two recruiters amending _different_ fields do not clobber
  one another (FR-5.4). The same field is last-write-wins, documented (EC-09).

**`deleteRole(roleId, actorId, log): Promise<void>`** — NEW in Revision 2

- One interactive `$transaction`: `findUnique({ select: { status } })`, then `delete`.
- **Order inside it is load-bearing.** `null` → `NotFoundError` **first**; only then
  `status !== CLOSED` → `RoleNotClosedError`. An unknown id must never earn a `409` about a status it
  does not have (FR-6.9, ERR-5, EC-14b).
- **Why one transaction and not a plain check-then-delete:** a concurrent `PATCH` reopening the role
  could land between the read and the delete, and an `OPEN` requisition would be removed (R-14).
- **Unlike `updateRole`, the `404` comes from the READ, not from `P2025` on the write.** That is not
  an inconsistency: the status guard needs the row anyway, so the read is not an extra query, and
  ordering the checks this way is what makes EC-14b come out right. `translatePrismaError` is not
  used here — nothing in this path can raise `P2025` once the read has succeeded inside the same
  transaction.
- Returns `void`. There is no role left to return (FR-6.8).
- Logs `role.deleted` **after the transaction commits**, so a rolled-back delete is never logged as
  one (FR-8.5).

**`src/modules/roles/roles.controller.ts`** — NEW

- Exports `list`, `get`, `create`, `update`, `remove`. Each is `async (req, res): Promise<void>` with
  **no try/catch** — Express 5 forwards a rejected promise to the error middleware, exactly as
  `auth.controller.ts` notes. _(`remove` added in Revision 2. It is named `remove`, not `delete`,
  because `delete` is a reserved word and cannot be an exported binding.)_
- Reads `req.validatedQuery as ListRolesQuery` / `req.validatedParams as RoleIdParam` /
  `req.body as CreateRoleInput`. **Never re-reads `req.params` or `req.query`.**
- `actorId` is `req.user!.id`, read from the verified token — never from a body, a query parameter or
  a header (AZ-3, SEC-4). `requireAuth` runs first on every route, so `req.user` is present.
- Responses: `200 { roles, pagination }` · `200 { role }` · `201 { role }` · `200 { role }` ·
  **`204` with no body** for `remove` (FR-6.8) — `res.status(204).send()`, never a `200` carrying
  `{ deleted: true }`.
- **Responsibility:** HTTP only. All Prisma access, all status-transition logic and all event logging
  live in the service — business rules do not live in route handlers
  ([../../../CLAUDE.md](../../../CLAUDE.md)).

**`src/modules/roles/roles.routes.ts`** — NEW

Exports `rolesRouter`. Imports the controller as a namespace (`import * as rolesController from …`),
matching `auth.routes.ts`.

| Method | Path       | Chain                                                                                                                               |
| ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`        | `requireAuth` → `requireRole(UserRole.RECRUITER)` → `validateQuery(listRolesQuerySchema)` → controller                              |
| GET    | `/:roleId` | `requireAuth` → `requireRole(UserRole.RECRUITER)` → `validateParams(roleIdParamSchema)` → controller                                |
| POST   | `/`        | `requireAuth` → `requireRole(UserRole.RECRUITER)` → `validate(createRoleSchema)` → controller                                       |
| PATCH  | `/:roleId` | `requireAuth` → `requireRole(UserRole.RECRUITER)` → `validateParams(roleIdParamSchema)` → `validate(updateRoleSchema)` → controller |
| DELETE | `/:roleId` | `requireAuth` → `requireRole(UserRole.RECRUITER)` → `validateParams(roleIdParamSchema)` → controller                                |

- **Authorization is settled before any parsing cost is paid** (BE-3). An interviewer's malformed
  request is a `403`, not a `400` — the API does not help an unauthorized caller fix their payload or
  their query string. It is also why an interviewer naming role `9999` gets `403`, not `404` (ERR-4,
  EC-11, AC-B18).
- `requireRole` sits on **all five** routes, on **every** request — the reads included, since the
  revision that made requisitions recruiter-only (AZ-1, AZ-2, SEC-1). The client's decision not to
  render a button, and its decision to answer an interviewer at `/roles` with its own 404, are not
  part of this.
- **`DELETE /:roleId` carries no status guard in its chain, and that is deliberate.** Middleware sees
  an id and nothing else; whether the role is `CLOSED` is a fact only a read can establish, so the
  guard lives in the service inside the delete's own transaction (FR-6.7, R-14). The chain does what
  the other four do and stops.
- Ordering consequence for `DELETE`, unchanged from the rest: an interviewer gets `403` **before**
  existence or status is considered — so the row survives and nothing is leaked about it (AZ-6,
  ERR-4, AC-B20).

### App wiring

**`src/app.ts`** — MODIFIED

- **Add:** `import { rolesRouter } from './modules/roles/roles.routes.js';` and
  `app.use('/api/roles', rolesRouter);` immediately after the `/api/users` line.
- **Keep:** the order `requestId` → `cors` → `express.json()` → `cookieParser()` → routers →
  `notFound` → `errorHandler`. The new router must sit **before** `notFound`, or every roles path
  404s.

### The `UserRole` rename — mechanical, six files

Each is a type or value import swap. **Behaviour and names are otherwise unchanged.**

| File                                                                                | Change                                                                                                                                                                                   | MODIFIED |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [`src/middleware/requireRole.ts`](../../../src/middleware/requireRole.ts)           | `import type { Role }` → `UserRole`; signature `(...roles: UserRole[])`. **The middleware keeps its name** — it gates on the caller's user-role and has nothing to do with requisitions. | ✔        |
| [`src/lib/tokens.ts`](../../../src/lib/tokens.ts)                                   | `Role` → `UserRole`. This is a **value** import (`role !== Role.INTERVIEWER && …`), so real code changes. The claim **value** is untouched.                                              | ✔        |
| [`src/modules/auth/auth.schema.ts`](../../../src/modules/auth/auth.schema.ts)       | `z.enum(UserRole, 'Role must be one of INTERVIEWER, RECRUITER')` — **message text unchanged**, because it is user-facing copy about a request field still named `role`.                  | ✔        |
| [`src/modules/auth/auth.service.ts`](../../../src/modules/auth/auth.service.ts)     | `Role` → `UserRole` on the `SafeUser` interface.                                                                                                                                         | ✔        |
| [`src/modules/users/users.routes.ts`](../../../src/modules/users/users.routes.ts)   | `requireRole(UserRole.RECRUITER)`                                                                                                                                                        | ✔        |
| [`src/modules/users/users.service.ts`](../../../src/modules/users/users.service.ts) | `where: { role: UserRole.INTERVIEWER }`                                                                                                                                                  | ✔        |

Plus `src/types/express.d.ts` (above) and `prisma/seed.ts` (below) — **eight files total.**

### Seed

**`prisma/seed.ts`** — MODIFIED

- **Change:** `import { Role }` → `import { UserRole, RoleStatus } from '../generated/prisma/enums.js';`
  and `UserRole.RECRUITER` / `UserRole.INTERVIEWER` in `SEED_ACCOUNTS`.
- **Add:** a `SEED_ROLES` array and a loop creating demo roles **after** the demo accounts, so a fresh
  database plus one command gives the frontend something to render (FR-9.1).
- **Three roles: two `OPEN`, one `CLOSED`**, so a status filter has something to prove (FR-9.2).
- **Idempotency is `findFirst`-then-`create` per title, not `upsert`** — `title` is not unique
  (FR-1.3), so there is no key to upsert on:
  ```ts
  const existing = await prisma.role.findFirst({
    where: { title: seed.title },
    select: { id: true },
  });
  if (existing === null) {
    await prisma.role.create({ data: seed, select: ROLE_SELECT });
  }
  ```
  **A check-then-write is acceptable here and nowhere else in this codebase** (FR-9.3): the seed is a
  single-process script with no concurrent caller, whereas a request path must derive conflicts from a
  database constraint (ERR-2).
- **Keep:** the existing `try`/`catch` → `logger.error` → `disconnect()` → `process.exit(1)` shape and
  the top-level `await`.

### Logging — `src/modules/roles/roles.service.ts`

| Event                 | Level | Fields                                                  |
| --------------------- | ----- | ------------------------------------------------------- |
| `role.created`        | info  | `actorId`, `roleId`                                     |
| `role.updated`        | info  | `actorId`, `roleId`, `changedFields: string[]`          |
| `role.status_changed` | info  | `actorId`, `roleId`, `from`, `to`                       |
| `role.deleted`        | info  | `actorId`, `roleId` — emitted **after commit** (FR-8.5) |

- **`requestId` needs no explicit field.** [`src/middleware/requestId.ts`](../../../src/middleware/requestId.ts)
  binds it on the child logger, so it lands on every line the service emits through `req.log`.
- `role.status_changed` fires **only on an actual transition** — `patch.status !== undefined &&
patch.status !== previousStatus`. A no-op status write emits `role.updated` and no transition event,
  so a client retrying cannot produce a fictitious second close (FR-6.3, FR-8.3, EC-07, AC-B24).
- **`role.deleted` is the only surviving trace of the role**, since the row is gone. That is why it is
  emitted unconditionally on success and why it carries `actorId` — a deletion with no attributable
  actor is the one outcome in this feature with no way to reconstruct it (FR-8.5, AC-B39).
- **Never logged:** the `title` or `description` **values**. `changedFields` is
  `Object.keys(patch)` — field names are what make a change reconstructable; pasting a description
  into a log line is noise that never stops growing (FR-8.4, AC-B28). Everything on the auth spec's
  never-log list still applies.
- Message strings follow the house shape: `log.info({ event: 'role.created', actorId, roleId }, 'role created')`.

---

## Database Changes

### Schema diff — `prisma/schema.prisma`

```prisma
// RENAMED from `Role`. `UserRole` is who you are; `Role` (below) is an open req.
enum UserRole {
  INTERVIEWER
  RECRUITER
}

enum RoleStatus {
  OPEN
  CLOSED
}

model User {
  // …unchanged except the enum's new name. No relation to Role: a requisition
  // references no person in this POC (FR-7.2).
  role UserRole
}

model Role {
  id          Int        @id @default(autoincrement())
  title       String
  description String
  // No default in the schema: the service sets OPEN explicitly on create, so
  // the rule lives where it can be read, not in a column definition (FR-4.3).
  status      RoleStatus

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([status, createdAt])
  @@index([createdAt])
}
```

### Indexes

| Index                          | Serves                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `@@index([status, createdAt])` | `GET /api/roles?status=OPEN` — the filtered listing, filtering and sorting in one index |
| `@@index([createdAt])`         | `GET /api/roles` — the unfiltered listing's `ORDER BY createdAt DESC`                   |

Both are added **now**, not after a slow query is observed — the brief expects the query plan to be
defensible at 200 roles (MIG-5, PERF-1, AC-B30).

### Migration — `add_roles`

One migration, on top of `20260914151935_add_auth`. It carries **both** the enum rename and the
additive `Role` table.

**The enum rename is the risky part and must be inspected before it is applied** (MIG-1). Prisma does
not reliably detect an enum rename; it may generate a drop-and-recreate rather than an
`ALTER TYPE … RENAME`.

```bash
npx prisma migrate dev --create-only --name add_roles
#    generates the SQL without applying it — do not skip --create-only
```

Then **read `prisma/migrations/<timestamp>_add_roles/migration.sql`** and take one of two paths:

| The generated SQL                                                                                      | Path                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserves `User.role` — an `ALTER TYPE "Role" RENAME TO "UserRole"`, or a recreate with a `USING` cast | **Ships as generated.** Apply with `npx prisma migrate dev`.                                                                                          |
| Would drop `User.role`, the type, or the rows                                                          | **Regenerate it — never hand-edit** ([../../../CLAUDE.md](../../../CLAUDE.md)). Recovery is `npx prisma migrate reset` followed by `npm run db:seed`. |

`migrate reset` is acceptable **only** because the database holds nothing but seeded demo accounts.
Confirm that with `SELECT count(*) FROM "User";` before running it. If the two paths both prove
awkward, the fallback is to split this into two migrations — `rename_role_enum` alone, then
`add_roles` — which isolates the risk at the cost of contradicting the spec's "one new migration".

The **only** permitted hand-edit is a leading comment, as
`20260914151935_add_auth/migration.sql` already does.

#### Generated SQL — filled during implementation

> Record the actual generated SQL here, and which of the two paths above was taken. Spec MIG-1
> requires this plan to carry it. **Do not fill this in from memory — paste what Prisma produced.**

```sql
-- (paste prisma/migrations/<timestamp>_add_roles/migration.sql here)
```

### Data migration, backfill and rollback

- **No backfill.** The `Role` table starts empty; `prisma/seed.ts` puts the first three rows in it.
- **Existing rows:** every `User` row must survive with its `role` value intact. That is the whole of
  MIG-1's risk and is checked by AC-B26 — a token issued **before** the migration must still
  authenticate after it.
- **`status` has no database default** (MIG-3), so a row cannot come into existence without a code
  path having chosen its status — the same reasoning as the auth spec's MIG-2 for `User.role`.
- **`description` is `String` (Postgres `text`)**, not a length-capped `varchar` (MIG-4). The 5000-character
  ceiling is a validation rule, changeable without a migration.
- **`Role` has no foreign key** (MIG-6), so it participates in no cascade, nothing can be orphaned,
  and no row in it is ever deleted by this feature.
- **Rollback:** `npx prisma migrate reset` + `npm run db:seed`. There is no
  down-migration, and no production data to protect.

---

## API Changes

All four are **NEW**. JSON, prefixed `/api`, `Authorization: Bearer <access token>` required. Every
error body is `{ code, message, details? }`.

### `GET /api/roles` — NEW · `RECRUITER`

| Parameter  | Type               | Default | Notes                                                          |
| ---------- | ------------------ | ------- | -------------------------------------------------------------- |
| `status`   | `OPEN` \| `CLOSED` | —       | Omitted means **all** statuses, not a hidden default of `OPEN` |
| `page`     | integer ≥ 1        | `1`     |                                                                |
| `pageSize` | integer 1–100      | `20`    | Above 100 is a `400`, **not a clamp**                          |

Response `200`: `{ roles: Role[], pagination: { page, pageSize, total, totalPages } }`.
Errors: `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `500 INTERNAL_ERROR`.

### `GET /api/roles/:roleId` — NEW · `RECRUITER`

Response `200`: `{ role }`.
Errors: `400` (`:roleId` not a positive integer) · `401` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500`.

### `POST /api/roles` — NEW · `RECRUITER`

Request: `{ title, description }` and nothing else. `status` in the body is **stripped, not honoured
and not an error** — the created role is always `OPEN`.
Response `201`: `{ role }`.
Errors: `400` · `401` · `403 FORBIDDEN` · `500`.

### `PATCH /api/roles/:roleId` — NEW · `RECRUITER`

Request: any **non-empty** subset of `{ title, description, status }`. An empty body is a `400` — a
`PATCH` that asks for nothing is a mistake, not a no-op worth a `200`.
Response `200`: the **complete** updated role, not a diff, so the client never merges its own patch
into cached state to know the truth.
Errors: `400` · `401` · `403` · `404` · `500`.

### `DELETE /api/roles/:roleId` — NEW in Revision 2 · `RECRUITER`

Request: no body. Only `:roleId` is read, and it is validated by the same `roleIdParamSchema` the
`GET` and `PATCH` routes use.
Response `204`: **empty**. There is no role left to describe (FR-6.8).
Errors: `400` (bad `:roleId`) · `401` · `403` · `404` (no such role — checked **before** status) ·
**`409 ROLE_NOT_CLOSED`** (the role is `OPEN`; it is left untouched) · `500`.

`ROLE_NOT_CLOSED` is a new `ErrorCode` in [`src/lib/errors.ts`](../../../src/lib/errors.ts), with a
`RoleNotClosedError` subclass — **MODIFIED**, the only file outside the roles module this revision
touches. It is not a reused `VALIDATION_ERROR`: the request was well-formed and the resource's
**state** was the problem, which is a different thing for a client to react to (ERR-6).

### Authorization matrix

| Endpoint                    | Anonymous | INTERVIEWER | RECRUITER                           |
| --------------------------- | --------- | ----------- | ----------------------------------- |
| `GET /api/roles`            | 401       | **403**     | ✅                                  |
| `GET /api/roles/:roleId`    | 401       | **403**     | ✅                                  |
| `POST /api/roles`           | 401       | **403**     | ✅                                  |
| `PATCH /api/roles/:roleId`  | 401       | **403**     | ✅                                  |
| `DELETE /api/roles/:roleId` | 401       | **403**     | ✅ — `CLOSED` only; `409` otherwise |

`401` means _"we don't know who you are"_; `403` means _"we know, and you may not"_ (AZ-4, EC-10).
**Reads are recruiter-only, like the writes** (AZ-1, revised after implementation). `GET /api/roles` is
the whole hiring picture, which is a recruiter's working surface; the narrower thing an interviewer
actually needs — the title of the req behind _their_ round — belongs on an assignment-scoped rounds
endpoint, not on this one. See the spec's [Revision](./spec.md#revision--reads-became-recruiter-only).

### Breaking changes

**None.** Every auth endpoint keeps its exact request and response shape through the `UserRole`
rename (MIG-2). No existing client needs a migration note.

---

## Shared Types / Contracts

Two separate git repos. **Nothing is shared by import, only by agreement** — a change on either side
is a change to both specs.

| Contract item                                                                                           | Owned by                          | Breaks on the frontend if changed                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role shape — `{ id, title, description, status, createdAt, updatedAt }`                                 | Backend `ROLE_SELECT`             | `features/roles/types.ts` stops matching; the detail view renders blanks. **No user field may ever appear** — if one does it is a backend bug to flag, not to filter client-side    |
| `RoleStatus` values `OPEN` \| `CLOSED`                                                                  | Backend `enum RoleStatus`         | The status badge, the filter and the close/reopen action all branch on these literals                                                                                               |
| `UserRole` values `INTERVIEWER` \| `RECRUITER`                                                          | Backend `enum UserRole`           | `canManageRoles` and the post-login landing route. **The rename changes the type name only; the wire values are unchanged**                                                         |
| List envelope — `{ roles, pagination: { page, pageSize, total, totalPages } }`                          | Backend `roles.service.listRoles` | The pager renders from `totalPages`; a rename silently gives it `undefined` pages                                                                                                   |
| Query parameters `status`, `page`, `pageSize`                                                           | Backend `listRolesQuerySchema`    | Linkable filter URLs break; a renamed parameter becomes a stripped unknown key and the list silently returns unfiltered                                                             |
| Error body `{ code, message, details? }`                                                                | Backend `errorHandler`            | Every error branch in the client keys off `body.code`                                                                                                                               |
| **`details: Record<string, string[]>`** — **array**, not string                                         | Backend `ErrorDetails`            | **Currently mismatched — see R-3.** The client declares `Record<string, string>` and passes the value straight to `setError`. Once BE-5 lands, forms render `["Title is required"]` |
| Error `code` values — `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `INTERNAL_ERROR` | Backend `ErrorCode`               | This feature adds none                                                                                                                                                              |
| `403`, never `401`, for an authenticated interviewer's request                                          | Backend `requireRole`             | A `401` would trigger the client's refresh-and-replay interceptor on what is an authorization failure                                                                               |
| `201` on create carrying the new `id`                                                                   | Backend `roles.controller.create` | The client navigates straight to the new role's detail view                                                                                                                         |
| Cookie name `refresh_token`, path `/api/auth`                                                           | Backend, unchanged                | Untouched by this feature                                                                                                                                                           |

---

## Verification Commands

PostgreSQL must be running and `.env` populated (`DATABASE_URL`, `SEED_PASSWORD`). Run from
`backend/`.

```bash
# 1. Dependencies — no new ones; this only regenerates the client
npm install
#    proves: package.json is unchanged (BE-7)

# 2. Generate the migration WITHOUT applying it
npx prisma migrate dev --create-only --name add_roles
#    proves: nothing yet — this is the gate for MIG-1

# 3. READ the generated SQL before it touches a database
cat prisma/migrations/*_add_roles/migration.sql
#    proves: MIG-1 — that User.role survives the enum rename.
#    STOP HERE if it drops the column, the type, or the rows.

# 4. Apply it
npx prisma migrate dev
#    proves: the migration applies cleanly; the Prisma client regenerates with UserRole + RoleStatus

# 5. Confirm no user row was lost
psql "$DATABASE_URL" -c 'SELECT id, email, role FROM "User" ORDER BY id;'
#    proves: MIG-1 — three demo accounts, roles intact

# 6. Seed, twice
npm run db:seed && npm run db:seed
psql "$DATABASE_URL" -c 'SELECT count(*), status FROM "Role" GROUP BY status;'
#    proves: AC-B29 — exactly 3 rows (2 OPEN, 1 CLOSED) both times, exit 0 both times

# 7. Static checks
npm run lint && npm run typecheck
#    proves: the eight-file rename is complete — a missed `Role` import fails typecheck

# 8. Run it
npm run dev
#    proves: the server boots and mounts /api/roles

# 9. DELETE — added in Revision 2. $REC is a recruiter token, $INT an interviewer's.
#    Create a role and try to delete it while it is still OPEN:
curl -i -X DELETE $BASE/api/roles/$ID -H "authorization: Bearer $REC"
#    proves: AC-B37 — 409 ROLE_NOT_CLOSED. Then GET it: unchanged, updatedAt NOT bumped.

curl -s -X PATCH $BASE/api/roles/$ID -H "authorization: Bearer $REC"   -H 'content-type: application/json' -d '{"status":"CLOSED"}'
curl -i -X DELETE $BASE/api/roles/$ID -H "authorization: Bearer $REC"
#    proves: AC-B36 — 204, empty body. Confirm with psql that the row is gone.

curl -i -X DELETE $BASE/api/roles/$ID -H "authorization: Bearer $REC"
#    proves: AC-B40 — the second call is 404, not another 204

curl -i -X DELETE $BASE/api/roles/9999 -H "authorization: Bearer $REC"
curl -i -X DELETE $BASE/api/roles/abc  -H "authorization: Bearer $REC"
curl -i -X DELETE $BASE/api/roles/1    -H "authorization: Bearer $INT"
#    proves: AC-B38 (404, not 409) · AC-B41 (400) · AC-B20 (403, and the row survives)
```

### Tokens

Every check below needs two access tokens, from the seeded accounts:

```bash
REC=$(curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"recruiter@demo.test","password":"'"$SEED_PASSWORD"'"}' | jq -r .accessToken)
INT=$(curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"interviewer1@demo.test","password":"'"$SEED_PASSWORD"'"}' | jq -r .accessToken)
```

### Checks needing particular care

These are the ones that are easy to fake by looking at the wrong thing.

- **AC-B22 (`details` is actually populated)** — the criterion that catches BE-5. `PATCH` with
  `{"title":"","description":""}` and assert **both** keys are present with non-empty arrays:
  ```bash
  curl -s -X PATCH localhost:3000/api/roles/1 -H "authorization: Bearer $REC" \
    -H 'content-type: application/json' -d '{"title":"","description":""}' | jq '.details'
  #    expect: { "title": ["…"], "description": ["…"] }.  `{}` is a FAIL — the fix did not land.
  ```
- **AC-B24 (one transition, two updates)** — `PATCH {"status":"CLOSED"}` twice against an open role,
  then read the server log. `role.status_changed` must appear **once** and `role.updated` **twice**.
  Both responses are `200`. Counting responses proves nothing here; the log is the evidence.
- **AC-B25 (exactly two SQL statements)** — **needs setup the repo does not have.**
  [`src/lib/prisma.ts`](../../../src/lib/prisma.ts) configures no `log`, so temporarily construct the
  client with `log: ['query']`, hit `GET /api/roles?pageSize=20` with 20 roles seeded, count the
  emitted statements, then **revert the change**. Two, not three, and never a per-row query.
- **AC-B26 (a live session survives the rename)** — the ordering is the whole test. Log in and capture
  a token **before** step 4, apply the migration, _then_ call `GET /api/auth/me` with that same token
  → `200` with `role: "RECRUITER"`. Logging in afterwards proves nothing.
- **AC-B30 (`EXPLAIN ANALYZE` at 200 roles)** — **needs 200 rows the seed does not create**, and must
  not: FR-9.2 fixes the seed at three. Insert throwaway rows directly, and delete them afterwards:
  ```sql
  INSERT INTO "Role" (title, description, status, "createdAt", "updatedAt")
  SELECT 'Load role ' || i, 'seeded for EXPLAIN', (CASE WHEN i % 3 = 0 THEN 'CLOSED' ELSE 'OPEN' END)::"RoleStatus",
         now() - (i || ' minutes')::interval, now()
  FROM generate_series(1, 200) AS i;

  EXPLAIN ANALYZE SELECT id, title, description, status, "createdAt", "updatedAt" FROM "Role"
  WHERE status = 'OPEN' ORDER BY "createdAt" DESC, id DESC LIMIT 20 OFFSET 0;

  DELETE FROM "Role" WHERE description = 'seeded for EXPLAIN';
  ```
  The plan must show an **index scan on `Role_status_createdAt_idx`, not a sequential scan followed by
  a sort**. Note: Postgres may legitimately choose a seq scan at 200 rows because the table is tiny —
  if so, say so and re-check at a scale where the index is the cheaper plan, rather than declaring the
  criterion passed.
- **AC-B27 (no user field anywhere)** — walk all four endpoints and `jq` every body. Absence is the
  assertion; a spot-check of one response does not prove it.
- **AC-B13 / AC-B16 / AC-B17 / AC-B20 (nothing was written)** — each needs a `psql` read, not just a
  status code. A `403` with a row created is still a failure.

#### `EXPLAIN ANALYZE` output — filled during implementation

> Spec PERF-1 requires this plan to carry the plan Postgres actually chose. Paste it here.

```
(paste EXPLAIN ANALYZE output here)
```

---

## Risks

| #    | Risk                                                                                                                                                                                                                                                                                      | Impact                                                                                                                                                                       | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | **The enum rename may be generated as a drop-and-recreate.** Prisma does not reliably detect an enum rename, and `User.role` is `NOT NULL`.                                                                                                                                               | Every user row lost; every seeded account and live session gone.                                                                                                             | `--create-only` and **read the SQL before applying** (MIG-1). Confirm `User` holds only demo rows first. Recovery is `migrate reset` + `db:seed`. Never hand-edit beyond a comment. Fallback: split into two migrations.                                                                                                                                                                                  |
| R-2  | **`req.query` is a getter in Express 5.** Copying `validate()`'s `req.body = result.data` into `validateQuery` throws at runtime, and only on a request that reaches that route.                                                                                                          | The list endpoint 500s on every call, with nothing caught at build time.                                                                                                     | `req.validatedQuery` (BE-2.2), and the rule that controllers never re-read `req.query`. Covered by AC-B03 and AC-B09.                                                                                                                                                                                                                                                                                     |
| R-3  | **Fixing BE-5 exposes a frontend type mismatch.** `details` has always been `Record<string, string[]>` on this side and `Record<string, string>` on the client; the client passes the value straight to `setError`. The bug is invisible today **only because `details` is always `{}`**. | The moment this ships, the **login form** — already in production behaviour — starts rendering `["Password is required"]`. This is a regression in a feature nobody touched. | Flagged under § Frontend Changes and carried in the frontend plan as a MODIFIED `features/auth/types.ts` entry. **The two repos must ship together, or the backend must ship second.**                                                                                                                                                                                                                    |
| R-4  | **Paging can repeat or drop a row** if two roles share a `createdAt` — the seed creates three in a tight loop, so this is likely, not theoretical.                                                                                                                                        | A recruiter paging through sees a role twice and another never.                                                                                                              | `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` makes the ordering total (FR-2.4, PERF-6). AC-B04 checks page 2 shares no row with page 1.                                                                                                                                                                                                                                                             |
| R-5  | **`total` and the rows can describe different snapshots** if the count runs outside the page query.                                                                                                                                                                                       | `totalPages` disagrees with what is rendered under concurrent writes.                                                                                                        | One `$transaction` carrying both, with the same `where` (BE-4.2, PERF-5).                                                                                                                                                                                                                                                                                                                                 |
| R-6  | **`updateRole`'s `from` could be read outside the transaction**, making the logged transition a lie under a concurrent patch.                                                                                                                                                             | The audit story — the point of FR-8 — is quietly wrong.                                                                                                                      | Read and write inside one interactive transaction (BE-4.3).                                                                                                                                                                                                                                                                                                                                               |
| R-7  | **A check-then-write for the `404`.** Reading first, then updating, loses under a race and turns a clean `404` into a `500`.                                                                                                                                                              | Wrong status code, and a Prisma error reaching the error middleware.                                                                                                         | The `404` is derived from `P2025` on the update (FR-5.5, ERR-2). The read supplies `from` only.                                                                                                                                                                                                                                                                                                           |
| R-8  | **`z.nativeEnum` and `{ message: … }` are zod v3.** This repo is on zod `^4.6.5`, and the _authentication plan_ still says `nativeEnum`.                                                                                                                                                  | Copying the older plan produces code that does not compile.                                                                                                                  | Follow the shipped [`auth.schema.ts`](../../../src/modules/auth/auth.schema.ts), not the older plan. Caught by `npm run typecheck`.                                                                                                                                                                                                                                                                       |
| R-9  | **An incomplete rename type-checks in the wrong direction.** A missed `Role` import in a file that also imports the new model gets confusing errors.                                                                                                                                      | Time lost to misleading diagnostics.                                                                                                                                         | Do the rename as **one atomic step** across all eight files (Implementation Order step 3), then `npm run typecheck` before writing any new code.                                                                                                                                                                                                                                                          |
| R-10 | **`requireRole` after `validate` would leak validation feedback to an unauthorized caller** and let them probe the schema — now on the reads too, where it would also leak which role ids exist.                                                                                          | An interviewer learns the shape of a payload they may not send, or which requisitions exist.                                                                                 | Chain order is fixed on all four routes in `roles.routes.ts` and checked by AC-B18 (`403`, not `404`, for a nonexistent id) and AC-B18b (`403`, not `400`, for a bad query).                                                                                                                                                                                                                              |
| R-11 | **Performance at the brief's stated scale is asserted, not measured**, until AC-B30 runs — and the seed creates three roles, so the natural check proves nothing.                                                                                                                         | A sequential scan ships unnoticed.                                                                                                                                           | The throwaway `generate_series` procedure above, plus honest reporting if Postgres picks a seq scan because the table is small.                                                                                                                                                                                                                                                                           |
| R-12 | **No rate limiting and no per-role ownership** — any recruiter may amend or close any role, including one they did not create, and can do so as fast as they can send requests.                                                                                                           | Accepted for a POC with one recruiter.                                                                                                                                       | **Not mitigated by this plan.** Documented as SEC-5, so a later "only the creating recruiter may close it" rule is a deliberate addition rather than a bug report.                                                                                                                                                                                                                                        |
| R-13 | **Last-write-wins on concurrent edits** (EC-09). No `If-Match`, no version column.                                                                                                                                                                                                        | A recruiter silently overwrites another's edit to the same field.                                                                                                            | **Not mitigated.** Disjoint fields survive because only present keys are written; `updatedAt` and the two log lines make the order reconstructable. Optimistic concurrency is explicitly out of scope.                                                                                                                                                                                                    |
| R-14 | **A check-then-delete outside a transaction loses the CLOSED guard.** Read the status, a concurrent `PATCH` reopens the role, then the delete lands — and an **open** requisition is gone.                                                                                                | The one rule protecting a live req fails exactly when two people are working at once, and there is no row left to notice it with.                                            | The status read and the `delete` share **one interactive `$transaction`** in `deleteRole` (FR-6.7). Verified by EC-14d and AC-B37.                                                                                                                                                                                                                                                                        |
| R-15 | **A hard delete cannot be undone, and this is the first destructive endpoint in the POC.** There is no `deletedAt`, no restore, and the row is the only copy.                                                                                                                             | A recruiter removes the wrong requisition and it is gone; only a log line says it existed.                                                                                   | **Accepted, with two guards**: the CLOSED-only rule makes it two deliberate acts (FR-6.7), and the client confirms with a dialog naming the role and saying it cannot be undone. `role.deleted` (FR-8.5) is the audit record. Documented as SEC-5, not mitigated further — see the spec's [Revision 2](./spec.md#revision-2--delete-exists-restricted-to-closed-roles) on why a soft delete was rejected. |
| R-16 | **The first model to take a foreign key to `Role` inherits an undecided `onDelete`.** Prisma's default is `Restrict` for a required relation, but nothing in _this_ plan says so, and a later spec could silently pick `Cascade` and take candidates with the req.                        | A deleted requisition silently deletes candidate history — the exact outcome the original no-delete rule existed to prevent.                                                 | **Deferred by design, and recorded as an obligation**: FR-6.10 requires the feature adding the first inbound FK to state its delete behaviour explicitly in its own spec. Postgres's default is not a decision.                                                                                                                                                                                           |

---

## Implementation Order

Each step leaves the repo type-checking and the existing endpoints working.

1. **Schema.** Edit `prisma/schema.prisma`: rename `enum Role` → `UserRole`, add `enum RoleStatus`,
   add `model Role` with both indexes. Nothing compiles yet — that is expected.
2. **Migration.** `--create-only`, **read the SQL** (R-1), then apply. Regenerates the client with
   `UserRole` and `RoleStatus`. Capture a pre-migration access token first, for AC-B26.
3. **The rename, atomically.** All eight files in one pass: `express.d.ts`, `requireRole.ts`,
   `tokens.ts`, `auth.schema.ts`, `auth.service.ts`, `users.routes.ts`, `users.service.ts`,
   `prisma/seed.ts`. **Then `npm run typecheck` and stop until it is green.** This is the step that
   must not be interleaved with new code (R-9).
4. **`zod-details.ts` + the `validate.ts` fix.** Independent of everything below — could be done in
   parallel with step 3 by a second person. Verify immediately with any existing `400` from
   `/api/auth/signup`: `details` must stop being `{}`.
5. **`validateParams.ts` and `validateQuery.ts`**, plus the two new `express.d.ts` properties. No
   consumer yet.
6. **`role.select.ts` and `roles.schema.ts`.** Pure data, no I/O. Independent of steps 4–5.
7. **`roles.service.ts`.** All four functions, the `P2025` translation and the three log events.
8. **`roles.controller.ts`**, then **`roles.routes.ts`**.
9. **`src/app.ts`** — mount `rolesRouter` before `notFound`. The API is now live; AC-B01…AC-B28 become
   checkable.
10. **`prisma/seed.ts`** — add `SEED_ROLES`. Run it twice for AC-B29.
11. **Verification.** Work the manual table below, then fill the two placeholder blocks (generated SQL,
    `EXPLAIN ANALYZE`).

Steps 4–5 and 6 are independent of each other and of step 3's tail. Everything from 7 onward is
strictly sequential.

### Step 9b — `DELETE` (added in Revision 2)

Done **after** the eleven steps above, against a working API. **No migration, no schema change, no new
dependency** — that is the whole advantage of a hard delete over a `deletedAt` column.

1. **`src/lib/errors.ts`** — add `'ROLE_NOT_CLOSED'` to the `ErrorCode` union and a
   `RoleNotClosedError` subclass (`409`, message `"Close the role before deleting it"`). The message
   is rendered verbatim by the client, so it names the remedy rather than restating the status code
   (ERR-1, ERR-6).
2. **`roles.service.ts`** — add `deleteRole`. One transaction; **`null` → 404 before
   `status !== CLOSED` → 409** (ERR-5); log `role.deleted` after the commit.
3. **`roles.controller.ts`** — add `remove`, answering `res.status(204).send()`.
4. **`roles.routes.ts`** — register `rolesRouter.delete('/:roleId', requireAuth,
requireRole(UserRole.RECRUITER), validateParams(roleIdParamSchema), rolesController.remove)`.
   Nothing else in the chain: the status guard belongs to the service (R-14).
5. **`npm run typecheck && npm run lint`**, then work AC-B36…AC-B41 with `curl`.

The frontend counterpart ships in the same pass — see
[the frontend plan](../../../../frontend/specs/features/roles/plan.md). Order does not matter here:
the client only _adds_ a call, so a client shipped first simply gets a `404` from an unregistered
route until the backend lands.

---

## Acceptance Criteria Mapping

Every criterion in [spec.md § Acceptance Criteria](./spec.md#acceptance-criteria) appears below — the
original thirty plus AC-B36…AC-B41 from Revision 2. Implementation entries use the paths from § Backend Changes.

The third column is the **manual check** — this repo has no automated tests and none are being added.
`$REC` and `$INT` are the two tokens captured above; `BASE` is `localhost:3000`.

| Acceptance Criterion                                              | Implementation                                                                     | Manual Verification                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-B01 — list returns 3 roles newest-first with pagination        | `roles.service.listRoles`, `roles.controller.list`, `role.select.ts`               | `curl -s $BASE/api/roles -H "authorization: Bearer $REC" \| jq` → `200`, 3 entries, `pagination` is `{page:1,pageSize:20,total:3,totalPages:1}`                                                                                          |
| AC-B02 — interviewer's reads are both 403                         | `roles.routes.ts` `requireRole(UserRole.RECRUITER)` on **both** GETs               | `GET /api/roles` and `GET /api/roles/1` with `$INT` → `403 FORBIDDEN` each, and `jq '.roles, .role, .pagination'` is `null` on both. A `200` is a failure (AZ-1, EC-15)                                                                  |
| AC-B03 — `?status=OPEN` returns 2, total 2                        | `listRoles` `where` + `count` sharing it                                           | `curl "$BASE/api/roles?status=OPEN" …` → 2 roles, `total` is **2**, not 3 (PERF-5)                                                                                                                                                       |
| AC-B04 — `?pageSize=2&page=2` returns 1 unseen role               | `listRoles` `skip`/`take`, `orderBy [createdAt desc, id desc]`                     | Fetch page 1 and page 2; `totalPages` is 2, page 2 has 1 role, and its `id` appears on neither page 1 row                                                                                                                                |
| AC-B05 — `?page=99` is a truthful empty page                      | `listRoles`, `totalPages` from `count`                                             | `curl "$BASE/api/roles?page=99" …` → `200`, `roles: []`, `total: 3`. Not a `404`                                                                                                                                                         |
| AC-B06 — detail deep-equals the list entry                        | `ROLE_SELECT` used by every query                                                  | `jq '.roles[0]'` from the list vs `jq '.role'` from the detail → identical. One shape, one select (FR-7.1)                                                                                                                               |
| AC-B07 — unknown id is 404                                        | `roles.service.getRole` null check                                                 | `curl -i $BASE/api/roles/9999 …` → `404`, body `{code:"NOT_FOUND",message:"Resource not found"}`                                                                                                                                         |
| AC-B08 — `/api/roles/abc` is 400 with `details.roleId`            | `validateParams`, `roleIdParamSchema`                                              | `curl -s $BASE/api/roles/abc … \| jq '.details.roleId'` → non-empty array. **No query runs**; never a 500 from a failed parse (EC-01)                                                                                                    |
| AC-B09 — `?status=PENDING` is 400, not unfiltered                 | `validateQuery`, `listRolesQuerySchema`                                            | `jq '.details.status'` non-empty. A `200` with 3 roles is a failure — the parameter must not be silently ignored (EC-02)                                                                                                                 |
| AC-B10 — `?pageSize=101` is 400, not clamped                      | `listRolesQuerySchema` `.max(100)`                                                 | `curl -i "$BASE/api/roles?pageSize=101" …` → `400`. A `200` with 100 roles is a failure (VAL-5)                                                                                                                                          |
| AC-B11 — create returns 201, status OPEN                          | `roles.service.createRole` (explicit `RoleStatus.OPEN`), `roles.controller.create` | `POST` a valid body with `$REC` → `201`, `status:"OPEN"`, and `id`/`createdAt`/`updatedAt` all present                                                                                                                                   |
| AC-B12 — `status:"CLOSED"` on create is stripped                  | `createRoleSchema` (no `status` key)                                               | `POST {"title":…,"description":…,"status":"CLOSED"}` → `201` with `status:"OPEN"`. Stripped, **not** an error (EC-06)                                                                                                                    |
| AC-B13 — whitespace title is 400, no row written                  | `titleField` `.trim().min(1)`                                                      | `POST {"title":"   ",…}` → `400`, `details.title` non-empty; then `SELECT count(*) FROM "Role"` unchanged (EC-12)                                                                                                                        |
| AC-B14 — missing description is 400                               | `createRoleSchema` required `description`                                          | `POST` without `description` → `400`, `details.description` non-empty (FR-1.4)                                                                                                                                                           |
| AC-B15 — `id`/`createdAt` in the body are stripped                | zod unknown-key stripping, `createRoleSchema`                                      | `POST {…, "id":1, "createdAt":"1999-01-01T00:00:00.000Z"}` → `201` with a fresh autoincrement `id` and a `createdAt` of now (SEC-3)                                                                                                      |
| AC-B16 — interviewer POST is 403, no row                          | `roles.routes.ts` `requireRole(UserRole.RECRUITER)`                                | `POST` a **perfectly valid** body with `$INT` → `403 FORBIDDEN`; `SELECT count(*) FROM "Role"` unchanged. _This is the criterion that proves "only recruiters may modify roles"_                                                         |
| AC-B17 — interviewer PATCH is 403, status unchanged               | same                                                                               | `PATCH {"status":"CLOSED"}` with `$INT` → `403`; `SELECT status FROM "Role" WHERE id=…` still `OPEN`                                                                                                                                     |
| AC-B18b — interviewer's bad query is 403, not 400                 | chain order: `requireRole` before `validateQuery`                                  | `GET "$BASE/api/roles?status=PENDING"` with `$INT` → `403`. The same call with `$REC` is a `400` — that contrast is the check (EC-16)                                                                                                    |
| AC-B18 — interviewer PATCH of id 9999 is 403, not 404             | chain order: `requireRole` before `validateParams`                                 | `PATCH $BASE/api/roles/9999` with `$INT` → `403`. A `404` means authorization ran after existence (ERR-4, EC-11)                                                                                                                         |
| AC-B19 — all five endpoints 401 without a header                  | `requireAuth` first in every chain                                                 | Call all five with no `Authorization` → every one `401 UNAUTHENTICATED`. Not `403`, not `404` (AZ-4, EC-10)                                                                                                                              |
| AC-B20 — an interviewer's DELETE is 403, row survives _(revised)_ | `roles.routes.ts` DELETE chain: `requireRole` **before** the controller            | `curl -i -X DELETE $BASE/api/roles/1 -H "authorization: Bearer $INT"` → `403 FORBIDDEN`; then `psql` → the row is still there. A `404` or `409` is a failure — both would mean authorization ran after existence or status (AZ-6, ERR-4) |
| AC-B21 — PATCH title leaves other fields alone                    | `updateRole` writes only present keys                                              | `PATCH {"title":"New title"}` → `200`, title changed, `description` and `status` unchanged, `updatedAt` > `createdAt` (FR-5.4)                                                                                                           |
| AC-B22 — `details` carries **both** fields                        | **`zod-details.ts` — the BE-5 fix**                                                | `PATCH {"title":"","description":""}` → `400` with `details.title` **and** `details.description`, both non-empty arrays. _An empty `details: {}` fails this_ — see § Checks needing particular care                                      |
| AC-B23 — empty `{}` PATCH is 400                                  | `updateRoleSchema` `.refine()`                                                     | `PATCH {}` → `400`. Also check `{"nonsense":1}` → `400`, since stripping leaves an empty patch (VAL-4, EC-05)                                                                                                                            |
| AC-B24 — double close: one transition event, two updates          | `updateRole` transition guard, `role.status_changed`                               | `PATCH {"status":"CLOSED"}` twice → both `200` with `status:"CLOSED"`; the log shows `role.status_changed` **once**, `role.updated` **twice** (EC-07, FR-6.3)                                                                            |
| AC-B25 — a 20-row page costs exactly 2 SQL statements             | `listRoles` `$transaction([findMany, count])`                                      | Needs `log: ['query']` added to `src/lib/prisma.ts` temporarily — see § Checks needing particular care. Two statements, then **revert** (PERF-3)                                                                                         |
| AC-B26 — a pre-rename token still works                           | `tokens.ts`, `requireAuth` — claim **value** unchanged                             | Capture a token **before** the migration, apply it, then `GET /api/auth/me` with that same token → `200`, `role:"RECRUITER"`. Order is the test (MIG-2, EC-14)                                                                           |
| AC-B27 — no response carries any user field                       | `ROLE_SELECT`; `Role` has no relation                                              | Exercise all four endpoints and `jq` each body — no `name`, `email`, `passwordHash`, or user id anywhere. Absence is the assertion (SEC-2)                                                                                               |
| AC-B28 — log carries `actorId`, never the text                    | `roles.service` log calls, `changedFields: Object.keys(patch)`                     | Create then close a role; read the log — `role.created` and `role.status_changed` carry the recruiter's `actorId`, and **neither line contains the title or description text** (FR-8.4)                                                  |
| AC-B29 — seed is idempotent                                       | `prisma/seed.ts` `findFirst`-then-`create`                                         | `npm run db:seed && npm run db:seed` on a fresh DB → exit `0` both times; `SELECT count(*) FROM "Role"` is `3` both times (FR-9.3)                                                                                                       |
| AC-B30 — the filtered list uses the index                         | `@@index([status, createdAt])`                                                     | 200 throwaway rows, then `EXPLAIN ANALYZE` — see § Checks needing particular care. Index scan on `Role_status_createdAt_idx`, no sequential scan of `Role` (PERF-1)                                                                      |
| AC-B36 — deleting a CLOSED role is 204 and the row is gone        | `deleteRole`; `rolesController.remove`                                             | Close a role, then `curl -i -X DELETE $BASE/api/roles/$ID -H "authorization: Bearer $REC"` → `204` with a **byte-empty** body; `psql "$DATABASE_URL" -c 'SELECT * FROM "Role" WHERE id = '$ID` → 0 rows (FR-6.6, FR-6.8)                 |
| AC-B37 — deleting an OPEN role is 409 and changes nothing         | the `status !== CLOSED` guard in `deleteRole`                                      | `DELETE` an open role → `409` with `code: "ROLE_NOT_CLOSED"`; then `GET` it → same `status: "OPEN"` and **the same `updatedAt` as before the attempt**. A bumped `updatedAt` means the endpoint touched the row (FR-6.7, EC-14)          |
| AC-B38 — an unknown id is 404, not 409                            | the `null` check **before** the status check in `deleteRole`                       | `curl -i -X DELETE $BASE/api/roles/9999 -H "authorization: Bearer $REC"` → `404 NOT_FOUND`. A `409` means the two checks are in the wrong order (FR-6.9, ERR-5, EC-14b)                                                                  |
| AC-B39 — `role.deleted` carries the actor, never the text         | the post-commit `log.info` in `deleteRole`                                         | Delete a closed role, read the log → exactly one `role.deleted` line with `actorId` and `roleId`, and **no title or description text** on it (FR-8.4, FR-8.5)                                                                            |
| AC-B40 — the second delete is a 404                               | the `null` check in `deleteRole`                                                   | `DELETE` the same closed role twice → `204`, then `404` (EC-14c)                                                                                                                                                                         |
| AC-B41 — a malformed `:roleId` is a 400                           | `validateParams(roleIdParamSchema)` on the DELETE chain                            | `curl -i -X DELETE $BASE/api/roles/abc -H "authorization: Bearer $REC"` → `400 VALIDATION_ERROR` with `roleId` in `details` (FR-3.2)                                                                                                     |
