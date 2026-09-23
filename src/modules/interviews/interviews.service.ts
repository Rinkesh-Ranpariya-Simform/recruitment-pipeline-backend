import type { Logger } from 'pino';
import { Prisma } from '../../generated/prisma/client.js';
import {
  ApplicationStatus,
  AuditAction,
  AuditEntityType,
  InterviewOutcome,
  InterviewStatus,
  UserRole,
} from '../../generated/prisma/enums.js';
import {
  AlreadyAssignedError,
  ApplicationNotActiveError,
  DecisionAlreadyRecordedError,
  InterviewCancelledError,
  InvalidStageTransitionError,
  NotAnInterviewerError,
  NotFoundError,
  StageConflictError,
} from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { recordAudit } from '../audit/audit.service.js';
// The stage graph and the two guarded writes come from the module that OWNS
// them (applications FR-3.4). This is a real cross-module dependency and it is
// the right one: re-deriving `canTransition` here would put a second copy of
// the brief's §3.1 rule in the codebase, and two copies of a rule are two
// rules. `pipeline.rules` imports nothing but the Prisma enums, so nothing
// circular comes back with it.
import { ALLOWED_STAGE_TRANSITIONS, canTransition } from '../pipeline/pipeline.rules.js';
import { guardedOutcomeUpdate, guardedStageUpdate } from '../pipeline/pipeline.repository.js';
import {
  ASSIGNMENT_SELECT,
  RECRUITER_INTERVIEW_SELECT,
  type InterviewerInterviewView,
  type RecruiterInterviewView,
} from './interview.select.js';
import {
  findInterviewById,
  findInterviewPage,
  findInterviewsForApplication,
  type Pagination,
} from './interviews.repository.js';
import type {
  CreateInterviewInput,
  InterviewDecisionInput,
  ListInterviewsQuery,
  UpdateInterviewStatusInput,
} from './interviews.schema.js';

/**
 * Rounds, their lifecycle and their panel.
 *
 * Three rules hold across every function here:
 *
 *   1. **Every write is ONE transaction** holding its row change and its
 *      `recordAudit` call (BE-7). `recordAudit` is passed `tx`, never the global
 *      client — the latter does not compile (audit EC-03) — and its failure is
 *      deliberately not caught: an action that could not be recorded did not
 *      happen (ERR-6, EC-20).
 *   2. **Conflicts come from constraints, not from preceding reads** (BE-6). A
 *      duplicate assignment is `P2002` from the unique index; a missing round on
 *      an insert is `P2003` from the foreign key. Prisma codes are caught
 *      OUTSIDE the transaction callback, because a constraint violation has
 *      already aborted the Postgres transaction by the time the `catch` runs —
 *      the same pattern as `applications.service.createApplication`.
 *   3. **The select is chosen by role before the query runs** (BE-4, FR-5.4).
 *      There is no post-fetch removal step in this module, and no function
 *      named after any kind of cleaning pass — their absence is the design, and
 *      AC-B23 is the grep that confirms it.
 *
 * The interviewer scope itself is not written here. It lives in exactly one
 * place, `interviews.repository.ts` (BE-3, AZ-4).
 *
 * `log: Logger` is last on every function, matching every shipped service
 * (BE-8). Log lines carry ids and enum values only — never a candidate name, an
 * email or a round's contents (FR-7.2, SEC-7).
 */

/** The `POST …/assignments` response body (contract). */
export interface AssignmentCreatedView {
  id: number;
  interviewId: number;
  interviewer: { id: number; name: string };
  createdAt: Date;
}

/* -------------------------------------------------------------------------
 * FR-1 — creating a round
 * ---------------------------------------------------------------------- */

