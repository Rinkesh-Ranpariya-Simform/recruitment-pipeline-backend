import type { Logger } from 'pino';
import { AuditAction, AuditEntityType, UserRole } from '../../generated/prisma/enums.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { recordAudit } from '../audit/audit.service.js';
import type {
  InterviewerCandidateRoundView,
  InterviewerCandidateView,
  RecruiterCandidateRowView,
  RecruiterCandidateView,
} from './candidate.select.js';
import {
  getInterviewerCandidate,
  getRecruiterCandidate,
  listCandidates as findCandidatePage,
  type Pagination,
} from './candidate.repository.js';
import type { ListCandidatesQuery, UpdateCandidateContactInput } from './candidate.schema.js';

/**
 * Candidates, as each role may read them — and the one write this feature has.
 *
 * **The role decides WHICH QUERY IS ISSUED, before it is issued** (BE-2, FR-7.2,
 * D-7, AC-B33). `getCandidateDetail` below dispatches to one of two separately
 * scoped repository functions; neither branch re-selects, narrows or inspects
 * the other's result, and there is no step anywhere in this module that takes a
 * field back out of a fetched row. The role never decides _which fields are
 * removed from a result_ — that design is one missed call site away from a leak,
 * and it is the one the brief's §4 asks to be designed out.
 *
 * The scope itself is not written here. It lives in exactly one place,
 * `candidate.repository.ts` (BE-3, AZ-2), and every call site of
 * `buildCandidateWhere` is inside that file (AC-B34).
 *
 * The one write is ONE transaction holding the scoped lookup, the upsert and
 * its `recordAudit` call (BE-6). `recordAudit` is passed `tx`, never the global
 * client — the latter does not compile — and its failure is deliberately not
 * caught: an action that could not be recorded did not happen (ERR-5, EC-15).
 *
 * `log: Logger` is last on every function, matching every shipped service
 * (BE-7). **Log lines carry ids, roles and counts only** (FR-8.2, SEC-7): never
 * a name, an email, a phone, a location or a search term. `q` in particular may
 * contain a candidate's email address, so it is excluded by name rather than by
 * hoping no line includes the query object.
 */

/** What `GET /api/candidates/:candidateId` answers a RECRUITER (FR-5.2). */
export interface RecruiterCandidateResult {
  candidate: RecruiterCandidateView;
}

/**
 * What it answers an assigned INTERVIEWER (FR-6.4, FR-6.6).
 *
 * `interviews` is a **separate, separately scoped key** rather than something
 * hanging off the candidate — the candidate object itself has two fields and no
 * path to an application (contract invariant 3).
 */
export interface InterviewerCandidateResult {
  candidate: InterviewerCandidateView;
  interviews: Array<InterviewerCandidateRoundView>;
}

/**
 * The two answers, as a union rather than one object with optional keys.
 *
 * A recruiter's result has **no** `interviews` key and an interviewer's has no
 * `profile` or `applications`; a shape with both optional would invite a
 * handler to reach for the wrong one (XFE-1).
 */
export type CandidateDetailResult = RecruiterCandidateResult | InterviewerCandidateResult;

/* -------------------------------------------------------------------------
 * FR-3 — the list
 * ---------------------------------------------------------------------- */

/**
 * One endpoint, both privileged roles, two projections (FR-3.1, FR-3.6, FR-3.7).
 *
 * **`?q=` from an interviewer is a `400`, not a silently dropped parameter**
 * (VAL-5, FR-3.8, EC-04, AC-B39). It is rejected here rather than in
 * `candidate.schema.ts` because the rule depends on the caller's role, which
 * `validateQuery` cannot see — but it is still rejected **before any query
 * runs**, which is the property VAL-8 asks for. A search box over candidates is
 * precisely the affordance this feature exists to deny an interviewer, and
 * ignoring the parameter would leave a client believing it worked.
 *
 * The scoping is entirely `buildCandidateWhere`'s, in the repository — this
 * function does not filter, and **must not start**: an interviewer's page is
 * narrow because the query was narrow, not because rows were dropped from a
 * wider one (AZ-2, XFE-2).
 *
 * An empty result is `200 { candidates: [], pagination }`, never a `404`
 * (FR-3.9). A page past the end is the same, with accurate pagination (EC-18).
 */
export async function listCandidates(
  query: ListCandidatesQuery,
  actorRole: UserRole,
  actorId: number,
  log: Logger,
): Promise<{
  candidates: Array<RecruiterCandidateRowView> | Array<InterviewerCandidateView>;
  pagination: Pagination;
}> {
  if (query.q !== undefined && actorRole !== UserRole.RECRUITER) {
    throw new ValidationError({ q: ['Search is not available on this list'] });
  }

  const { candidates, total } = await findCandidatePage(query, actorRole, actorId);

  log.info(
    // No `q`, deliberately — it may be a candidate's email address (SEC-7,
    // EC-17, AC-B18). Ids, the role and the count, and nothing else.
    { event: 'candidate.listed', actorId, actorRole, resultCount: candidates.length },
    'candidates listed',
  );

  return {
    candidates,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      // 0 for an empty result, not 1 — matching the roles, audit and interviews
      // pagers.
      totalPages: Math.ceil(total / query.pageSize),
    },
  };
}

/* -------------------------------------------------------------------------
 * FR-5 / FR-6 — the two reads
 * ---------------------------------------------------------------------- */

