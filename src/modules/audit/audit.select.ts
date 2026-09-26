/**
 * Audit log select projection for database queries.
 *
 * Expands actor relation with id, name, and role, while omitting email
 * and raw foreign key actorUserId to keep responses lean and consistent.
 */
export const AUDIT_SELECT = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  metadata: true,
  createdAt: true,
  actor: { select: { id: true, name: true, role: true } },
} as const;
