import type { Prisma } from '../../../generated/prisma/client.js';
import { UserRole } from '../../../generated/prisma/enums.js';
import type { InterviewStatus } from '../../../generated/prisma/enums.js';
import { prisma } from '../../lib/prisma.js';
import { FEEDBACK_SELECT, type FeedbackView } from './feedback.select.js';
import type { UpdateFeedbackInput } from './feedback.schema.js';

/**
 * Feedback repository handling database queries and authorization scoping.
 *
 * Authorization for feedback is enforced directly in queries via assignment predicates:
 * interviewers can only submit, edit, or view feedback for interviews they are assigned to.
 * Recruiters can view all round feedback across the system.
 */

/* -------------------------------------------------------------------------
 * The predicate
 * ---------------------------------------------------------------------- */

/**
 * Filter predicate ensuring the interviewer is assigned to the interview round.
 * Leverages the index on InterviewAssignment(interviewerId, createdAt).
 */
function assignedTo(actorId: number): Prisma.InterviewWhereInput {
  return { assignments: { some: { interviewerId: actorId } } };
}

/**
 * Builds the read scope for interview feedback based on the caller's role.
 * Recruiters can view feedback for any interview; interviewers are restricted
 * to interviews to which they are actively assigned.
 */
function buildReadableInterviewWhere(
  interviewId: number,
  actorRole: UserRole,
  actorId: number,
): Prisma.InterviewWhereInput {
  return actorRole === UserRole.RECRUITER
    ? { id: interviewId }
    : { id: interviewId, ...assignedTo(actorId) };
}

/* -------------------------------------------------------------------------
 * The write path
 * ---------------------------------------------------------------------- */

/** What the write path needs from the interview round. */
export interface WritableInterview {
  id: number;
  status: InterviewStatus;
}

/**
 * Resolves an interview round for feedback creation or edit, verifying that the actor
 * is an assigned interviewer in the same query.
 *
 * Returns null if the round does not exist or the actor is not assigned.
 */
export async function resolveWritableInterview(
  tx: Prisma.TransactionClient,
  interviewId: number,
  actorId: number,
): Promise<WritableInterview | null> {
  return tx.interview.findFirst({
    where: { id: interviewId, ...assignedTo(actorId) },
    select: { id: true, status: true },
  });
}

/**
 * Finds existing feedback authored by the actor on an assigned interview.
 * Verifies both row ownership (interviewerId = actorId) and active interview assignment.
 * Returns null if not found, not owned, or if the interviewer is no longer assigned.
 */
export async function findEditableFeedback(
  tx: Prisma.TransactionClient,
  interviewId: number,
  actorId: number,
): Promise<{ id: number; rating: number } | null> {
  return tx.feedback.findFirst({
    where: {
      interviewId,
      interviewerId: actorId,
      interview: assignedTo(actorId),
    },
    select: { id: true, rating: true },
  });
}

/**
 * Updates an interviewer's own feedback record using the composite unique key.
 * Only updates fields explicitly provided in the input.
 */
export async function updateOwnFeedback(
  tx: Prisma.TransactionClient,
  interviewId: number,
  actorId: number,
  input: UpdateFeedbackInput,
): Promise<FeedbackView> {
  const data: Prisma.FeedbackUpdateInput = {};

  if (input.rating !== undefined) {
    data.rating = input.rating;
  }
  if (input.notes !== undefined) {
    data.notes = input.notes;
  }

  return tx.feedback.update({
    where: { interviewId_interviewerId: { interviewId, interviewerId: actorId } },
    data,
    select: FEEDBACK_SELECT,
  });
}

/* -------------------------------------------------------------------------
 * The read path
 * ---------------------------------------------------------------------- */

/**
 * Retrieves all feedback entries for an interview round, ordered newest first.
 * If the interview does not exist or is not accessible to the caller, returns null.
 * Otherwise returns the array of feedback items (or empty array if none submitted).
 */
export async function findRoundFeedback(
  interviewId: number,
  actorRole: UserRole,
  actorId: number,
): Promise<Array<FeedbackView> | null> {
  const interview = await prisma.interview.findFirst({
    where: buildReadableInterviewWhere(interviewId, actorRole, actorId),
    select: {
      feedback: {
        select: FEEDBACK_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      },
    },
  });

  return interview === null ? null : interview.feedback;
}
