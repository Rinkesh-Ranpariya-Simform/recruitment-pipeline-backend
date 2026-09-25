import type { Prisma } from '../../../generated/prisma/client.js';
import type {
  ApplicationStatus,
  InterviewStatus,
  InterviewType,
  PipelineStage,
  RoleStatus,
} from '../../../generated/prisma/enums.js';

/**
 * **This is the file the brief's §7.3 question is answered in** (BE-2, SEC-1).
 *
 * > when an interviewer's endpoint returns candidate data, is the restricted
 * > contact information ever present in the row your database returned to your
 * > application code, or does it only get removed in the response mapping
 * > afterward?
 *
 * It is never present. `INTERVIEWER_CANDIDATE_SELECT` below is two lines long:
 * it names `id` and `name`. It does not name `email`. It does not join
 * `candidateProfile`, where `phone` lives. It does not reach `applications`,
 * and therefore reaches no stage history, no panel and no feedback. **The row
 * Postgres hands to Node contains none of it**, so there is no mapping step
 * that could forget to leave it out, no serializer that could put it back, and
 * no log line that could print it.
 *
 * The two projections are **different objects, chosen by role before the query
 * runs** — not one select with a runtime branch and not one wide fetch narrowed
 * afterwards (FR-7.2, D-7). The recruiter's is larger in content, but it is not
 * a superset that the interviewer's is derived from: deriving one from the
 * other is precisely the design that leaks the first time someone edits the
 * wrong branch.
 *
 * **If a field must be kept from an interviewer, it comes out of the select.**
 * There is no function in this module that removes a field from a fetched row,
 * and that absence is the design (FR-7.3, SEC-4, AC-B32).
 */

/* -------------------------------------------------------------------------
 * Views — what each role's endpoints return
 * ---------------------------------------------------------------------- */

/**
 * A candidate's contact details, as a recruiter reads them (FR-2.5).
 *
 * **Always an object, never `null`.** A candidate with no `CandidateProfile`
 * row gets three nulls rather than an absent object, so a client never has to
 * tell "no row" from "no value" — a distinction with no meaning here (EC-10,
 * XFE-6).
 *
 * `updatedAt` is `null` in exactly that case, and is the one field that can
 * distinguish the two if anybody ever needs to.
 */
export interface CandidateProfileView {
  phone: string | null;
  location: string | null;
  headline: string | null;
  updatedAt: Date | null;
}

/** One seat on a panel, as the recruiter detail renders it (FR-5.2). */
export interface CandidateAssignmentView {
  id: number;
  interviewer: { id: number; name: string };
}

/**
 * One assessment, with its `notes` (FR-5.4, D-12).
 *
 * The notes are here because a recruiter may read feedback on any round
 * already (feedback AZ-3), and withholding them on this surface would be an
 * inconsistency rather than a protection. **This type is reachable only from
 * `RecruiterCandidateView`** — an interviewer's payload has no path to it.
 */
export interface CandidateFeedbackView {
  id: number;
  /**
   * The round this assessment is on, and `updatedAt` beside it.
   *
   * **Neither is in the spec's contract sketch, and both are here on purpose.**
   * The client renders these entries with the feedback feature's own
   * `<FeedbackList>` fed straight from this payload — which is what makes a
   * candidate with five rounds ONE request instead of six (frontend D-7, FE-7,
   * XBE-6). That component's `Feedback` type declares both, so a payload
   * without them could not be handed to it and the zero-request path the two
   * specs agree on would not exist.
   *
   * Neither is restricted: `interviewId` is the id of the round this object is
   * already nested inside, and `updatedAt` is what tells a reader an assessment
   * was revised. Both are already in every response `GET
   * /api/interviews/:id/feedback` gives a recruiter, which they may read for any
   * round (feedback AZ-3). **This adds nothing an interviewer can reach** —
   * `INTERVIEWER_CANDIDATE_SELECT` does not reach `applications`, so it does not
   * reach this type at all.
   */
  interviewId: number;
  rating: number;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
  interviewer: { id: number; name: string };
}

/** One round on a recruiter's candidate detail, with its panel and assessments. */
export interface CandidateInterviewView {
  id: number;
  type: InterviewType;
  stage: PipelineStage;
  /** Nullable: a round started from the applications table has no date yet. */
  scheduledAt: Date | null;
  status: InterviewStatus;
  assignments: Array<CandidateAssignmentView>;
  feedback: Array<CandidateFeedbackView>;
}

