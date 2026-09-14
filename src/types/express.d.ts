import type { Logger } from 'pino';
import type { Role } from '../generated/prisma/enums.js';

/**
 * Declaration merging so `req.user`, `req.id` and `req.log` are typed
 * everywhere without a cast at each call site (R-5).
 *
 * `user` is optional at the type level because it is genuinely absent on
 * anonymous routes. Handlers behind `requireAuth` still narrow it — the
 * middleware guarantees it at runtime, but the type deliberately does not, so
 * that mounting a handler on an unprotected route is a compile error rather
 * than an undefined at runtime.
 */
declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      user?: { id: number; role: Role };
    }
  }
}

export {};
