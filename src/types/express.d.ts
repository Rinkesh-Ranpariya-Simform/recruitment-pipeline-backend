import type { Logger } from 'pino';
import type { UserRole } from '../../generated/prisma/enums.js';

/**
 * Declaration merging so `req.user`, `req.id` and `req.log` are typed
 * everywhere without a cast at each call site.
 *
 * `user` is optional at the type level because it is genuinely absent on
 * anonymous routes. Handlers behind `requireAuth` still narrow it — the
 * middleware guarantees it at runtime, but the type deliberately does not, so
 * that mounting a handler on an unprotected route is a compile error rather
 * than an undefined at runtime.
 *
 * `validatedParams` / `validatedQuery` carry the parsed output of
 * `validateParams()` / `validateQuery()`. They exist because `req.query` is a
 * getter in Express 5 and cannot be reassigned.
 *
 * They are `unknown` rather than generic because a global augmentation cannot
 * be typed per route. Controllers cast at the point of use —
 * `req.validatedParams as RoleIdParam` — which is safe because the route that
 * reaches the controller is the route that installed the schema.
 */
declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      user?: { id: number; role: UserRole };
      validatedParams?: unknown;
      validatedQuery?: unknown;
    }
  }
}

export {};
