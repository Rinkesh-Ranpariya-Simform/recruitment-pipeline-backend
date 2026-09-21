import type { Request, Response } from 'express';
import { UnauthenticatedError } from '../../lib/errors.js';
import type { ListAuditQuery } from './audit.schema.js';
import * as auditService from './audit.service.js';

/**
 * HTTP only: read the request, call the service, shape the response (BE-1).
 * There is no business logic here and no Prisma access.
 *
 * Handlers don't catch - Express 5 forwards a rejected promise to the error
 * middleware, which is also what keeps a Prisma error off the wire (ERR-1).
 *
 * There is ONE handler, and there will be one. No `PATCH`, no `DELETE`, no
 * `GET /:id` (FR-6.1) - those paths fall through to the shipped `notFound`
 * handler and answer 404. The absence is the immutability guarantee.
 */

/** The authenticated user's id. `requireAuth` runs before the route below. */
function actorId(req: Request): number {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.id;
}

/**
 * A page of the trace for a recruiter.
 *
 * Reads `req.validatedQuery`, NEVER `req.query` (BE-4): Express 5 makes
 * `req.query` a getter that cannot be reassigned, so `validateQuery` puts its
 * coerced, defaulted output on a separate property. The cast is safe because
 * the route that reaches this handler is the route that installed the schema.
 *
 * `actorId` here is the READER, passed only so the service can log who paged
 * the trace (FR-8.1). It is not a filter - there is no self-scoped read of this
 * endpoint (AZ-3, EC-12).
 *
 * An empty page is a 200, never a 404 (ERR-3).
 */
export async function list(req: Request, res: Response): Promise<void> {
  const { entries, pagination } = await auditService.listAuditEntries(
    req.validatedQuery as ListAuditQuery,
    actorId(req),
    req.log,
  );

  res.status(200).json({ entries, pagination });
}
