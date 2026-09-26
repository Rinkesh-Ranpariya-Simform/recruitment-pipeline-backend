import type {
  ApplicationStatus,
  InterviewOutcome,
  InterviewStatus,
  InterviewType,
  PipelineStage,
} from '../../../generated/prisma/enums.js';

/**
 * Two projections, and **the role decides which is used before the query runs**
 * — not which fields are removed after it returns.
 *
 * The recruiter's is a SUPERSET in content but a DIFFERENT OBJECT, not a
 * runtime branch inside one select. There is no code path in this module in
 * which a `phone` or `email` column is fetched and then removed for an
 * interviewer: **a shape that never selects the columns cannot leak them**.
 *
 * Neither names `candidateUserId`, `createdByUserId` or `assignedByUserId`
 * — a raw foreign key gives a client something to guess with and nothing to
 * render.
 *
 * Neither names `email` or `phone`, for ANY role. The rule has no recruiter
 * exception in this feature; contact details are the candidate-access
 * feature's surface.
 */

/* -------------------------------------------------------------------------
 * Views — what each role's endpoints return
 * ---------------------------------------------------------------------- */

/** One seat on a panel. Recruiter-only. */
export interface InterviewAssignmentView {
  id: number;
  interviewer: { id: number; name: string };
}

/**
 * What a RECRUITER gets: the round, its application's stage and status, the
 * role, the candidate's `{ id, name }` and the panel.
 */
export interface RecruiterInterviewView {
  id: number;
  type: InterviewType;
  stage: PipelineStage;
  /** Nullable: a round started from the applications table has no date yet. */
  scheduledAt: Date | null;
  status: InterviewStatus;
  /**
   * The recruiter's verdict AT this round, null until they record one.
   * `decidedBy` is present so the page can say who decided — an assessment
   * with no actor behind it is not a record.
   */
  outcome: InterviewOutcome | null;
  decidedAt: Date | null;
  decidedBy: { id: number; name: string } | null;
  createdAt: Date;
  application: {
    id: number;
    currentStage: PipelineStage;
    status: ApplicationStatus;
    role: { id: number; title: string };
    candidate: { id: number; name: string };
  };
  assignments: Array<InterviewAssignmentView>;
}

/**
 * What an assigned INTERVIEWER gets: the round, the role's `{ id, title }` and
 * the candidate as `{ id, name }` ONLY.
 *
 * **There is no `assignments` key**: an interviewer's payload does not name
 * their colleagues. They learn who else is on the panel from the feedback
 * feature, where that disclosure is specified, not incidentally from a round
 * payload.
 *
 * There is no `application` key either — an interviewer's scope is the round,
 * not the person's whole process, so the application's own id and stage are not
 * theirs to see.
 */
export interface InterviewerInterviewView {
  id: number;
  type: InterviewType;
  stage: PipelineStage;
  /** Nullable, as on the recruiter's view — an undated round is ordinary, not an error. */
  scheduledAt: Date | null;
  status: InterviewStatus;
  role: { id: number; title: string };
  candidate: { id: number; name: string };
}

/**
 * **There is no `outcome` on the interviewer's view, and that is deliberate.**
 *
 * A round's verdict is the recruiter's decision about a candidate's process,
 * not a fact about the round an assessor needs in order to assess it — and an
 * interviewer who can see it before writing their feedback is an interviewer
 * being told the answer. Their scope is the round; the decision is the
 * application's.
 *
 * It is absent from the SELECT below, not removed after the fact, so there is
 * nothing here for a future call site to include by accident.
 */

/* -------------------------------------------------------------------------
 * Selects
 * ---------------------------------------------------------------------- */

/** The panel as `POST …/assignments` returns it, and as it is nested below. */
export const ASSIGNMENT_SELECT = {
  id: true,
  interviewId: true,
  interviewer: { select: { id: true, name: true } },
  createdAt: true,
} as const;

/**
 * The recruiter projection.
 *
 * `assignments` is fetched by Prisma's relation select, which JOINs — it is not
 * an N+1 lookup per round. Ordered oldest-first so a panel renders in the order
 * it was staffed.
 */
export const RECRUITER_INTERVIEW_SELECT = {
  id: true,
  type: true,
  stage: true,
  scheduledAt: true,
  status: true,
  outcome: true,
  decidedAt: true,
  decidedBy: { select: { id: true, name: true } },
  createdAt: true,
  application: {
    select: {
      id: true,
      currentStage: true,
      status: true,
      role: { select: { id: true, title: true } },
      // `{ id, name }`. NOT `email`, and no `candidateProfile` join — the rule
      // has no recruiter exception here.
      candidate: { select: { id: true, name: true } },
    },
  },
  assignments: {
    select: { id: true, interviewer: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  },
} as const;

/**
 * The interviewer projection.
 *
 * **It does not name `email`. It joins no `candidateProfile`. It carries no
 * `assignments`.** The row Postgres returns does not contain the restricted
 * data, so no future call site, log line or serializer can leak it. Excluded at
 * the query, not removed afterwards.
 *
 * `application` appears here ONLY as the path to the role and the candidate's
 * name — `toInterviewerView` below lifts both to the top level and the
 * application itself never reaches the wire.
 */
export const INTERVIEWER_INTERVIEW_SELECT = {
  id: true,
  type: true,
  stage: true,
  scheduledAt: true,
  status: true,
  application: {
    select: {
      role: { select: { id: true, title: true } },
      candidate: { select: { id: true, name: true } },
    },
  },
} as const;

/** Exactly the row `INTERVIEWER_INTERVIEW_SELECT` produces. */
interface InterviewerInterviewRow {
  id: number;
  type: InterviewType;
  stage: PipelineStage;
  scheduledAt: Date | null;
  status: InterviewStatus;
  application: {
    role: { id: number; title: string };
    candidate: { id: number; name: string };
  };
}

/**
 * Lifts `role` and `candidate` out of `application` to the top level, which is
 * the shape the API contract publishes and the client's `InterviewerInterview`
 * interface declares.
 *
 * **This is not post-fetch filtering, and the distinction is the whole point.**
 * The architecture rules out a step that FETCHES restricted columns and then
 * removes them — the failure mode where one missed call site leaks an email.
 * Nothing restricted is fetched here: `INTERVIEWER_INTERVIEW_SELECT` never
 * names `email`, `phone` or `assignments`, so this function has nothing to
 * remove and removes nothing. It only re-nests three values that were all
 * already selected, because Prisma cannot flatten a relation in a `select` and
 * the published contract is flat.
 *
 * **If a field ever needs keeping from an interviewer, it comes out of
 * the select above, not out of this function.**
 */
export function toInterviewerView(row: InterviewerInterviewRow): InterviewerInterviewView {
  return {
    id: row.id,
    type: row.type,
    stage: row.stage,
    scheduledAt: row.scheduledAt,
    status: row.status,
    role: row.application.role,
    candidate: row.application.candidate,
  };
}
