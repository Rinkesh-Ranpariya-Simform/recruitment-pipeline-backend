import type { Prisma } from '../../../generated/prisma/client.js';
import { UserRole } from '../../../generated/prisma/enums.js';
import { prisma } from '../../lib/prisma.js';
import {
  INTERVIEWER_INTERVIEW_SELECT,
  RECRUITER_INTERVIEW_SELECT,
  toInterviewerView,
  type InterviewerInterviewView,
  type RecruiterInterviewView,
} from './interview.select.js';
import type { ListInterviewsQuery } from './interviews.schema.js';

/**
 * **The one file that expresses the interviewer scope.**
 *
 * `buildInterviewWhere` below is the only place in this codebase that writes
 * `assignments: { some: … }`. Every read that could reach a round — the page,
 * the pager's `count` and the single by-id read — routes through it.
 * **No handler filters a fetched list, and there is no
 * `if (interview.assignments.some(...))` anywhere in this module**; a reviewer
 * can confirm the scoping is correct by reading this file alone.
 *
 * If a third interviews read is ever added, it routes through
 * `buildInterviewWhere` too. A second copy of this decision is how the rule
 * rots.
 */

/** Byte-identical in shape to the roles and audit pagers, so clients reuse it. */
export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * THE role-aware query decision, shared by all three reads.
 *
 * It mirrors `buildRoleWhere` in `roles.service.ts` in shape, naming and ANDing
 * discipline, so a reader who has understood one has understood both.
 *
 * For a NON-RECRUITER, `{ assignments: { some: { interviewerId: actorId } } }`
 * goes into the `where` **before the query runs**. An unassigned interviewer's
 * request produces no row at all, so the restricted data is never retrieved
 * into application memory. The predicate is served by
 * `InterviewAssignment_interviewerId_createdAt_idx`, and it is a JOIN rather
 * than a two-step fetch: this module never loads an interviewer's assignment ids
 * and then queries interviews with an `in` list.
 *
 * Predicates are **ANDed, never overwritten**, which is why an interviewer
 * passing `?applicationId=` for an application they have no round on gets an
 * empty page rather than somebody else's rounds: a filter narrows within their
 * scope and can never widen beyond it.
 *
 * The test is `!== RECRUITER` rather than `=== INTERVIEWER` so it fails CLOSED:
 * a role added later is scoped until someone decides otherwise. Candidates never
 * reach here — they are refused at the route — but if that guard were ever
 * loosened this would not hand them the whole table.
 */
export function buildInterviewWhere(
  query: Pick<ListInterviewsQuery, 'status' | 'applicationId' | 'roleId'>,
  actorRole: UserRole,
  actorId: number,
): Prisma.InterviewWhereInput {
  const and: Array<Prisma.InterviewWhereInput> = [];

  if (actorRole !== UserRole.RECRUITER) {
    and.push({ assignments: { some: { interviewerId: actorId } } });
  }

  if (query.status !== undefined) {
    and.push({ status: query.status });
  }

  if (query.applicationId !== undefined) {
    and.push({ applicationId: query.applicationId });
  }

  // Through the application, because a round has no `roleId` of its own — the
  // role is a property of the application it hangs off.
  if (query.roleId !== undefined) {
    and.push({ application: { roleId: query.roleId } });
  }

  return and.length === 0 ? {} : { AND: and };
}

/**
 * A page of rounds, plus its `count`, in ONE transaction sharing ONE `where`
 * — so `total` always describes the same snapshot and the same scope as the
 * rows beside it. Two queries per request, never one per row.
 *
 * Branched on role rather than a ternary on `select` alone, so each call keeps
 * its own inferred row type and the two projections cannot be confused. The
 * recruiter's `assignments` come from a relation select, which joins — not an
 * N+1 per round.
 *
 * `id desc` is the tiebreak: without it two rounds sharing a `scheduledAt` could
 * be repeated or skipped across pages.
 */
export async function findInterviewPage(
  query: ListInterviewsQuery,
  actorRole: UserRole,
  actorId: number,
): Promise<{
  interviews: Array<RecruiterInterviewView> | Array<InterviewerInterviewView>;
  total: number;
}> {
  const where = buildInterviewWhere(query, actorRole, actorId);

  const page = {
    where,
    orderBy: [{ scheduledAt: 'desc' as const }, { id: 'desc' as const }],
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
  };

  if (actorRole === UserRole.RECRUITER) {
    const [interviews, total] = await prisma.$transaction([
      prisma.interview.findMany({ ...page, select: RECRUITER_INTERVIEW_SELECT }),
      prisma.interview.count({ where }),
    ]);

    return { interviews, total };
  }

  const [rows, total] = await prisma.$transaction([
    prisma.interview.findMany({ ...page, select: INTERVIEWER_INTERVIEW_SELECT }),
    prisma.interview.count({ where }),
  ]);

  return { interviews: rows.map(toInterviewerView), total };
}

/**
 * One round, resolved with the **same** scoped `where` as the page.
 *
 * **The authorization condition is inside the database query.** An unassigned
 * interviewer's request returns `null` because the row never matched, not
 * because a check rejected it afterwards — so the round's data is never loaded
 * into memory at all. The authorization costs nothing extra: it is part of the
 * query that was already being run.
 *
 * `findFirst`, not `findUnique`, because the predicate is id + assignment rather
 * than a unique key alone.
 *
 * The caller turns `null` into a `404` — never a `403`.
 */
export async function findInterviewById(
  interviewId: number,
  actorRole: UserRole,
  actorId: number,
): Promise<RecruiterInterviewView | InterviewerInterviewView | null> {
  const where = { id: interviewId, ...buildInterviewWhere({}, actorRole, actorId) };

  if (actorRole === UserRole.RECRUITER) {
    return prisma.interview.findFirst({ where, select: RECRUITER_INTERVIEW_SELECT });
  }

  const row = await prisma.interview.findFirst({ where, select: INTERVIEWER_INTERVIEW_SELECT });

  return row === null ? null : toInterviewerView(row);
}

/**
 * Every round on one application, recruiter projection.
 *
 * **This read has no interviewer path at all**, and it is not scoped: reaching
 * rounds through an application id would bypass the assignment predicate
 * entirely, so the route is recruiter-only and there is nothing here to bypass.
 * It deliberately does NOT call `buildInterviewWhere` — there is no role
 * decision to make, and passing a role it would then ignore would suggest
 * otherwise.
 *
 * Unpaginated because it is bounded by the rounds on one application — a
 * single-digit number in practice. **50 rounds on one application is the
 * documented threshold at which this must gain a pager.**
 */
export async function findInterviewsForApplication(
  applicationId: number,
): Promise<Array<RecruiterInterviewView>> {
  return prisma.interview.findMany({
    where: { applicationId },
    orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
    select: RECRUITER_INTERVIEW_SELECT,
  });
}
