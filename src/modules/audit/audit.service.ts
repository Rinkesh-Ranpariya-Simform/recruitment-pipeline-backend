import type { Logger } from 'pino';
import type { Prisma } from '../../../generated/prisma/client.js';
import type {
  ApplicationStatus,
  AuditAction,
  AuditEntityType,
  PipelineStage,
  UserRole,
} from '../../../generated/prisma/enums.js';
import { prisma } from '../../lib/prisma.js';
import { AUDIT_SELECT } from './audit.select.js';
import type { ListAuditQuery } from './audit.schema.js';

/**
 * Audit service providing audit log recording and querying.
 *
 * Core capabilities:
 * - recordAudit: Appends an audit row within an existing Prisma transaction.
 * - listAuditEntries: Queries paginated audit logs for recruiters.
 * Audit logs are immutable and cannot be modified or deleted.
 */

/* -------------------------------------------------------------------------
 * Audit entry types and definitions
 * ---------------------------------------------------------------------- */

/**
 * Base audit entry attributes required for all audit records.
 */
interface AuditEntryBase {
  actorUserId: number;
  entityId: number;
}

/** Stage progression along the pipeline stage graph. */
interface StageChangedEntry extends AuditEntryBase {
  action: typeof AuditAction.CANDIDATE_STAGE_CHANGED;
  entityType: typeof AuditEntityType.APPLICATION;
  metadata: { fromStage: PipelineStage; toStage: PipelineStage };
}

/** Recruiter explicit stage override with required reason and skipped count. */
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

/** Application outcome change (e.g., accepted, rejected, withdrawn) with optional reason. */
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

/** Interview round creation. */
interface InterviewCreatedEntry extends AuditEntryBase {
  action: typeof AuditAction.INTERVIEW_CREATED;
  entityType: typeof AuditEntityType.INTERVIEW;
  metadata: {
    applicationId: number;
    type: string;
    stage: PipelineStage;
    scheduledAt?: string;
  };
}

/** Interview round decision recorded by a recruiter. */
interface InterviewDecisionRecordedEntry extends AuditEntryBase {
  action: typeof AuditAction.INTERVIEW_DECISION_RECORDED;
  entityType: typeof AuditEntityType.INTERVIEW;
  metadata: {
    applicationId: number;
    outcome: string;
    stage: PipelineStage;
    toStage?: PipelineStage;
    toStatus?: string;
  };
}

/** Interviewer assigned to an interview round. */
interface InterviewerAssignedEntry extends AuditEntryBase {
  action: typeof AuditAction.INTERVIEWER_ASSIGNED;
  entityType: typeof AuditEntityType.INTERVIEW;
  metadata: { interviewerId: number };
}

/** Interviewer unassigned from an interview round. */
interface InterviewerUnassignedEntry extends AuditEntryBase {
  action: typeof AuditAction.INTERVIEWER_UNASSIGNED;
  entityType: typeof AuditEntityType.INTERVIEW;
  metadata: { interviewerId: number };
}

/** Feedback submitted for an interview round. */
interface FeedbackSubmittedEntry extends AuditEntryBase {
  action: typeof AuditAction.FEEDBACK_SUBMITTED;
  entityType: typeof AuditEntityType.FEEDBACK;
  metadata: { interviewId: number; rating: number };
}

/** Feedback rating updated for an interview round. */
interface FeedbackUpdatedEntry extends AuditEntryBase {
  action: typeof AuditAction.FEEDBACK_UPDATED;
  entityType: typeof AuditEntityType.FEEDBACK;
  metadata: { interviewId: number; fromRating: number; toRating: number };
}

/** Candidate contact details updated. Tracks field names changed without logging values. */
interface CandidateContactUpdatedEntry extends AuditEntryBase {
  action: typeof AuditAction.CANDIDATE_CONTACT_UPDATED;
  entityType: typeof AuditEntityType.CANDIDATE;
  metadata: { fields: Array<string> };
}

/**
 * Discriminated union of all supported audit entry payloads.
 */
export type AuditEntry =
  | StageChangedEntry
  | StageOverrideCreatedEntry
  | ApplicationOutcomeSetEntry
  | InterviewCreatedEntry
  | InterviewDecisionRecordedEntry
  | InterviewerAssignedEntry
  | InterviewerUnassignedEntry
  | FeedbackSubmittedEntry
  | FeedbackUpdatedEntry
  | CandidateContactUpdatedEntry;

/* -------------------------------------------------------------------------
 * Audit writer
 * ---------------------------------------------------------------------- */

/**
 * Enforces that only an active interactive transaction client is accepted.
 */
type TransactionClient = Prisma.TransactionClient & { $connect?: never };

/**
 * Records an audit log entry within the caller's active database transaction.
 *
 * Ensures atomicity: if the audit insertion fails, the entire transaction rolls back.
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
      metadata: entry.metadata as Prisma.InputJsonObject,
    },
    select: { id: true },
  });

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
 * Audit reader
 * ---------------------------------------------------------------------- */

/** Audit entry representation returned by list endpoint. */
export interface AuditEntryView {
  id: number;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: number;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  actor: { id: number; name: string; role: UserRole };
}

/** Standard pagination metadata. */
export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Builds Prisma where filter based on provided query parameters.
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
 * Lists paginated audit log entries matching filters, sorted by creation date descending.
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: AUDIT_SELECT,
    }),
    prisma.auditLog.count({ where }),
  ]);

  log.info({ event: 'audit.listed', actorId, resultCount: entries.length }, 'audit listed');

  return {
    entries,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    },
  };
}
