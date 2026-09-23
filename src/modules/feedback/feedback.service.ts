import type { Logger } from 'pino';
import { Prisma } from '../../generated/prisma/client.js';
import {
  AuditAction,
  AuditEntityType,
  InterviewStatus,
  UserRole,
} from '../../generated/prisma/enums.js';
import {
  FeedbackAlreadySubmittedError,
  InterviewCancelledError,
  NotFoundError,
} from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { recordAudit } from '../audit/audit.service.js';
import { FEEDBACK_SELECT, type FeedbackView } from './feedback.select.js';
import {
  findEditableFeedback,
  findRoundFeedback,
  resolveWritableInterview,
  updateOwnFeedback,
} from './feedback.repository.js';
import type { CreateFeedbackInput, UpdateFeedbackInput } from './feedback.schema.js';

/**
 * Structured feedback: submit, edit, read.
 *
 * Four rules hold across every function here:
 *
 *   1. **Authorization is the assignment, resolved in the query** — never
 *      `feedback.interviewerId === currentUser.id`, which compares a value this
 *      service is about to write to itself and authorizes nothing (FR-1.3,
 *      SEC-3). The predicate itself is not written in this file; it lives in
 *      exactly one place, `feedback.repository.ts` (BE-2, AZ-2).
 *   2. **Every write is ONE transaction** holding its row change and its
 *      `recordAudit` call (BE-7). `recordAudit` is passed `tx`, never the global
 *      client — the latter does not compile — and its failure is deliberately
 *      not caught: an action that could not be recorded did not happen (ERR-7,
 *      EC-20).
 *   3. **Conflicts come from constraints, not from preceding reads** (BE-5).
 *      The duplicate submission is `P2002` from
 *      `@@unique([interviewId, interviewerId])`, caught OUTSIDE the transaction
 *      callback because a constraint violation has already aborted the Postgres
 *      transaction by the time the `catch` runs — the same pattern as
 *      `applications.service.createApplication` and `assignInterviewer`.
 *      **There is no `findFirst` before the `create`**, and AC-B15 is the grep
 *      that confirms it.
 *   4. **One projection, `FEEDBACK_SELECT`, for both roles.** It reaches no
 *      candidate relation, so the response the brief's §3.6 singles out has
 *      nothing in it to strip (SEC-1). There is no `sanitise`, `strip` or
 *      `redact` function in this module, and that absence is the design
 *      (SEC-2, AC-B38).
 *
 * `log: Logger` is last on every function, matching every shipped service
 * (BE-8). Log lines carry ids and ratings only — **`notes` is never logged**
 * (FR-7.2, SEC-5), and it is on pino's `redact` list as a second line of
 * defence.
 */

/* -------------------------------------------------------------------------
 * FR-2 / FR-3 — submitting
 * ---------------------------------------------------------------------- */

/**
 * One interviewer's assessment of one round (FR-2.1).
 *
 * **Three statements in one transaction** (PERF-1): the scoped round lookup, the
 * insert, the audit insert. Nothing else — and in particular **no pre-check for
 * an existing submission**. The unique index does that work, and a check would
 * cost a query *and* still be wrong: two overlapping requests from one person
 * both read "nothing here yet" and both commit (FR-3.3, D-3).
 *
 * **The §3.4 policy, stated once: both submissions are kept.** Two different
 * interviewers firing at the same instant hold different unique-key tuples, so
 * there is nothing to contend on — no lock, no retry, no merge, and both get
 * `201` (FR-3.1, FR-3.2, EC-01). The same interviewer twice is one `201` and one
 * `409 FEEDBACK_ALREADY_SUBMITTED`, and the refused request's transaction rolls
 * back entirely, so it leaves **no orphan audit row** (FR-3.4, EC-02). Three
 * panellists at once is the same non-event as two (FR-3.6).
 *
 * `interviewerId` is `actorUserId` — `req.user.id`, from a verified token. It is
 * not a body field; zod dropped any that tried before this function ran (FR-2.5,
 * AZ-8, AC-B09).
 *
 * The round need **not** be `COMPLETED` (FR-2.6): requiring it would mean an
 * interviewer cannot file notes until a recruiter updates a status, which
 * produces lost feedback rather than discipline. It must not be `CANCELLED`
 * (FR-2.7) — a cancelled round did not happen — and that status came back on the
 * lookup that authorized, so the refusal costs no extra query.
 */
