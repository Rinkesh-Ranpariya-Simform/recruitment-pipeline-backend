import { Router } from 'express';
import { UserRole } from '../../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { validateParams } from '../../middleware/validateParams.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import * as pipelineController from './pipeline.controller.js';
import {
  applicationIdParamSchema,
  changeStageSchema,
  pipelineQuerySchema,
  setOutcomeSchema,
  stageOverrideSchema,
} from './pipeline.schema.js';

/**
 * Two routers, one module (BE-5).
 *
 * The three WRITES are mounted onto the existing `/api/applications` path,
 * because the resource being changed is an application — `PATCH
 * /api/pipeline/12/stage` would name a thing that does not exist. The two READS
 * are a new `/api/pipeline`, because an aggregate over every role is not a
 * member of the applications collection.
 *
 * Both live here rather than in `applications.routes.ts` so that **the module
 * owning the stage rules owns every route that applies them**. A reviewer
 * asking "what can change a stage?" reads one file.
 *
 * **Every route is `requireRole(RECRUITER)`** (AZ-2, D-2, D-3). A candidate is
 * 403 even on their own application — there is no self-service stage change and
 * no self-withdrawal in this POC (AZ-4). An interviewer is 403 on all five,
 * including the override: an interviewer able to advance a candidate they are
 * assessing is the conflict of interest the separation exists to prevent
 * (AZ-3), and this is the brief's §3.3 "be explicit" answered explicitly.
 *
 * **The role guard is the WHOLE authorization.** There is no per-row scoping in
 * the service behind it — a recruiter sees and may move every application on
 * every role (AZ-2, SEC-8a). Anyone widening this guard is not granting a
 * filtered view; they are granting everything. Do not widen it.
 *
 * Middleware order is load-bearing (BE-6, VAL-6): `requireAuth` →
 * `requireRole` → `validateParams` → `validate`. Anonymous is always 401 and a
 * wrong role is always 403, whether or not the body is also malformed — so an
 * interviewer sending `{"toStage":"BANANA"}` gets a 403 and learns nothing
 * about the body contract (AC-B43).
 */

/* -------------------------------------------------------------------------
 * The writes — mounted on /api/applications
 * ---------------------------------------------------------------------- */

/**
 * Added to the applications router by `applications.routes.ts`, which imports
 * this. Exported as a separate router rather than as three handlers so the
 * middleware stack for each is declared once, here, beside the rules it guards.
 */
export const pipelineApplicationRoutes = Router();

/** A legal move along the graph. 409 on anything the graph refuses (FR-2). */
pipelineApplicationRoutes.patch(
  '/:applicationId/stage',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(applicationIdParamSchema),
  validate(changeStageSchema),
  pipelineController.changeStage,
);

/**
 * The skip, on the record (FR-4, brief §3.3).
 *
 * `validate(stageOverrideSchema)` is where a missing or too-short `reason`
 * becomes a 400 — the first of the three places that rule is enforced, and the
 * one that stops a reasonless override before it reaches a transaction. The
 * client should also require it before enabling Submit, but **that is UX and
 * this is the control** (XFE-5).
 */
pipelineApplicationRoutes.post(
  '/:applicationId/stage-override',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(applicationIdParamSchema),
  validate(stageOverrideSchema),
  pipelineController.overrideStage,
);

/** Hired or rejected. `ACTIVE` is a 400, not a resurrection (FR-3, VAL-4). */
pipelineApplicationRoutes.patch(
  '/:applicationId/outcome',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(applicationIdParamSchema),
  validate(setOutcomeSchema),
  pipelineController.setOutcome,
);

/* -------------------------------------------------------------------------
 * The reads — mounted at /api/pipeline
 * ---------------------------------------------------------------------- */

/**
 * Mounted at `/api/pipeline` by `app.ts`.
 *
 * Two GETs and nothing else. There is deliberately **no history endpoint here**
 * (FR-5.6): the `StageHistory` rows this feature writes are read on the
 * recruiter candidate detail, owned by the candidate-access feature. A second
 * endpoint returning the same rows in a different envelope is how a contract
 * rots.
 *
 * There is also no write on this router, and no `/:id`. Both absences fall
 * through to `notFound` and answer 404.
 */
export const pipelineRouter = Router();

/**
 * The board — counts and ageing per role per stage (FR-7).
 *
 * Unpaginated on purpose (FR-7.9): the response is one cell per role per stage,
 * so it scales with roles and not with the 20,000 candidates behind them.
 * PERF-5 names 500 roles as the point at which that stops being true and this
 * gains a pager.
 *
 * It returns **no candidate names and no candidate list** (XFE-8, invariant 6).
 * The board is counts; the people are `GET /api/candidates`.
 */
pipelineRouter.get(
  '/',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateQuery(pipelineQuerySchema),
  pipelineController.getPipeline,
);

/**
 * The dashboard headline (FR-8).
 *
 * No `validateQuery`: it takes no parameters, and zod would have nothing to
 * check. Unknown query keys are simply ignored, as they are on any endpoint
 * that reads none.
 */
pipelineRouter.get(
  '/summary',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  pipelineController.getSummary,
);
