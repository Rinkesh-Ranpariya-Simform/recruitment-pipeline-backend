import type { Request, Response } from 'express';
import { UnauthenticatedError } from '../../lib/errors.js';
import type { ListAuditQuery } from './audit.schema.js';
import * as auditService from './audit.service.js';

/**
 * Audit log controller handling HTTP requests and responses.
 * Forwards requests to the audit service, relying on Express error middleware
 * for uniform error handling.
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
 * Lists paginated audit log entries matching provided query filters.
 * Returns 200 OK with entries array and pagination details.
 */
export async function list(req: Request, res: Response): Promise<void> {
  const { entries, pagination } = await auditService.listAuditEntries(
    req.validatedQuery as ListAuditQuery,
    actorId(req),
    req.log,
  );

  res.status(200).json({ entries, pagination });
}
