import type { NextFunction, Request, Response } from 'express';
import { NotFoundError } from '../lib/errors.js';

/**
 * Terminal 404 for any unmatched route, in the standard JSON error shape rather
 * than Express's default HTML page.
 *
 * This is also what answers `POST /api/users` — that route is deliberately not
 * registered, so it falls through to here and is indistinguishable from any
 * other path that does not exist.
 */
export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError());
}