export async function submitFeedback(
  interviewId: number,
  input: CreateFeedbackInput,
  actorUserId: number,
  log: Logger,
): Promise<FeedbackView> {
  let feedback: FeedbackView;

  try {
    feedback = await prisma.$transaction(async (tx) => {
      const interview = await resolveWritableInterview(tx, interviewId, actorUserId);

      if (interview === null) {
        throw new NotFoundError();
      }

      if (interview.status === InterviewStatus.CANCELLED) {
        throw new InterviewCancelledError();
      }

      const created = await tx.feedback.create({
        data: {
          interviewId: interview.id,
          interviewerId: actorUserId,
          rating: input.rating,
          notes: input.notes,
        },
        select: FEEDBACK_SELECT,
      });

      await recordAudit(
        tx,
        {
          action: AuditAction.FEEDBACK_SUBMITTED,
          entityType: AuditEntityType.FEEDBACK,
          entityId: created.id,
          actorUserId,
          // `rating` and the round, and deliberately NOT `notes` (FR-2.8,
          // audit FR-4.4, SEC-5). The audit feed is recruiter-readable and its
          // readers are not always the round's readers; the notes belong on the
          // feedback record, where the read rules already live.
          metadata: { interviewId: interview.id, rating: input.rating },
        },
        log,
      );

      return created;
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      // The single most useful line for noticing somebody walking the id space.
      // Ids only, and the response was a 404 — never a 403, which would confirm
      // the round exists (FR-7.1, SEC-4, AC-B17).
      log.warn(
        { event: 'feedback.scoped_write_miss', actorId: actorUserId, interviewId },
        'scoped feedback write matched no assigned round',
      );
      throw error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      log.warn(
        { event: 'feedback.duplicate_refused', actorId: actorUserId, interviewId },
        'feedback already submitted for this round by this interviewer',
      );
      throw new FeedbackAlreadySubmittedError();
    }

    throw error;
  }

  // Logged after the transaction commits, so it never claims a submission that
  // was rolled back. The rating is an id-like bounded integer and is logged; the
  // notes are not, at any level (FR-7.2).
  log.info(
    {
      event: 'feedback.submitted',
      actorId: actorUserId,
      interviewId,
      feedbackId: feedback.id,
      rating: feedback.rating,
    },
    'feedback submitted',
  );

  return feedback;
}

/* -------------------------------------------------------------------------
 * FR-4 — editing
 * ---------------------------------------------------------------------- */

/**
 * The author corrects their own assessment (FR-4.1).
 *
 * **The author only** (D-5, AZ-5). A recruiter is `403` at the route: they did
 * not conduct the interview, and an assessment a recruiter can rewrite is not an
 * assessment. There is **no edit deadline** (FR-4.5) — a time window is a policy
 * nobody asked for, and every edit is audited.
 *
 * Ownership is in the `where` of both statements below, never in an `if` after a
 * fetch (FR-4.2, AZ-6) — and so is **the assignment**: `findEditableFeedback`
 * carries the same predicate the submission and the read use, so an interviewer
 * taken off a round cannot keep editing what they wrote (AZ-9). Their row
 * survives and stays readable by the recruiter and the rest of the panel; it is
 * access that is withdrawn, not the assessment (FR-6.4, EC-12).
 *
 * A row belonging to somebody else, a round the caller never wrote on, and a
 * round they are no longer on are all the same `404` — deliberately
 * indistinguishable (EC-07, EC-08).
 *
 * **Three statements, where PERF-5 asks for two — a recorded deviation.** The
 * spec wants the guarded update and the audit insert with no preceding read, and
 * FR-4.4 wants `metadata.fromRating`, which the `AuditEntry` union makes a
 * compile-time requirement. The previous rating cannot be read out of the
 * statement that overwrites it, so one of the two has to give, and dropping the
 * previous rating from the trace is the worse loss: a changed score is precisely
 * what a hiring manager would ask about. **The read is not an authorization
 * check** — the update's own `where` still carries `interviewerId`, so removing
 * the read would not widen access by one row.
 */
export async function updateFeedback(
  interviewId: number,
  input: UpdateFeedbackInput,
  actorUserId: number,
  log: Logger,
): Promise<FeedbackView> {
  const { feedback, fromRating } = await prisma.$transaction(async (tx) => {
    const existing = await findEditableFeedback(tx, interviewId, actorUserId);

    if (existing === null) {
      throw new NotFoundError();
    }

    const updated = await updateOwnFeedback(tx, interviewId, actorUserId, input);

    await recordAudit(
      tx,
      {
        action: AuditAction.FEEDBACK_UPDATED,
        entityType: AuditEntityType.FEEDBACK,
        entityId: updated.id,
        actorUserId,
        // The rating either side of the edit, and **never the notes text**, old
        // or new (FR-4.4, audit FR-4.4). `fromRating === toRating` when only the
        // notes changed, which is itself the fact worth recording.
        metadata: {
          interviewId,
          fromRating: existing.rating,
          toRating: updated.rating,
        },
      },
      log,
    );

    return { feedback: updated, fromRating: existing.rating };
  });

  log.info(
    {
      event: 'feedback.updated',
      actorId: actorUserId,
      interviewId,
      feedbackId: feedback.id,
      fromRating,
      toRating: feedback.rating,
    },
    'feedback updated',
  );

  return feedback;
}

/* -------------------------------------------------------------------------
 * FR-5 — reading
 * ---------------------------------------------------------------------- */

/**
 * Every assessment on one round, newest first (FR-5.1).
 *
 * **This is the brief's opening complaint being fixed** — _"Interviewers can't
 * see prior feedback before their round"_ — so an assigned interviewer sees the
 * whole panel's entries, their colleagues' included, and before writing their
 * own (FR-5.4, D-9, EC-13). The anchoring risk that creates is named as an
 * accepted gap in SEC-7 rather than half-mitigated by a blind-until-submitted
 * rule nobody asked for.
 *
 * A **recruiter reads any round** with no assignment requirement (AZ-3); an
 * **interviewer reads only rounds they are assigned to**, through the *same*
 * predicate as the write (FR-5.3, AZ-4). One rule, one expression, two verbs.
 *
 * A miss is `404`, byte-identical to a round that does not exist (ERR-1, AZ-7).
 * A round the caller may see with nothing on it is `200 { feedback: [] }`, never
 * a `404` (FR-5.8, EC-14) — and a recruiter reading a round with no panel at all
 * gets the same (EC-21).
 *
 * The response carries **no candidate data of any kind** (FR-5.6): not because
 * it is stripped, but because `FEEDBACK_SELECT` reaches no candidate relation.
 * A client renders the candidate's name from the *interview* payload, which
 * carries `{ id, name }` for an assigned interviewer (XFE-7).
 */
export async function listRoundFeedback(
  interviewId: number,
  actorRole: UserRole,
  actorId: number,
  log: Logger,
): Promise<Array<FeedbackView>> {
  const feedback = await findRoundFeedback(interviewId, actorRole, actorId);

  if (feedback === null) {
    if (actorRole !== UserRole.RECRUITER) {
      log.warn(
        { event: 'feedback.scoped_read_miss', actorId, actorRole, interviewId },
        'scoped feedback read matched no assigned round',
      );
    }

    throw new NotFoundError();
  }

  log.info(
    { event: 'feedback.listed', actorId, actorRole, interviewId, resultCount: feedback.length },
    'round feedback listed',
  );

  return feedback;
}