/**
 * Schedules one round against one ACTIVE application (FR-1.6).
 *
 * The application is resolved by `findFirst({ where: { id, status: ACTIVE } })`
 * — **the eligibility rule and the lookup are one statement**, so there is no
 * window between checking that an application is live and using it. The
 * follow-up read runs ONLY when the first misses, and exists only to tell a
 * missing application (`404`) from a terminal one (`409`).
 *
 * `status` is the `SCHEDULED` literal below, never a schema default, so the rule
 * lives where a reader will find it (FR-1.5). `createdByUserId` is the token's
 * subject; no body field can set it (AZ-7).
 *
 * `stage` is whatever the recruiter asked for and is **not** checked against the
 * application's `currentStage` (D-13, FR-1.4, EC-09): scheduling the technical
 * round while the candidate is still at SCREEN is routine. The stage on a round
 * is what it is FOR, not an assertion about now.
 */
export async function createInterview(
  applicationId: number,
  input: CreateInterviewInput,
  actorUserId: number,
  log: Logger,
): Promise<RecruiterInterviewView> {
  const interview = await prisma.$transaction(async (tx) => {
    const application = await tx.application.findFirst({
      where: { id: applicationId, status: ApplicationStatus.ACTIVE },
      select: { id: true },
    });

    if (application === null) {
      // Only reached on a miss, so the happy path stays at one lookup. A
      // terminal application is a 409 and a missing one a 404 — the recruiter
      // is the only actor who can reach this route, so there is no enumeration
      // concern in telling the two apart (EC-11, D-12).
      const exists = await tx.application.findUnique({
        where: { id: applicationId },
        select: { id: true },
      });

      throw exists === null ? new NotFoundError() : new ApplicationNotActiveError();
    }

    const created = await tx.interview.create({
      data: {
        applicationId: application.id,
        type: input.type,
        stage: input.stage,
        // `?? null` rather than passing `undefined` through: Prisma treats an
        // absent key and an explicit `null` identically on a create, but the
        // column is nullable on purpose and writing the intent out stops a
        // later reader assuming the field was forgotten (applications FR-2.3).
        scheduledAt: input.scheduledAt ?? null,
        status: InterviewStatus.SCHEDULED,
        createdByUserId: actorUserId,
      },
      select: RECRUITER_INTERVIEW_SELECT,
    });

    await recordAudit(
      tx,
      {
        action: AuditAction.INTERVIEW_CREATED,
        entityType: AuditEntityType.INTERVIEW,
        entityId: created.id,
        actorUserId,
        metadata: {
          applicationId: application.id,
          type: input.type,
          stage: input.stage,
          // An ISO string, not a `Date`: `metadata` is a JSON column and the
          // audit union pins the serialised form so two callers cannot disagree.
          //
          // The key is OMITTED on an undated round rather than written as
          // `null`, so a reader of the feed can tell "no date was set" from "a
          // date was set to nothing" — the latter is not a thing that happens.
          ...(input.scheduledAt ? { scheduledAt: input.scheduledAt.toISOString() } : {}),
        },
      },
      log,
    );

    return created;
  });

  log.info(
    {
      event: 'interview.created',
      actorId: actorUserId,
      interviewId: interview.id,
      applicationId,
      type: interview.type,
      stage: interview.stage,
    },
    'interview created',
  );

  return interview;
}

/* -------------------------------------------------------------------------
 * FR-2 — the lifecycle
 * ---------------------------------------------------------------------- */

/**
 * A round's status, its date, or both (FR-2.1, FR-2.2, applications FR-2.4).
 *
 * **Neither terminal status may change again.** A second status `PATCH` is `409
 * INVALID_STAGE_TRANSITION` — the code the pipeline feature added, reused rather
 * than duplicated: it is the same idea, a state machine refusing a move, and a
 * second code for it would give the client two branches where one suffices
 * (ERR-4, EC-14).
 *
 * **A date may only be set while a round is `SCHEDULED`**, through the same
 * guard and for the same reason. Moving the date of a round that already
 * happened, or was cancelled, would rewrite a fact rather than plan one; the
 * recruiter's path there is a new round.
 *
 * `status: SCHEDULED` is part of the `where` of the update itself, not checked
 * beforehand — so two concurrent `PATCH`es cannot both commit, and the loser
 * gets the same `409` as a sequential second attempt. The follow-up read runs
 * only on a miss, to tell a missing round from an already-terminal one.
 *
 * **Cancelling does not touch assignments** (FR-2.3, AC-B38). The round was
 * planned and its panel was chosen; erasing the panel would erase that record.
 */
