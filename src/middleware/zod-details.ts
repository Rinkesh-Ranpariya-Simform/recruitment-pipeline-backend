import { z } from 'zod';
import type { ErrorDetails } from '../lib/errors.js';

/**
 * The single definition of how a zod failure becomes an API error body
 * (BE-5, VAL-6). `validate`, `validateParams` and `validateQuery` all consume
 * this; none reimplements it, so the fix below exists in exactly one place.
 *
 * THE BE-5 DEFECT THIS FIXES: the shipped `validate()` accumulated into
 * `(details[key] ?? []).push(issue.message)`, which builds a temporary array,
 * pushes into it, and discards it — the key is never assigned. Every
 * `400 VALIDATION_ERROR` this API has ever returned carried `details: {}`.
 * It was invisible only because the login form's two client-side rules catch
 * everything before a request is sent; this feature's forms are the first real
 * consumer (XFE-3, AC-B22).
 *
 * `noUncheckedIndexedAccess` is on, so the assignment must BIND — `??=` both
 * creates the bucket in `details` and hands back the array actually stored
 * there.
 *
 * Every field error is returned at once, keyed by request-body (or parameter)
 * name, so the client can show all problems in one pass. A whole-object issue —
 * the `.refine()` on the patch schema, which has no path — is keyed `_`.
 */
export function toErrorDetails(issues: readonly z.core.$ZodIssue[]): ErrorDetails {
  const details: ErrorDetails = {};

  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';

    const bucket = (details[key] ??= []);
    bucket.push(issue.message);
  }

  return details;
}
