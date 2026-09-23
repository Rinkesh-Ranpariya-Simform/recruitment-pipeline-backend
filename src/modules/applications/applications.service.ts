import type { Logger } from 'pino';
import { Prisma } from '../../generated/prisma/client.js';
import { ApplicationStatus, PipelineStage, RoleStatus } from '../../generated/prisma/enums.js';
import { AlreadyAppliedError, NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import {
  APPLICATION_SELECT,
  CANDIDATE_APPLICATION_DETAIL_SELECT,
  RECRUITER_APPLICATION_DETAIL_SELECT,
  RECRUITER_APPLICATION_SELECT,
  type CandidateApplicationView,
  type RecruiterApplicationDetailView,
  type RecruiterApplicationView,
} from './application.select.js';
import { buildTimeline, type TimelineInterviewRow } from './timeline.js';
import type { ListApplicationsQuery } from './applications.schema.js';

/**
 * All Prisma access, the eligibility rule and the event logging for
 * applications; the controller does none of it.
 *
 * **Every read in this file is written twice, once per audience** — a candidate
 * function and a recruiter function, each with its own `where` and its own
 * select (BE-2). There is no function here that takes a role and branches
 * inside one query. That is the same discipline as `getRecruiterCandidate` /
 * `getInterviewerCandidate` in the candidate-access spec, and it exists because
 * a single function with a role branch is one edit away from the wrong branch.
 */

/** The candidate-facing envelope, as both of their endpoints return it. */
export type Application = CandidateApplicationView;

/** Matching the shipped roles, audit and interviews pagers. */
export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Exactly what the two candidate selects return, so `toCandidateApplication`
 * below is checked against the rows it is actually handed.
 */
interface CandidateApplicationRow {
  id: number;
  status: ApplicationStatus;
  currentStage: PipelineStage;
  createdAt: Date;
  role: { id: number; title: string };
  interviews: Array<TimelineInterviewRow>;
}

/**
 * Replaces the fetched rounds with the timeline built from them (FR-5.4).
 *
 * **This is not the post-fetch filtering BE-4 forbids, and the distinction is
 * the whole point** — the same one `toInterviewerView` documents. BE-4 rules
 * out a step that FETCHES restricted columns and then removes them, the failure
 * mode where one missed call site leaks a rating or an interviewer's name.
 * Nothing restricted is fetched here: `APPLICATION_SELECT` names eight neutral
 * columns per round and no `interviewer`, `feedback`, `rating` or `notes`, so
 * this function has nothing to remove and removes nothing of the kind.
 *
 * What it drops is a raw round list a candidate has no route to open, having
 * already used it for the one thing it was selected for.
 *
 * **If a field ever needs keeping from a candidate, it comes out of the select,
 * not out of this function.**
 */
const toCandidateApplication = (row: CandidateApplicationRow): CandidateApplicationView => {
  return {
    id: row.id,
    status: row.status,
    currentStage: row.currentStage,
    createdAt: row.createdAt,
    role: row.role,
    timeline: buildTimeline(row, row.interviews),
  };
};

/**
 * Creates one application for the authenticated candidate (candidate FR-5).
 *
 * **`candidateUserId` comes from the token, never the body** (FR-5.3, AZ-5). The
 * schema has no field for it, so there is no impersonation case to defend
 * against rather than a check that could be forgotten.
 *
 * The requisition is resolved by a query whose `where` is `{ id, status: OPEN }`
 * — **the eligibility rule and the lookup are one statement** (FR-5.5, AZ-6).
 * There is no fetch-then-check, so there is no window between deciding a role is
 * open and using it. A CLOSED or missing role produces the same 404 from the
 * same query, which is also what keeps the endpoint from confirming that a
 * closed requisition exists (SEC-4, AC-B30/AC-B31).
 *
 * `status`, `currentStage` and `stageEnteredAt` are literals (FR-5.4). Nothing
 * in the request influences them.
 *
 * **A candidate may apply to the same role only ONCE**, enforced by the
 * `@@unique([candidateUserId, roleId])` index rather than a preceding
 * `findFirst` — see `AlreadyAppliedError` for why (EC-06).
 */
export async function createApplication(
  roleId: number,
  candidateUserId: number,
  log: Logger,
): Promise<Application> {
  // One transaction so the `Role` row's existence is guaranteed for the insert
  // and the foreign key cannot fail with an unexplained P2003 (FR-5.7).
  //
  // A recruiter closing this role between the two statements is possible, and
  // accepted: the resulting row is valid, the FK holds, and the candidate did
  // apply while it was genuinely open (EC-08). Preventing it would mean row
  // locking `Role` on every apply, which is not worth it at this scale.
  let application: CandidateApplicationRow;

  try {
    application = await prisma.$transaction(async (tx) => {
      const role = await tx.role.findFirst({
        where: { id: roleId, status: RoleStatus.OPEN },
        select: { id: true },
      });

      if (role === null) {
        throw new NotFoundError();
      }

      const now = new Date();

      const created = await tx.application.create({
        data: {
          candidateUserId,
          roleId: role.id,
          status: ApplicationStatus.ACTIVE,
          currentStage: PipelineStage.APPLIED,
          stageEnteredAt: now,
        },
        select: APPLICATION_SELECT,
      });

      // The ENTRY row of the stage timeline (pipeline FR-9.1, FR-5.3) — the one
      // statement this feature gains from the pipeline feature, and the only
      // amendment pipeline makes to shipped code.
      //
      // `fromStage`/`fromStatus` are null here and ONLY here: this row records
      // an application coming into existence at APPLIED, so there is no
      // "before" to name. Every later row has both ends.
      //
      // `changedByUserId` is the candidate, not a recruiter. Entry into APPLIED
      // is the act of applying, and it is the one transition in the timeline
      // this API does not attribute to a recruiter.
      //
      // Inside the EXISTING transaction, so an application can never exist with
      // no history — the same rule every pipeline write follows.
      await tx.stageHistory.create({
        data: {
          applicationId: created.id,
          fromStage: null,
          toStage: PipelineStage.APPLIED,
          fromStatus: null,
          toStatus: ApplicationStatus.ACTIVE,
          changedByUserId: candidateUserId,
          overrideId: null,
        },
        select: { id: true },
      });

      return created;
    });
  } catch (error) {
    // The duplicate is caught OUTSIDE the transaction, not inside it: a unique
    // violation aborts the Postgres transaction, so the `catch` has to sit where
    // there is no longer one to be in.
    //
    // Ordering note: the role lookup runs first, so a repeat apply to a role
    // that has since been CLOSED answers 404, not 409 — the candidate is told
    // the position is gone rather than that they already applied to it.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Not logged at `warn` with the ids: a second click is ordinary user
      // behaviour, and the error middleware already logs every AppError.
      throw new AlreadyAppliedError();
    }
    throw error;
  }

  // Ids only — never the candidate's name or email, and never the requisition
  // title (FR-5.9, FR-9.4).
  log.info(
    {
      event: 'application.created',
      applicationId: application.id,
      candidateUserId,
      roleId,
    },
    'application created',
  );

  return toCandidateApplication(application);
}

