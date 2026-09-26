import type { Logger } from 'pino';
import { Prisma } from '../../../generated/prisma/client.js';
import { RoleStatus, UserRole } from '../../../generated/prisma/enums.js';
import { NotFoundError, RoleHasApplicationsError, RoleNotClosedError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { PUBLIC_ROLE_SELECT, ROLE_SELECT } from './role.select.js';
import type { CreateRoleInput, ListRolesQuery, UpdateRoleInput } from './roles.schema.js';

/**
 * All Prisma access, status-transition logic and event logging for roles.
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

/** What a non-recruiter gets: `Role` minus `updatedAt`. */
export type PublicRole = Omit<Role, 'updatedAt'>;

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * THE role-aware query decision, shared by both read endpoints.
 *
 * For a non-recruiter, `status: OPEN` goes into the `where` clause **before the
 * query runs** — for the page, for the `count` behind the pager, and for the
 * single-role read. A `CLOSED` requisition is never fetched, so it cannot be
 * leaked by a mapping mistake downstream.
 *
 * Predicates are ANDed rather than overwritten, which is why a candidate's
 * `?status=CLOSED` returns an empty page rather than being silently rewritten to
 * OPEN or rejected outright. `status = OPEN AND status = CLOSED` matches nothing,
 * which is the honest answer to that request.
 */
export function buildRoleWhere(
  query: Pick<ListRolesQuery, 'q' | 'status'>,
  actorRole: UserRole,
): Prisma.RoleWhereInput {
  const and: Array<Prisma.RoleWhereInput> = [];

  if (actorRole !== UserRole.RECRUITER) {
    and.push({ status: RoleStatus.OPEN });
  }

  // An omitted status still means all statuses for a recruiter, not a hidden
  // default of OPEN.
  if (query.status !== undefined) {
    and.push({ status: query.status });
  }

  // Title only — `description` is deliberately not searched. This is a
  // parameterised Prisma filter, never interpolated SQL.
  if (query.q !== undefined) {
    and.push({ title: { contains: query.q, mode: 'insensitive' } });
  }

  return and.length === 0 ? {} : { AND: and };
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
export async function listRoles(
  query: ListRolesQuery,
  actorRole: UserRole,
): Promise<{
  roles: Array<Role> | Array<PublicRole>;
  pagination: Pagination;
}> {
  const where = buildRoleWhere(query, actorRole);

  const page = {
    where,
    // `id desc` is the tiebreak: without it, two roles sharing a `createdAt`
    // could be repeated or skipped across pages.
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
  };

  // Branched rather than a ternary on `select`, so each call keeps its own
  // inferred row type.
  const [roles, total] =
    actorRole === UserRole.RECRUITER
      ? await prisma.$transaction([
          prisma.role.findMany({ ...page, select: ROLE_SELECT }),
          prisma.role.count({ where }),
        ])
      : await prisma.$transaction([
          prisma.role.findMany({ ...page, select: PUBLIC_ROLE_SELECT }),
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

/**
 * A well-formed id with no matching row is a 404, never an empty 200.
 *
 * For a non-recruiter the `OPEN` predicate is part of the lookup, so a `CLOSED`
 * requisition and one that never existed produce the **same** 404 with the same
 * body. That indistinguishability is the point: a 403 here, or a different
 * message, would confirm the requisition exists and turn the endpoint into an
 * enumeration oracle.
 *
 * `findFirst`, not `findUnique`, because the predicate is id + status rather
 * than a unique key alone.
 */
export async function getRole(roleId: number, actorRole: UserRole): Promise<Role | PublicRole> {
  const where = { id: roleId, ...buildRoleWhere({}, actorRole) };

  const role =
    actorRole === UserRole.RECRUITER
      ? await prisma.role.findFirst({ where, select: ROLE_SELECT })
      : await prisma.role.findFirst({ where, select: PUBLIC_ROLE_SELECT });

  if (role === null) {
    throw new NotFoundError();
  }

  return role;
}

/**
 * Every role is created OPEN. Set explicitly here rather than relying on a
 * column default, so the rule is visible in the code that applies it.
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
  try {
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
      // Checked BEFORE the applications rule, so a recruiter is always told the
      // first of the two steps they need.
      if (existing.status !== RoleStatus.CLOSED) {
        throw new RoleNotClosedError();
      }

      await tx.role.delete({ where: { id: roleId } });
    });
  } catch (error) {
    // `Application.roleId` is `onDelete: Restrict`, so Postgres refuses this
    // delete when anyone has applied. Derived from the constraint violation
    // rather than a preceding `count()`, which a concurrent apply would
    // invalidate.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      log.warn(
        { event: 'role.delete.refused', actorId, roleId, reason: 'has_applications' },
        'role delete refused — role has applications',
      );
      throw new RoleHasApplicationsError();
    }

    throw error;
  }

  // Logged after the transaction commits, so it never claims a deletion that
  // was rolled back. With the row gone, this line is the only surviving record
  // that the role existed.
  log.info({ event: 'role.deleted', actorId, roleId }, 'role deleted');
}
