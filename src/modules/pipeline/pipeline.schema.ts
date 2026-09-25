import { z } from 'zod';
import { ApplicationStatus, PipelineStage } from '../../../generated/prisma/enums.js';

/**
 * The validation boundary for all five endpoints (Validation table).
 *
 * **This is where the brief's §6 check lives**: a transition naming a stage
 * that isn't defined is rejected *before any business logic runs* (VAL-1).
 * `{ "toStage": "PROBATION" }` never reaches `pipeline.rules`, never reaches
 * Prisma, and produces no `pipeline.*` log line.
 *
 * Unknown keys are stripped, as everywhere else in this codebase (VAL-5). A
 * body of `{ toStage: 'SCREEN', performedBy: 9, currentStage: 'OFFER' }`
 * reaches the service as `{ toStage: 'SCREEN' }` — the tampered fields are not
 * rejected, they simply do not exist by the time any code could read one.
 *
 * This is zod v4: enum messages are `z.enum(Values, 'message')`, not
 * `z.nativeEnum` or `{ message: … }`.
 */

const STAGE_MESSAGE = 'Stage must be one of APPLIED, SCREEN, INTERVIEW, OFFER';

/** Coerced here, so `/api/applications/abc/stage` is a 400 at the boundary
 *  rather than a 500 further down (EC-06). */
export const applicationIdParamSchema = z.object({
  applicationId: z.coerce
    .number('Application id must be a positive integer')
    .int('Application id must be a positive integer')
    .positive('Application id must be a positive integer'),
});

/**
 * A legal move along the graph. There is no `fromStage` field: the current
 * stage is read from the row, never supplied by the client — a caller who
 * could name both ends could name a pair the row is not actually at.
 */
export const changeStageSchema = z.object({
  toStage: z.enum(PipelineStage, STAGE_MESSAGE),
});

/**
 * The override (FR-4.3, VAL-2, brief §3.3).
 *
 * **`reason` is required and is 10 characters minimum after trimming.** The
 * trim is in the schema, so `"   "` is a 400 rather than an empty recorded
 * reason, and the service never sees an untrimmed value. The minimum is
 * deliberate rather than cosmetic: it makes `"ok"` and `"."` fail, which is the
 * difference between recording a reason and recording a keystroke.
 *
 * This is the first of the three places the rule is enforced. The second is the
 * `NOT NULL` column; the third is that the override row is inserted before the
 * stage moves, so a move can never commit without its explanation.
 */
export const stageOverrideSchema = z.object({
  toStage: z.enum(PipelineStage, STAGE_MESSAGE),
  reason: z
    .string('Give a reason of at least 10 characters')
    .trim()
    .min(10, 'Give a reason of at least 10 characters')
    .max(1000, 'Reason must be at most 1000 characters'),
});

/**
 * The outcome (FR-3.2, FR-3.6, VAL-3, VAL-4).
 *
 * `status` accepts the two TERMINAL values only. `{ "status": "ACTIVE" }` is a
 * 400 and not a resurrection: un-rejecting a candidate is out of scope, and a
 * validation error states that more clearly than a 409 would.
 *
 * `reason` is optional here, unlike on the override, and carries no minimum
 * (VAL-3). Rejecting at the end of a stage is not an exception to the process;
 * skipping one is. It is recorded in the audit metadata when present.
 */
export const setOutcomeSchema = z.object({
  status: z.enum(
    [ApplicationStatus.HIRED, ApplicationStatus.REJECTED],
    'Status must be one of HIRED, REJECTED',
  ),
  reason: z
    .string('Reason must be text')
    .trim()
    .max(1000, 'Reason must be at most 1000 characters')
    .optional(),
});

/**
 * The aggregate's two filters (FR-7.2).
 *
 * Both optional and both ANDed — they sit on different columns, so assigning
 * each is already a conjunction and one can never overwrite the other.
 *
 * There is no `page`/`pageSize` here, deliberately (FR-7.9): the response is
 * one row per role per stage, bounded by roles rather than by the 20,000
 * candidates behind them. PERF-5 names 500 roles as the threshold at which that
 * stops being true and this gains a pager.
 */
export const pipelineQuerySchema = z.object({
  roleId: z.coerce
    .number('Role id must be a positive integer')
    .int('Role id must be a positive integer')
    .positive('Role id must be a positive integer')
    .optional(),
  stage: z.enum(PipelineStage, STAGE_MESSAGE).optional(),
});

export type ApplicationIdParam = z.infer<typeof applicationIdParamSchema>;
export type ChangeStageInput = z.infer<typeof changeStageSchema>;
export type StageOverrideInput = z.infer<typeof stageOverrideSchema>;
export type SetOutcomeInput = z.infer<typeof setOutcomeSchema>;
export type PipelineQuery = z.infer<typeof pipelineQuerySchema>;
