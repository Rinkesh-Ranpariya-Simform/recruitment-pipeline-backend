import { Router } from 'express';
import { UserRole } from '../../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { validateParams } from '../../middleware/validateParams.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { interviewApplicationRoutes } from '../interviews/interviews.routes.js';
import { pipelineApplicationRoutes } from '../pipeline/pipeline.routes.js';
import * as applicationsController from './applications.controller.js';
import {
  applicationIdParamSchema,
  createApplicationSchema,
  listApplicationsQuerySchema,
} from './applications.schema.js';

export const applicationsRouter = Router();

/**
 * `POST /` is `CANDIDATE`-only; the two reads carry
 * `requireRole(CANDIDATE, RECRUITER)`.
 *
 * **An interviewer is `403` on all three.** An interviewer's scope is the round
 * they were assigned to, not the person's whole process — and reaching an
 * application by id would hand them a timeline of rounds they are not on,
 * bypassing the assignment predicate the whole system rests on (interviews
 * AZ-6). The answer is not a scoped `200` for them; it is `403`, so that there
 * is nothing here to bypass.
 *
 * **The role guard is not the scoping.** Behind it, each read dispatches to one
 * of two service functions with two different `where` clauses and two different
 * selects (BE-2). A candidate's is `where: { candidateUserId }` from the
 * verified token; a recruiter's has no per-row predicate at all, because a
 * recruiter may read every application — the same arrangement as the pipeline
 * board (pipeline AZ-2). Anyone widening the recruiter guard is not granting a
 * filtered view; they are granting everything.
 *
 * Middleware order: `requireAuth` before `requireRole` before
 * `validateParams`/`validateQuery`/`validate`, so an anonymous caller always
 * gets 401, a wrong-role caller always gets 403, and neither learns whether
 * their payload was also malformed (BE-4, VAL-8, AZ-1).
 *
 * The three RECRUITER-only writes under `/:applicationId` — stage, override and
 * outcome — are mounted at the bottom of this file from `pipeline.routes.ts`
 * (pipeline BE-5), and the interviews feature's two are mounted below them.
 * They live in those modules rather than here so the module owning a set of
 * rules also owns every route that applies them; the resource is an
 * application, which is why they hang off this path.
 */
applicationsRouter.post(
  '/',
  requireAuth,
  requireRole(UserRole.CANDIDATE),
  validate(createApplicationSchema),
  applicationsController.create,
);

/**
 * The role-aware list. One endpoint, two roles, two projections and two pagers
 * — the same construction as `GET /api/interviews` (interviews FR-4.1).
 *
 * `validateQuery` runs for BOTH roles because middleware cannot branch on one.
 * That is not a widening: a candidate's filters are parsed and then handed to
 * nobody — `listApplications` takes no query argument, so there is no parameter
 * of theirs that could reach a `where`.
 */
applicationsRouter.get(
  '/',
  requireAuth,
  requireRole(UserRole.CANDIDATE, UserRole.RECRUITER),
  validateQuery(listApplicationsQuerySchema),
  applicationsController.list,
);

/**
 * The by-id read — **added by the applications feature, reversing the candidate
 * feature's deliberate absence** (candidate FR-6.8, EC-09).
 *
 * That absence was a real guarantee and it is being given up on purpose, so it
 * is worth stating what replaces it. The argument then was: with no by-id
 * surface, there is no scoping rule on it to forget. The argument now is that
 * there is something on a detail page worth showing — the stage transition
 * timeline, which is the brief's §3.5 complaint answered for both audiences —
 * and the scoping rule is not somewhere it could be forgotten: it is
 * `where: { id, candidateUserId }` inside `getCandidateApplication`, one
 * statement, with no fetch-then-check in front of it.
 *
 * A candidate asking for another candidate's id gets `404`, from a query that
 * returned no row — the same answer a nonexistent id gets, from the same
 * statement. **Not `403`**, which would confirm the application exists.
 */
applicationsRouter.get(
  '/:applicationId',
  requireAuth,
  requireRole(UserRole.CANDIDATE, UserRole.RECRUITER),
  validateParams(applicationIdParamSchema),
  applicationsController.get,
);

/**
 * The pipeline feature's three writes, on `/:applicationId/…` (pipeline BE-5).
 *
 * Mounted after the routes above, and that is safe rather than merely
 * conventional: every path inside is `/:applicationId/<something>`, so none can
 * shadow `GET /:applicationId` or `/`. Every route inside carries its own
 * `requireAuth` + `requireRole(RECRUITER)` stack — none of this module's guards
 * apply to them, and none of their `RECRUITER` guards leak back onto the routes
 * above.
 */
applicationsRouter.use(pipelineApplicationRoutes);

/**
 * The interviews feature's two application-nested routes, on
 * `/:applicationId/interviews` (interviews BE-2).
 *
 * Mounted here for the same reason as the pipeline routes above, and just as
 * safely. Every route inside carries its own `requireAuth` +
 * `requireRole(RECRUITER)` stack — **including the GET**, which has no
 * interviewer path at all, because reaching rounds by application id would
 * bypass the assignment predicate the whole feature rests on (interviews
 * FR-1.9, AZ-6).
 */
applicationsRouter.use(interviewApplicationRoutes);
