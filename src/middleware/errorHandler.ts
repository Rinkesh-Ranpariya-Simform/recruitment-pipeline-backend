import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, Array<string>>;
}

/**
 * The only place a failure response body is built (BE-6).
 *
 * A thrown `AppError` is a deliberate, client-visible outcome and is rendered
 * as-is. Anything else is a bug: it is logged in full server-side and becomes a
 * generic 500. A stack trace, a Prisma error code, a SQL fragment or an
 * exception message never reaches the client, in any environment (ERR-3, AC-B34).
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  // If the response has already started, the only correct move is to hand back
  // to Express so it can destroy the socket — writing a second body would
  // corrupt the first.
  if (res.headersSent) {
    next(err);
    return;
  }

  const log = req.log ?? logger;

  if (err instanceof AppError) {
    const body: ErrorBody = { code: err.code, message: err.message };
    if (err.details !== undefined) {
      body.details = err.details;
    }

    log.warn(
      { code: err.code, status: err.status, method: req.method, path: req.originalUrl },
      'request failed',
    );
    res.status(err.status).json(body);
    return;
  }

  log.error(
    { err, method: req.method, path: req.originalUrl },
    'unhandled error while handling request',
  );

  res
    .status(500)
    .json({ code: 'INTERNAL_ERROR', message: 'Something went wrong' } satisfies ErrorBody);
}
