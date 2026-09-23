import type { Request, Response } from 'express';
import type { UserRole } from '../../generated/prisma/enums.js';
import { UnauthenticatedError } from '../../lib/errors.js';
import * as interviewsService from './interviews.service.js';
import type {
  ApplicationIdParam,
  AssignInterviewerInput,
  AssignmentParams,
  CreateInterviewInput,
  InterviewDecisionInput,
  InterviewIdParam,
  ListInterviewsQuery,
  UpdateInterviewStatusInput,
} from './interviews.schema.js';

/**
 * HTTP only: read the request, call a service, shape a response (BE-1). No
 * scoping, no Prisma, no transactions — the interviewer predicate lives in
 * `interviews.repository.ts` and nowhere else (BE-3, AZ-4).
 *
 * **Nothing here filters a response.** The two reads pass `req.user.role` down
 * so the SERVICE can pick a projection before its query runs; no handler
 * inspects a fetched round and decides what to send (BE-4, FR-5.4).
 *
 * Handlers don't catch — Express 5 forwards a rejected promise to the error
 * middleware, which is what keeps a Prisma code off the wire (ERR-5).
 *
 * Input comes from `req.validatedParams`, `req.validatedQuery` and `req.body`,
 * never the raw `req.params` / `req.query`, which are un-coerced strings. Each
 * cast is safe because the route that reaches a handler is the route that
 * installed its schema.
 */

/**
 * The actor on every row this feature writes, and the subject every scoped read
 * resolves against (AZ-7, SEC-8).
 *
 * `req.user.id`, established by `requireAuth` from a verified token, and
 * **nothing else**. No body, query parameter or header supplies one.
 */
function actorId(req: Request): number {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.id;
}

/**
 * The caller's user role, which the two reads scope and project by.
 *
 * Read from `req.user` — a verified token claim — and never from a request the
 * caller controls. A client cannot ask for the recruiter projection.
 */
function actorRole(req: Request): UserRole {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.role;
}

/** 201 with the created round, `status: "SCHEDULED"` and an empty panel (AC-B01). */
export async function create(req: Request, res: Response): Promise<void> {
  const { applicationId } = req.validatedParams as ApplicationIdParam;

  const interview = await interviewsService.createInterview(
    applicationId,
    req.body as CreateInterviewInput,
    actorId(req),
    req.log,
  );

  res.status(201).json({ interview });
}

/** Unpaged — bounded by the rounds on one application (PERF-8). */
export async function listForApplication(req: Request, res: Response): Promise<void> {
  const { applicationId } = req.validatedParams as ApplicationIdParam;

  const interviews = await interviewsService.listApplicationInterviews(
    applicationId,
    actorId(req),
    req.log,
  );

  res.status(200).json({ interviews });
}

/**
 * 200 with the full round, not a diff, so the client doesn't have to merge its
 * own patch into cached state.
 *
 * Handles the status change AND the date edit, because they are one `PATCH` on
 * one resource. Which of the two a request carries is the schema's business,
 * not this handler's.
 */
export async function updateStatus(req: Request, res: Response): Promise<void> {
  const { interviewId } = req.validatedParams as InterviewIdParam;

  const interview = await interviewsService.updateInterviewStatus(
    interviewId,
    req.body as UpdateInterviewStatusInput,
    actorId(req),
    req.log,
  );

  res.status(200).json({ interview });
}

/**
 * One endpoint, two response shapes, chosen by the caller's role (XBE/XFE-1).
 *
 * An empty result is `200 { interviews: [], pagination }`, never a 404 — an
 * interviewer with no assignments has a valid, empty answer (EC-15).
 */
export async function list(req: Request, res: Response): Promise<void> {
  const { interviews, pagination } = await interviewsService.listInterviews(
    req.validatedQuery as ListInterviewsQuery,
    actorRole(req),
    actorId(req),
    req.log,
  );

  res.status(200).json({ interviews, pagination });
}

/** 404 — never 403 — when the caller's scope does not contain the round (FR-4.6). */
export async function get(req: Request, res: Response): Promise<void> {
  const { interviewId } = req.validatedParams as InterviewIdParam;

  const interview = await interviewsService.getInterview(
    interviewId,
    actorRole(req),
    actorId(req),
    req.log,
  );

  res.status(200).json({ interview });
}

/** 201 with the new seat, so the client can render the panel without a refetch. */
export async function assign(req: Request, res: Response): Promise<void> {
  const { interviewId } = req.validatedParams as InterviewIdParam;
  const { interviewerId } = req.body as AssignInterviewerInput;

  const assignment = await interviewsService.assignInterviewer(
    interviewId,
    interviewerId,
    actorId(req),
    req.log,
  );

  res.status(201).json({ assignment });
}

/**
 * `204 No Content` with an empty body, matching the shipped
 * `DELETE /api/roles/:roleId` (FR-3.6, XFE-7). There is no seat left to return.
 */
export async function unassign(req: Request, res: Response): Promise<void> {
  const { interviewId, userId } = req.validatedParams as AssignmentParams;

  await interviewsService.unassignInterviewer(interviewId, userId, actorId(req), req.log);

  res.status(204).send();
}

/**
 * A round's verdict, and whatever it moves (applications FR-3).
 *
 * `200` with the decided round — including the application's new
 * `currentStage` and `status`, since a decision routinely changes both and the
 * client would otherwise have to refetch to find out.
 *
 * `POST`, not `PATCH`: a decision creates a record that cannot be edited
 * afterwards (`409 DECISION_ALREADY_RECORDED`), and `PATCH` would suggest
 * otherwise.
 */
export async function decide(req: Request, res: Response): Promise<void> {
  const { interviewId } = req.validatedParams as InterviewIdParam;

  const interview = await interviewsService.recordDecision(
    interviewId,
    req.body as InterviewDecisionInput,
    actorId(req),
    req.log,
  );

  res.status(200).json({ interview });
}
