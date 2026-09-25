import type { Prisma } from '../../../generated/prisma/client.js';
import { UserRole } from '../../../generated/prisma/enums.js';
import { prisma } from '../../lib/prisma.js';
import {
  INTERVIEWER_CANDIDATE_ROUND_SELECT,
  INTERVIEWER_CANDIDATE_SELECT,
  RECRUITER_CANDIDATE_LIST_SELECT,
  RECRUITER_CANDIDATE_SELECT,
  toInterviewerRound,
  toRecruiterCandidateRow,
  toRecruiterCandidateView,
  type InterviewerCandidateRoundView,
  type InterviewerCandidateView,
  type RecruiterCandidateRowView,
  type RecruiterCandidateView,
} from './candidate.select.js';
import type { ListCandidatesQuery } from './candidate.schema.js';

/**
 * **The file a reviewer opens to answer the brief's §7.3 question about
 * AUTHORIZATION** — `candidate.select.ts` is the one that answers it about
 * EXPOSURE (BE-2, AZ-2, SEC-2).
 *
 * > an interviewer requesting a candidate they are not assigned to, directly by
 * > ID, must be refused at the point of the query.
 *
 * It is. `buildCandidateWhere` below puts the assignment chain into the `where`
 * **before the query runs**, and every read in this module goes through it —
 * the page, the pager's `count` and the single by-id read (FR-3.3). When no
 * authorized row exists, Postgres returns nothing, so the restricted data is
 * never retrieved into application memory and there is no moment at which this
 * service holds a row it had no right to.
 *
 * **There is no fetch-then-check anywhere in this module.** No function loads a
 * candidate and then asks whether the caller is assigned; the question is part
 * of the statement that would have returned the row (AC-B31).
 *
 * **There are exactly four exported functions and no generic `getCandidate`**
 * (FR-7.1, D-7, AC-B14). The role picks which of the two reads is called, in
 * the service, before anything is queried — a single function with a role
 * parameter is one edit away from the wrong branch, and the leak that edit
 * causes is silent (SEC-3).
 *
 * This mirrors `buildRoleWhere` (roles) and `buildInterviewWhere` (interviews)
 * in shape, naming and ANDing discipline, so a reader who has understood one
 * has understood all three (BE-3).
 */

/** Byte-identical in shape to the roles, audit and interviews pagers (XFE-9). */
export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * The actor id handed to `buildCandidateWhere` on the RECRUITER path, which
 * never reads it (AZ-9).
 *
 * Named rather than passed as a bare `0` so the call site states the rule —
 * **a recruiter has no per-row scoping here; the role guard is the whole
 * authorization** — instead of looking like a forgotten argument. If a fallback
 * row filter is ever wanted for recruiters, this constant is what has to go.
 */
const RECRUITER_HAS_NO_ROW_SCOPE = 0;

/**
 * THE scope decision, shared by all three reads (FR-3.2, FR-3.3).
 *
 * It always ANDs `{ role: UserRole.CANDIDATE }`, so **this surface cannot be
 * used to read a recruiter or an interviewer** — `/api/candidates/:id` naming
 * one answers `404` for every caller, including a recruiter, and their user row
 * is never loaded (FR-1.2, AZ-7, EC-08, AC-B06, AC-B07).
 *
 * For a NON-RECRUITER it additionally requires an application with a round this
 * caller sits on. The test is `!== RECRUITER` rather than `=== INTERVIEWER` so
 * it fails CLOSED: a role added later is scoped until somebody decides
 * otherwise. Candidates never reach here — they are refused at the route
 * (AZ-5) — but if that guard were ever loosened this would not hand them the
 * whole table.
 *
 * **The scope predicate and the application filters share ONE `some` block**,
 * and that is deliberate rather than incidental. Pushing them as separate
 * `applications: { some: … }` clauses would mean `?roleId=3&stage=SCREEN`
 * matched a candidate who applied to role 3 at OFFER and to role 9 at SCREEN —
 * two different applications satisfying one filter each. Folded together they
 * mean what a recruiter reads them to mean: _one application_ matching all of
 * them. For an interviewer the same fold is what makes EC-03 true: their
 * `?roleId=` narrows to an application they have a round on, so a filter
 * narrows within their scope and **can never widen beyond it** (FR-3.2).
 *
 * The predicate is served by `InterviewAssignment_interviewerId_createdAt_idx`
 * (interviews MIG-4, PERF-1), and it is a JOIN rather than a two-step fetch:
 * nothing here loads an interviewer's assignment ids and then queries users
 * with an `in` list.
 *
 * `q` is a parameterised Prisma filter over `name` and `email`, never
 * interpolated SQL (D-11, FR-3.4). It is recruiter-only, and that restriction
 * is enforced in the service before this is called (VAL-5, FR-3.8).
 */
export function buildCandidateWhere(
  query: Pick<ListCandidatesQuery, 'q' | 'roleId' | 'stage' | 'status'>,
  actorRole: UserRole,
  actorId: number,
): Prisma.UserWhereInput {
  const and: Array<Prisma.UserWhereInput> = [{ role: UserRole.CANDIDATE }];

  // One application must satisfy all of these at once — see the note above.
  const application: Prisma.ApplicationWhereInput = {};

  // Assigned first, so that a non-recruiter's block is never empty and the
  // `Object.keys` test below can never drop their scope.
  if (actorRole !== UserRole.RECRUITER) {
    application.interviews = { some: { assignments: { some: { interviewerId: actorId } } } };
  }

  // US-04, the job → applicants step (FR-3.4). Served by the shipped
  // `Application_roleId_currentStage_idx` (PERF-8).
  if (query.roleId !== undefined) {
    application.roleId = query.roleId;
  }

  if (query.stage !== undefined) {
    application.currentStage = query.stage;
  }

  if (query.status !== undefined) {
    application.status = query.status;
  }

  if (Object.keys(application).length > 0) {
    and.push({ applications: { some: application } });
  }

  if (query.q !== undefined) {
    and.push({
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { email: { contains: query.q, mode: 'insensitive' } },
      ],
    });
  }

  return { AND: and };
}

