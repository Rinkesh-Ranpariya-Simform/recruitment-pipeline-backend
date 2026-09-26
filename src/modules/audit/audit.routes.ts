import { Router } from 'express';
import { UserRole } from '../../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import * as auditController from './audit.controller.js';
import { listAuditQuerySchema } from './audit.schema.js';

export const auditRouter = Router();

/**
 * GET /api/audit: Lists paginated audit logs.
 * Restricted to recruiters only. Audit logs are append-only and cannot be updated or deleted.
 *
 * Middleware pipeline order:
 * 1. `requireAuth`: Ensures user is logged in.
 * 2. `requireRole(RECRUITER)`: Restricts access exclusively to recruiters.
 * 3. `validateQuery`: Validates and parses query parameters.
 */
auditRouter.get(
  '/',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateQuery(listAuditQuerySchema),
  auditController.list,
);
