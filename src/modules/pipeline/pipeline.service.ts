import type { Logger } from 'pino';
import {
  ApplicationStatus,
  AuditEntityType,
  InterviewStatus,
  PipelineStage,
} from '../../../generated/prisma/enums.js';
import type { RoleStatus } from '../../../generated/prisma/enums.js';
import {
  ApplicationNotActiveError,
  InvalidStageTransitionError,
  NotFoundError,
  StageConflictError,
  ValidationError,
} from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { recordAudit } from '../audit/audit.service.js';
import {
  aggregatePipeline,
  guardedOutcomeUpdate,
  guardedStageUpdate,
} from './pipeline.repository.js';
import {
  ALLOWED_OUTCOMES,
  ALLOWED_STAGE_TRANSITIONS,
  STAGE_ORDER,
  canSetOutcome,
  canTransition,
  stagesSkipped,
} from './pipeline.rules.js';
import { APPLICATION_STATE_SELECT, STAGE_OVERRIDE_SELECT } from './pipeline.select.js';
import type { PipelineQuery, SetOutcomeInput, StageOverrideInput } from './pipeline.schema.js';

/**
 * The three write transactions and the two reads.
 *
 * Every write follows the same three beats:
 *
 *   1. **Read once, outside the transaction** — one primary-key lookup.
 *   2. **Ask `pipeline.rules`** whether the move is legal. An illegal move costs
 *      that one read and no write at all.
 *   3. **One `prisma.$transaction`** holding the guarded update, the history
 *      insert, the override insert where there is one, and `recordAudit`. All of
 *      them commit or none do.
 *
 * The gap between step 1 and step 3 is real and is **not** closed by locking —
 * it is closed by the guard inside the update, which carries the stage step 1
 * observed. A row that moved in between matches zero rows and the whole
 * transaction aborts. That is why there is no check-then-write here despite
 * there being a read before a write.
 *
 * `recordAudit` is called with `tx`, never the global client, and its failure is
 * deliberately not caught: an action that could not be recorded did not happen.
 */

/* -------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------- */

/** The write responses' `application`. No candidate, by construction. */
export interface PipelineApplication {
  id: number;
  status: ApplicationStatus;
  currentStage: PipelineStage;
  stageEnteredAt: Date;
  role: { id: number; title: string };
}

/** The override as `POST …/stage-override` returns it. `performedBy` is a recruiter. */
export interface StageOverrideView {
  id: number;
  fromStage: PipelineStage;
  toStage: PipelineStage;
  reason: string;
  skipped: number;
  createdAt: Date;
  performedBy: { id: number; name: string };
}

/** One board cell. `avgDaysInStage`/`maxDaysInStage` are null iff the count is 0. */
export interface PipelineStageCell {
  stage: PipelineStage;
  candidateCount: number;
  avgDaysInStage: number | null;
  maxDaysInStage: number | null;
}

/** One board column group — a role and its four (or filtered) stage cells. */
export interface PipelineRoleView {
  id: number;
  title: string;
  status: RoleStatus;
  totalActive: number;
  stages: Array<PipelineStageCell>;
}

/**
 * The dashboard headline. **Seven** numbers, including the interviews count.
 *
 * `interviews` is the count of `SCHEDULED` rounds across all applications — the
 * dashboard's third tile. Additive: a client written against the six-field
 * version simply does not render the new tile.
 */
export interface PipelineSummary {
  openRoles: number;
  totalApplicants: number;
  activeApplicants: number;
  offers: number;
  hired: number;
  rejected: number;
  interviews: number;
}

/* -------------------------------------------------------------------------
 * Shared pre-flight
 * ---------------------------------------------------------------------- */

/**
 * The one read every write performs, and the only one.
 *
 * A primary-key lookup selecting five columns and joining `Role` by its own
 * primary key for the title. The title is fetched **here** rather than by
 * re-reading the application after the update, because everything else the
 * response needs is already known once the guarded update reports success:
 * `currentStage` is the stage we asked for, `stageEnteredAt` is the timestamp we
 * passed, `status` is unchanged. Assembling the response from those keeps the
 * transaction to four statements instead of adding a fifth read.
 *
 * A missing application is a `404`. There is no 403-versus-404 enumeration
 * concern to weigh: every non-recruiter was already refused at the route, so
 * the only actor who can tell "missing" from "exists" is the one permitted to
 * see all of them.
 *
 * A terminal application is refused **here**, before the transaction opens.
 * `HIRED` and `REJECTED` are terminal for all three writes, so the check belongs
 * in the one place all three pass through.
 */
