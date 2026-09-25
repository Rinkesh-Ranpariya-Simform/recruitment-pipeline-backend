import { Router } from 'express';
import { UserRole } from '../../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { validateParams } from '../../middleware/validateParams.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import * as candidateController from './candidate.controller.js';
import {
  candidateIdParamSchema,
  listCandidatesQuerySchema,
  updateCandidateContactSchema,
} from './candidate.schema.js';

/**
 * Three routes. Mounted at `/api/candidates` by `app.ts`.
 *
 * Middleware order is load-bearing (BE-4, VAL-7): `requireAuth` →
 * `requireRole` → `validateParams` → `validate` / `validateQuery`. An anonymous
 * caller is always `401` and a wrong-role caller always `403`, whether or not
 * their body or query is also malformed — so a candidate sending a malformed
 * `PATCH` gets `403` and learns nothing about the body contract (AC-B40).
 *
 * **A CANDIDATE is `403` on all three, including on their own record** (AZ-5,
 * D-6, AC-B36, AC-B37). Their surface is `GET /api/auth/me` and
 * `GET /api/applications`, both shipped and both already scoped. Self-service
 * profile editing would mean deciding what a candidate may see of a recruiter's
 * notes, which no requirement covers.
 *
 * **The two reads carry `requireRole(RECRUITER, INTERVIEWER)` and scope in the
 * query.** The guard admits exactly the two roles the endpoint × role matrix
 * admits; **the scoping behind it is entirely `buildCandidateWhere`'s**, and
 * this guard does not narrow an interviewer's rows by even one row. Without it
 * a candidate would receive a scoped `200 { candidates: [] }` instead of the
 * `403` AZ-5 requires — the same reason the interviews reads carry theirs.
 *
 * **There is deliberately no `POST`** (FR-1.4, D-1, EC-19, AC-B41). It falls
 * through to the shipped `notFound` handler and answers `404`. Provisioning
 * remains `POST /api/auth/signup` (anonymous, candidates only) and
 * `npm run db:seed`; **the shipped codebase has exactly one account-creation
 * path and this feature does not add a second.** Do not add one without a spec
 * change.
 *
 * **There is no `DELETE` either** (D-13). `AuditLog.actor` and
 * `Feedback.interviewer` are `Restrict`, so a delete would fail anyway — and a
 * GDPR-shaped anonymise is a real feature, not a verb.
 */
export const candidatesRouter = Router();

/**
 * The role-aware list (FR-3.1). One endpoint, both roles, two projections.
 *
 * An interviewer's `roleId` and `stage` filters AND into the same `some` block
 * as their assignment predicate, so a filter narrows within their own
 * candidates and can never widen beyond them (FR-3.2, EC-03). **`?q=` is
 * recruiter-only and is a `400` for them** — rejected in the service, where the
 * caller's role is known, before any query runs (VAL-5, FR-3.8).
 */
candidatesRouter.get(
  '/',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.INTERVIEWER),
  validateQuery(listCandidatesQuerySchema),
  candidateController.list,
);

/**
 * The scoped by-id read — **the brief's sharpest check** (FR-6.2, EC-01).
 *
 * An interviewer who is not assigned gets `404`, from the same query that would
 * have returned the candidate. Not `403`: a `403` confirms the candidate exists
 * (AZ-6, SEC-5).
 */
candidatesRouter.get(
  '/:candidateId',
  requireAuth,
  requireRole(UserRole.RECRUITER, UserRole.INTERVIEWER),
  validateParams(candidateIdParamSchema),
  candidateController.get,
);

/**
 * Recording contact details — **recruiter-only** (FR-4.1, AZ-4, D-5).
 *
 * An interviewer is `403` here even for a candidate they ARE assigned to
 * (AC-B38): the assignment authorizes them to read a name and their own rounds,
 * not to write to the person's record.
 *
 * It accepts `phone`, `location` and `headline` and nothing else. `name`,
 * `email` and `role` are dropped by the schema, so this endpoint cannot be used
 * to change a login identity or escalate a role (SEC-9, VAL-4).
 */
candidatesRouter.patch(
  '/:candidateId',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(candidateIdParamSchema),
  validate(updateCandidateContactSchema),
  candidateController.updateContact,
);
