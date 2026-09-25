import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors.js';
import type { UserRole } from '../../generated/prisma/enums.js';

/**
 * Restricts a route to certain `UserRole`s. Always composed after `requireAuth`.
 *
 * This gates on the caller's user role — nothing to do with `Role`, the open
 * requisition model. The role comes from `req.user`, i.e. a verified JWT claim,
 * never from a body, query parameter or header.
 *
 * A mismatch is always 403, never 401: the client treats 401 as "refresh and
 * retry" and 403 as terminal.
 */
export function requireRole(...roles: Array<UserRole>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.user === undefined) {
      // Only reachable if a route used requireRole without requireAuth.
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
