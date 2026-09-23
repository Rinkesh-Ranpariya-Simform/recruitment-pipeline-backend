import { Router } from 'express';
import { UserRole } from '../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { validateParams } from '../../middleware/validateParams.js';
import * as feedbackController from './feedback.controller.js';
import {
  createFeedbackSchema,
  interviewIdParamSchema,
  updateFeedbackSchema,
} from './feedback.schema.js';

/**
 * Three verbs on one path, mounted under `/api/interviews/:interviewId/feedback`
 * by `interviews.routes.ts` (BE-3).
 *
 * **The path shape is the authorization model made visible.** Feedback is always
 * reached through its round, so the authorization question is always the same
 * question: _is this caller on that round's panel_ (FR-6.2). There is no
 * `GET /api/feedback` and no `GET /api/feedback/:id`, and both answer `404` from
 * the shipped `notFound` handler (AC-B41).
 *
 * **There is no `DELETE`** (FR-6.1, D-14). Retracting an assessment without a
 * trace is the opposite of what the brief's §6 asks for; an interviewer who
 * changes their mind edits, and the edit is audited. The absence IS the
 * guarantee — a `DELETE` here answers `404` from `notFound` (EC-18, AC-B40).
 *
 * `mergeParams`, because `:interviewId` belongs to the parent router. Without it
 * `validateParams` would see an empty object and every request would be a `400`.
 *
 * Middleware order is load-bearing (BE-4, VAL-6, VAL-7):
 * `requireAuth` → `requireRole` → `validateParams` → `validate`.
 *
 *   - An anonymous caller is always `401`, a wrong-role caller always `403`,
 *     whether or not their body is also malformed — so a recruiter POSTing
 *     nonsense gets `403` and learns nothing about a contract they may not use
 *     (AC-B32).
 *   - Validation still runs **before** the assignment lookup, so an unassigned
 *     interviewer's malformed body is `400`, not `404`. The body shape is not a
 *     secret, the brief's §6 asks for bad input to be rejected before business
 *     logic, and the `400` is identical whether or not the round exists.
 *
 * **`POST` and `PATCH` are `requireRole(INTERVIEWER)`, and a recruiter is `403`**
 * (AZ-5, EC-09). They did not conduct the interview. An assessment a recruiter
 * can write or rewrite is not an assessment, and that guard is what makes the
 * audit trail worth reading.
 *
 * **`GET` admits both, and does its scoping in the query.** A recruiter reads
 * any round; an interviewer reads only rounds they are assigned to, and their
 * miss is `404` rather than `403` — a `403` would confirm the round exists and
 * turn the endpoint into an enumeration oracle (AZ-3, AZ-4, AZ-7). A candidate
 * is `403` on all three, including on feedback about themselves (AZ-10).
 */
export const feedbackRouter = Router({ mergeParams: true });

/** `201`. The duplicate refusal is the unique index, never a preceding read (FR-3.3). */
feedbackRouter.post(
  '/',
  requireAuth,
  requireRole(UserRole.INTERVIEWER),
  validateParams(interviewIdParamSchema),
  validate(createFeedbackSchema),
  feedbackController.submit,
);

/** `200`. The author's own row only, with ownership in the `where` (FR-4.2, AZ-6). */
feedbackRouter.patch(
  '/',
  requireAuth,
  requireRole(UserRole.INTERVIEWER),
  validateParams(interviewIdParamSchema),
  validate(updateFeedbackSchema),
  feedbackController.update,
);

/** `200 { feedback: [...] }`, unpaginated — a panel is single digits (FR-5.7). */
feedbackRouter.get(
  '/',
  requireAuth,
  requireRole(UserRole.INTERVIEWER, UserRole.RECRUITER),
  validateParams(interviewIdParamSchema),
  feedbackController.list,
);
