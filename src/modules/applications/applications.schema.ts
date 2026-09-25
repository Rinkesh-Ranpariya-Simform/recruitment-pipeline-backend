import { z } from 'zod';
import { ApplicationStatus, PipelineStage } from '../../../generated/prisma/enums.js';

/**
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
   * Coerced here, so a non-numeric `roleId` is a 400 before any query runs
   * (VAL-4, AC-B33).
   */
  roleId: z.coerce
    .number('Role id must be a positive integer')
    .int('Role id must be a positive integer')
    .positive('Role id must be a positive integer'),
});

/**
 * `GET /api/applications/:applicationId` — the by-id read (applications FR-4.1).
 *
 * Coerced, so `/api/applications/abc` is a 400 at the boundary rather than a
 * 500 further down. Declared here rather than imported from `pipeline.schema`
 * or `interviews.schema`, both of which export an identical shape: this module
 * must not depend on either to validate its own boundary, and five lines of
 * coercion are cheaper than the coupling.
 */
export const applicationIdParamSchema = z.object({
  applicationId: z.coerce
    .number('Application id must be a positive integer')
    .int('Application id must be a positive integer')
    .positive('Application id must be a positive integer'),
});

/**
 * The RECRUITER list's filters and pager (applications FR-1.4).
 *
 * **A candidate never reaches this schema.** Their `GET /api/applications` takes
 * no parameters at all and is not paged — the list is their own, and it is
 * short. The route runs `validateQuery` for both roles because middleware
 * cannot branch on a role, so a candidate sending `?page=2` has it parsed and
 * then ignored by a service that reads none of it. That is deliberate and it is
 * not a widening: no filter here can reach the candidate's query, which has a
 * hardcoded `where: { candidateUserId }` and nothing else (AZ-2).
 *
 * `?pageSize=101` is a 400, never a silent clamp (VAL-7), matching
 * `listRolesQuerySchema` and `listInterviewsQuerySchema`.
 */
export const listApplicationsQuerySchema = z.object({
  roleId: z.coerce
    .number('Role id must be a positive integer')
    .int('Role id must be a positive integer')
    .positive('Role id must be a positive integer')
    .optional(),
  stage: z.enum(PipelineStage, 'Stage must be one of APPLIED, SCREEN, INTERVIEW, OFFER').optional(),
  status: z.enum(ApplicationStatus, 'Status must be one of ACTIVE, HIRED, REJECTED').optional(),
  /**
   * `?hasInterviews=true` — applications with at least one round.
   *
   * This is what makes `/interviews` a list of PEOPLE IN PROCESS rather than a
   * list of rounds: one candidate on one requisition is one row, however many
   * rounds they have had. `false` is accepted too and means the opposite — the
   * applications nobody has started yet, which is the other half a recruiter
   * wants from the applications table.
   *
   * A string, not `z.coerce.boolean()`: coercion would read `"false"` as `true`
   * along with every other non-empty string, which is the single most common
   * way a boolean query parameter is got wrong.
   */
  hasInterviews: z
    .enum(['true', 'false'], 'hasInterviews must be true or false')
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce
    .number('Page must be an integer of at least 1')
    .int('Page must be an integer of at least 1')
    .min(1, 'Page must be an integer of at least 1')
    .default(1),
  pageSize: z.coerce
    .number('Page size must be an integer between 1 and 100')
    .int('Page size must be an integer between 1 and 100')
    .min(1, 'Page size must be an integer between 1 and 100')
    .max(100, 'Page size must be at most 100')
    .default(20),
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type ApplicationIdParam = z.infer<typeof applicationIdParamSchema>;
export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;
