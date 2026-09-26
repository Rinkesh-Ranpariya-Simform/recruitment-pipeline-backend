/**
 * The single definition of the safe user projection.
 *
 * `passwordHash` is absent BY CONSTRUCTION. A query that never selects the
 * column cannot leak it, whereas a query that fetches the whole row and deletes
 * the key afterwards is one forgotten call site away from leaking it.
 */
export const SAFE_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
} as const;
