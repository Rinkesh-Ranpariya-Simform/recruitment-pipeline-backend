import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors.js';
import type { Role } from '../generated/prisma/enums.js';

/**
 * Role gate (FR-7.2). Always composed AFTER `requireAuth`.
 *
 * The role is read from `req.user`, which came from a verified JWT claim — never
 * from a body, query parameter or client-supplied header (AZ-3).
 *
 * A mismatch is 403, never 401: the two are never interchanged, because the
 * client treats 401 as "refresh and retry" and 403 as terminal (AZ-2, XFE-3).
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.user === undefined) {
      // Defensive: reaching here means the route composed requireRole without
      // requireAuth. "We don't know who you are" is the honest answer.
      next(new UnauthenticatedError());
      return;
    }

    if (!roles.includes(req.user.role)) {
      req.log.warn(
        {
          event: 'authz.denied',
          userId: req.user.id,
          role: req.user.role,
          method: req.method,
          path: req.originalUrl,
        },
        'authorization denied',
      );
      next(new ForbiddenError());
      return;
    }

    next();
  };
}