export async function updateInterviewStatus(
  interviewId: number,
  input: UpdateInterviewStatusInput,
  actorUserId: number,
  log: Logger,
): Promise<RecruiterInterviewView> {
  // `'scheduledAt' in input`, not a truthiness test: `null` is a meaningful
  // value here — it clears the date back to undated — and `?? undefined` would
  // silently turn "clear it" into "leave it alone" (VAL-3).
  const changesDate = 'scheduledAt' in input;

  const interview = await prisma.$transaction(async (tx) => {
    const updated = await tx.interview.updateMany({
      where: { id: interviewId, status: InterviewStatus.SCHEDULED },
      data: {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(changesDate ? { scheduledAt: input.scheduledAt ?? null } : {}),
      },
    });

    if (updated.count === 0) {
      const existing = await tx.interview.findUnique({
        where: { id: interviewId },
        select: { status: true },
      });

      if (existing === null) {
        throw new NotFoundError();
      }

      // `details.allowed` is empty because nothing is reachable from a terminal
      // round — the same contract as the pipeline's stage refusal, so a client
      // renders its remaining actions from one array either way (ERR-1, XFE-2).
      throw new InvalidStageTransitionError(
        `This interview is already ${existing.status} and cannot be changed again`,
        { status: [`Not reachable from ${existing.status}`], allowed: [] },
      );
    }

    return tx.interview.findUniqueOrThrow({
      where: { id: interviewId },
      select: RECRUITER_INTERVIEW_SELECT,
    });
  });

  log.info(
    {
      event: 'interview.updated',
      actorId: actorUserId,
      interviewId,
      to: input.status ?? null,
      // Whether a date moved, never which date it moved to: the log line is a
      // fact about a process, and the round itself carries the value.
      rescheduled: changesDate,
    },
    'interview updated',
  );

  return interview;
}

/* -------------------------------------------------------------------------
 * applications FR-3 — the verdict, and what it moves
 * ---------------------------------------------------------------------- */

/**
 * Records "selected" or "rejected" AT one round, and applies what that means to
 * the application — **in one transaction** (applications FR-3.3).
 *
 * This is the single write behind the Select / Reject pair at the top of a
 * round's page, and it is one endpoint rather than three client calls for a
 * reason worth stating: a client that PATCHed the round, then the stage, then
 * the outcome could fail between any two of them and leave a candidate marked as
 * having passed a round they were never advanced past. Here the whole thing
 * commits or none of it does.
 *
 * What it does, in order:
 *
 * 1. **Closes the round** — `status: COMPLETED`, plus `outcome`, `decidedAt` and
 *    `decidedByUserId` — guarded on `outcome: null`. The guard is the duplicate
 *    check and the concurrency control at once: two recruiters clicking Select
 *    at the same instant both reach the statement, one matches zero rows, and
 *    that one is told `409 DECISION_ALREADY_RECORDED` rather than silently
 *    winning.
 * 2. **On `SELECTED`** — moves the application to the round's own stage, if it
 *    is not already there. `canTransition` is imported from `pipeline.rules`,
 *    **not re-derived here**: the stage graph has one definition, and a second
 *    copy in this module is how the two come to disagree. A move the graph
 *    refuses is `409 INVALID_STAGE_TRANSITION`, and the recruiter's path is then
 *    a stage override with a reason — the brief's §3.1 "cannot skip a stage
 *    without an explicit override" holding for this endpoint too.
 * 3. **On `REJECTED`** — closes the application, leaving `currentStage` exactly
 *    where it stopped (pipeline FR-3.5). "Rejected at Screen" and "rejected at
 *    Offer" are different outcomes, and an outcome that reset the stage would
 *    erase the difference.
 * 4. **Writes the history and audit rows** for whichever of those happened, plus
 *    one `INTERVIEW_DECISION_RECORDED` row naming the round. Three audit actions
 *    rather than one, because they answer three different questions — collapsing
 *    them would make *"which round advanced this candidate?"* unanswerable from
 *    the feed.
 *
 * **A `SELECTED` verdict at a round whose stage the candidate is already in
 * moves nothing, and that is correct rather than a gap.** A technical round
 * followed by a system-design round is two rounds at one stage. The timeline
 * shows both, because it is built from rounds; the stage does not move, because
 * the stage does not move.
 */