/**
 * One step of an application's stage timeline (FR-5.3, FR-5.5).
 *
 * `override` is non-null exactly when this transition used the override path,
 * and it carries the `reason` and the recruiter who performed it. **This is the
 * surface where the brief's §3.3 record is actually read**, which is why the
 * reason is returned in full rather than as a flag.
 *
 * `fromStage` is `null` only on the entry into `APPLIED` (pipeline FR-5.3).
 */
export interface CandidateStageHistoryView {
  id: number;
  fromStage: PipelineStage | null;
  toStage: PipelineStage;
  toStatus: ApplicationStatus;
  createdAt: Date;
  changedBy: { id: number; name: string };
  override: {
    id: number;
    reason: string;
    createdAt: Date;
    performedBy: { id: number; name: string };
  } | null;
}

/** One application on a recruiter's candidate detail, with its whole history. */
export interface RecruiterCandidateApplicationView {
  id: number;
  status: ApplicationStatus;
  currentStage: PipelineStage;
  stageEnteredAt: Date;
  createdAt: Date;
  role: { id: number; title: string; status: RoleStatus };
  stageHistory: Array<CandidateStageHistoryView>;
  interviews: Array<CandidateInterviewView>;
}

/** What a RECRUITER gets from `GET /api/candidates/:candidateId` (FR-5.2). */
export interface RecruiterCandidateView {
  id: number;
  name: string;
  email: string;
  createdAt: Date;
  profile: CandidateProfileView;
  applications: Array<RecruiterCandidateApplicationView>;
}

/** One row of a RECRUITER's `GET /api/candidates` page (FR-3.6). */
export interface RecruiterCandidateRowView {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  createdAt: Date;
  applicationCount: number;
  applications: Array<{
    id: number;
    status: ApplicationStatus;
    currentStage: PipelineStage;
    stageEnteredAt: Date;
    role: { id: number; title: string };
  }>;
}

/**
 * **Everything an INTERVIEWER is told about a candidate, on both endpoints.**
 * Two fields (D-8, FR-3.7, FR-6.4).
 *
 * There is no `email`, no `phone`, no `applications`, no `stageHistory` and no
 * `feedback` — **not optional, absent** (contract invariants 1–3). A shape with
 * `email?: string` would invite a caller to render it, and the whole point is
 * that there is nothing here to render.
 */
export interface InterviewerCandidateView {
  id: number;
  name: string;
}

/**
 * One of the interviewer's OWN rounds with a candidate (FR-6.6, FR-6.7).
 *
 * It carries no panel and no feedback: an interviewer's payload does not name
 * their colleagues, and a candidate interviewed by three panels shows each one
 * their own round and nothing about the others.
 */
export interface InterviewerCandidateRoundView {
  id: number;
  type: InterviewType;
  stage: PipelineStage;
  scheduledAt: Date | null;
  status: InterviewStatus;
  role: { id: number; title: string };
}

/* -------------------------------------------------------------------------
 * Ordering
 * ---------------------------------------------------------------------- */

/**
 * The nested `orderBy`s, declared out here rather than inline.
 *
 * Not a style choice: the selects below are `as const`, which makes every array
 * literal inside them `readonly`, and Prisma's generated `orderBy` inputs are
 * mutable arrays. Referencing an explicitly typed constant keeps the literal
 * key inference `as const` is there for while handing Prisma the array type it
 * declares.
 *
 * `id` is the tiebreak on every one of them. Two rows sharing a timestamp —
 * which a single transaction routinely produces — must still have one order,
 * or a client's list silently reshuffles between requests.
 */
const APPLICATIONS_NEWEST_FIRST: Array<Prisma.ApplicationOrderByWithRelationInput> = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

/** **Oldest first: a timeline reads forwards** (FR-5.3, frontend FR-5.1). */
const HISTORY_OLDEST_FIRST: Array<Prisma.StageHistoryOrderByWithRelationInput> = [
  { createdAt: 'asc' },
  { id: 'asc' },
];

const ROUNDS_NEWEST_FIRST: Array<Prisma.InterviewOrderByWithRelationInput> = [
  { scheduledAt: 'desc' },
  { id: 'desc' },
];