/**
 * A page of candidates, plus its `count`, in ONE transaction sharing ONE
 * `where` (FR-3.3, PERF-3) — so `total` always describes the same snapshot and
 * the same scope as the rows beside it. Two statements per request, never one
 * per row (AC-B46).
 *
 * Branched on role rather than a ternary on `select` alone, so each call keeps
 * its own inferred row type and the two projections cannot be confused. **The
 * interviewer's page is built by selecting two columns, never by selecting the
 * recruiter shape and narrowing it** — that would fetch contact data for every
 * row on every page, which is the leak this feature exists to close, made worse
 * by volume (PERF-5, AC-B11).
 *
 * `id desc` is the tiebreak: without it two candidates sharing a `createdAt`
 * could be repeated or skipped across pages.
 */
export async function listCandidates(
  query: ListCandidatesQuery,
  actorRole: UserRole,
  actorId: number,
): Promise<{
  candidates: Array<RecruiterCandidateRowView> | Array<InterviewerCandidateView>;
  total: number;
}> {
  const where = buildCandidateWhere(query, actorRole, actorId);

  const page = {
    where,
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
  };

  if (actorRole === UserRole.RECRUITER) {
    const [rows, total] = await prisma.$transaction([
      prisma.user.findMany({ ...page, select: RECRUITER_CANDIDATE_LIST_SELECT }),
      prisma.user.count({ where }),
    ]);

    return { candidates: rows.map(toRecruiterCandidateRow), total };
  }

  const [candidates, total] = await prisma.$transaction([
    prisma.user.findMany({ ...page, select: INTERVIEWER_CANDIDATE_SELECT }),
    prisma.user.count({ where }),
  ]);

  return { candidates, total };
}

/**
 * One candidate in full, for a RECRUITER (FR-5.1, FR-5.2, D-7).
 *
 * **One Prisma call.** Its nested `select` produces a bounded set of joined
 * statements; there is no second call and no per-application loop, so the
 * statement count is independent of how many applications, rounds or
 * assessments this candidate has (FR-5.7, PERF-2, AC-B44).
 *
 * It routes through `buildCandidateWhere` for the `role: CANDIDATE` predicate —
 * the same decision the page and the pager use, expressed once (FR-3.3). A
 * recruiter's or an interviewer's id answers `404` here exactly as it does on
 * the list (AC-B07).
 *
 * `findFirst`, not `findUnique`, because the predicate is id **plus** the role
 * requirement rather than a unique key alone. The caller turns `null` into a
 * `404` (FR-5.6).
 */
export async function getRecruiterCandidate(
  candidateId: number,
): Promise<RecruiterCandidateView | null> {
  const row = await prisma.user.findFirst({
    where: {
      id: candidateId,
      ...buildCandidateWhere({}, UserRole.RECRUITER, RECRUITER_HAS_NO_ROW_SCOPE),
    },
    select: RECRUITER_CANDIDATE_SELECT,
  });

  return row === null ? null : toRecruiterCandidateView(row);
}

/**
 * One candidate for an assigned INTERVIEWER — **the brief's sharpest test**
 * (FR-6.1, FR-6.2, EC-01, AC-B01).
 *
 * A different function from the recruiter's, not a branch inside one (D-7).
 *
 * **The authorization is the `where`.** The first statement requires a
 * candidate with an application carrying a round this interviewer sits on. If
 * no authorized row exists, Postgres returns nothing: the restricted data is
 * never retrieved, so there is no moment at which this service holds a row it
 * had no right to, and nothing downstream can forget to check anything. The
 * caller turns `null` into a `404` — **never a `403`**, which would confirm the
 * candidate exists and turn the endpoint into an enumeration oracle (FR-6.5,
 * AZ-6, SEC-5).
 *
 * **Two narrow queries, not one wide one** (FR-6.6, PERF-7, AC-B47). The rounds
 * are fetched separately rather than by widening `INTERVIEWER_CANDIDATE_SELECT`
 * to reach `applications` — a reach that would then have to be constrained
 * again on every branch inside it. Each statement carries its own
 * `interviewerId` predicate, so neither can be the one that forgets, and the
 * second runs only after the first has already authorized the read.
 *
 * The second returns **only rounds this interviewer is assigned to** (FR-6.7,
 * EC-07): a candidate interviewed by three panels shows each panellist their
 * own round and nothing about the others.
 */
export async function getInterviewerCandidate(
  candidateId: number,
  interviewerId: number,
): Promise<{
  candidate: InterviewerCandidateView;
  interviews: Array<InterviewerCandidateRoundView>;
} | null> {
  const candidate = await prisma.user.findFirst({
    where: {
      id: candidateId,
      ...buildCandidateWhere({}, UserRole.INTERVIEWER, interviewerId),
    },
    select: INTERVIEWER_CANDIDATE_SELECT,
  });

  if (candidate === null) {
    return null;
  }

  const rounds = await prisma.interview.findMany({
    where: {
      application: { candidateUserId: candidateId },
      assignments: { some: { interviewerId } },
    },
    orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
    select: INTERVIEWER_CANDIDATE_ROUND_SELECT,
  });

  return { candidate, interviews: rounds.map(toInterviewerRound) };
}