/* -------------------------------------------------------------------------
 * The candidate's own reads
 * ---------------------------------------------------------------------- */

/**
 * The authenticated candidate's own applications, and only those (candidate
 * FR-6).
 *
 * **The scoping is in the query** — `where: { candidateUserId }` — not a wider
 * read narrowed afterwards in application code (FR-6.2, AZ-2). This is the
 * brief's §3.2 discipline pointed at the new actor: a shape that never selects
 * another candidate's rows cannot leak them.
 *
 * **It takes no query parameters**, deliberately, even though the route now runs
 * `validateQuery` for both roles. A candidate's list is their own and is short;
 * a `roleId` filter on it would let them narrow a set they can already see
 * whole, and a pager would be a second contract to keep. `ListApplicationsQuery`
 * is not a parameter of this function, so no filter can reach this `where` by
 * any route the controller could take.
 *
 * One indexed query, served by `@@index([candidateUserId, createdAt])` — the
 * filter and the ORDER BY in one index, so there is no sort step (PERF-1). The
 * rounds behind each timeline are one further batched query for the whole list,
 * not one per application (PERF-2).
 */
export async function listApplications(candidateUserId: number): Promise<Array<Application>> {
  const rows = await prisma.application.findMany({
    where: { candidateUserId },
    // `id desc` is the tiebreak, matching the roles listing: two applications
    // sharing a `createdAt` must still have a stable order.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: APPLICATION_SELECT,
  });

  return rows.map(toCandidateApplication);
}

/**
 * One of the authenticated candidate's own applications (FR-4.3).
 *
 * **`candidateUserId` is part of the `where`, not a check after the fetch**
 * (AZ-2). A candidate asking for somebody else's id gets a `404` produced by a
 * query that returned no row — the same answer a nonexistent id gets, from the
 * same statement, so the response cannot be used to discover that an
 * application exists.
 *
 * This is the route the candidate feature deliberately did not ship (candidate
 * FR-6.8), and the reversal is deliberate too: that absence was a guarantee
 * only because there was nothing on a detail page worth showing. There is now —
 * the stage timeline the brief's §3.5 complaint is about. The guarantee is
 * replaced by the predicate above rather than abandoned.
 */
