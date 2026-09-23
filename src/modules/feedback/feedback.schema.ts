import { z } from 'zod';

/**
 * The validation boundary for all three endpoints (Validation table).
 *
 * **This is where the brief's §6 check lives for this feature**: a rating of 0,
 * 6 or 4.5, and an empty `notes`, are rejected *before any business logic runs*
 * — before the round is even looked up (VAL-7). The database `CHECK` constraint
 * (MIG-4) is the second line of defence, not the first: it exists because zod
 * guards only HTTP, and the seed, `psql` and any future admin path are not HTTP.
 *
 * Unknown keys are dropped, as everywhere else in this codebase (VAL-4). A body
 * of `{"rating":4,"notes":"…","interviewerId":9,"id":1}` reaches the service as
 * `{ rating, notes }` — the tampered fields are not rejected, they simply do not
 * exist by the time any code could read one (FR-2.5, AZ-8, AC-B09).
 *
 * Validation runs AFTER `requireAuth` and `requireRole` (BE-4, VAL-6), so a
 * recruiter POSTing a malformed body gets `403`, not a `400` that would teach
 * them a contract they may not use (AC-B32). It runs BEFORE the assignment
 * lookup (VAL-7), so an unassigned interviewer's malformed body is `400` rather
 * than `404` — the body shape is not a secret, and the `400` is identical
 * whether or not the round exists.
 */

const RATING_MESSAGE = 'Rating must be an integer between 1 and 5';
const NOTES_MESSAGE = 'Notes must be between 1 and 5000 characters';

/**
 * `z.number().int()`, **not** `z.coerce.number()` (VAL-1).
 *
 * A body of `{"rating":"4"}` is a `400`. Coercion is right for query strings and
 * path parameters, which are always text; it is wrong for a JSON body, where a
 * string rating means the client is confused about its own contract — and
 * quietly accepting it hides that for as long as the confusion is harmless.
 */
const ratingField = z
  .number(RATING_MESSAGE)
  .int(RATING_MESSAGE)
  .min(1, RATING_MESSAGE)
  .max(5, RATING_MESSAGE);

/**
 * Trimmed BEFORE the length check, so `"   "` is a `400` rather than a stored
 * blank (VAL-3, EC-17). The trimmed value is what reaches the service —
 * `validate` replaces `req.body` with the parse result, so no code path further
 * in can forget to normalise.
 */
const notesField = z.string(NOTES_MESSAGE).trim().min(1, NOTES_MESSAGE).max(5000, NOTES_MESSAGE);

/**
 * The path parameter shared by all three routes.
 *
 * Coerced here, so `/api/interviews/abc/feedback` is a `400` at the boundary
 * rather than a `500` further down. Declared in this module rather than imported
 * from `interviews.schema.ts`, which exports an identical shape: this module
 * must not depend on that one to validate its own boundary, and five lines of
 * coercion are cheaper than the coupling — the same call the interviews module
 * itself made about the pipeline's application-id schema.
 */
export const interviewIdParamSchema = z.object({
  interviewId: z.coerce
    .number('Interview id must be a positive integer')
    .int('Interview id must be a positive integer')
    .positive('Interview id must be a positive integer'),
});

/**
 * A submission (FR-2.1). Both fields required.
 *
 * There is **no `interviewerId` field, and there must never be one**: the author
 * is `req.user.id` and nothing in a body can set it (FR-2.5, AZ-8). There is no
 * `interviewId` field either — the round is the path, because feedback is always
 * reached through its round (FR-6.2).
 *
 * `notes` is required rather than optional (FR-2.4). A rating with no words is
 * not structured feedback, it is a number, and a hiring manager cannot act on a
 * number.
 */
export const createFeedbackSchema = z.object({
  rating: ratingField,
  notes: notesField,
});

/**
 * An edit (FR-4.1). Any non-empty subset of the two fields.
 *
 * The `.refine()` runs after unknown keys are stripped, so `{"nonsense":1}` is
 * rejected just like `{}`. That issue has no field path, so it is keyed `_` in
 * the error `details` — matching `updateRoleSchema` and the `zod-details`
 * convention (VAL-5, AC-B29).
 */
export const updateFeedbackSchema = z
  .object({
    rating: ratingField.optional(),
    notes: notesField.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one of rating, notes');

export type InterviewIdParam = z.infer<typeof interviewIdParamSchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export type UpdateFeedbackInput = z.infer<typeof updateFeedbackSchema>;
