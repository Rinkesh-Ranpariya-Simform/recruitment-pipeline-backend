import { z } from 'zod';
import { AuditAction, AuditEntityType } from '../../generated/prisma/enums.js';

/**
 * The query contract for `GET /api/audit` (Validation table).
 *
 * zod strips unknown keys, so `?sort=asc` renders the default ordering rather
 * than a 400 — matching the shipped behaviour on `GET /api/roles` (VAL-5).
 *
 * This is zod v4: enum messages are `z.enum(Values, 'message')`, not
 * `z.nativeEnum` or `{ message: … }`.
 */
export const listAuditQuerySchema = z
  .object({
    entityType: z
      .enum(
        AuditEntityType,
        'Entity type must be one of APPLICATION, INTERVIEW, FEEDBACK, CANDIDATE',
      )
      .optional(),
    entityId: z.coerce
      .number('Entity id must be a positive integer')
      .int('Entity id must be a positive integer')
      .positive('Entity id must be a positive integer')
      .optional(),
    action: z.enum(AuditAction, 'Action must be one of the nine audit actions').optional(),
    actorId: z.coerce
      .number('Actor id must be a positive integer')
      .int('Actor id must be a positive integer')
      .positive('Actor id must be a positive integer')
      .optional(),
    // `.default()` handles `undefined` before coercion, so an omitted `page` is
    // 1 and never `NaN` — same as `listRolesQuerySchema`.
    page: z.coerce
      .number('Page must be an integer of at least 1')
      .int('Page must be an integer of at least 1')
      .min(1, 'Page must be an integer of at least 1')
      .default(1),
    // 101 is a 400, NEVER a silent clamp to 100 (VAL-2): a client that asked
    // for 500 rows and received 100 without being told has been lied to about
    // what it has, and its pagination arithmetic is then quietly wrong.
    pageSize: z.coerce
      .number('Page size must be an integer between 1 and 100')
      .int('Page size must be an integer between 1 and 100')
      .min(1, 'Page size must be an integer between 1 and 100')
      .max(100, 'Page size must be at most 100')
      .default(20),
  })
  /**
   * `?entityId=12` with no `entityType` is a 400, not an unfiltered result
   * (VAL-3). An entity id is ambiguous across four tables; returning
   * application 12's trace *and* interview 12's trace because the caller forgot
   * a parameter is worse than refusing.
   *
   * Keyed onto `entityId` via `path`, so the client can render the message on
   * the id input it belongs to rather than as a form-level error.
   */
  .refine((value) => value.entityId === undefined || value.entityType !== undefined, {
    error: 'Provide entityType when filtering by entityId',
    path: ['entityId'],
  });

export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;