export async function recordDecision(
  interviewId: number,
  input: InterviewDecisionInput,
  actorUserId: number,
  log: Logger,
): Promise<RecruiterInterviewView> {
  const decidedAt = new Date();

  const { interview, movedToStage, closedWith } = await prisma.$transaction(async (tx) => {
    const existing = await tx.interview.findUnique({
      where: { id: interviewId },
      select: {
        id: true,
        stage: true,
        status: true,
        outcome: true,
        application: { select: { id: true, currentStage: true, status: true } },
      },
    });

    if (existing === null) {
      throw new NotFoundError();
    }

    if (existing.status === InterviewStatus.CANCELLED) {
      // A cancelled round did not happen, so there is nothing to decide about
      // it — the same reasoning that refuses feedback on one (feedback D-12).
      throw new InterviewCancelledError();
    }

    if (existing.application.status !== ApplicationStatus.ACTIVE) {
      throw new ApplicationNotActiveError();
    }

    const selected = input.decision === InterviewOutcome.SELECTED;
    const fromStage = existing.application.currentStage;

    // Whether this verdict moves the candidate, decided BEFORE anything is
    // written. A round at the stage they are already in advances nobody.
    const toStage = selected && fromStage !== existing.stage ? existing.stage : null;

    if (toStage !== null && !canTransition(fromStage, toStage)) {
      log.info(
        {
          event: 'interview.decision_refused',
          interviewId,
          fromStage,
          toStage,
          actorId: actorUserId,
        },
        'interview decision refused by the stage graph',
      );

      throw new InvalidStageTransitionError(
        `A candidate at ${fromStage} cannot move to ${toStage} without an override`,
        {
          toStage: [`Not reachable from ${fromStage}`],
          allowed: [...ALLOWED_STAGE_TRANSITIONS[fromStage]],
        },
      );
    }

    // The guard AND the write in one statement. `updateMany`, not `update`,
    // deliberately: `update` requires a unique `where` and would therefore have
    // to be preceded by a read-and-compare, which is the check-then-write this
    // design exists to avoid.
    const claimed = await tx.interview.updateMany({
      where: { id: interviewId, status: InterviewStatus.SCHEDULED, outcome: null },
      data: {
        status: InterviewStatus.COMPLETED,
        outcome: input.decision,
        decidedAt,
        decidedByUserId: actorUserId,
      },
    });

    if (claimed.count === 0) {
      // Someone decided this round between the read above and this statement.
      // The throw aborts the transaction, so no stage move and no audit row
      // survives a decision that did not happen.
      throw new DecisionAlreadyRecordedError();
    }

    if (toStage !== null) {
      const count = await guardedStageUpdate(
        tx,
        existing.application.id,
        fromStage,
        toStage,
        decidedAt,
      );

      if (count === 0) {
        // The application moved under us. Same reasoning as above: the whole
        // transaction goes, including the decision written a moment ago.
        throw new StageConflictError();
      }

      await tx.stageHistory.create({
        data: {
          applicationId: existing.application.id,
          fromStage,
          toStage,
          fromStatus: ApplicationStatus.ACTIVE,
          toStatus: ApplicationStatus.ACTIVE,
          changedByUserId: actorUserId,
          // Null: this transition did not use the override path (pipeline FR-5.4).
          overrideId: null,
        },
        select: { id: true },
      });

      await recordAudit(
        tx,
        {
          action: AuditAction.CANDIDATE_STAGE_CHANGED,
          entityType: AuditEntityType.APPLICATION,
          entityId: existing.application.id,
          actorUserId,
          metadata: { fromStage, toStage },
        },
        log,
      );
    }

    if (!selected) {
      const count = await guardedOutcomeUpdate(
        tx,
        existing.application.id,
        ApplicationStatus.REJECTED,
      );

      if (count === 0) {
        throw new StageConflictError();
      }

      await tx.stageHistory.create({
        data: {
          applicationId: existing.application.id,
          // `currentStage` is untouched by an outcome, and both ends are
          // recorded anyway: a history row that only fills in what moved cannot
          // be read on its own (pipeline FR-5.2).
          fromStage,
          toStage: fromStage,
          fromStatus: ApplicationStatus.ACTIVE,
          toStatus: ApplicationStatus.REJECTED,
          changedByUserId: actorUserId,
          overrideId: null,
        },
        select: { id: true },
      });

      await recordAudit(
        tx,
        {
          action: AuditAction.APPLICATION_OUTCOME_SET,
          entityType: AuditEntityType.APPLICATION,
          entityId: existing.application.id,
          actorUserId,
          // The same metadata shape `pipeline.setOutcome` writes, so the two
          // paths to a rejection produce one readable row type in the feed.
          // No `reason`: a rejection at a round is not an exception to the
          // process and the endpoint asks for none.
          metadata: {
            fromStatus: ApplicationStatus.ACTIVE,
            toStatus: ApplicationStatus.REJECTED,
            atStage: fromStage,
          },
        },
        log,
      );
    }

    await recordAudit(
      tx,
      {
        action: AuditAction.INTERVIEW_DECISION_RECORDED,
        entityType: AuditEntityType.INTERVIEW,
        entityId: interviewId,
        actorUserId,
        metadata: {
          applicationId: existing.application.id,
          outcome: input.decision,
          stage: existing.stage,
          ...(toStage === null ? {} : { toStage }),
          ...(selected ? {} : { toStatus: ApplicationStatus.REJECTED }),
        },
      },
      log,
    );

    return {
      interview: await tx.interview.findUniqueOrThrow({
        where: { id: interviewId },
        select: RECRUITER_INTERVIEW_SELECT,
      }),
      movedToStage: toStage,
      closedWith: selected ? null : ApplicationStatus.REJECTED,
    };
  });

  // Ids and enum values only — never the candidate's name (pipeline FR-10.2).
  log.info(
    {
      event: 'interview.decision_recorded',
      actorId: actorUserId,
      interviewId,
      applicationId: interview.application.id,
      outcome: input.decision,
      movedToStage,
      closedWith,
    },
    'interview decision recorded',
  );

  return interview;
}

