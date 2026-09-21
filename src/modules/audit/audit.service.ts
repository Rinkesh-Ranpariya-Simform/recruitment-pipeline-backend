import type { Logger } from 'pino';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  ApplicationStatus,
  AuditAction,
  AuditEntityType,
  PipelineStage,
  UserRole,
} from '../../generated/prisma/enums.js';
import { prisma } from '../../lib/prisma.js';
import { AUDIT_SELECT } from './audit.select.js';
import type { ListAuditQuery } from './audit.schema.js';

/**
 * The whole audit module: the writer every other feature calls, and the one
 * read a recruiter makes.
 *
 * **This module exports exactly two functions** - `recordAudit` and
 * `listAuditEntries` (FR-6.2). There is no update, no delete, and no third
 * function. The absence is the immutability guarantee (FR-6.1, AZ-4).
 *
 * **It is a leaf** (BE-2). Pipeline, interviews, feedback and candidates all
 * import `recordAudit`; it imports nothing from any of them. The `AuditEntry`
 * union below is written in terms of the Prisma enums, never those modules'
 * types, so adding a feature can never create a cycle back into here.
 *
 * Both functions take `log: Logger` as their last argument, matching every
 * shipped service - neither reaches for the global logger (BE-6).
 */

/* -------------------------------------------------------------------------
 * The entry a caller writes
 * ---------------------------------------------------------------------- */

/**
 * What every audit row carries regardless of action (FR-1.2).
 *
 * `actorUserId` is always the caller's `req.user.id`, resolved by `requireAuth`
 * from a verified token (FR-2.1, AZ-5). No endpoint accepts an actor in a body,
 * a query parameter or a header, so there is no forged attribution to defend
 * against - there is simply no field that could carry one.
 *
 * `createdAt` is absent deliberately: it is the database's `now()`, never
 * supplied by a caller (FR-1.6).
 */
interface AuditEntryBase {
  actorUserId: number;
  entityId: number;
}

/** pipeline - a legal, in-order move along the stage graph. */
interface StageChangedEntry extends AuditEntryBase {
  action: typeof AuditAction.CANDIDATE_STAGE_CHANGED;
  entityType: typeof AuditEntityType.APPLICATION;
  metadata: { fromStage: PipelineStage; toStage: PipelineStage };
}

/**
 * pipeline - a recruiter's explicit override row.
 *
 * `reason` is REQUIRED by the type, which is how the brief's section 3.3 rule -
 * an override without a recorded reason and actor is rejected - is enforced at
 * compile time rather than by a runtime check that could be skipped (EC-04).
 * It is the one free-text field any `metadata` may hold: a recruiter's own
 * words about a process decision, not a fact about a person (FR-4.5).
 *
 * `skipped` is the NUMBER OF STAGES JUMPED, computed by the caller from the
 * canonical stage order (FR-4.6) - so "was a stage actually skipped, or did a
 * recruiter use the override path for a legal move?" is answerable without
 * re-deriving the stage graph at read time.
 */
interface StageOverrideCreatedEntry extends AuditEntryBase {
  action: typeof AuditAction.STAGE_OVERRIDE_CREATED;
  entityType: typeof AuditEntityType.APPLICATION;
  metadata: {
    fromStage: PipelineStage;
    toStage: PipelineStage;
    reason: string;
    overrideId: number;
    skipped: number;
  };
}

/**
 * pipeline - an application reaching a terminal outcome.
 *
 * `atStage` is where it stopped, and it matters: the outcome does not move
 * `currentStage` (pipeline FR-3.5), so "rejected at Screen" and "rejected at
 * Offer" stay distinguishable in the trace.
 *
 * `reason` is OPTIONAL and is the second free-text value this union permits,
 * added by pipeline FR-3.6 - which requires an outcome's reason to be recorded
 * in metadata when the recruiter supplied one. FR-4.5 of this feature's own
 * spec called an override's reason the only one, written before the pipeline
 * spec settled; the exemption is the same in substance, so it is widened here
 * rather than worked around. It is a recruiter's own words about a process
 * decision, NOT a fact about a person - the rule that actually matters (FR-4.4)
 * is that no email, phone, name or feedback `notes` ever appears in a metadata
 * object, and this does not touch it. Like an override's reason it is in pino's
 * `redact` list and reaches no log line.
 *
 * Unlike an override's, it is optional: rejecting at the defined terminal of a
 * stage is not an exception to the process, whereas skipping one is.
 */
interface ApplicationOutcomeSetEntry extends AuditEntryBase {
  action: typeof AuditAction.APPLICATION_OUTCOME_SET;
  entityType: typeof AuditEntityType.APPLICATION;
  metadata: {
    fromStatus: ApplicationStatus;
    toStatus: ApplicationStatus;
    atStage: PipelineStage;
    reason?: string;
  };
}