async function loadActiveApplication(applicationId: number): Promise<{
  id: number;
  status: ApplicationStatus;
  currentStage: PipelineStage;
  stageEnteredAt: Date;
  role: { id: number; title: string };
}> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: APPLICATION_STATE_SELECT,
  });

  if (application === null) {
    throw new NotFoundError();
  }

  if (application.status !== ApplicationStatus.ACTIVE) {
    throw new ApplicationNotActiveError();
  }

  return application;
}

/**
 * The refusal an illegal move produces.
 *
 * `details.allowed` is the live answer from the map — the stages actually
 * reachable from where this application sits. The client renders its buttons
 * from that array and never owns a second copy of the graph; two copies
 * disagree the first time the graph changes.
 *
 * The message names both ends. "Not allowed" on its own tells a recruiter
 * nothing about what is.
 */
function invalidStageTransition(
  from: PipelineStage,
  to: PipelineStage,
): InvalidStageTransitionError {
  return new InvalidStageTransitionError(
    `A candidate at ${from} cannot move to ${to} without an override`,
    {
      toStage: [`Not reachable from ${from}`],
      allowed: [...ALLOWED_STAGE_TRANSITIONS[from]],
    },
  );
}

/* -------------------------------------------------------------------------
 * Legal move along the graph
 * ---------------------------------------------------------------------- */

/**
 * Advance an application one stage.
 *
 * The graph is consulted **before** the transaction opens, so a refused move
 * costs one indexed read and touches nothing. `toStage === currentStage` is
 * refused here too and is a `409`, not a no-op `200`: a transition to where you
 * already are is a client bug, and a `200` hides it.
 *
 * Inside the transaction, in this order: the guarded update, the history row
 * with `overrideId: null`, the audit row. The `count === 0` branch is the
 * concurrency control, not an error path that "shouldn't happen" — it is the
 * ordinary outcome when two recruiters act at once, and the loser is told.
 */
export async function changeStage(
  applicationId: number,
  toStage: PipelineStage,
  actorUserId: number,
  log: Logger,
): Promise<PipelineApplication> {
  const application = await loadActiveApplication(applicationId);
  const fromStage = application.currentStage;

  if (!canTransition(fromStage, toStage)) {
    log.info(
      { event: 'pipeline.transition_refused', applicationId, fromStage, toStage, actorUserId },
      'stage transition refused',
    );
    throw invalidStageTransition(fromStage, toStage);
  }

  const stageEnteredAt = new Date();

  await prisma.$transaction(async (tx) => {
    const count = await guardedStageUpdate(tx, applicationId, fromStage, toStage, stageEnteredAt);

    if (count === 0) {
      // Someone moved this row between the read above and this statement. The
      // throw aborts the transaction, so no history and no audit row survive a
      // stage change that did not happen.
      throw new StageConflictError();
    }

    await tx.stageHistory.create({
      data: {
        applicationId,
        fromStage,
        toStage,
        // The status is unchanged by a stage move, and both ends are recorded
        // anyway: a history row that only fills in what moved cannot be read on
        // its own.
        fromStatus: ApplicationStatus.ACTIVE,
        toStatus: ApplicationStatus.ACTIVE,
        changedByUserId: actorUserId,
        // Null: this transition did not use the override path.
        overrideId: null,
      },
      select: { id: true },
    });

    await recordAudit(
      tx,
      {
        action: 'CANDIDATE_STAGE_CHANGED',
        entityType: AuditEntityType.APPLICATION,
        entityId: applicationId,
        actorUserId,
        metadata: { fromStage, toStage },
      },
      log,
    );
  });

  // Ids and enum values only.
  log.info(
    { event: 'pipeline.stage_changed', applicationId, fromStage, toStage, actorUserId },
    'stage changed',
  );

  return { ...application, currentStage: toStage, stageEnteredAt };
}

