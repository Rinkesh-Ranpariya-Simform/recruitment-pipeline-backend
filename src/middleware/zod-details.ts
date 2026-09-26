import { z } from 'zod';
import type { ErrorDetails } from '../lib/errors.js';

/**
 * The single definition of how a zod failure becomes an API error body.
 * `validate`, `validateParams` and `validateQuery` all consume this; none
 * reimplements it, so the logic exists in exactly one place.
 *
 * `??=` rather than `(details[key] ?? []).push(...)`, which builds a temporary
 * array and discards it. With `noUncheckedIndexedAccess` on, the assignment must
 * BIND: `??=` both creates the bucket and hands back the array actually stored
 * there.
 *
 * Every field error is returned at once, keyed by request-body (or parameter)
 * name, so the client can show all problems in one pass. A whole-object issue —
 * the `.refine()` on the patch schema, which has no path — is keyed `_`.
 */
export function toErrorDetails(issues: ReadonlyArray<z.core.$ZodIssue>): ErrorDetails {
  const details: ErrorDetails = {};

  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';

    const bucket = (details[key] ??= []);
    bucket.push(issue.message);
  }

  return details;
}
