import type { Prisma } from '../../../generated/prisma/client.js';
import { UserRole } from '../../../generated/prisma/enums.js';
import type { InterviewStatus } from '../../../generated/prisma/enums.js';
import { prisma } from '../../lib/prisma.js';
import { FEEDBACK_SELECT, type FeedbackView } from './feedback.select.js';
import type { UpdateFeedbackInput } from './feedback.schema.js';

/**
 * **The one file that expresses this feature's authorization** (BE-2, AZ-2).
 *
 * The request that prompted this feature states the rule in the negative, which
 * is the clearer way to state it:
 *
 * > Never authorize feedback submission only by checking
 * > `interviewerId === currentUser.id`. The interviewer must actually be
 * > assigned to the interview.
 *
 * That check is not weak — it is **vacuous**. `interviewerId` is the value the
 * service is about to write, so comparing it to the caller compares a value to
 * itself and authorizes nothing (FR-1.3, SEC-3). The only fact that authorizes
 * anything is an `InterviewAssignment` row, and every function below resolves it
 * **inside the query**, in the `where` (FR-1.2).
 *
 * `assignedTo` is the single expression of that predicate. The write path and
 * the read path both go through it, so they cannot drift — they are one
 * expression used twice (FR-1.5, FR-5.3, AZ-4). This mirrors
 * `buildInterviewWhere` in the interviews module, which is the same decision for
 * rounds; the two together are the only places in `src/` that write
 * `assignments: { some: … }`, and if a third feedback read is ever added it
 * routes through here rather than copying the predicate.
 *
 * **There is no fetch-then-check anywhere in this module.** An unassigned
 * interviewer's row is never loaded, so there is nothing for a caller to forget
 * to check and nothing in memory to leak (SEC-2). A miss is the caller's `404`,
 * never a `403` (AZ-7).
 */

/* -------------------------------------------------------------------------
 * The predicate
 * ---------------------------------------------------------------------- */

/**
 * "…and this interviewer sits on that round's panel."
 *
 * Served by `InterviewAssignment_interviewerId_createdAt_idx` (interviews
 * MIG-4), so the authorization costs **one index lookup** — not a scan, and not
 * a round trip separate from the fetch it guards (PERF-2). It is a JOIN, never a
 * two-step "load their assignment ids, then query with an `in` list".
 */
function assignedTo(actorId: number): Prisma.InterviewWhereInput {
  return { assignments: { some: { interviewerId: actorId } } };
}

/**
 * The read's scope, chosen by role **before** the query runs.
 *
 * A **recruiter reads any round's feedback with no assignment predicate at all**
 * (AZ-3, D-8) — their role is the whole authorization for the read, and there is
 * no row filter hiding behind it. Stated here so that nobody later assumes one
 * exists.
 *
 * The test is `!== RECRUITER` rather than `=== INTERVIEWER` so that it fails
 * **closed**, matching `buildInterviewWhere`: a role added later is scoped until
 * somebody decides otherwise. Candidates never reach here — they are refused at
 * the route (AZ-10) — but if that guard were ever loosened, this would not hand
 * them a panel's assessments.
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

/** What the write path needs off the round, and nothing else. */
export interface WritableInterview {
  id: number;
  status: InterviewStatus;
}

