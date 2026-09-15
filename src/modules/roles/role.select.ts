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
