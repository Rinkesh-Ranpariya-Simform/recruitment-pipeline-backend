import type { Logger } from 'pino';
import { Prisma } from '../../generated/prisma/client.js';
import { ApplicationStatus, PipelineStage, RoleStatus } from '../../generated/prisma/enums.js';
import { AlreadyAppliedError, NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { APPLICATION_SELECT } from './application.select.js';

/**
 * The two functions this module has. All Prisma access, the eligibility rule and
 * the event logging live here; the controller does none of it.
 *
 * Like the auth and roles services, these take `req.log` as an argument rather
 * than reaching for a global logger.
 */

export interface Application {
  id: number;
  status: ApplicationStatus;
  currentStage: PipelineStage;
  createdAt: Date;
  role: { id: number; title: string };
}

/**
 * Creates one application for the authenticated candidate (FR-5).
 *
 * **`candidateUserId` comes from the token, never the body** (FR-5.3, AZ-5). The
 * schema has no field for it, so there is no impersonation case to defend
 * against rather than a check that could be forgotten.
 *
 * The requisition is resolved by a query whose `where` is `{ id, status: OPEN }`
 * — **the eligibility rule and the lookup are one statement** (FR-5.5, AZ-6).
 * There is no fetch-then-check, so there is no window between deciding a role is
 * open and using it. A CLOSED or missing role produces the same 404 from the
 * same query, which is also what keeps the endpoint from confirming that a
 * closed requisition exists (SEC-4, AC-B30/AC-B31).
 *
 * `status`, `currentStage` and `stageEnteredAt` are literals (FR-5.4). Nothing
 * in the request influences them.
 *
 * **A candidate may apply to the same role only ONCE.** The rule is the
 * `@@unique([candidateUserId, roleId])` index, and the 409 below is that index's
 * `P2002` translated — there is deliberately no `findFirst` beforehand. A
 * read-then-write check has a window in which two concurrent applies both pass
 * it, and both would then commit; the index has no such window, so the second
 * request loses in Postgres and becomes `409 ALREADY_APPLIED` (EC-06).
 *
 * Applying to a DIFFERENT role is untouched: the constraint is on the pair, so a
 * candidate may hold as many applications as there are open requisitions.
 */
export async function createApplication(
  roleId: number,
  candidateUserId: number,
  log: Logger,
): Promise<Application> {
  // One transaction so the `Role` row's existence is guaranteed for the insert
  // and the foreign key cannot fail with an unexplained P2003 (FR-5.7).
  //
  // A recruiter closing this role between the two statements is possible, and
  // accepted: the resulting row is valid, the FK holds, and the candidate did
  // apply while it was genuinely open (EC-08). Preventing it would mean row
  // locking `Role` on every apply, which is not worth it at this scale.
  let application: Application;

  try {
    application = await prisma.$transaction(async (tx) => {
      const role = await tx.role.findFirst({
        where: { id: roleId, status: RoleStatus.OPEN },
        select: { id: true },
      });

      if (role === null) {
        throw new NotFoundError();
      }

      const now = new Date();

      return tx.application.create({
        data: {
          candidateUserId,
          roleId: role.id,
          status: ApplicationStatus.ACTIVE,
          currentStage: PipelineStage.APPLIED,
          stageEnteredAt: now,
        },
        select: APPLICATION_SELECT,
      });
    });
  } catch (error) {
    // The duplicate is caught OUTSIDE the transaction, not inside it: a unique
    // violation aborts the Postgres transaction, so the `catch` has to sit where
    // there is no longer one to be in.
    //
    // Ordering note: the role lookup runs first, so a repeat apply to a role
    // that has since been CLOSED answers 404, not 409 — the candidate is told
    // the position is gone rather than that they already applied to it.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Not logged at `warn` with the ids: a second click is ordinary user
      // behaviour, and the error middleware already logs every AppError.
      throw new AlreadyAppliedError();
    }
    throw error;
  }

  // Ids only — never the candidate's name or email, and never the requisition
  // title (FR-5.9, FR-9.4).
  log.info(
    {
      event: 'application.created',
      applicationId: application.id,
      candidateUserId,
      roleId,
    },
    'application created',
  );

  return application;
}

/**
 * The authenticated candidate's own applications, and only those (FR-6).
 *
 * **The scoping is in the query** — `where: { candidateUserId }` — not a wider
 * read narrowed afterwards in application code (FR-6.2, AZ-2). This is the
 * brief's §3.2 discipline pointed at the new actor: a shape that never selects
 * another candidate's rows cannot leak them.
 *
 * There is deliberately no `getApplication(id)` here and no route for one
 * (FR-6.8). With no by-id surface there is no scoping rule on it to forget.
 *
 * One indexed query, served by `@@index([candidateUserId, createdAt])` — the
 * filter and the ORDER BY in one index, so there is no sort step (PERF-1).
 */
export async function listApplications(candidateUserId: number): Promise<Application[]> {
  return prisma.application.findMany({
    where: { candidateUserId },
    // `id desc` is the tiebreak, matching the roles listing: two applications
    // sharing a `createdAt` must still have a stable order.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: APPLICATION_SELECT,
  });
}
