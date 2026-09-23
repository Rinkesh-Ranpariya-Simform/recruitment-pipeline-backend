import { Router } from 'express';
import { UserRole } from '../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { interviewApplicationRoutes } from '../interviews/interviews.routes.js';
import { pipelineApplicationRoutes } from '../pipeline/pipeline.routes.js';
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
 *
 * The three RECRUITER-only writes under `/:applicationId` — stage, override and
 * outcome — are mounted at the bottom of this file from
 * `pipeline.routes.ts` (pipeline BE-5). They live in that module rather than
 * here so the module owning the stage rules also owns every route that applies
 * them; the resource is an application, which is why they hang off this path.
 * **Neither of the two routes above is widened by them** (pipeline FR-9.2,
 * D-13): `GET /api/applications` stays candidate-scoped and unpaged.
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

/**
 * The pipeline feature's three writes, on `/:applicationId/…` (pipeline BE-5).
 *
 * Mounted LAST, and that is safe rather than merely conventional: both routes
 * above match the exact path `/`, so nothing below them can shadow either.
 * Every route inside carries its own `requireAuth` + `requireRole(RECRUITER)`
 * stack — none of this module's `CANDIDATE` guards apply to them, and none of
 * their `RECRUITER` guards leak back onto the two routes above.
 */
applicationsRouter.use(pipelineApplicationRoutes);

/**
 * The interviews feature's two application-nested routes, on
 * `/:applicationId/interviews` (interviews BE-2).
 *
 * Mounted here for the same reason as the pipeline routes above, and just as
 * safely: both routes in this file match the exact path `/`, so nothing below
 * them can shadow either. Every route inside carries its own `requireAuth` +
 * `requireRole(RECRUITER)` stack — **including the GET**, which has no
 * interviewer path at all, because reaching rounds by application id would
 * bypass the assignment predicate the whole feature rests on (interviews
 * FR-1.9, AZ-6).
 */
applicationsRouter.use(interviewApplicationRoutes);
