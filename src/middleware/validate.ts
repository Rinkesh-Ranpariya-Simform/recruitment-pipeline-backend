import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ValidationError, type ErrorDetails } from '../lib/errors.js';

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
      // Every field error at once, keyed by request-body field name, so the
      // client can show all problems in one pass (VAL-5, XFE-4).
      const details: ErrorDetails = {};

      for (const issue of result.error.issues) {
        const key = issue.path.length > 0 ? issue.path.join('.') : '_';
        (details[key] ?? []).push(issue.message);
      }

      next(new ValidationError(details));
      return;
    }

    req.body = result.data;
    next();
  };
}
