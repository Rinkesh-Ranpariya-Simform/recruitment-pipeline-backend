/**
 * The fields every role endpoint returns. Used by all queries in this module so
 * the response shape can't differ between endpoints.
 *
 * Columns are listed explicitly rather than returning the whole row, matching
 * `SAFE_USER_SELECT` in `../users/user.select.ts`.
 */
export const ROLE_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * What a NON-RECRUITER gets from the two read endpoints (candidate spec FR-4.5).
 *
 * `updatedAt` is omitted: a candidate browsing open positions has no use for a
 * requisition's internal editing churn.
 *
 * It omits nothing else, deliberately: `Role` references no person and carries
 * no restricted column. **The protection is not this list** — it is the forced
 * `status: OPEN` predicate in `buildRoleWhere` (FR-4.4).
 */
export const PUBLIC_ROLE_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  createdAt: true,
} as const;
