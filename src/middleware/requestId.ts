import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { child } from '../lib/logger.js';

/**
 * Assigns a per-request id and a logger bound to it, so every line emitted
 * while handling a request is correlatable. Echoed back as `X-Request-Id` so a
 * client-reported failure can be found in the logs.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = crypto.randomUUID();

  req.id = id;
  req.log = child({ requestId: id });
  res.setHeader('X-Request-Id', id);

  next();
}
