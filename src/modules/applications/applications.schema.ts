import { z } from 'zod';

/**
 * One body schema. `GET /api/applications` takes no body, no params and no query
 * string, so it has no schema and no `validate*()` in its chain.
 *
 * Unknown keys are stripped (zod object default), which is what makes the
 * impersonation case a non-case: a body of
 * `{ roleId: 1, candidateUserId: 99, status: "HIRED" }` reaches the service as
 * `{ roleId: 1 }` (EC-10, AC-B34).
 */
export const createApplicationSchema = z.object({
  /**
   * There is deliberately NO `candidateUserId` field, and no `status` or
   * `currentStage` field (FR-5.3, FR-5.4).
   *
   * The candidate is `req.user.id`, from a verified token. The status and stage
   * are literals in the service. A field the client cannot send is a field no
   * one has to remember to validate.
   *
   * Coerced here so the controller receives a real `number` and never parses
   * one — a non-numeric `roleId` is a 400 before any query runs, not a 500
   * further down (VAL-4, AC-B33).
   */
  roleId: z.coerce
    .number('Role id must be a positive integer')
    .int('Role id must be a positive integer')
    .positive('Role id must be a positive integer'),
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
