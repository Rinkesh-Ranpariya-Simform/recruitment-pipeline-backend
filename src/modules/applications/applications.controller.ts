import type { Request, Response } from 'express';
import { UnauthenticatedError } from '../../lib/errors.js';
import type { CreateApplicationInput } from './applications.schema.js';
import * as applicationsService from './applications.service.js';

/**
 * HTTP concerns only: read the request, call a service, shape a response. No
 * eligibility rules, no Prisma (BE-1).
 *
 * Handlers don't catch — Express 5 forwards a rejected promise from an async
 * handler to the error middleware.
 */

/**
 * The authenticated candidate's id.
 *
 * This is the ONLY source of `candidateUserId` in the feature. It comes from
 * `req.user`, established by `requireAuth` from a verified token, and never from
 * a body, query parameter or header (AZ-5).
 */
function candidateUserId(req: Request): number {
  if (req.user === undefined) {
    throw new UnauthenticatedError(); // Unreachable behind requireAuth; typed, not assumed.
  }

  return req.user.id;
}

/** 201 with the created application, so the client can render it without a refetch. */
export async function create(req: Request, res: Response): Promise<void> {
  const { roleId } = req.body as CreateApplicationInput;

  const application = await applicationsService.createApplication(
    roleId,
    candidateUserId(req),
    req.log,
  );

  res.status(201).json({ application });
}

/** An empty result is `200 { applications: [] }`, never a 404 (FR-6.7). */
export async function list(req: Request, res: Response): Promise<void> {
  const applications = await applicationsService.listApplications(candidateUserId(req));

  res.status(200).json({ applications });
}
