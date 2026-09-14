---
description: Spec-Driven Development phase 3 — implement the approved spec + plan, verify every acceptance criterion
argument-hint: [feature-name]
---

We are now in the **implementation phase** for the backend.

Feature:

$ARGUMENTS

If I gave you no feature name above, list the folders under `specs/features/` and ask me which one to implement.

---

## Step 1 — Read the spec and the plan

Read both in full. They are the source of truth; nothing you build may exceed or contradict them.

- `specs/features/[feature-name]/spec.md` — **what** and **why**
- `specs/features/[feature-name]/plan.md` — **how**, including the Acceptance Criteria Mapping table

Also read, for cross-boundary context (paths relative to this repo's root; skip any not present):

- `../frontend/specs/features/[feature-name]/spec.md` — the other half of the shared API contract
- `CLAUDE.md` — layering, the query-level data-exclusion rule, migration and security rules
- `../recruitment-pipeline.md` — the POC brief

**If the plan is not approved, or is insufficient to implement reliably, stop.** Do not fill gaps by assuming. List the exact questions, then wait. Where the spec and the plan disagree, **the spec wins** — say so and stop rather than picking one silently.

---

## Rules

1. **Do not expand scope.** Only what the plan lists gets built. No speculative endpoints, no unrelated refactors, no drive-by "while I was in here" changes.
2. **Do not invent unspecified product behavior.** If the spec is silent on a behaviour you need, stop and ask — a guess becomes an undocumented contract.
3. **Do not silently modify the specification.** If implementation proves the spec wrong, say so, propose the spec change, and get it approved before coding around it. Never let code and spec drift.
4. **Follow the existing project architecture.** Route handlers own HTTP concerns only; business logic, authorization scoping and audit writes live in the service layer. Validation sits at the route boundary.
5. **Reuse existing patterns.** Before writing a new service, middleware, error helper or validation schema, find the existing one and use it. The plan's **reuses** entries are binding.
6. **Make the smallest clean changes necessary.** Preserve existing behavior in every file you touch unless the spec explicitly changes it.
7. **Implement acceptance criteria one by one**, in the plan's **## Implementation Order**.
8. **Verify every acceptance criterion by hand** after implementation, using the plan's manual verification table (see Step 3).
9. Run linting and type checking.
10. Run the production build where appropriate.

**Never disable a validation or authorization check, loosen a type, or add an `eslint-disable` to make a check pass.** If something won't pass honestly, stop and say why.

**Never hard-code a secret, trust a client-supplied role or user ID for authorization, or log credentials, contact details or raw feedback.**

---

## Step 2 — Implement

Work through **## Implementation Order** from `plan.md`. Schema and migrations before services; services before routes. Each step must leave the repo type-checking.

For **each acceptance criterion** (`AC-B01…`):

1. **Implement it** — the files named in the plan's **## Backend Changes**, and no others. If you need a file the plan doesn't list, that's a scope question: stop and ask.
2. **Fix failures** — fix the cause, not the symptom. A failure that reveals a spec gap goes back to rule 3.
3. **Verify it** — run the criterion's exact row from the plan's manual verification table and observe the real result: status code, headers, body, row counts.

Database work:

- Edit `prisma/schema.prisma`, then create the migration with `npx prisma migrate dev --name <name-from-plan>`.
- **Never hand-edit a generated migration**, never edit `src/generated/prisma`, and never drop existing data as a shortcut.
- If a migration in the plan is destructive, flag it and get confirmation before running it.

Track progress with a todo list — one item per acceptance criterion — so the state of the work is visible.

---

## Step 3 — Verify

Run the commands from the plan's **## Verification Commands**, in order. At minimum:

```bash
npm run lint            # eslint
npx tsc --noEmit        # type check
npm run format:check    # prettier
npm run build           # production build (tsc)
```

Note what must be running first (Postgres; the API on its port for any `curl` row).

Then work the **manual verification table** row by row against the running API. Every row needs a real command and a real observed result. Cover, explicitly:

- **Negatives** — wrong role → `403`, no token → `401`, tampered body ignored.
- **Absence** — the restricted-field invariant: contact details appear in **no** response from any endpoint.
- **Query-level exclusion** — an interviewer requesting an unassigned candidate **by ID** is refused at the query, not filtered afterwards. Prove it, don't assert it.
- **Concurrency** — fired genuinely concurrently, not two sequential requests.

**Do not claim something is verified unless you actually ran it and saw the result.** If a check can't be run — Postgres isn't up, a seed is missing, it depends on unimplemented frontend work — say exactly that and mark the criterion **unverified**. An unverified criterion is a normal, reportable outcome; a falsely verified one is not.

---

## Step 4 — After implementing

1. Confirm **every** acceptance criterion in `spec.md` is either implemented and verified, or explicitly listed as unverified with the reason.
2. Confirm no file was changed that the plan didn't call for.
3. Confirm the API contract as built matches `spec.md` **## API Contract** exactly — path, method, status codes, error `code` values, header and cookie names. Any divergence breaks the frontend, which agreed to this contract by hand; flag it loudly and note that both repos must change together.
4. Update the feature status table in `CLAUDE.md` (the `code` column).
5. Report plainly:
   - what you changed, by path
   - which acceptance criteria are verified, and the evidence for each
   - which are unverified, and why
   - lint / type-check / build results, as they actually came out
   - any deviation from the spec or plan, and any question still open

Do not paper over a gap between the spec and what got built.