/* -------------------------------------------------------------------------
 * FR-3 — the panel
 * ---------------------------------------------------------------------- */

/**
 * Puts one interviewer on one round (FR-3.2) — **the write the whole scoping
 * model rests on**, which is why it is recruiter-gated at the route and has no
 * other caller outside the seed (AZ-3, SEC-3).
 *
 * Three statements, and only three (PERF-6): the interviewer lookup, the insert,
 * the audit insert.
 *
 *   - **The role requirement is in the `where`** (FR-3.3): a `findFirst` for
 *     `{ id, role: INTERVIEWER }` that matches nothing is `400
 *     NOT_AN_INTERVIEWER`. A recruiter's or candidate's user row is never
 *     loaded, and a nonexistent id answers identically — so the endpoint does
 *     not reveal whether the id exists as some other role (EC-03, EC-04, VAL-6).
 *   - **The duplicate is refused by Postgres**, not by a preceding read: the
 *     `@@unique([interviewId, interviewerId])` index raises `P2002`, which
 *     becomes `409 ALREADY_ASSIGNED` (FR-3.4, D-5). A check-then-write loses to
 *     two concurrent clicks; a unique index cannot (EC-01, AC-B14). **Do not add
 *     a `findFirst` before this create.**
 *   - **A missing round is refused by the foreign key**, `P2003` → `404`, for
 *     the same reason and at the same cost: no extra statement.
 */
