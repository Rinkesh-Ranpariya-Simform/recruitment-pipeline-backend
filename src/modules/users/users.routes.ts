import { Router } from 'express';
import { UserRole } from '../../generated/prisma/enums.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireRole } from '../../middleware/requireRole.js';
import * as usersController from './users.controller.js';

export const usersRouter = Router();

/**
 * ONE route. Read-only.
 *
 * `requireAuth` runs before `requireRole` so an anonymous caller gets 401 and an
 * authenticated non-recruiter gets 403 — the two are never interchanged
 * (AZ-2, AC-B27, AC-B28).
 *
 * There is deliberately NO `POST` here, and no stub that returns 403 or 405.
 * An unregistered route falls through to `notFound` and answers 404 like any
 * other path that does not exist — the absence IS the guarantee (EC-09,
 * AC-B26, R-12). Do not add one.
 */
usersRouter.get('/', requireAuth, requireRole(UserRole.RECRUITER), usersController.list);
