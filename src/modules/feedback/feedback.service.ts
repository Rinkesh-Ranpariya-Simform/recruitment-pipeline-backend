import type { Logger } from 'pino';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  AuditAction,
  AuditEntityType,
  InterviewStatus,
  UserRole,
} from '../../../generated/prisma/enums.js';
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
 * Service managing interview feedback creation, modification, and queries.
 *
 * Core principles:
 * 1. Authorization is enforced directly in queries via assignment predicates.
 * 2. Writes execute inside a single transaction with audit logging.
 * 3. Duplicate submissions trigger a unique constraint violation (P2002) mapped to FeedbackAlreadySubmittedError.
 * 4. Sensitive candidate details are excluded from queries, avoiding the need for in-memory redaction.
 * 5. Log messages record IDs and ratings, keeping detailed notes out of log entries.
 */

/* -------------------------------------------------------------------------
 * Submitting feedback
 * ---------------------------------------------------------------------- */

/**
 * Submits feedback for an interview round by an assigned interviewer.
 * Ensures the interview is active and not cancelled, inserts the feedback record,
 * and creates an audit entry in a single transaction.
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
          // Records interviewId and rating; notes are kept out of audit entries for privacy
          metadata: { interviewId: interview.id, rating: input.rating },
        },
        log,
      );

      return created;
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
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
 * Editing feedback
 * ---------------------------------------------------------------------- */

/**
 * Updates an interviewer's own existing feedback on an assigned round.
 * Fetches the current rating to capture from/to rating transition in audit logs.
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
 * Reading feedback
 * ---------------------------------------------------------------------- */

/**
 * Lists all feedback entries submitted for an interview round.
 * Recruiters can view all interview rounds; interviewers can only view rounds they are assigned to.
 * Throws NotFoundError if the round does not exist or is inaccessible.
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
