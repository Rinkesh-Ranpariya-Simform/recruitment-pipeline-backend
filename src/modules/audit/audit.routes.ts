import { Router } from 'express';
import { UserRole } from '../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import * as auditController from './audit.controller.js';
import { listAuditQuerySchema } from './audit.schema.js';

export const auditRouter = Router();

/**
 * ONE route, and one only.
 *
 * **The feed is recruiter-only** (AZ-2, D-5). It names candidates by
 * application id, other interviewers by name, and carries recruiters'
 * free-text override reasons - none of which an interviewer may see, and all
 * of which would undo the scoping the candidates and feedback features build.
 *
 * **The role guard is the WHOLE authorization** (AZ-3). There is no per-row
 * scoping in the service behind it, because there is no role permitted to read
 * a subset. Adding an interviewer to this guard does not give them a filtered
 * view - it gives them everything. Do not widen it.
 *
 * Middleware order is load-bearing (BE-3, VAL-1): `requireAuth` ->
 * `requireRole` -> `validateQuery`. Anonymous is always 401 and a wrong role is
 * always 403, whether or not the query string is also malformed - so a
 * candidate sending `?action=BANANA` gets a 403 and learns nothing about the
 * query contract (AC-B17).
 *
 * **There is deliberately no PATCH, no DELETE and no `/:id`** (FR-6.1, AZ-4).
 * An audit row is never updated or deleted, and immutability is enforced by the
 * absence of a handler rather than by a permission check that could later be
 * widened. Those paths fall through to `notFound` and answer 404 (invariant 6).
 * Do not add one without a spec change.
 */
auditRouter.get(
  '/',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateQuery(listAuditQuerySchema),
  auditController.list,
);
