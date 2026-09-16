import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../lib/errors.js';
import { toErrorDetails } from './zod-details.js';

/**
 * The validation boundary (BE-2.2). Invalid input never reaches a service.
 *
 * On success the parsed result REPLACES `req.body`, so every downstream
 * consumer receives the transformed value — notably the trimmed, lowercased
 * email (VAL-3). No code path further in can forget to normalise, because the
 * un-normalised value no longer exists by the time it runs.
 */
export function validate(schema: z.ZodType) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(new ValidationError(toErrorDetails(result.error.issues)));
      return;
    }

    req.body = result.data;
    next();
  };
}