/**
 * **The role dispatch, and it happens before any query is issued** (FR-7.2,
 * BE-2, AC-B33).
 *
 * This is the only generic-sounding name in the feature, and it is a dispatcher
 * rather than a query: there is no `getCandidate` in the repository and no
 * single query with a role parameter (FR-7.1, SEC-3, AC-B14). The two branches
 * call two different functions against two different projections, and neither
 * touches the other's result.
 *
 * **No row is `404 NOT_FOUND`, never `403`** (FR-6.5, AZ-6, ERR-1). For an
 * interviewer that answer covers three causes — no such candidate, the id is
 * not a candidate, and "not assigned" — and it is **byte-identical** across all
 * three, which is the enumeration oracle this whole design closes (SEC-5,
 * AC-B01, AC-B06).
 *
 * The miss is logged as `candidate.scoped_read_miss` for a non-recruiter only
 * (FR-8.1, AC-B02) — the single most useful line for noticing someone probing
 * the id space. It carries ids and the role alone. A recruiter's miss is an
 * ordinary `404` and says nothing about access.
 */
export async function getCandidateDetail(
  candidateId: number,
  actorRole: UserRole,
  actorId: number,
  log: Logger,
): Promise<CandidateDetailResult> {
  if (actorRole === UserRole.RECRUITER) {
    const candidate = await getRecruiterCandidate(candidateId);

    if (candidate === null) {
      throw new NotFoundError();
    }

    log.info({ event: 'candidate.read', actorId, actorRole, candidateId }, 'candidate read');

    return { candidate };
  }

  const result = await getInterviewerCandidate(candidateId, actorId);

  if (result === null) {
    log.warn(
      { event: 'candidate.scoped_read_miss', actorId, actorRole, candidateId },
      'scoped candidate read matched no row',
    );

    throw new NotFoundError();
  }

  log.info(
    {
      event: 'candidate.read',
      actorId,
      actorRole,
      candidateId,
      roundCount: result.interviews.length,
    },
    'candidate read',
  );

  return result;
}

/* -------------------------------------------------------------------------
 * FR-4 — recording contact details
 * ---------------------------------------------------------------------- */

/**
 * Records a candidate's phone, location and/or headline (FR-4.1, FR-4.3).
 *
 * **Three statements in one transaction** (BE-6, PERF-6): the scoped lookup,
 * the upsert and the audit insert.
 *
 * The target is resolved by `findFirst({ where: { id, role: CANDIDATE } })` —
 * **the role requirement is in the `where`**, not in an `if` after fetching a
 * user (FR-4.4, FR-1.2). A recruiter's or an interviewer's id answers `404`,
 * not `403`, so this endpoint cannot be used to enumerate roles, and their user
 * row is never loaded (ERR-3, AC-B30).
 *
 * The write is an **upsert** on the profile's primary key (D-4): the row is
 * created on first use and updated thereafter, so there is no create endpoint
 * and no "profile not found" state a client must handle (EC-11). Two recruiters
 * writing at the same instant both get `200` and the later commit wins the
 * column values — an upsert on a primary key cannot produce two rows, and the
 * fields are independent free text, so there is no lost-update hazard worth a
 * version column (EC-14).
 *
 * The patch is built key by key rather than by spread: with
 * `exactOptionalPropertyTypes` on, an explicit `undefined` is not the same as
 * an absent key, and spreading one would write `null` over a column the
 * recruiter never mentioned (FR-4.6, VAL-6, EC-12).
 *
 * The audit entry carries **the NAMES of the changed fields, never their
 * values** (FR-4.5, SEC-8, contract invariant 8, AC-B26). The feed records that
 * a phone number was recorded; it does not record the phone number — and its
 * readers are a different, broader set than this endpoint's.
 *
 * The full recruiter detail is read back AFTER the transaction commits, so the
 * client needs no refetch (FR-4.7, XFE-10). It is deliberately outside: it is a
 * read of committed state, not part of the write, and holding the transaction
 * open across it would widen the lock for nothing.
 */
export async function updateCandidateContact(
  candidateId: number,
  input: UpdateCandidateContactInput,
  actorUserId: number,
  log: Logger,
): Promise<RecruiterCandidateView> {
  const data: { phone?: string | null; location?: string | null; headline?: string | null } = {};
  const fields: Array<string> = [];

  if (input.phone !== undefined) {
    data.phone = input.phone;
    fields.push('phone');
  }
  if (input.location !== undefined) {
    data.location = input.location;
    fields.push('location');
  }
  if (input.headline !== undefined) {
    data.headline = input.headline;
    fields.push('headline');
  }

  await prisma.$transaction(async (tx) => {
    const target = await tx.user.findFirst({
      where: { id: candidateId, role: UserRole.CANDIDATE },
      select: { id: true },
    });

    if (target === null) {
      throw new NotFoundError();
    }

    await tx.candidateProfile.upsert({
      where: { userId: candidateId },
      create: { userId: candidateId, ...data },
      update: data,
      select: { userId: true },
    });

    await recordAudit(
      tx,
      {
        action: AuditAction.CANDIDATE_CONTACT_UPDATED,
        entityType: AuditEntityType.CANDIDATE,
        entityId: candidateId,
        actorUserId,
        metadata: { fields },
      },
      log,
    );
  });

  log.info(
    // The field NAMES, matching the audit row. No value of any of them reaches
    // this line (FR-8.2, SEC-7).
    { event: 'candidate.contact_updated', actorId: actorUserId, candidateId, fields },
    'candidate contact updated',
  );

  const candidate = await getRecruiterCandidate(candidateId);

  if (candidate === null) {
    // Only reachable if the candidate was deleted between the commit above and
    // this read. There is no deletion endpoint, so this is a `404` for a row
    // that genuinely is not there any more rather than a defensive branch.
    throw new NotFoundError();
  }

  return candidate;
}
