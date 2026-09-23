import { z } from 'zod';
import { InterviewStatus, InterviewType, PipelineStage } from '../../generated/prisma/enums.js';

/**
 * The validation boundary for all seven endpoints (Validation table).
 *
 * **This is where the brief's §6 check lives for this feature**: a round type or
 * stage outside its enum is rejected *before any business logic runs* (VAL-1).
 * `{"type":"COFFEE_CHAT"}` never reaches Prisma and produces no `interview.*`
 * log line (AC-B03).
 *
 * Unknown keys are dropped, as everywhere else in this codebase (VAL-5). A body
 * of `{"interviewerId":5,"assignedByUserId":999}` reaches the service as
 * `{ interviewerId: 5 }` — the tampered field is not rejected, it simply does
 * not exist by the time any code could read one (AZ-7, AC-B37).
 *
 * Validation runs AFTER `requireAuth` and `requireRole` (BE-5, VAL-4), so an
 * interviewer POSTing a malformed body gets `403`, not a `400` that would teach
 * them the shape.
 *
 * This is zod v4: enum messages are `z.enum(Values, 'message')`, not
 * `z.nativeEnum` or `{ message: … }`.
 */

const TYPE_MESSAGE =
  'Type must be one of PHONE_SCREEN, TECHNICAL, SYSTEM_DESIGN, CULTURE_FIT, HIRING_MANAGER';
const STAGE_MESSAGE = 'Stage must be one of APPLIED, SCREEN, INTERVIEW, OFFER';

/** Coerced here, so `/api/interviews/abc` is a 400 at the boundary rather than a
 *  500 further down. */
export const interviewIdParamSchema = z.object({
  interviewId: z.coerce
    .number('Interview id must be a positive integer')
    .int('Interview id must be a positive integer')
    .positive('Interview id must be a positive integer'),
});

/**
 * The two application-nested routes' path parameter.
 *
 * Declared here rather than imported from `pipeline.schema.ts`, which exports an
 * identical shape: this module must not depend on that one to validate its own
 * boundary, and five lines of coercion are cheaper than the coupling.
 */
export const applicationIdParamSchema = z.object({
  applicationId: z.coerce
    .number('Application id must be a positive integer')
    .int('Application id must be a positive integer')
    .positive('Application id must be a positive integer'),
});

/** `DELETE /api/interviews/:interviewId/assignments/:userId` — both params. */
export const assignmentParamsSchema = z.object({
  interviewId: z.coerce
    .number('Interview id must be a positive integer')
    .int('Interview id must be a positive integer')
    .positive('Interview id must be a positive integer'),
  userId: z.coerce
    .number('User id must be a positive integer')
    .int('User id must be a positive integer')
    .positive('User id must be a positive integer'),
});

/**
 * A new round (FR-1.6).
 *
 * There is no `status` field: every round is created `SCHEDULED` by a literal in
 * the service (FR-1.5). There is no `createdByUserId` field either — the actor
 * is `req.user.id` and nothing in a body can set it (AZ-7).
 *
 * **`scheduledAt` has no `.min(new Date())` refinement, deliberately** (VAL-3,
 * FR-1.7). Backfilling a round that already happened is a normal thing to do,
 * and refusing it would push recruiters to lie about the date.
 *
 * `z.iso.datetime()` before the coercion, so `{"scheduledAt": null}` and
 * `{"scheduledAt": 0}` are 400s rather than `new Date(null)` quietly becoming
 * the epoch. The contract is an ISO 8601 string (XFE-9); this is that contract
 * stated where it is enforced.
 */
export const createInterviewSchema = z.object({
  type: z.enum(InterviewType, TYPE_MESSAGE),
  stage: z.enum(PipelineStage, STAGE_MESSAGE),
  scheduledAt: z.iso
    .datetime({ offset: true, message: 'Scheduled time must be an ISO 8601 datetime' })
    .transform((value) => new Date(value)),
});

/**
 * A round's status change (FR-2.1).
 *
 * **The enum is the two TERMINAL values only.** `{"status":"SCHEDULED"}` is a
 * `400`, not a `409`: un-cancelling is not a supported action, and a validation
 * error states that more clearly than a conflict would (VAL-2, AC-B41,
 * mirroring pipeline VAL-4).
 */
export const updateInterviewStatusSchema = z.object({
  status: z.enum(
    [InterviewStatus.COMPLETED, InterviewStatus.CANCELLED],
    'Status must be one of COMPLETED, CANCELLED',
  ),
});

/**
 * An assignment (FR-3.2).
 *
 * `interviewerId` is the only field. Whether that user is actually an
 * `INTERVIEWER` is not a zod concern — it is resolved by a `where` in the
 * service that simply does not match anybody else (FR-3.3).
 */
export const assignInterviewerSchema = z.object({
  interviewerId: z.coerce
    .number('Interviewer id must be a positive integer')
    .int('Interviewer id must be a positive integer')
    .positive('Interviewer id must be a positive integer'),
});

/**
 * The list's three optional filters and its pager (FR-4.4).
 *
 * An interviewer may pass every one of these. They ARE ANDed with that
 * interviewer's assignment predicate in `buildInterviewWhere`, so a filter can
 * narrow within their own rounds and can never widen beyond them (FR-4.2,
 * EC-06) — which is why none of them needs to be rejected here.
 *
 * `?pageSize=101` is a 400, never a silent clamp (VAL-7), matching
 * `listRolesQuerySchema`.
 */
export const listInterviewsQuerySchema = z.object({
  status: z
    .enum(InterviewStatus, 'Status must be one of SCHEDULED, COMPLETED, CANCELLED')
    .optional(),
  applicationId: z.coerce
    .number('Application id must be a positive integer')
    .int('Application id must be a positive integer')
    .positive('Application id must be a positive integer')
    .optional(),
  roleId: z.coerce
    .number('Role id must be a positive integer')
    .int('Role id must be a positive integer')
    .positive('Role id must be a positive integer')
    .optional(),
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

export type InterviewIdParam = z.infer<typeof interviewIdParamSchema>;
export type ApplicationIdParam = z.infer<typeof applicationIdParamSchema>;
export type AssignmentParams = z.infer<typeof assignmentParamsSchema>;
export type CreateInterviewInput = z.infer<typeof createInterviewSchema>;
export type UpdateInterviewStatusInput = z.infer<typeof updateInterviewStatusSchema>;
export type AssignInterviewerInput = z.infer<typeof assignInterviewerSchema>;
export type ListInterviewsQuery = z.infer<typeof listInterviewsQuerySchema>;
