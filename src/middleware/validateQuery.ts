import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../lib/errors.js';
import { toErrorDetails } from './zod-details.js';

/**
 * Query-string validation, coercion and defaulting (BE-2.1).
 *
 * WHY A NEW PROPERTY AND NOT `req.query = result.data`: in Express 5 `req.query`
 * is a GETTER and cannot be reassigned. The trick `validate()` uses for
 * `req.body` does not transfer here — copying it would throw at runtime, and
 * only on a request that actually reached this route, with nothing caught at
 * build time (BE-2.2, R-2).
 *
 * Controllers read `req.validatedQuery` and never re-read `req.query`.
 *
 * An unrecognised value is rejected, never silently ignored: `?status=PENDING`
 * is a 400 with `details.status`, not an unfiltered 200 (EC-02, AC-B09). And
 * `?pageSize=101` is a 400, never a silent clamp — a client that asked for 500
 * rows and received 100 without being told has been lied to about what it has
 * (VAL-5, AC-B10).
 */
export function validateQuery(schema: z.ZodType) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      next(new ValidationError(toErrorDetails(result.error.issues)));
      return;
    }

    req.validatedQuery = result.data;
    next();
  };
}