/** Oldest first, so a panel renders in the order it was staffed. */
const PANEL_STAFFING_ORDER: Array<Prisma.InterviewAssignmentOrderByWithRelationInput> = [
  { createdAt: 'asc' },
  { id: 'asc' },
];

const FEEDBACK_NEWEST_FIRST: Array<Prisma.FeedbackOrderByWithRelationInput> = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

/* -------------------------------------------------------------------------
 * The two selects the feature is judged on
 * ---------------------------------------------------------------------- */

/**
 * The RECRUITER's candidate detail, in one nested `select` (FR-5.2, FR-5.7).
 *
 * Every relation here is fetched by Prisma's relation select, which JOINs.
 * There is no per-application loop and no second call: the statement count is
 * independent of how many applications, rounds or assessments this candidate
 * has (PERF-2, AC-B44).
 *
 * Ordering is fixed here rather than in a service, so the client never re-sorts
 * (FR-5.3, XFE, frontend FR-5.1): applications newest first, **stage history
 * oldest first because a timeline reads forwards**, rounds newest first,
 * feedback newest first. `id` is the tiebreak everywhere — two rows sharing a
 * timestamp, which one transaction can easily produce, must still have one
 * order.
 *
 * `candidateProfile` is joined HERE and only here. The interviewer's select
 * below does not name this relation at all.
 */
