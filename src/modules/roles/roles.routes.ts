import { Router } from 'express';
import { UserRole } from '../../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { validateParams } from '../../middleware/validateParams.js';
import { validateQuery } from '../../middleware/validateQuery.js';
import * as rolesController from './roles.controller.js';
import {
  createRoleSchema,
  listRolesQuerySchema,
  roleIdParamSchema,
  updateRoleSchema,
} from './roles.schema.js';

export const rolesRouter = Router();

/**
 * The three WRITES are recruiter-only. The two READS are not, as of the
 * candidate feature (spec FR-4.1, FR-4.2, and its "Revision to the roles
 * feature").
 *
 * That reverses this module's earlier rule deliberately: browsing open
 * positions is one-for-one with `GET /api/roles?status=OPEN`, so a second
 * module would have been the same query behind a second name.
 *
 * **What widened is this guard, not the query.** A non-recruiter's rows are
 * still narrowed to `status: OPEN` and `PUBLIC_ROLE_SELECT` — see
 * `buildRoleWhere` in the service.
 *
 * The cost, named: an interviewer regains a requisition read they were
 * previously denied. Accepted (spec SEC-12.5).
 *
 * Middleware order matters: auth and authorization run before validation, so an
 * anonymous caller always gets 401, and a non-recruiter gets 403 on a write
 * whether their request is malformed or names a role that doesn't exist. The API
 * doesn't help an unauthorized caller fix their payload.
 *
 * The client hiding the "New role" button is only an affordance — the guards on
 * the writes below are what enforce it.
 */
rolesRouter.get('/', requireAuth, validateQuery(listRolesQuerySchema), rolesController.list);

rolesRouter.get('/:roleId', requireAuth, validateParams(roleIdParamSchema), rolesController.get);

rolesRouter.post(
  '/',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validate(createRoleSchema),
  rolesController.create,
);

rolesRouter.patch(
  '/:roleId',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(roleIdParamSchema),
  validate(updateRoleSchema),
  rolesController.update,
);

/**
 * A hard delete — the row is gone.
 *
 * Both refusals (`ROLE_NOT_CLOSED`, `ROLE_HAS_APPLICATIONS`) live in the
 * service rather than middleware, which only sees the id.
 */
rolesRouter.delete(
  '/:roleId',
  requireAuth,
  requireRole(UserRole.RECRUITER),
  validateParams(roleIdParamSchema),
  rolesController.remove,
);
