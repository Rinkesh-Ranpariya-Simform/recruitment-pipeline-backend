import { z } from 'zod';
import { AuditAction, AuditEntityType } from '../../../generated/prisma/enums.js';

/**
 * Query parameter validation schema for listing audit entries.
 * Supports filtering by entityType, entityId, action, and actorId with pagination.
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
  })
  /**
   * Refinement: When entityId is provided, entityType must also be specified to avoid ambiguous ID matches across entity types.
   */
  .refine((value) => value.entityId === undefined || value.entityType !== undefined, {
    error: 'Provide entityType when filtering by entityId',
    path: ['entityId'],
  });

export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;