/* -------------------------------------------------------------------------
 * The override
 * ---------------------------------------------------------------------- */

/**
 * Skip a stage, on the record.
 *
 * This is the escape hatch from the graph, so it is **not itself constrained by
 * the graph**: any stage other than the current one, forwards or backwards.
 * Constraining it would just produce a second graph for recruiters to work
 * around. A backwards override is permitted deliberately — a recruiter who
 * advanced someone by mistake needs a recorded way back, and the reason column
 * is what makes that accountable rather than quiet.
 *
 * `toStage === currentStage` is a `400`, not the `409` the stage endpoint gives.
 * The asymmetry is real: this endpoint's contract is "change the stage to
 * something else", which such a body violates, while the stage endpoint's
 * contract is "make this legal move", which the graph refuses.
 *
 * **The override row is inserted FIRST.** If anything downstream fails, the
 * transaction takes the whole thing with it — but the ordering is what makes the
 * intent unambiguous to a reader: the record of *why* is not an afterthought
 * appended to a move that already happened.
 *
 * An override to a stage the graph would have allowed anyway is permitted and
 * recorded with `skipped: 0`. Refusing it would force a client to re-derive the
 * graph just to choose which endpoint to call.
 */
export async function overrideStage(
  applicationId: number,
  input: StageOverrideInput,
  actorUserId: number,
  log: Logger,
): Promise<{ application: PipelineApplication; override: StageOverrideView }> {
  const application = await loadActiveApplication(applicationId);
  const fromStage = application.currentStage;
  const { toStage, reason } = input;

  if (toStage === fromStage) {
    log.info(
      { event: 'pipeline.transition_refused', applicationId, fromStage, toStage, actorUserId },
      'override refused: already at that stage',
    );
    // A 400 — a `ValidationError`, not the 409 the stage endpoint raises. The
    // body is what is wrong here: this endpoint's contract is "change the stage
    // to something else". Recording an override that changes nothing would
    // pollute the very trail this feature exists to keep clean.
    throw new ValidationError({
      toStage: [`The application is already at ${fromStage}`],
    });
  }

  const skipped = stagesSkipped(fromStage, toStage);
  const stageEnteredAt = new Date();

  const override = await prisma.$transaction(async (tx) => {
    // FIRST — the record of why.
    const created = await tx.stageOverride.create({
      data: { applicationId, fromStage, toStage, reason, performedByUserId: actorUserId },
      select: STAGE_OVERRIDE_SELECT,
    });

    const count = await guardedStageUpdate(tx, applicationId, fromStage, toStage, stageEnteredAt);

    if (count === 0) {
      // The row moved under us. The `StageOverride` inserted a moment ago rolls
      // back with this transaction, so **no orphan override exists** for a move
      // that did not happen — which is the whole reason the insert is inside the
      // transaction rather than before it.
      throw new StageConflictError();
    }

    await tx.stageHistory.create({
      data: {
        applicationId,
        fromStage,
        toStage,
        fromStatus: ApplicationStatus.ACTIVE,
        toStatus: ApplicationStatus.ACTIVE,
        changedByUserId: actorUserId,
        // Non-null exactly because this transition used the override path, and
        // `@unique` on the column stops the two fanning out.
        overrideId: created.id,
      },
      select: { id: true },
    });

    await recordAudit(
      tx,
      {
        action: 'STAGE_OVERRIDE_CREATED',
        entityType: AuditEntityType.APPLICATION,
        entityId: applicationId,
        actorUserId,
        // `reason` is required by the audit union's type, which is how the rule
        // is enforced at compile time rather than by a runtime check that could
        // be skipped.
        metadata: { fromStage, toStage, reason, overrideId: created.id, skipped },
      },
      log,
    );

    return created;
  });

  // `reason` is NOT logged — it is recruiter free text about a candidate, it is
  // in pino's `redact` list, and pino is not the business record.
  log.info(
    {
      event: 'pipeline.override_created',
      applicationId,
      overrideId: override.id,
      fromStage,
      toStage,
      skipped,
      actorUserId,
    },
    'stage override created',
  );

  return {
    application: { ...application, currentStage: toStage, stageEnteredAt },
    override: { ...override, skipped },
  };
}

