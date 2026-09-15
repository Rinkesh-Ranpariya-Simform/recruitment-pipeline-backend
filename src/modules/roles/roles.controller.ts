import type { Request, Response } from 'express';
import { UnauthenticatedError } from '../../lib/errors.js';
import type {
  CreateRoleInput,
  ListRolesQuery,
  RoleIdParam,
  UpdateRoleInput,
} from './roles.schema.js';
import * as rolesService from './roles.service.js';

/**
 * HTTP only: read the request, call a service, shape a response. Business rules
 * and Prisma access live in the service.
 *
 * Handlers don't catch — Express 5 forwards a rejected promise to the error
 * middleware.
 *
 * Input is read from `req.validatedQuery` / `req.validatedParams` / `req.body`,
 * never from the raw `req.params` / `req.query`, which are not coerced. The
 * casts are safe because each route installs the matching schema.
 */

/** The authenticated user's id. `requireAuth` runs before every route here. */
function actorId(req: Request): number {
  if (req.user === undefined) {
    throw new UnauthenticatedError(); // Unreachable behind requireAuth.
  }

  return req.user.id;
}

/** An empty result is `200 { roles: [], pagination }`, never a 404. */
export async function list(req: Request, res: Response): Promise<void> {
  const { roles, pagination } = await rolesService.listRoles(req.validatedQuery as ListRolesQuery);

  res.status(200).json({ roles, pagination });
}

export async function get(req: Request, res: Response): Promise<void> {
  const { roleId } = req.validatedParams as RoleIdParam;

  const role = await rolesService.getRole(roleId);

  res.status(200).json({ role });
}

/** 201 with the full created role, so the client can navigate straight to it. */
export async function create(req: Request, res: Response): Promise<void> {
  const role = await rolesService.createRole(req.body as CreateRoleInput, actorId(req), req.log);

  res.status(201).json({ role });
}

/**
 * 200 with the full updated role, not a diff, so the client doesn't have to
 * merge its own patch into cached state.
 */
export async function update(req: Request, res: Response): Promise<void> {
  const { roleId } = req.validatedParams as RoleIdParam;

  const role = await rolesService.updateRole(
    roleId,
    req.body as UpdateRoleInput,
    actorId(req),
    req.log,
  );

  res.status(200).json({ role });
}

/**
 * `204 No Content` with an empty body — there is no role left to return.
 *
 * The CLOSED-only guard lives in the service; it's a domain rule, not an HTTP
 * one.
 */
export async function remove(req: Request, res: Response): Promise<void> {
  const { roleId } = req.validatedParams as RoleIdParam;

  await rolesService.deleteRole(roleId, actorId(req), req.log);

  res.status(204).send();
}
