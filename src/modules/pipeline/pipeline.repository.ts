import { Prisma } from '../../../generated/prisma/client.js';
import { ApplicationStatus, PipelineStage } from '../../../generated/prisma/enums.js';
import { prisma } from '../../lib/prisma.js';
import type { PipelineQuery } from './pipeline.schema.js';

/**
 * The only file in this codebase permitted to contain raw SQL (BE-4).
 *
 * It holds one statement, and it is here because Prisma's `groupBy` cannot
 * express `now() - "stageEnteredAt"` per group (D-9). The alternative — loading
 * applications into Node and computing ageing in a loop — is the one thing the
 * brief forbids by name (§6), so the interval arithmetic goes to the database
 * where it belongs.
 *
 * **Every interpolation is a tagged-template `${}`, never string concatenation**
 * (FR-7.5, SEC-3). Prisma sends each one as a bound parameter, so the statement
 * text is fixed at compile time. `$queryRawUnsafe` is not used here or anywhere
 * else in `src/` — that rule is absolute and is checked by AC-B37.
 *
 * The two values that reach it have already been through zod: `roleId` is a
 * coerced positive integer and `stage` is constrained to the `PipelineStage`
 * enum (VAL table). Neither could carry SQL even if the binding did not stop
 * it — that is belt and braces, not the control.
 */

/**
 * One `(role, stage)` cell as Postgres returns it.
 *
 * Explicitly typed rather than `any` (BE-4): `$queryRaw` returns whatever the
 * statement produced, so the only thing standing between a renamed column and a
 * runtime `undefined` is this interface agreeing with the SELECT list below.
 *
 * The numeric columns are cast to `float8` in the statement, not left as
 * `numeric`. The pg driver returns `numeric` as a **string** to preserve
 * arbitrary precision, which would put `"4.2"` into a field the contract
 * declares a number and hand the client a silently wrong type. `float8` comes
 * back as a JS number, and one decimal place of a day count has no precision
 * worth preserving.
 */
export interface PipelineCellRow {
  roleId: number;
  currentStage: PipelineStage;
  candidateCount: number;
  avgDaysInStage: number | null;
  maxDaysInStage: number | null;
}

/**
 * Counts and ageing per role per stage — **one SQL statement** (FR-7.4, PERF-2).
 *
 * `GROUP BY` does the counting, `AVG`/`MAX` over `now() - "stageEnteredAt"` do
 * the ageing, and nothing is computed in Node. The statement is issued once per
 * request regardless of how many roles, stages or candidates it covers: there is
 * no query per role, per stage or per candidate anywhere in this feature
 * (PERF-2).
 *
 * `WHERE status = 'ACTIVE'` leads because it is the most selective predicate,
 * and `Application_status_roleId_currentStage_idx` is ordered to match — the
 * plan is an index scan, verified by AC-B34. Hired and rejected applications are
 * excluded entirely (FR-7.6): a board is a picture of live candidates, and the
 * outcomes are reported separately by the summary.
 *
 * **It returns no row for an empty group** — that is how `GROUP BY` works, and
 * it is why the service densifies rather than trusting this shape (FR-7.7).
 * It also returns no row for a role with no applications at all, which is why
 * the role list is read separately and drives the response.
 *
 * The enum casts on the bound parameters are required, not decorative: the
 * driver sends parameters as text, and `"currentStage" = $1` with a text `$1`
 * is an operator Postgres does not have.
 */
export async function aggregatePipeline(query: PipelineQuery): Promise<Array<PipelineCellRow>> {
  const roleFilter =
    query.roleId === undefined ? Prisma.empty : Prisma.sql`AND a."roleId" = ${query.roleId}`;

  const stageFilter =
    query.stage === undefined
      ? Prisma.empty
      : Prisma.sql`AND a."currentStage" = ${query.stage}::"PipelineStage"`;

  return prisma.$queryRaw<Array<PipelineCellRow>>`
    SELECT a."roleId"                                                                    AS "roleId",
           a."currentStage"                                                              AS "currentStage",
           COUNT(*)::int                                                                 AS "candidateCount",
           ROUND(AVG(EXTRACT(EPOCH FROM (now() - a."stageEnteredAt")) / 86400)::numeric, 1)::float8 AS "avgDaysInStage",
           ROUND(MAX(EXTRACT(EPOCH FROM (now() - a."stageEnteredAt")) / 86400)::numeric, 1)::float8 AS "maxDaysInStage"
      FROM "Application" a
     WHERE a."status" = ${ApplicationStatus.ACTIVE}::"ApplicationStatus"
       ${roleFilter}
       ${stageFilter}
     GROUP BY a."roleId", a."currentStage"
  `;
}

/**
 * Move an application's stage — **guarded, and the guard is the concurrency
 * control** (FR-6.2, D-10).
 *
 * The stage the caller observed before the transaction opened is part of the
 * `where`. If another request moved the row in between, this matches **zero**
 * rows, the caller throws, and the whole transaction — history row, audit row,
 * override row — rolls back with it. The second recruiter is told `409
 * STAGE_CONFLICT` instead of silently overwriting the first (FR-6.1).
 *
 * `updateMany`, not `update`, on purpose: `update` requires a unique `where`
 * and would therefore have to be preceded by a read-and-compare, which is the
 * check-then-write this design exists to avoid. `updateMany` lets the guard and
 * the write be one statement, and its `count` is the answer.
 *
 * `status: ACTIVE` is in the guard too, so a concurrent outcome also loses the
 * race rather than being overwritten (EC-04).
 *
 * There is no version column and none is needed (FR-6.6): `currentStage` is
 * itself the version, because every transition changes it.
 */
export async function guardedStageUpdate(
  tx: Prisma.TransactionClient,
  applicationId: number,
  fromStage: PipelineStage,
  toStage: PipelineStage,
  stageEnteredAt: Date,
): Promise<number> {
  const { count } = await tx.application.updateMany({
    where: { id: applicationId, status: ApplicationStatus.ACTIVE, currentStage: fromStage },
    data: { currentStage: toStage, stageEnteredAt },
  });

  return count;
}

/**
 * Set an application's outcome — the same guard shape, on `status` (FR-6.3).
 *
 * **`currentStage` and `stageEnteredAt` are not touched** (FR-3.5). The
 * application stops where it stopped, which is the fact a hiring manager needs:
 * "rejected at Screen" and "rejected at Offer" are different outcomes, and an
 * outcome that resets the stage erases the difference.
 *
 * The guard is `status: ACTIVE`, so a second outcome — or an outcome racing a
 * stage move — matches zero rows and becomes a `409` rather than a lost update
 * (EC-04, EC-10).
 */
export async function guardedOutcomeUpdate(
  tx: Prisma.TransactionClient,
  applicationId: number,
  toStatus: ApplicationStatus,
): Promise<number> {
  const { count } = await tx.application.updateMany({
    where: { id: applicationId, status: ApplicationStatus.ACTIVE },
    data: { status: toStatus },
  });

  return count;
}