export async function assignInterviewer(
  interviewId: number,
  interviewerId: number,
  actorUserId: number,
  log: Logger,
): Promise<AssignmentCreatedView> {
  let assignment: AssignmentCreatedView;

  try {
    assignment = await prisma.$transaction(async (tx) => {
      const interviewer = await tx.user.findFirst({
        where: { id: interviewerId, role: UserRole.INTERVIEWER },
        select: { id: true },
      });

      if (interviewer === null) {
        throw new NotAnInterviewerError();
      }

      const created = await tx.interviewAssignment.create({
        data: {
          interviewId,
          interviewerId: interviewer.id,
          // The token's subject. A body carrying `assignedByUserId` was already
          // dropped by zod and reaches no code that could read it (AZ-7,
          // VAL-5, AC-B37).
          assignedByUserId: actorUserId,
        },
        select: ASSIGNMENT_SELECT,
      });

      await recordAudit(
        tx,
        {
          action: AuditAction.INTERVIEWER_ASSIGNED,
          entityType: AuditEntityType.INTERVIEW,
          entityId: interviewId,
          actorUserId,
          metadata: { interviewerId },
        },
        log,
      );

      return created;
    });
  } catch (error) {
    if (error instanceof NotAnInterviewerError) {
      log.warn(
        {
          event: 'interview.assign_refused',
          actorId: actorUserId,
          interviewId,
          targetUserId: interviewerId,
          reason: 'not_an_interviewer',
        },
        'interview assignment refused',
      );
      throw error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        log.warn(
          {
            event: 'interview.assign_refused',
            actorId: actorUserId,
            interviewId,
            targetUserId: interviewerId,
            reason: 'already_assigned',
          },
          'interview assignment refused',
        );
        throw new AlreadyAssignedError();
      }

      // The `Interview` this assignment names does not exist. Derived from the
      // FK the insert itself violates rather than a preceding existence check,
      // which a concurrent delete would invalidate anyway.
      if (error.code === 'P2003') {
        throw new NotFoundError();
      }
    }

    throw error;
  }

  log.info(
    {
      event: 'interview.assigned',
      actorId: actorUserId,
      interviewId,
      assignmentId: assignment.id,
      targetUserId: interviewerId,
    },
    'interviewer assigned',
  );

  return assignment;
}

/**
 * Takes an interviewer off a round (FR-3.6).
 *
 * **A hard delete** (D-10, MIG-5). The `AuditLog` row written in the same
 * transaction is the record that the assignment existed and was removed; a
 * soft-delete column would be a second, weaker record of the same fact, and two
 * records of one fact eventually disagree.
 *
 * **Not idempotent**: removing an assignment that is not there is `404`, not
 * `204` (FR-3.8, EC-08). A client that thinks it removed somebody who was never
 * on the panel has a bug worth surfacing.
 *
 * `deleteMany` rather than `delete`, so the miss is a `count` of 0 rather than a
 * `P2025` to catch — one statement either way, and no preceding read.
 *
 * **The interviewer loses read access immediately** (FR-3.10, AZ-8, EC-07):
 * authorization is a join against this table evaluated per request, not a claim
 * captured in their token, so their very next call answers `404` without them
 * re-authenticating (AC-B21).
 *
 * **It does not delete their feedback.** That is the feedback feature's decision
 * to state (feedback FR-6.4); `Feedback` has no foreign key to
 * `InterviewAssignment` for exactly this reason (FR-3.9).
 */
