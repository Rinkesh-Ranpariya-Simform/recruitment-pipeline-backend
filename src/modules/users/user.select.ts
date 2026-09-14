/**
 * The single definition of the safe user projection (FR-6.1, FR-6.3).
 *
 * `passwordHash` is absent BY CONSTRUCTION. This is the mechanism behind
 * AC-B32: a query that never selects the column cannot leak it, whereas a query
 * that fetches the whole row and deletes the key afterwards is one forgotten
 * call site away from leaking it.
 *
 * This is the same discipline candidate contact details will need later — see
 * "Authorization & data exposure" in backend/CLAUDE.md. Establishing it here,
 * on the smallest possible model, is the point.
 */
export const SAFE_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
} as const;