/**
 * interviews - a round being created.
 *
 * `type` is a `string` rather than an enum ONLY because the interviews feature
 * has not yet added one to the schema. When it does, narrow this field to that
 * Prisma enum - do not introduce an interviews-owned type here, which would
 * make `audit` stop being a leaf (BE-2).
 *
 * `scheduledAt` is an ISO 8601 string, not a `Date`: `metadata` is a JSON
 * column, and pinning the serialised form in the type stops two callers
 * disagreeing about it.
 */
interface InterviewCreatedEntry extends AuditEntryBase {
  action: typeof AuditAction.INTERVIEW_CREATED;
  entityType: typeof AuditEntityType.INTERVIEW;
  metadata: {
    applicationId: number;
    type: string;
    stage: PipelineStage;
    scheduledAt: string;
  };
}

/** interviews - an interviewer gaining access to a round. */
interface InterviewerAssignedEntry extends AuditEntryBase {
  action: typeof AuditAction.INTERVIEWER_ASSIGNED;
  entityType: typeof AuditEntityType.INTERVIEW;
  metadata: { interviewerId: number };
}

/** interviews - an interviewer losing it. */
interface InterviewerUnassignedEntry extends AuditEntryBase {
  action: typeof AuditAction.INTERVIEWER_UNASSIGNED;
  entityType: typeof AuditEntityType.INTERVIEW;
  metadata: { interviewerId: number };
}

/**
 * feedback - a submission.
 *
 * `rating` is recorded because it is a bounded integer a hiring manager needs.
 * **`notes` is not, and there is deliberately no field for it** (FR-4.4,
 * SEC-3): the audit feed is recruiter-readable, and the notes belong on the
 * feedback record where the authorization rules for reading them already live.
 */
interface FeedbackSubmittedEntry extends AuditEntryBase {
  action: typeof AuditAction.FEEDBACK_SUBMITTED;
  entityType: typeof AuditEntityType.FEEDBACK;
  metadata: { interviewId: number; rating: number };
}

/** feedback - a rating being revised. Again: the rating, never the notes. */
interface FeedbackUpdatedEntry extends AuditEntryBase {
  action: typeof AuditAction.FEEDBACK_UPDATED;
  entityType: typeof AuditEntityType.FEEDBACK;
  metadata: { interviewId: number; fromRating: number; toRating: number };
}

/**
 * candidates - a candidate's contact details being edited.
 *
 * `fields` holds the NAMES of the changed fields, never their values (FR-4.1,
 * FR-4.4). `["email","phone"]` is a fact about a process; the new email address
 * is the leak this whole design exists to prevent.
 */
interface CandidateContactUpdatedEntry extends AuditEntryBase {
  action: typeof AuditAction.CANDIDATE_CONTACT_UPDATED;
  entityType: typeof AuditEntityType.CANDIDATE;
  metadata: { fields: Array<string> };
}

/**
 * A discriminated union over `action` (FR-3.3).
 *
 * This is what makes the metadata contract in FR-4.1 a compile-time obligation:
 * a caller writing `STAGE_OVERRIDE_CREATED` without a `reason`, or pairing an
 * action with the wrong `entityType`, does not compile. There is no runtime
 * validation of `metadata` anywhere, and none is needed.
 */
export type AuditEntry =
  | StageChangedEntry
  | StageOverrideCreatedEntry
  | ApplicationOutcomeSetEntry
  | InterviewCreatedEntry
  | InterviewerAssignedEntry
  | InterviewerUnassignedEntry
  | FeedbackSubmittedEntry
  | FeedbackUpdatedEntry
  | CandidateContactUpdatedEntry;

/* -------------------------------------------------------------------------
 * The writer
 * ---------------------------------------------------------------------- */

/**
 * The transaction client, and ONLY the transaction client (FR-3.1, EC-03).
 *
 * `Prisma.TransactionClient` alone does not carry this guarantee, though the
 * spec assumes it does. It is `Omit<PrismaClient, ITXClientDenyList>`, and a
 * full `PrismaClient` has every member that omission leaves behind plus more -
 * so it satisfies the type structurally and `recordAudit(prisma, ...)` compiles
 * cleanly. Checked, not assumed: with the bare annotation the global client was
 * accepted without complaint, which would leave the central invariant of this
 * feature a convention rather than a rule.
 *
 * `$connect?: never` closes it. In Prisma 7 the deny list is exactly
 * `["$connect", "$disconnect", "$on", "$use", "$extends"]` - note that
 * `$transaction` is NOT among them, which is why discriminating on that one
 * collapses the intersection to `never`. An interactive transaction client has
 * no `$connect`, so a real `tx` still satisfies this; `PrismaClient` declares
 * `$connect` as a function, which is not assignable to `undefined`, so passing
 * the global client is now the type error EC-03 says it is.
 */
type TransactionClient = Prisma.TransactionClient & { $connect?: never };

