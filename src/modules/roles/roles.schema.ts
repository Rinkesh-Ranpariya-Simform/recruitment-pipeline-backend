import { z } from 'zod';
import { RoleStatus } from '../../../generated/prisma/enums.js';

/**
 * All schemas here strip unknown keys (zod's default), so an unexpected field
 * never reaches a Prisma `data` object.
 *
 * This is zod v4: enum messages use `z.enum(Values, 'message')`, not
 * `z.nativeEnum` or `{ message: … }`.
 */

/**
 * Shared by create and patch so the two can't drift.
 *
 * Trimming happens in the schema, so services always see the normalised value
 * and a title of `"   "` fails `min(1)` after the trim.
 */
const titleField = z
  // Every message is user-facing: the client renders `details` straight onto
  // form fields, so the `z.string()` message matters too — it's what a missing
  // or non-string title shows instead of zod's default wording.
  .string('Title is required')
  .trim()
  .min(1, 'Title is required')
  .max(120, 'Title must be at most 120 characters');

/**
 * Required and non-empty — a requisition with no description isn't useful to
 * anyone but the person who created it.
 *
 * The 5000 cap is a validation rule rather than a column type, so it can change
 * without a migration. Over-long input is a 400, never a silent truncation.
 */
const descriptionField = z
  .string('Description is required')
  .trim()
  .min(1, 'Description is required')
  .max(5000, 'Description must be at most 5000 characters');

/**
 * No `status` field: every role is created OPEN, and closing one is a separate
 * action.
 */
export const createRoleSchema = z.object({
  title: titleField,
  description: descriptionField,
});

/**
 * Any non-empty subset of the three fields.
 *
 * The `.refine()` runs after unknown keys are stripped, so `{ "nonsense": 1 }`
 * is rejected just like `{}`. That issue has no field path, so it is keyed `_`
 * in the error `details`.
 */
export const updateRoleSchema = z
  .object({
    title: titleField.optional(),
    description: descriptionField.optional(),
    status: z.enum(RoleStatus, 'Status must be one of OPEN, CLOSED').optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one of title, description, status',
  );

/** Coerced here, so a non-numeric or non-positive `:roleId` is a 400 at the
 *  boundary rather than a 500 further down. */
export const roleIdParamSchema = z.object({
  roleId: z.coerce
    .number('Role id must be a positive integer')
    .int('Role id must be a positive integer')
    .positive('Role id must be a positive integer'),
});

/**
 * An omitted `status` means all statuses, not a hidden default of OPEN — that
 * would hide closed roles without explaining why.
 *
 * `.default()` handles `undefined` before coercion, so an omitted `page` is 1
 * and never `NaN`.
 */
export const listRolesQuerySchema = z.object({
  /**
   * Title search (candidate spec FR-4.6, VAL-2, VAL-3).
   *
   * Capped at 120 — the same ceiling as `title`, since a term longer than the
   * column it searches cannot match anything and should not reach the database.
   *
   * `.transform` turns a term that is empty after trimming into `undefined`, so
   * `?q=` and no `q` at all produce the same page and a client clearing its
   * search box needs no special case (EC-13).
   */
  q: z
    .string('Search term must be text')
    .trim()
    .max(120, 'Search term must be at most 120 characters')
    .transform((value) => (value === '' ? undefined : value))
    .optional(),
  status: z.enum(RoleStatus, 'Status must be one of OPEN, CLOSED').optional(),
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

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type RoleIdParam = z.infer<typeof roleIdParamSchema>;
export type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;
