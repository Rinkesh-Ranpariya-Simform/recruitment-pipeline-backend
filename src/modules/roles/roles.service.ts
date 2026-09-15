import type { Logger } from 'pino';
import { Prisma } from '../../generated/prisma/client.js';
import { RoleStatus } from '../../generated/prisma/enums.js';
import { NotFoundError, RoleNotClosedError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { ROLE_SELECT } from './role.select.js';
import type { CreateRoleInput, ListRolesQuery, UpdateRoleInput } from './roles.schema.js';

/**
 * All Prisma access, status-transition logic and event logging for roles. These
 * five functions are the module's entire surface.
 *
 * Like the auth service, these take `req.log` as an argument rather than
 * reaching for a global logger.
 */

export interface Role {
  id: number;
  title: string;
  description: string;
  status: RoleStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Turns Prisma's `P2025` ("record to update not found") into a 404 and rethrows
 * everything else untouched.
 *
 * Letting the update itself produce the 404, rather than checking with a read
 * first, keeps it correct when the row is deleted concurrently — a
 * check-then-write would turn that race into a 500.
 */
function translatePrismaError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    throw new NotFoundError();
  }

  throw error;
}

/**
 * The page and its `count` run in one transaction and share the same `where`,
 * so `total` always describes the same snapshot as the rows beside it.
 */
export async function listRoles(query: ListRolesQuery): Promise<{
  roles: Role[];
  pagination: Pagination;
}> {
  // An omitted status means all statuses, not a hidden default of OPEN.
  const where = query.status === undefined ? {} : { status: query.status };

  const [roles, total] = await prisma.$transaction([
    prisma.role.findMany({
      where,
      // `id desc` is the tiebreak: without it, two roles sharing a `createdAt`
      // could be repeated or skipped across pages.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: ROLE_SELECT,
    }),
    prisma.role.count({ where }),
  ]);

  return {
    roles,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      // 0 for an empty result, not 1. A page past the end returns [] with
      // accurate pagination rather than an error.
      totalPages: Math.ceil(total / query.pageSize),
    },
  };
}

/** A well-formed id with no matching row is a 404, never an empty 200. */
export async function getRole(roleId: number): Promise<Role> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: ROLE_SELECT });

  if (role === null) {
    throw new NotFoundError();
  }

  return role;
}

/**
 * Every role is created OPEN. Set explicitly here rather than relying on a
 * column default, so the rule is visible in the code that applies it.
 *
 * `input` is the parsed schema output, so it carries only `title` and
 * `description` — anything else in the request body was already stripped.
 */
export async function createRole(
  input: CreateRoleInput,
  actorId: number,
  log: Logger,
): Promise<Role> {
  const role = await prisma.role.create({
    data: { ...input, status: RoleStatus.OPEN },
    select: ROLE_SELECT,
  });

  // The log is the only record of who created a role — the model stores no
  // person. `actorId` comes from the verified token.
  log.info({ event: 'role.created', actorId, roleId: role.id }, 'role created');

  return role;
}

/**
 * Reads the current status and writes the new row in one transaction, so the
 * `from` status it logs is the value the update actually moved off. The read
 * exists only for that — the 404 still comes from the update failing.
 *
 * Only the keys present in `patch` are written, so two recruiters editing
 * different fields don't clobber each other. The same field is last-write-wins.
 */
export async function updateRole(
  roleId: number,
  patch: UpdateRoleInput,
  actorId: number,
  log: Logger,
): Promise<Role> {
  // Built key by key rather than spread, so only the fields the client actually
  // sent are written. (A spread wouldn't type-check anyway: with
  // `exactOptionalPropertyTypes` on, zod's `string | undefined` optionals don't
  // fit Prisma's update input.)
  const data: Prisma.RoleUpdateInput = {};

  if (patch.title !== undefined) {
    data.title = patch.title;
  }
  if (patch.description !== undefined) {
    data.description = patch.description;
  }
  if (patch.status !== undefined) {
    data.status = patch.status;
  }

  let role: Role;
  let previousStatus: RoleStatus | undefined;

  try {
    ({ role, previousStatus } = await prisma.$transaction(async (tx) => {
      const existing = await tx.role.findUnique({
        where: { id: roleId },
        select: { status: true },
      });

      const updated = await tx.role.update({
        where: { id: roleId },
        data,
        select: ROLE_SELECT,
      });

      return { role: updated, previousStatus: existing?.status };
    }));
  } catch (error) {
    translatePrismaError(error);
  }

  // Field names only, never their values — a 5000-character description does
  // not belong in a log line.
  log.info(
    { event: 'role.updated', actorId, roleId: role.id, changedFields: Object.keys(patch) },
    'role updated',
  );

  // Only on a real transition. Setting the status a role already has is
  // accepted, but a retry must not look like a second close in the logs.
  if (patch.status !== undefined && patch.status !== previousStatus) {
    log.info(
      {
        event: 'role.status_changed',
        actorId,
        roleId: role.id,
        from: previousStatus,
        to: patch.status,
      },
      'role status changed',
    );
  }

  return role;
}

/**
 * Deletes a role permanently, and only if it is already `CLOSED`.
 *
 * The status check and the delete share one transaction: outside one, a `PATCH`
 * reopening the role could slip between the two statements and we'd delete a
 * requisition that is back in circulation.
 *
 * Unlike `updateRole`, the 404 comes from the read rather than from the write
 * failing. The status guard needs the row anyway, and checking existence first
 * is what makes a missing role a 404 instead of a 409 about a status it doesn't
 * have.
 */
export async function deleteRole(roleId: number, actorId: number, log: Logger): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.role.findUnique({
      where: { id: roleId },
      select: { status: true },
    });

    // Existence first, status second — a role that isn't there is a 404, not a
    // conflict about its status.
    if (existing === null) {
      throw new NotFoundError();
    }

    // An OPEN requisition is still in circulation: it has to be closed first.
    if (existing.status !== RoleStatus.CLOSED) {
      throw new RoleNotClosedError();
    }

    await tx.role.delete({ where: { id: roleId } });
  });

  // Logged after the transaction commits, so it never claims a deletion that
  // was rolled back. With the row gone, this line is the only surviving record
  // that the role existed.
  log.info({ event: 'role.deleted', actorId, roleId }, 'role deleted');
}