/**
 * Resolves the round a submission or an edit is about to touch — **and
 * authorizes it in the same statement** (FR-1.2, BE-2).
 *
 * The eligibility rule and the lookup are one query, exactly as
 * `applications.service.createApplication` resolves an `ACTIVE` role: there is
 * no window between checking and using, and **no unauthorized row is ever loaded
 * into application memory** (SEC-2, EC-05).
 *
 * The predicate here is **unconditional** — there is no role branch. `POST` and
 * `PATCH` are `requireRole(INTERVIEWER)` at the route, so the only caller is an
 * interviewer; making the scope conditional would mean that widening the route
 * guard one day silently hands a recruiter a write path (AZ-5).
 *
 * `status` rides along because the `CANCELLED` refusal (FR-2.7) is then free:
 * it is read by the same lookup that authorizes, not by a second query (PERF-1).
 *
 * `findFirst`, not `findUnique`, because the predicate is id **plus** assignment
 * rather than a unique key alone. The caller turns `null` into a `404` — never a
 * `403` (FR-1.4, AZ-7).
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
 * The row an edit is about to change — **the assignment gate and the ownership
 * test in one `where`** (FR-4.2, AZ-6, AZ-9).
 *
 * Two conditions, both in the query and neither in an `if` after a fetch:
 *
 *   - `interviewerId: actorId` — _is this row mine to edit_. This is the one
 *     place in the module where `interviewerId` is compared to the caller, and
 *     it is **not** the authorization: it is ownership, and comparing a row's
 *     author to the caller says nothing about whether they may touch the round
 *     at all (FR-1.3, SEC-3, EC-07).
 *   - `interview: assignedTo(actorId)` — _am I still on this panel_. This is the
 *     authorization, the same predicate the submission and the read use, so
 *     **an interviewer removed from a round cannot keep editing what they
 *     wrote** (AZ-9, and the `PATCH` column of the endpoint × role matrix, which
 *     answers `404` for an unassigned interviewer). Access is evaluated per
 *     request, not captured at the moment the row was written.
 *
 * The asymmetry that leaves is deliberate and is worth naming: the row itself
 * **remains** and stays readable by recruiters and by the rest of the panel
 * (FR-6.4, EC-12). Unassignment withdraws access; it does not retract an
 * assessment that was made.
 *
 * It also supplies `fromRating` for the audit entry (FR-4.4), which the
 * `AuditEntry` union makes a compile-time requirement — see the note on
 * `updateFeedback` in the service about the statement that costs.
 *
 * `null` means "you wrote nothing here", "that is not yours", or "you are no
 * longer on this round". All three are `404`, and they are deliberately
 * indistinguishable (EC-07, EC-08, AC-B19, AC-B20).
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
 * The guarded edit (FR-4.2).
 *
 * The composite unique key **is** the guard: `interviewerId` is part of the
 * `where`, so an attempt to edit somebody else's assessment matches no row
 * rather than being rejected after one is fetched (AZ-6). It is the
 * single-statement form of the spec's `updateMany` — it guards identically, and
 * it returns the projected row, which `updateMany` cannot.
 *
 * The patch is built key by key rather than by spread: with
 * `exactOptionalPropertyTypes` on, an explicit `undefined` is not the same as an
 * absent key, and spreading one would write `null` over a column the caller
 * never mentioned.
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
 * A round's whole panel of assessments, newest first — in **one** query
 * (FR-5.1, PERF-3).
 *
 * The round is the outer `where`, so the same statement answers both questions
 * the endpoint has: _may this caller see this round_ (the scope) and _what has
 * been written on it_ (the nested select). A round the caller may not see
 * returns `null` and becomes a `404`; a round they may see with nothing written
 * on it returns `[]` and is a `200`, never a `404` (FR-5.8, EC-14).
 *
 * **The outer select names `feedback` and nothing else.** It does not reach
 * `application`, and therefore reaches no candidate, no `email` and no `phone` —
 * the leak path the brief's §3.6 names by name is closed by the shape of the
 * query, not by a later filter (FR-5.6, SEC-1).
 *
 * `interviewer` inside `FEEDBACK_SELECT` is a relation select, which JOINs; the
 * panel's names are not an N+1 lookup per row (PERF-4). Unpaginated, because a
 * round's panel is bounded by `@@unique([interviewId, interviewerId])` and by how
 * many interviewers a recruiter assigns — **25 assignments on one round is the
 * documented threshold at which this must gain a pager** (FR-5.7, PERF-6).
 *
 * `id desc` is the tiebreak: two rows sharing a `createdAt` — which two
 * panellists submitting together can produce — must still have one stable order.
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