export const RECRUITER_CANDIDATE_SELECT = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  candidateProfile: {
    select: { phone: true, location: true, headline: true, updatedAt: true },
  },
  applications: {
    orderBy: APPLICATIONS_NEWEST_FIRST,
    select: {
      id: true,
      status: true,
      currentStage: true,
      stageEnteredAt: true,
      createdAt: true,
      role: { select: { id: true, title: true, status: true } },
      stageHistory: {
        orderBy: HISTORY_OLDEST_FIRST,
        select: {
          id: true,
          fromStage: true,
          toStage: true,
          toStatus: true,
          createdAt: true,
          changedBy: { select: { id: true, name: true } },
          override: {
            select: {
              id: true,
              reason: true,
              createdAt: true,
              performedBy: { select: { id: true, name: true } },
            },
          },
        },
      },
      interviews: {
        orderBy: ROUNDS_NEWEST_FIRST,
        select: {
          id: true,
          type: true,
          stage: true,
          scheduledAt: true,
          status: true,
          assignments: {
            orderBy: PANEL_STAFFING_ORDER,
            select: { id: true, interviewer: { select: { id: true, name: true } } },
          },
          feedback: {
            orderBy: FEEDBACK_NEWEST_FIRST,
            select: {
              id: true,
              // See `CandidateFeedbackView` for why these two are selected:
              // the client hands these entries to the feedback feature's own
              // list component, which is what makes a five-round candidate one
              // request rather than six.
              interviewId: true,
              rating: true,
              notes: true,
              createdAt: true,
              updatedAt: true,
              interviewer: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * **The projection the POC is judged on** (FR-6.4, SEC-1, AC-B13).
 *
 * Two lines. It names no `email`. It joins no `candidateProfile`. It reaches no
 * `applications`, and therefore no stage history, no override reason, no panel
 * and no assessment.
 *
 * There is nothing in this shape to leave out, because nothing restricted was
 * ever selected. That is the difference between a design that cannot leak and
 * one that has not leaked yet.
 *
 * It serves **both** interviewer reads — the list row and the by-id detail
 * (FR-3.7, FR-6.4) — so there is one answer to "what does an interviewer see of
 * a person", not two that can drift.
 */
export const INTERVIEWER_CANDIDATE_SELECT = {
  id: true,
  name: true,
} as const;

/* -------------------------------------------------------------------------
 * The list and second-query projections
 * ---------------------------------------------------------------------- */

/**
 * The RECRUITER's list row (FR-3.6).
 *
 * `_count` gives `applicationCount` in the same statement as the rows, and
 * `applications` carries enough for the walkthrough's applicants table without
 * a second call (US-04, frontend FR-9.2).
 *
 * `candidateProfile` is joined for `phone` alone — the list shows a phone
 * column and nothing else from the profile.
 */
export const RECRUITER_CANDIDATE_LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  candidateProfile: { select: { phone: true } },
  _count: { select: { applications: true } },
  applications: {
    orderBy: APPLICATIONS_NEWEST_FIRST,
    select: {
      id: true,
      status: true,
      currentStage: true,
      stageEnteredAt: true,
      role: { select: { id: true, title: true } },
    },
  },
} as const;

/**
 * The interviewer's own rounds with one candidate (FR-6.6).
 *
 * `application` appears only as the path to the role — an `Interview` has no
 * `roleId` of its own. It selects the role's `{ id, title }` and **nothing
 * else**: not the application's id, not its stage, not its candidate, and
 * certainly not that candidate's contact columns.
 */
export const INTERVIEWER_CANDIDATE_ROUND_SELECT = {
  id: true,
  type: true,
  stage: true,
  scheduledAt: true,
  status: true,
  application: { select: { role: { select: { id: true, title: true } } } },
} as const;

/* -------------------------------------------------------------------------
 * Re-nesting — and what these functions deliberately are not
 * ---------------------------------------------------------------------- */

/**
 * The three functions below re-nest values that were **all already selected**,
 * because Prisma cannot flatten a relation inside a `select` and the published
 * contract is flat.
 *
 * **None of them removes anything from a row, and none of them may start.**
 * BE-2 rules out a step that fetches restricted columns and then takes them
 * back out — the failure mode where one missed call site leaks an email. There
 * is nothing here to take out: `INTERVIEWER_CANDIDATE_SELECT` never names a
 * restricted column, so the only function on an interviewer's path
 * (`toInterviewerRound`) touches nothing but a round's own fields.
 *
 * They are deliberately named after what they build, not after any kind of
 * cleaning pass — a reviewer greps this module for those names and finds
 * nothing, which is the check AC-B32 makes. **If a field must be kept from a
 * reader, it comes out of the select above, never out of one of these.**
 */

/** Exactly the row `RECRUITER_CANDIDATE_SELECT` produces. */
interface RecruiterCandidateRow {
  id: number;
  name: string;
  email: string;
  createdAt: Date;
  candidateProfile: {
    phone: string | null;
    location: string | null;
    headline: string | null;
    updatedAt: Date;
  } | null;
  applications: Array<RecruiterCandidateApplicationView>;
}

/**
 * Publishes `candidateProfile` as `profile`, and **turns a missing row into
 * three nulls rather than a `null` object** (FR-2.5, EC-10).
 *
 * A candidate nobody has recorded anything about is the normal state, not a gap
 * (MIG-5) — so the client renders `—` per field and never has to handle a
 * "no profile" case that would mean the same thing.
 */
export function toRecruiterCandidateView(row: RecruiterCandidateRow): RecruiterCandidateView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.createdAt,
    profile: {
      phone: row.candidateProfile?.phone ?? null,
      location: row.candidateProfile?.location ?? null,
      headline: row.candidateProfile?.headline ?? null,
      updatedAt: row.candidateProfile?.updatedAt ?? null,
    },
    applications: row.applications,
  };
}

/** Exactly the row `RECRUITER_CANDIDATE_LIST_SELECT` produces. */
interface RecruiterCandidateListRow {
  id: number;
  name: string;
  email: string;
  createdAt: Date;
  candidateProfile: { phone: string | null } | null;
  _count: { applications: number };
  applications: RecruiterCandidateRowView['applications'];
}

/** Lifts `phone` and the `_count` to the top level, which is the published shape. */
export function toRecruiterCandidateRow(row: RecruiterCandidateListRow): RecruiterCandidateRowView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.candidateProfile?.phone ?? null,
    createdAt: row.createdAt,
    applicationCount: row._count.applications,
    applications: row.applications,
  };
}

/** Exactly the row `INTERVIEWER_CANDIDATE_ROUND_SELECT` produces. */
interface InterviewerCandidateRoundRow {
  id: number;
  type: InterviewType;
  stage: PipelineStage;
  scheduledAt: Date | null;
  status: InterviewStatus;
  application: { role: { id: number; title: string } };
}

/** Lifts `role` out of `application`, so the application itself never reaches the wire. */
export function toInterviewerRound(
  row: InterviewerCandidateRoundRow,
): InterviewerCandidateRoundView {
  return {
    id: row.id,
    type: row.type,
    stage: row.stage,
    scheduledAt: row.scheduledAt,
    status: row.status,
    role: row.application.role,
  };
}
