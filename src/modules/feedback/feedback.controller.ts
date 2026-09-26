import type { Request, Response } from 'express';
import type { UserRole } from '../../../generated/prisma/enums.js';
import { UnauthenticatedError } from '../../lib/errors.js';
import * as feedbackService from './feedback.service.js';
import type {
  CreateFeedbackInput,
  InterviewIdParam,
  UpdateFeedbackInput,
} from './feedback.schema.js';

/**
 * Feedback controller handling HTTP request parsing and response formatting.
 * Business logic and authorization predicates are handled in the service and repository layers.
 * Unhandled rejections propagate to the error middleware for uniform error responses.
 */

/**
 * Extracts and returns the authenticated user's ID from the request.
 * Throws an UnauthenticatedError if no authenticated user is present.
 */
function actorId(req: Request): number {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.id;
}

/**
 * Extracts and returns the authenticated user's role from the request.
 * Throws an UnauthenticatedError if no authenticated user is present.
 */
function actorRole(req: Request): UserRole {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.role;
}

/**
 * Handles feedback submission for an interview.
 * Returns 201 Created with the created feedback record and expanded author details.
 */
export async function submit(req: Request, res: Response): Promise<void> {
  const { interviewId } = req.validatedParams as InterviewIdParam;

  const feedback = await feedbackService.submitFeedback(
    interviewId,
    req.body as CreateFeedbackInput,
    actorId(req),
    req.log,
  );

  res.status(201).json({ feedback });
}

/**
 * Handles updating an existing feedback record.
 * Returns 200 OK with the updated feedback record.
 */
export async function update(req: Request, res: Response): Promise<void> {
  const { interviewId } = req.validatedParams as InterviewIdParam;

  const feedback = await feedbackService.updateFeedback(
    interviewId,
    req.body as UpdateFeedbackInput,
    actorId(req),
    req.log,
  );

  res.status(200).json({ feedback });
}

/**
 * Handles listing feedback records for an interview round.
 * Returns 200 OK with an array of feedback entries visible to the user's role.
 */
export async function list(req: Request, res: Response): Promise<void> {
  const { interviewId } = req.validatedParams as InterviewIdParam;

  const feedback = await feedbackService.listRoundFeedback(
    interviewId,
    actorRole(req),
    actorId(req),
    req.log,
  );

  res.status(200).json({ feedback });
}