export async function getCandidateApplication(
  applicationId: number,
  candidateUserId: number,
): Promise<Application> {
  const row = await prisma.application.findFirst({
    where: { id: applicationId, candidateUserId },
    select: CANDIDATE_APPLICATION_DETAIL_SELECT,
  });

  if (row === null) {
    throw new NotFoundError();
  }

  return toCandidateApplication(row);
}

/* -------------------------------------------------------------------------
 * The recruiter's reads
 * ---------------------------------------------------------------------- */

/**
 * `?hasInterviews=` as a `where` fragment (FR-1.4).
 *
 * Both branches are `EXISTS` subqueries in the SQL Prisma emits — `some` and
 * `none` — rather than a join that multiplies rows or a count loaded into Node.
 * Omitted entirely when the parameter was not sent, so the unfiltered list pays
 * for nothing.
 */
const interviewPresenceFilter = (
  hasInterviews: boolean | undefined,
): Prisma.ApplicationWhereInput => {
  if (hasInterviews === undefined) {
    return {};
  }

  return hasInterviews ? { interviews: { some: {} } } : { interviews: { none: {} } };
};

/**
 * Every application, filtered and paged (FR-1).
 *
 * **There is no per-row scoping here, and the role guard on the route is the
 * whole authorization** — the same arrangement as the pipeline board (pipeline
 * AZ-2). A recruiter sees every application on every requisition. Anyone
 * widening that guard is not granting a filtered view; they are granting
 * everything.
 *
 * `hasInterviews` is the filter that makes `/interviews` a list of candidates in
 * process rather than a list of rounds (FR-1.4). It is expressed as `interviews:
 * { some: {} }` / `{ none: {} }`, which Prisma compiles to an `EXISTS`
 * subquery — not a join that multiplies rows and not a count loaded into Node.
 *
 * Paged, unlike the candidate's list, because this one scales with people: it is
 * the only read in this module whose result set grows with the 20,000 candidates
 * the brief names (PERF-3).
 */
export async function listRecruiterApplications(
  query: ListApplicationsQuery,
): Promise<{ applications: Array<RecruiterApplicationView>; pagination: Pagination }> {
  const where: Prisma.ApplicationWhereInput = {
    ...(query.roleId === undefined ? {} : { roleId: query.roleId }),
    ...(query.stage === undefined ? {} : { currentStage: query.stage }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...interviewPresenceFilter(query.hasInterviews),
  };

  // One round trip for both statements, and both see the same snapshot — so a
  // page cannot be counted against a table that changed between the two.
  const [rows, total] = await prisma.$transaction([
    prisma.application.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: RECRUITER_APPLICATION_SELECT,
    }),
    prisma.application.count({ where }),
  ]);

  return {
    applications: rows.map((row) => ({
      id: row.id,
      status: row.status,
      currentStage: row.currentStage,
      stageEnteredAt: row.stageEnteredAt,
      createdAt: row.createdAt,
      role: row.role,
      candidate: row.candidate,
      // Lifted out of Prisma's `_count` envelope, which is a shape the API
      // contract should not have to publish.
      interviewCount: row._count.interviews,
    })),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
  };
}

/**
 * One application, with its timeline and every round on it (FR-4.2).
 *
 * `404` on a missing id. There is no scoping predicate and none is missing: a
 * recruiter may read every application, as they may on the board and on
 * `GET /api/interviews`.
 */
export async function getRecruiterApplication(
  applicationId: number,
): Promise<RecruiterApplicationDetailView> {
  const row = await prisma.application.findUnique({
    where: { id: applicationId },
    select: RECRUITER_APPLICATION_DETAIL_SELECT,
  });

  if (row === null) {
    throw new NotFoundError();
  }

  return {
    id: row.id,
    status: row.status,
    currentStage: row.currentStage,
    stageEnteredAt: row.stageEnteredAt,
    createdAt: row.createdAt,
    role: row.role,
    candidate: row.candidate,
    // The SAME builder a candidate's timeline comes from (FR-5.5). Two builders
    // would eventually tell the two audiences different stories about one
    // process, which is the failure the brief opens with.
    timeline: buildTimeline(row, row.interviews),
    interviews: row.interviews,
  };
}
