import type {
  ApplicationStatus,
  InterviewOutcome,
  InterviewStatus,
  InterviewType,
  PipelineStage,
} from '../../generated/prisma/enums.js';
import type { TimelineNode } from './timeline.js';

/**
 * Every projection this module fetches, and **the role decides which one is
 * used before the query runs** — not which fields are removed after it returns
 * (BE-4). The same construction as `interview.select.ts`: the recruiter's is a
 * superset in content but a DIFFERENT OBJECT, so there is no code path here in
 * which a candidate's query loads a column and a later step drops it.
 *
 * Four selects, in two pairs:
 *
 * | Audience  | List                              | Detail                              |
 * | --------- | --------------------------------- | ----------------------------------- |
 * | Candidate | `APPLICATION_SELECT`              | `CANDIDATE_APPLICATION_DETAIL_SELECT` |
 * | Recruiter | `RECRUITER_APPLICATION_SELECT`    | `RECRUITER_APPLICATION_DETAIL_SELECT` |
 *
 * **No select in this file names `email` or `phone`, for any role.** Contact
 * details are the candidate-access feature's surface, and this module gained a
 * recruiter audience without gaining one field of them.
 */

/* -------------------------------------------------------------------------
 * The candidate's own applications
 * ---------------------------------------------------------------------- */

/**
 * The single definition of the candidate-facing application projection
 * (candidate FR-6.3, FR-6.4, FR-6.5).
 *
 * A candidate must never see interviewer feedback, a rating, an internal note,
 * an interviewer's identity, or an override reason. **None of them is a column
 * this select names**, and the timeline assembled beside it carries none either
 * — see `timeline.ts`.
 *
 * `interviews` IS selected here as of the applications feature, and it is the
 * one addition: four columns per round, none of which says anything about who
 * ran it or what they thought. It exists so `buildTimeline` can tell a
 * candidate where they stand, which is the whole point of showing them a
 * timeline at all (FR-5.4).
 *
 * The nested role select is `{ id, title }` and nothing more. Widening it would
 * turn a candidate's application list into a second, unpaged view of the
 * requisition table — one that does not carry the forced `status: OPEN`
 * predicate the roles module applies.
 */
export const APPLICATION_SELECT = {
  id: true,
  status: true,
  currentStage: true,
  createdAt: true,
  role: { select: { id: true, title: true } },
  interviews: {
    select: {
      id: true,
      type: true,
      stage: true,
      scheduledAt: true,
      status: true,
      outcome: true,
      decidedAt: true,
      createdAt: true,
    },
    // Creation order, matching `buildTimeline`'s contract. Served by
    // `Interview_applicationId_createdAt_idx`, so there is no sort step and no
    // per-application query — Prisma batches the relation load (PERF-2).
    orderBy: { createdAt: 'asc' },
  },
} as const;

/**
 * A candidate's own application, in detail.
 *
 * **Identical to the list projection.** They are two constants rather than one
 * because they answer two questions and will not always agree — but today a
 * candidate's detail view adds nothing to their list row except room to render
 * it, and pretending otherwise by widening one would be inventing a difference.
 */
export const CANDIDATE_APPLICATION_DETAIL_SELECT = APPLICATION_SELECT;

/* -------------------------------------------------------------------------
 * The recruiter's view
 * ---------------------------------------------------------------------- */

/**
 * One row of the recruiter's applications table (FR-1.2).
 *
 * `candidate` is `{ id, name }` — **not `email`**, and no `candidateProfile`
 * join. A recruiter may see contact details, but not here: this is a list of
 * applications, and the surface that serves contact details is the one the
 * candidate-access feature specifies with its own authorization story.
 *
 * `_count.interviews` rather than the rounds themselves: the table shows how
 * many rounds a candidate has had, and loading every round of every application
 * to render a number is the shape the brief's §6 forbids by name. Prisma
 * resolves it as a correlated subquery, not as N queries (PERF-3).
 */
export const RECRUITER_APPLICATION_SELECT = {
  id: true,
  status: true,
  currentStage: true,
  stageEnteredAt: true,
  createdAt: true,
  role: { select: { id: true, title: true } },
  candidate: { select: { id: true, name: true } },
  _count: { select: { interviews: true } },
} as const;

/**
 * One application, as a recruiter opens it (FR-4.2).
 *
 * The rounds are fetched in full here — with their panel — because this IS the
 * page a recruiter runs a candidate's process from, and every round on it is
 * one they may open, staff or decide. The list projection above deliberately
 * does not, which is the difference between the two.
 *
 * Still no `email`, and still no `feedback`: a round's assessments are read
 * through `GET /api/interviews/:id/feedback`, where the feedback module's own
 * authorization applies. Nesting them here would be a second path to the same
 * rows with a different guard in front of it.
 */
export const RECRUITER_APPLICATION_DETAIL_SELECT = {
  id: true,
  status: true,
  currentStage: true,
  stageEnteredAt: true,
  createdAt: true,
  role: { select: { id: true, title: true } },
  candidate: { select: { id: true, name: true } },
  interviews: {
    select: {
      id: true,
      type: true,
      stage: true,
      scheduledAt: true,
      status: true,
      outcome: true,
      decidedAt: true,
      createdAt: true,
      assignments: {
        select: { id: true, interviewer: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const;

/* -------------------------------------------------------------------------
 * Views — the shapes that reach the wire
 * ---------------------------------------------------------------------- */

/** One round as it appears inside an application payload, for either audience. */
export interface ApplicationInterviewView {
  id: number;
  type: InterviewType;
  stage: PipelineStage;
  scheduledAt: Date | null;
  status: InterviewStatus;
  outcome: InterviewOutcome | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** The same round, with the panel a recruiter is allowed to see. */
export interface RecruiterApplicationInterviewView extends ApplicationInterviewView {
  assignments: Array<{ id: number; interviewer: { id: number; name: string } }>;
}

/**
 * What a CANDIDATE gets, from both of their endpoints.
 *
 * `interviews` is deliberately **absent** even though the select fetches the
 * rows: they exist to build `timeline`, and a candidate has no use for a raw
 * round list they cannot open. `toCandidateApplication` below is what drops
 * them.
 *
 * That is not the post-fetch filtering BE-4 forbids, and the distinction is the
 * same one `toInterviewerView` documents: **nothing restricted is fetched**.
 * The select names eight neutral columns per round and no interviewer, rating
 * or note, so there is nothing here to strip and nothing a future call site
 * could leak. If a field ever needs keeping from a candidate, **it comes out of
 * the select above, not out of that function.**
 */
export interface CandidateApplicationView {
  id: number;
  status: ApplicationStatus;
  currentStage: PipelineStage;
  createdAt: Date;
  role: { id: number; title: string };
  timeline: Array<TimelineNode>;
}

/** One row of the recruiter's table. */
export interface RecruiterApplicationView {
  id: number;
  status: ApplicationStatus;
  currentStage: PipelineStage;
  stageEnteredAt: Date;
  createdAt: Date;
  role: { id: number; title: string };
  candidate: { id: number; name: string };
  interviewCount: number;
}

/** One application, as a recruiter opens it. */
export interface RecruiterApplicationDetailView {
  id: number;
  status: ApplicationStatus;
  currentStage: PipelineStage;
  stageEnteredAt: Date;
  createdAt: Date;
  role: { id: number; title: string };
  candidate: { id: number; name: string };
  timeline: Array<TimelineNode>;
  interviews: Array<RecruiterApplicationInterviewView>;
}
