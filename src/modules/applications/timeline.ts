import type {
  ApplicationStatus,
  InterviewOutcome,
  InterviewStatus,
  InterviewType,
  PipelineStage,
} from '../../../generated/prisma/enums.js';

/**
 * The stage transition timeline, and nothing else.
 *
 * **This file imports the Prisma enums and nothing more** — no `prisma`, no
 * Express, no logger, no error classes — for the same reason `pipeline.rules`
 * does: it is the file a reviewer opens to answer *"where does the timeline a
 * candidate sees come from?"*, and it has to be readable without following an
 * import out of it. Everything here is a pure function over rows the caller has
 * already fetched.
 *
 * ## Why this is not `StageHistory`
 *
 * `StageHistory` records every change to `Application.currentStage`. The
 * timeline the actors actually want is a different sequence:
 *
 * ```
 * Applied → Screened (phone screen) → Interview (technical) → Interview (system design) → Not selected
 * ```
 *
 * The third and fourth nodes are **two rounds at one stage**. `currentStage`
 * moved once, so `StageHistory` holds one row for the pair and can never
 * distinguish them. The round is the unit of a hiring process; the stage is
 * only where the round sits. So the timeline is built from `Interview` rows,
 * with the application's own creation as its first node and its terminal
 * status as its last.
 *
 * `StageHistory` is untouched by this and remains what it was: the audit of how
 * a stage was entered, which the pipeline feature writes and the audit feed
 * reads. The two disagreeing is not possible, because a decision writes both in
 * one transaction (`recordDecision`).
 *
 * ## One builder, both audiences
 *
 * A recruiter and a candidate are shown the **same nodes**, built by this one
 * function. That is deliberate: nobody outside one recruiter's head should be
 * unable to tell where a candidate stands, and two builders would eventually
 * tell them two different stories.
 *
 * What differs is what the caller SELECTS before getting here, not what this
 * does with it — a candidate's rows carry no interviewer, no feedback and no
 * rating, because `CANDIDATE_TIMELINE_INTERVIEW_SELECT` never names them. This
 * function could not leak one if it tried: `TimelineInterviewRow` has no field
 * to put it in.
 */

/**
 * How a node reads.
 *
 * `PASSED` is green, `REJECTED` is red, `PENDING` is neutral — but the colours
 * are the client's business. What is settled here is that there are exactly
 * three, and that **`PENDING` is a round with no verdict yet**, not a round
 * with no date. An undated round is ordinary and is not a different state.
 */
export type TimelineNodeState = 'PASSED' | 'REJECTED' | 'PENDING';

/**
 * What a node IS, which decides how the client labels it.
 *
 * Three kinds, not one free-text label, for the same reason `AuditEntityType`
 * is an enum: a label assembled on the server is a label the client cannot
 * translate, shorten for a phone, or render as a link. The server sends facts;
 * the frontend turns them into words.
 */
export type TimelineNodeKind = 'APPLIED' | 'ROUND' | 'OUTCOME';

/**
 * One node of the timeline.
 *
 * **It carries no interviewer, no rating and no feedback**, on either audience's
 * path — see the file header. `interviewId` is present so a recruiter's client
 * can link a node to `/interviews/:id`; a candidate's client has no such route
 * and the id names a round they are already being told about.
 */
export interface TimelineNode {
  /** Stable within one application, so React can key on it without an index. */
  key: string;
  kind: TimelineNodeKind;
  /** `APPLIED` on the first node, the round's own stage on a `ROUND`, null on an `OUTCOME`. */
  stage: PipelineStage | null;
  /** The round type on a `ROUND`, null otherwise. */
  interviewType: InterviewType | null;
  /** The terminal status on an `OUTCOME`, null otherwise. */
  status: ApplicationStatus | null;
  state: TimelineNodeState;
  /** When this node happened, as an ISO string. Null on a round with neither a verdict nor a date. */
  at: string | null;
  interviewId: number | null;
}

/**
 * Exactly the columns `buildTimeline` reads from a round.
 *
 * Declared here rather than inferred from a Prisma select so that **the two
 * selects that feed it — the recruiter's and the candidate's — are checked
 * against one shape**, and so that widening either cannot widen this without a
 * deliberate edit to this interface.
 */
export interface TimelineInterviewRow {
  id: number;
  type: InterviewType;
  stage: PipelineStage;
  scheduledAt: Date | null;
  status: InterviewStatus;
  outcome: InterviewOutcome | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** Exactly the columns `buildTimeline` reads from the application itself. */
export interface TimelineApplicationRow {
  status: ApplicationStatus;
  createdAt: Date;
}

/**
 * How a round's verdict reads on the timeline.
 *
 * A round with no `outcome` is `PENDING` whether it is scheduled for next week
 * or was never given a date. The recruiter has not decided, and that is the
 * fact the node states.
 */
const stateOf = (outcome: InterviewOutcome | null): TimelineNodeState => {
  if (outcome === null) {
    return 'PENDING';
  }

  return outcome === 'SELECTED' ? 'PASSED' : 'REJECTED';
};

/**
 * The timeline for one application.
 *
 * ```
 *   applied ──► round ──► round ──► … ──► outcome
 * ```
 *
 * - **The first node is always `Applied`**, `PASSED`, at the application's
 *   `createdAt`. Every application has one and it is never pending: applying is
 *   the act, not a request for permission.
 * - **One node per round, in CREATION order** — not scheduled order. A round
 *   may have no date, and ordering by a nullable column would collapse every
 *   undated round to one end of a sequence that is supposed to be the order
 *   things happened in.
 * - **`CANCELLED` rounds are omitted.** A cancelled round did not happen, so it
 *   is not part of what happened. It is still readable on its own page, and its
 *   feedback and panel are untouched — this only decides what the timeline
 *   narrates.
 * - **The last node is the outcome**, and only once the application is
 *   terminal. An `ACTIVE` application has no outcome node, because it has no
 *   outcome; a client that wants to show "in progress" reads
 *   `application.status` rather than a node invented here to carry it.
 *
 * `interviews` must already be ordered by `createdAt asc` — the caller's query
 * does it, served by `Interview_applicationId_createdAt_idx`, so there is no
 * sort here and none per application.
 */
export function buildTimeline(
  application: TimelineApplicationRow,
  interviews: ReadonlyArray<TimelineInterviewRow>,
): Array<TimelineNode> {
  const nodes: Array<TimelineNode> = [
    {
      key: 'applied',
      kind: 'APPLIED',
      stage: 'APPLIED',
      interviewType: null,
      status: null,
      state: 'PASSED',
      at: application.createdAt.toISOString(),
      interviewId: null,
    },
  ];

  for (const interview of interviews) {
    if (interview.status === 'CANCELLED') {
      continue;
    }

    nodes.push({
      key: `interview-${interview.id}`,
      kind: 'ROUND',
      stage: interview.stage,
      interviewType: interview.type,
      status: null,
      state: stateOf(interview.outcome),
      // The verdict's time if there is one, else the date it is set for, else
      // nothing. `createdAt` is deliberately NOT the fallback: "this round was
      // created on Tuesday" is not a thing that happened to the candidate.
      at: (interview.decidedAt ?? interview.scheduledAt)?.toISOString() ?? null,
      interviewId: interview.id,
    });
  }

  if (application.status !== 'ACTIVE') {
    nodes.push({
      key: 'outcome',
      kind: 'OUTCOME',
      stage: null,
      interviewType: null,
      status: application.status,
      state: application.status === 'HIRED' ? 'PASSED' : 'REJECTED',
      at: null,
      interviewId: null,
    });
  }

  return nodes;
}
