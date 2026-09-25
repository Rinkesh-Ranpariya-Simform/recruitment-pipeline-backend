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
 * HTTP only: read the request, call a service, shape a response (BE-1). No
 * scoping, no Prisma, no transactions — the assignment predicate lives in
 * `feedback.repository.ts` and nowhere else (BE-2, AZ-2). **No handler composes
 * it**, and nothing here inspects a fetched row and decides what to send.
 *
 * Handlers don't catch — Express 5 forwards a rejected promise to the error
 * middleware, which is what keeps a Prisma code off the wire (ERR-6).
 *
 * Input comes from `req.validatedParams` and `req.body`, never the raw
 * `req.params`, whose values are un-coerced strings. Each cast is safe because
 * the route that reaches a handler is the route that installed its schema.
 */

/**
 * The author of every row this feature writes, and the subject every scoped
 * lookup resolves against (FR-2.5, AZ-8).
 *
 * `req.user.id`, established by `requireAuth` from a verified token, and
 * **nothing else**. No body, query parameter or header supplies one — which is
 * why `interviewerId` is not a field in `createFeedbackSchema` and why a body
 * carrying one changes nothing (AC-B09).
 */
function actorId(req: Request): number {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.id;
}

/**
 * The caller's role, which the read scopes by.
 *
 * Read from `req.user` — a verified token claim — and never from anything the
 * caller controls. A client cannot ask to be read as a recruiter.
 */
function actorRole(req: Request): UserRole {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.role;
}

/**
 * `201` with the created row and its author expanded (FR-2.9).
 *
 * The body is complete enough for a client to append optimistically, though
 * invalidating its feedback query is equally correct (XFE-11). There is no
 * candidate field anywhere in it (AC-B33).
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
 * `200` with the whole row, not a diff, so the client doesn't have to merge its
 * own patch into cached state.
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
 * `200 { feedback: [...] }` — **no pagination envelope** (FR-5.7, XFE-9). A
 * round's panel is single digits, bounded by the unique index and by how many
 * interviewers a recruiter assigns.
 *
 * An empty round is `200` with `feedback: []`, never a `404`, provided the
 * caller may see the round at all (FR-5.8).
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