/**
 * Writes one audit row (FR-3).
 *
 * **`tx` is the transaction client, not the global `prisma`** (FR-3.1, D-3).
 * Every caller invokes this INSIDE the `prisma.$transaction` that performs the
 * state change it is recording, so the trace and the change commit together or
 * not at all. Passing the global client is a type error rather than a
 * silently-unatomic write - see `TransactionClient` above for why the bare
 * `Prisma.TransactionClient` is not enough to make that true (EC-03).
 *
 * **It does not catch its own errors** (FR-3.4, D-4). A failed insert
 * propagates, the enclosing transaction aborts, and the state change rolls back
 * with it. That is the whole point: an action that could not be recorded did
 * not happen (EC-01, EC-02).
 *
 * **It performs no authorization** (AZ-6). Its caller has already authorized
 * the state change; a second check here would be a second place for the rule to
 * rot, and is why this function is exported to services and never to a route.
 *
 * **One INSERT, no reads** (PERF-5). The actor id is already in `req.user` and
 * is passed down - this never looks the actor up, counts anything, or turns a
 * one-statement endpoint into a three-statement one.
 */
export async function recordAudit(
  tx: TransactionClient,
  entry: AuditEntry,
  log: Logger,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      // The one cast in this module. Each variant's `metadata` is a closed
      // interface, and TypeScript grants an implicit index signature only to
      // type aliases - so an interface never structurally satisfies Prisma's
      // `InputJsonObject` however correct its contents are. The union above is
      // what guarantees the shape; this only restates it to Prisma.
      metadata: entry.metadata as Prisma.InputJsonObject,
      // `createdAt` is omitted on purpose - the column's `@default(now())` is
      // the database's clock, never this process's (FR-1.6).
    },
    select: { id: true },
  });

  // Ids and enum values only, matching the shipped logging convention. It NEVER
  // logs `metadata` - that is where an override's reason lives, and pino is not
  // the business record (FR-3.5, FR-8.2).
  log.info(
    {
      event: 'audit.recorded',
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      actorUserId: entry.actorUserId,
    },
    'audit recorded',
  );
}

/* -------------------------------------------------------------------------
 * The read
 * ---------------------------------------------------------------------- */

/** One entry as `GET /api/audit` returns it. No `actorUserId` (invariant 5). */
export interface AuditEntryView {
  id: number;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: number;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  actor: { id: number; name: string; role: UserRole };
}

/** Byte-identical in shape to the roles pager, so the client reuses it (XFE-2). */
export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * The four optional filters, ANDed (FR-5.2).
 *
 * They sit on four distinct columns, so assigning each key is already a
 * conjunction - one filter can never overwrite another. `entityId` is only ever
 * reachable alongside `entityType`; the schema rejects it alone (VAL-3).
 *
 * Built key by key rather than by spread: with `exactOptionalPropertyTypes` on,
 * an explicit `undefined` is not the same as an absent key.
 */
function buildAuditWhere(query: ListAuditQuery): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};

  if (query.entityType !== undefined) {
    where.entityType = query.entityType;
  }
  if (query.entityId !== undefined) {
    where.entityId = query.entityId;
  }
  if (query.action !== undefined) {
    where.action = query.action;
  }
  if (query.actorId !== undefined) {
    where.actorUserId = query.actorId;
  }

  return where;
}

/**
 * A page of the trace, newest first (FR-5).
 *
 * **No per-row scoping, deliberately** (AZ-3). The recruiter-only route guard
 * is the WHOLE authorization for this read - there is no role permitted to see
 * a subset, so there is no row filter here to fall back on. Anyone widening the
 * guard leaks the entire trace; this comment is the warning that nothing below
 * would stop them.
 *
 * The page and its `count` run in ONE transaction sharing ONE `where` (FR-5.6),
 * so `total` can never describe a different filter than the rows beside it.
 * Two queries per request, and the actor is joined by Prisma's relation select
 * rather than looked up per entry (PERF-4).
 *
 * An empty result is a 200 with `entries: []`, never a 404 - this endpoint
 * cannot tell whether the entity exists and must not imply that it doesn't
 * (ERR-3, EC-08, EC-09).
 */
export async function listAuditEntries(
  query: ListAuditQuery,
  actorId: number,
  log: Logger,
): Promise<{ entries: Array<AuditEntryView>; pagination: Pagination }> {
  const where = buildAuditWhere(query);

  const [entries, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      // `id desc` is the stable tiebreak, matching `roles.service` and
      // `applications.service`: two rows sharing a `createdAt` - which is
      // ordinary here, since several can be written in one transaction - must
      // still have one order across pages (FR-5.1, EC-05).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: AUDIT_SELECT,
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Ids and counts only. No filter values are logged: `actorId` here is the
  // READER, and an entry's metadata never reaches a log line (FR-8.1, FR-8.2).
  log.info({ event: 'audit.listed', actorId, resultCount: entries.length }, 'audit listed');

  return {
    entries,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      // 0 for an empty result, not 1 - `Math.ceil(0 / 20)`, matching
      // `roles.service` (EC-09).
      totalPages: Math.ceil(total / query.pageSize),
    },
  };
}
