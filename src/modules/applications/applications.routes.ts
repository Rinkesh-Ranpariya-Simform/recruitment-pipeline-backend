import { Router } from 'express';
import { UserRole } from '../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as applicationsController from './applications.controller.js';
import { createApplicationSchema } from './applications.schema.js';

export const applicationsRouter = Router();

/**
 * Both routes are `CANDIDATE`-only.
 *
 * A recruiter gets `403`, not `200 { applications: [] }` (AZ-7, EC-15,
 * AC-B43). An empty list would read as "no applications exist", which is worse
 * than a refusal. The recruiter's view of applications is a different query with
 * different scoping and belongs to the pipeline feature.
 *
 * Middleware order: `requireAuth` before `requireRole` before `validate`, so an
 * anonymous caller always gets 401, a wrong-role caller always gets 403, and
 * neither learns whether their payload was also malformed (BE-4, VAL-8, AZ-1).
 *
 * There is deliberately NO `GET /:applicationId`, and no stub returning 403 or
 * 405 — it falls through to `notFound` like any path that does not exist
 * (FR-6.8, EC-09, AC-B44). **The absence is the guarantee**: with no by-id
 * surface, there is no scoping rule on it to forget. Do not add one.
 */
applicationsRouter.post(
  '/',
  requireAuth,
  requireRole(UserRole.CANDIDATE),
  validate(createApplicationSchema),
  applicationsController.create,
);

applicationsRouter.get(
  '/',
  requireAuth,
  requireRole(UserRole.CANDIDATE),
  applicationsController.list,
);
