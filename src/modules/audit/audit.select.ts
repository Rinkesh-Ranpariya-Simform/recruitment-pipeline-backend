/**
 * The ONE projection `listAuditEntries` returns (BE-5). Every audit read goes
 * through it, so the response shape cannot differ between call sites.
 *
 * `actorUserId` is absent BY CONSTRUCTION: the raw foreign key is replaced by
 * the expanded `actor` object, so a client has nothing to join on and no reason
 * to try (contract invariant 5).
 *
 * `actor` names `id`, `name` and `role` and **does not name `email`** (SEC-2).
 * The exclusion is in this select list, not in a mapping step after the fetch —
 * the column is never in the row Postgres returns, so no future call site can
 * leak it. Actors are recruiters and interviewers, never candidates; the rule
 * still holds without exception, which is what makes it auditable.
 *
 * Prisma's relation `select` compiles to a join, not a per-row lookup, so the
 * expansion costs no N+1 (PERF-4).
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
