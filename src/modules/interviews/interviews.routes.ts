import { Router } from 'express';
import { UserRole } from '../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { validateParams } from '../../middleware/validateParams.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import { feedbackRouter } from '../feedback/feedback.routes.js';
import * as interviewsController from './interviews.controller.js';
import {
  applicationIdParamSchema,
  assignInterviewerSchema,
  assignmentParamsSchema,
  createInterviewSchema,
  interviewIdParamSchema,
  listInterviewsQuerySchema,
  updateInterviewStatusSchema,
} from './interviews.schema.js';

/**
 * Two routers, one module (BE-2).
 *
 * The two application-nested routes mount onto the existing `/api/applications`
 * path, because the resource they hang off is an application. The other five
 * mount at a new `/api/interviews`. Both live here rather than in
 * `applications.routes.ts` so that **the module owning the scoping owns every
 * route that needs it** — a reviewer asking "what can reach a round?" reads one
 * file.
 *
 * Middleware order is load-bearing (BE-5, VAL-4): `requireAuth` →
 * `requireRole` → `validateParams` → `validate` / `validateQuery`. An anonymous
 * caller is always `401` and a wrong-role caller always `403`, whether or not
 * their body is also malformed — so an interviewer POSTing nonsense to an
 * assignment route gets a `403` and learns nothing about the body contract
 * (AC-B36).
 *
 * **Five of the seven routes are `requireRole(RECRUITER)`** (AZ-2, D-2, D-3).
 * The exception that matters is assignment: **an interviewer who could write to
 * `InterviewAssignment` could grant themselves access to any candidate in the
 * system.** The entire scoping model rests on that one guard, which is why
 * assignment is not a self-service action and why both the `POST` and the
 * `DELETE` carry it (AZ-3, SEC-3, EC-18, AC-B31).
 *
 * **The two reads carry `requireRole(RECRUITER, INTERVIEWER)`.** The spec's BE-5
 * describes them as carrying no role guard at all, because their scoping is in
 * the query — but AZ-9, EC-17 and AC-B35 all require a CANDIDATE to get `403`
 * here, including for rounds on their own application. Without a guard a
 * candidate would receive a scoped `200 { interviews: [] }` instead. The guard
 * admits exactly the two roles the endpoint × role matrix admits; **the scoping
 * behind it is still entirely `buildInterviewWhere`'s**, and this guard does not
 * narrow an interviewer's rows by even one row.
 */

/* -------------------------------------------------------------------------
 * The application-nested routes — mounted on /api/applications
 * ---------------------------------------------------------------------- */

/**
 * Added to the applications router by `applications.routes.ts`, which imports
 * this. Exported as a separate router rather than as two handlers so each
 * middleware stack is declared once, here, beside the rules it guards.
 */
export const interviewApplicationRoutes = Router();

/** Schedule a round. `409 APPLICATION_NOT_ACTIVE` on a terminal application (FR-1.6). */
interviewApplicationRoutes.post(
  '/:applicationId/interviews',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(applicationIdParamSchema),
  validate(createInterviewSchema),
  interviewsController.create,
);

/**
 * An application's rounds — **recruiter-only, with no interviewer path at all**
 * (FR-1.9, AZ-6, AC-B33).
 *
 * An interviewer reaching rounds by application id would bypass the assignment
 * predicate entirely. The answer is not a scoped `200` for them; it is `403`, so
 * that there is nothing here to bypass.
 */
interviewApplicationRoutes.get(
  '/:applicationId/interviews',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(applicationIdParamSchema),
  interviewsController.listForApplication,
);

/* -------------------------------------------------------------------------
 * The rest — mounted at /api/interviews
 * ---------------------------------------------------------------------- */

/** Mounted at `/api/interviews` by `app.ts`. */
export const interviewsRouter = Router();

/**
 * The role-aware list (FR-4.1). One endpoint, both roles, two projections.
 *
 * An interviewer's filters AND with their assignment predicate and can only
 * narrow within it (FR-4.2) — which is why every filter is open to them.
 */
interviewsRouter.get(
  '/',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.INTERVIEWER),
  validateQuery(listInterviewsQuerySchema),
  interviewsController.list,
);

/**
 * The scoped by-id read — **the brief's sharpest check** (FR-4.5, EC-05).
 *
 * An interviewer who is not assigned gets `404`, from the same query that would
 * have returned the round. Not `403`: a `403` confirms the round exists (AZ-5).
 */
interviewsRouter.get(
  '/:interviewId',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.INTERVIEWER),
  validateParams(interviewIdParamSchema),
  interviewsController.get,
);

/** Complete or cancel. There is no reschedule in this pass (D-11, FR-2.1). */
interviewsRouter.patch(
  '/:interviewId',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(interviewIdParamSchema),
  validate(updateInterviewStatusSchema),
  interviewsController.updateStatus,
);

/**
 * Staffing a round. **Recruiter-only, and that guard is the whole of the
 * interviewer-scoping model's integrity** (AZ-3, SEC-3).
 *
 * The duplicate refusal is the unique index, not middleware and not a service
 * read — see `assignInterviewer` (FR-3.4).
 */
interviewsRouter.post(
  '/:interviewId/assignments',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(interviewIdParamSchema),
  validate(assignInterviewerSchema),
  interviewsController.assign,
);

/** A hard delete, `204`, and `404` on a second attempt — not idempotent (FR-3.6, FR-3.8). */
interviewsRouter.delete(
  '/:interviewId/assignments/:userId',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(assignmentParamsSchema),
  interviewsController.unassign,
);

/* -------------------------------------------------------------------------
 * The feedback feature's three routes — mounted under /:interviewId/feedback
 * ---------------------------------------------------------------------- */

/**
 * Feedback hangs off a round, so its routes mount here (feedback BE-3).
 *
 * The nesting is not cosmetic: **it is the authorization model made visible.**
 * There is no path to an assessment that does not name the round it belongs to,
 * so the question every one of those three routes asks is the same question this
 * module already answers — is this caller on that round's panel (feedback
 * FR-6.2).
 *
 * The module owns its own guards and its own copy of the assignment predicate,
 * in `feedback.repository.ts`. That is the **second** place in `src/` writing
 * `assignments: { some: … }`, after `buildInterviewWhere` above — one per
 * feature, each serving every read and write in its own module, which is the
 * line this codebase draws rather than sharing one helper across two features'
 * `where` shapes.
 */
interviewsRouter.use('/:interviewId/feedback', feedbackRouter);