/* -------------------------------------------------------------------------
 * The outcome
 * ---------------------------------------------------------------------- */

/**
 * Close an application as hired or rejected.
 *
 * **`currentStage` is not touched.** The application stops where it stopped:
 * "rejected at Screen" and "rejected at Offer" are different outcomes, and
 * moving the stage on the way out would erase the difference a hiring manager
 * is reading for. `stageEnteredAt` is likewise left alone.
 *
 * `HIRED` is legal only from `OFFER` — hiring someone who was never offered is
 * exactly the skip this feature exists to prevent, and it must go through an
 * override to `OFFER` first, leaving a reason behind it.
 *
 * The guard is on `status: ACTIVE`, so a second outcome or a racing stage move
 * loses rather than overwriting.
 */
export async function setOutcome(
  applicationId: number,
  input: SetOutcomeInput,
  actorUserId: number,
  log: Logger,
): Promise<PipelineApplication> {
  const application = await loadActiveApplication(applicationId);
  const atStage = application.currentStage;
  const toStatus = input.status;

  if (!canSetOutcome(atStage, toStatus)) {
    log.info(
      { event: 'pipeline.transition_refused', applicationId, atStage, toStatus, actorUserId },
      'outcome refused',
    );
    throw new InvalidStageTransitionError(
      `An application at ${atStage} cannot be set to ${toStatus}`,
      {
        status: [`Not reachable from ${atStage}`],
        allowed: [...ALLOWED_OUTCOMES[atStage]],
      },
    );
  }

  await prisma.$transaction(async (tx) => {
    const count = await guardedOutcomeUpdate(tx, applicationId, toStatus);

    if (count === 0) {
      throw new StageConflictError();
    }

    await tx.stageHistory.create({
      data: {
        applicationId,
        // Both stage ends are the SAME value, because an outcome moves the
        // status and not the stage. The row is still written: every change to
        // either column leaves exactly one history row, with no exceptions and
        // no code path that skips it.
        fromStage: atStage,
        toStage: atStage,
        fromStatus: ApplicationStatus.ACTIVE,
        toStatus,
        changedByUserId: actorUserId,
        overrideId: null,
      },
      select: { id: true },
    });

    await recordAudit(
      tx,
      {
        action: 'APPLICATION_OUTCOME_SET',
        entityType: AuditEntityType.APPLICATION,
        entityId: applicationId,
        actorUserId,
        metadata: {
          fromStatus: ApplicationStatus.ACTIVE,
          toStatus,
          atStage,
          // Optional, and omitted rather than written as `null` when absent.
          // `exactOptionalPropertyTypes` is on, so the key is built
          // conditionally rather than spread with an `undefined` value.
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      },
      log,
    );
  });

  log.info(
    { event: 'pipeline.outcome_set', applicationId, atStage, toStatus, actorUserId },
    'application outcome set',
  );

  return { ...application, status: toStatus };
}

/* -------------------------------------------------------------------------
 * The board
 * ---------------------------------------------------------------------- */

/**
 * Counts per stage per role, with ageing.
 *
 * **Two queries, whatever the scale**: one `GROUP BY` over `Application`, and
 * one indexed read of `Role` for the titles and statuses. Not one per role, not
 * one per stage, and never a `findMany` over applications.
 *
 * The **roles** drive the response, not the aggregate. A role with no
 * applications produces no `GROUP BY` row at all, so reading the roles
 * separately is what makes it appear with four empty cells instead of vanishing.
 * `CLOSED` roles are included: one with live applications in it is exactly the
 * role people get forgotten in.
 *
 * The result is **densified**: every role carries a cell for every stage in
 * scope, in `STAGE_ORDER` and never alphabetically — `APPLIED, INTERVIEW,
 * OFFER, SCREEN` is a board nobody can read. A client that has to invent the
 * missing columns is a client that will invent them differently from the next
 * one.
 *
 * `avgDaysInStage` and `maxDaysInStage` are `null` on an empty cell and never
 * `0`: null means *no candidates*, zero means *no time*, and an application
 * created a second ago legitimately reads `0.0`.
 *
 * `?roleId=` naming a role that does not exist is `200 { roles: [] }`, not a
 * `404` — the filter matched nothing, which is a valid answer to a question
 * about counts.
 */
export async function getPipeline(
  query: PipelineQuery,
  log: Logger,
): Promise<Array<PipelineRoleView>> {
  const [roles, cells] = await Promise.all([
    prisma.role.findMany({
      where: query.roleId === undefined ? {} : { id: query.roleId },
      // The shipped roles ordering, tiebroken by id — two roles sharing a
      // `createdAt` must still have one order.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, title: true, status: true },
    }),
    aggregatePipeline(query),
  ]);

  // One pass over the cells into a map keyed by `roleId:stage`, so densifying
  // below is a lookup per cell rather than a scan of the whole result per cell.
  // At 200 roles that is the difference between 800 lookups and 640,000
  // comparisons.
  const byRoleStage = new Map<string, (typeof cells)[number]>();
  for (const cell of cells) {
    byRoleStage.set(`${cell.roleId}:${cell.currentStage}`, cell);
  }

  // When `?stage=` is given the board shows that column only — the aggregate
  // was filtered to it, so densifying the other three would state a zero the
  // query never asked about.
  const stagesInScope =
    query.stage === undefined ? STAGE_ORDER : STAGE_ORDER.filter((stage) => stage === query.stage);

  const board = roles.map((role) => {
    const stages: Array<PipelineStageCell> = stagesInScope.map((stage) => {
      const cell = byRoleStage.get(`${role.id}:${stage}`);

      if (cell === undefined) {
        return { stage, candidateCount: 0, avgDaysInStage: null, maxDaysInStage: null };
      }

      return {
        stage,
        candidateCount: cell.candidateCount,
        avgDaysInStage: cell.avgDaysInStage,
        maxDaysInStage: cell.maxDaysInStage,
      };
    });

    return {
      id: role.id,
      title: role.title,
      status: role.status,
      // The sum of the cells shown, so the header and the columns under it can
      // never disagree. Under `?stage=`, that is the count for that one stage —
      // which is what "active, in scope" means for a filtered board.
      totalActive: stages.reduce((total, cell) => total + cell.candidateCount, 0),
      stages,
    };
  });

  // Counts only. No role titles and no filter values: the aggregate's shape is
  // the interesting fact, not the requisitions in it.
  log.info(
    { event: 'pipeline.aggregate_read', roleCount: board.length, cellCount: cells.length },
    'pipeline aggregate read',
  );

  return board;
}

/* -------------------------------------------------------------------------
 * The dashboard headline
 * ---------------------------------------------------------------------- */

/**
 * Seven indexed counts in one transaction.
 *
 * `count` with a `where`, never a `findMany` whose `length` is taken — the
 * latter is the same mistake as computing ageing in Node, just wearing a
 * different hat.
 *
 * One `$transaction` so the seven numbers describe one instant. Reported
 * separately from the board because the board is live candidates only and
 * `hired`/`rejected` are the outcomes that left it.
 *
 * **`interviews`** is one more indexed `count` in the transaction that was
 * already running, served by `Interview_status_scheduledAt_idx`, and it adds
 * no new authorization surface: the endpoint is recruiter-only either way.
 */
export async function getSummary(log: Logger): Promise<PipelineSummary> {
  const [openRoles, totalApplicants, activeApplicants, offers, hired, rejected, interviews] =
    await prisma.$transaction([
      prisma.role.count({ where: { status: 'OPEN' } }),
      prisma.application.count(),
      prisma.application.count({ where: { status: ApplicationStatus.ACTIVE } }),
      prisma.application.count({
        where: { status: ApplicationStatus.ACTIVE, currentStage: PipelineStage.OFFER },
      }),
      prisma.application.count({ where: { status: ApplicationStatus.HIRED } }),
      prisma.application.count({ where: { status: ApplicationStatus.REJECTED } }),
      // Every SCHEDULED round, on any application including terminal ones — a
      // round on a rejected application is still on the calendar until someone
      // cancels it.
      prisma.interview.count({ where: { status: InterviewStatus.SCHEDULED } }),
    ]);

  log.info({ event: 'pipeline.aggregate_read', scope: 'summary' }, 'pipeline summary read');

  return { openRoles, totalApplicants, activeApplicants, offers, hired, rejected, interviews };
}