export async function unassignInterviewer(
  interviewId: number,
  interviewerId: number,
  actorUserId: number,
  log: Logger,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const removed = await tx.interviewAssignment.deleteMany({
      where: { interviewId, interviewerId },
    });

    if (removed.count === 0) {
      throw new NotFoundError();
    }

    await recordAudit(
      tx,
      {
        action: AuditAction.INTERVIEWER_UNASSIGNED,
        entityType: AuditEntityType.INTERVIEW,
        entityId: interviewId,
        actorUserId,
        metadata: { interviewerId },
      },
      log,
    );
  });

  // Logged after the transaction commits, so it never claims a removal that was
  // rolled back.
  log.info(
    {
      event: 'interview.unassigned',
      actorId: actorUserId,
      interviewId,
      targetUserId: interviewerId,
    },
    'interviewer unassigned',
  );
}

/* -------------------------------------------------------------------------
 * FR-4 — the reads
 * ---------------------------------------------------------------------- */

/**
 * One endpoint, both roles, two projections (FR-4.1, D-7).
 *
 * The scoping is entirely `buildInterviewWhere`'s, in the repository — this
 * function does not filter, and **must not start**: an interviewer's page is
 * narrow because the query was narrow, not because rows were dropped from a
 * wider one (AZ-4, XFE-2).
 *
 * An empty result is `200 { interviews: [], pagination }`, never a `404` and
 * never a `403` (EC-15). A page past the end is the same, with accurate
 * pagination (EC-16).
 */
export async function listInterviews(
  query: ListInterviewsQuery,
  actorRole: UserRole,
  actorId: number,
  log: Logger,
): Promise<{
  interviews: Array<RecruiterInterviewView> | Array<InterviewerInterviewView>;
  pagination: Pagination;
}> {
  const { interviews, total } = await findInterviewPage(query, actorRole, actorId);

  log.info(
    { event: 'interview.listed', actorId, actorRole, resultCount: interviews.length },
    'interviews listed',
  );

  return {
    interviews,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      // 0 for an empty result, not 1 — matching the roles and audit pagers.
      totalPages: Math.ceil(total / query.pageSize),
    },
  };
}

/**
 * One round by id, scoped in the query (FR-4.5).
 *
 * **No row is `404 NOT_FOUND`, never `403`** (FR-4.6, AZ-5, ERR-1). A `403`
 * would confirm the round exists, turning the endpoint into an enumeration
 * oracle; the `404` an unassigned interviewer gets is byte-identical to the one
 * a nonexistent id gets (AC-B18). This is the brief's sharpest check.
 *
 * The miss is logged as `interview.scoped_read_miss` for a non-recruiter only —
 * the single most useful line for noticing someone probing the id space, and it
 * carries ids alone (FR-7.1, SEC-7, AC-B19). A recruiter's miss is an ordinary
 * `404` and says nothing about access.
 */
export async function getInterview(
  interviewId: number,
  actorRole: UserRole,
  actorId: number,
  log: Logger,
): Promise<RecruiterInterviewView | InterviewerInterviewView> {
  const interview = await findInterviewById(interviewId, actorRole, actorId);

  if (interview === null) {
    if (actorRole !== UserRole.RECRUITER) {
      log.warn(
        { event: 'interview.scoped_read_miss', actorId, actorRole, interviewId },
        'scoped interview read matched no row',
      );
    }

    throw new NotFoundError();
  }

  return interview;
}

/**
 * Every round on one application, recruiter-only (FR-1.9, AZ-6).
 *
 * The application is resolved first so that a nonexistent one is a `404` rather
 * than an empty list — "this application has no rounds" and "there is no such
 * application" are different facts, and only a recruiter can reach this route,
 * so telling them apart leaks nothing.
 */
export async function listApplicationInterviews(
  applicationId: number,
  actorId: number,
  log: Logger,
): Promise<Array<RecruiterInterviewView>> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true },
  });

  if (application === null) {
    throw new NotFoundError();
  }

  const interviews = await findInterviewsForApplication(applicationId);

  log.info(
    { event: 'interview.listed', actorId, applicationId, resultCount: interviews.length },
    'application interviews listed',
  );

  return interviews;
}
