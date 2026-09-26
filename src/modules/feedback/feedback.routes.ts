import { Router } from 'express';
import { UserRole } from '../../../generated/prisma/enums.js';
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
 * Feedback router mounted under `/api/interviews/:interviewId/feedback`.
 *
 * Middleware pipeline order:
 * 1. `requireAuth`: Ensures user is logged in.
 * 2. `requireRole`: Authorizes roles based on action (interviewers for write/patch, recruiters & interviewers for read).
 * 3. `validateParams`: Validates `:interviewId` route parameter.
 * 4. `validate`: Validates request body schema.
 */
export const feedbackRouter = Router({ mergeParams: true });

/** POST /api/interviews/:interviewId/feedback: Submits feedback for an interview round. */
feedbackRouter.post(
  '/',
  requireAuth,
  requireRole(UserRole.INTERVIEWER),
  validateParams(interviewIdParamSchema),
  validate(createFeedbackSchema),
  feedbackController.submit,
);

/** PATCH /api/interviews/:interviewId/feedback: Updates author's existing feedback for an interview round. */
feedbackRouter.patch(
  '/',
  requireAuth,
  requireRole(UserRole.INTERVIEWER),
  validateParams(interviewIdParamSchema),
  validate(updateFeedbackSchema),
  feedbackController.update,
);

/** GET /api/interviews/:interviewId/feedback: Lists all feedback entries for an interview round. */
feedbackRouter.get(
  '/',
  requireAuth,
  requireRole(UserRole.INTERVIEWER, UserRole.RECRUITER),
  validateParams(interviewIdParamSchema),
  feedbackController.list,
);
