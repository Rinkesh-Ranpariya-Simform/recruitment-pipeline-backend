import { z } from 'zod';
import { ApplicationStatus, PipelineStage } from '../../../generated/prisma/enums.js';

/**
 * The validation boundary for all three endpoints.
 *
 * Unknown keys are dropped, as everywhere else in this codebase. That is how
 * **`name`, `email` and `role` are kept out of the `PATCH`**: a body of
 * `{"phone":"+1","email":"attacker@evil.test","role":"RECRUITER"}` reaches the
 * service as `{ phone: '+1' }` — the tampered fields are not rejected, they
 * simply do not exist by the time any code could read one, and the endpoint
 * answers `200` having changed only the phone. **Rejecting would tell an
 * attacker which fields exist; dropping tells them nothing and changes nothing.**
 *
 * Validation runs AFTER `requireAuth` and `requireRole`, so a candidate
 * sending a malformed `PATCH` gets `403` and learns nothing about the body
 * contract.
 *
 * **One rule is not here**: `?q=` from an interviewer is a `400`. It depends on
 * the caller's role, which `validateQuery` cannot see, so it is enforced at the
 * top of `candidate.service.listCandidates` — before any query runs.
 *
 * This is zod v4: enum messages are `z.enum(Values, 'message')`, not
 * `z.nativeEnum` or `{ message: … }`.
 */

const STAGE_MESSAGE = 'Stage must be one of APPLIED, SCREEN, INTERVIEW, OFFER';
const STATUS_MESSAGE = 'Status must be one of ACTIVE, HIRED, REJECTED';

/** Coerced here, so `/api/candidates/abc` is a 400 at the boundary rather than
 *  a 500 further down. */
export const candidateIdParamSchema = z.object({
  candidateId: z.coerce
    .number('Candidate id must be a positive integer')
    .int('Candidate id must be a positive integer')
    .positive('Candidate id must be a positive integer'),
});

/**
 * The list's four optional filters and its pager.
 *
 * `q` follows the shipped `listRolesQuerySchema` convention exactly: trimmed,
 * capped at 120, and an empty term becomes `undefined` so `?q=` renders an
 * unfiltered page rather than searching for nothing.
 *
 * `stage` and `status` come from the shipped Prisma enums, so `?stage=PROBATION`
 * is a `400` before any query runs.
 *
 * `?pageSize=101` is a `400`, never a silent clamp, matching
 * `listRolesQuerySchema`. **This is the only endpoint in the system whose
 * result set scales with the number of people**, which is why it is the only
 * one that must paginate.
 */
export const listCandidatesQuerySchema = z.object({
  q: z
    .string('Search term must be text')
    .trim()
    .max(120, 'Search term must be at most 120 characters')
    .transform((value) => (value === '' ? undefined : value))
    .optional(),
  roleId: z.coerce
    .number('Role id must be a positive integer')
    .int('Role id must be a positive integer')
    .positive('Role id must be a positive integer')
    .optional(),
  stage: z.enum(PipelineStage, STAGE_MESSAGE).optional(),
  status: z.enum(ApplicationStatus, STATUS_MESSAGE).optional(),
  page: z.coerce
    .number('Page must be an integer of at least 1')
    .int('Page must be an integer of at least 1')
    .min(1, 'Page must be an integer of at least 1')
    .default(1),
  pageSize: z.coerce
    .number('Page size must be an integer between 1 and 100')
    .int('Page size must be an integer between 1 and 100')
    .min(1, 'Page size must be an integer between 1 and 100')
    .max(100, 'Page size must be at most 100')
    .default(20),
});

/**
 * The contact patch — **three fields, and only three.**
 *
 * Every one is `.nullable().optional()`, and the pair is load-bearing: an
 * explicit `null` CLEARS a field, an omitted key LEAVES IT UNCHANGED, and the
 * service distinguishes them by `!== undefined` rather than by a sentinel
 * string. "Remove this number" is therefore expressible, and a client editing
 * only the location cannot wipe a phone it never displayed.
 *
 * `.trim()` runs before the length caps, so `"   "` stores an empty string
 * rather than failing — deliberate: there is no `.min(1)` here, because a POC
 * that argues with a recruiter about whitespace is worse than one that stores
 * what they typed. There is **no format validation on `phone`** for the same
 * reason: rejecting a valid international number is the worse failure.
 *
 * The `.refine()` runs after unknown keys are dropped, so `{}` — and a body
 * carrying nothing but `name`/`email`/`role` — is a `400`. That issue has no
 * field path, so it is keyed `_` in `details`, matching `updateRoleSchema` and
 * the `zod-details` convention.
 */
export const updateCandidateContactSchema = z
  .object({
    phone: z
      .string('Phone must be text')
      .trim()
      .max(40, 'Phone must be at most 40 characters')
      .nullable()
      .optional(),
    location: z
      .string('Location must be text')
      .trim()
      .max(120, 'Location must be at most 120 characters')
      .nullable()
      .optional(),
    headline: z
      .string('Headline must be text')
      .trim()
      .max(200, 'Headline must be at most 200 characters')
      .nullable()
      .optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one of phone, location, headline',
  );

export type CandidateIdParam = z.infer<typeof candidateIdParamSchema>;
export type ListCandidatesQuery = z.infer<typeof listCandidatesQuerySchema>;
export type UpdateCandidateContactInput = z.infer<typeof updateCandidateContactSchema>;
