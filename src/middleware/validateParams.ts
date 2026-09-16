import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../lib/errors.js';
import { toErrorDetails } from './zod-details.js';

/**
 * Path-parameter validation (BE-2.1).
 *
 * The parsed result is assigned to `req.validatedParams`, NOT back onto
 * `req.params`. Controllers read `req.validatedParams` and never re-read
 * `req.params`: the un-coerced string values are not to be trusted downstream
 * (BE-2.2).
 *
 * Coercion happens in the schema, so a controller receives a real `number` and
 * never calls `parseInt` itself — which is why `/api/roles/abc` is a 400 at the
 * boundary and never a 500 from a failed parse (BE-2.4, EC-01, AC-B08).
 *
 * The failure body is byte-identical to body validation's: a caller cannot tell
 * from the SHAPE which part of the request was wrong, only from the `details`
 * keys (BE-2.3, ERR-3).
 */
export function validateParams(schema: z.ZodType) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      next(new ValidationError(toErrorDetails(result.error.issues)));
      return;
    }

    req.validatedParams = result.data;
    next();
  };
}
