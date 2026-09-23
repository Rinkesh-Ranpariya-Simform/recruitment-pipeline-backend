/**
 * The error contract (BE-6, ERR-1..ERR-5).
 *
 * Throwing an `AppError` is the only way a handler or service signals a
 * client-visible failure. Anything else that escapes is an unexpected error and
 * becomes a generic 500 in the error middleware — the client never learns more.
 *
 * `code` is the stable machine-readable contract; `message` is user-safe copy
 * the client may render verbatim and may change without being a breaking change.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'EMAIL_TAKEN'
  | 'ROLE_NOT_CLOSED'
  | 'ROLE_HAS_APPLICATIONS'
  | 'ALREADY_APPLIED'
  | 'NOT_AN_INTERVIEWER'
  | 'ALREADY_ASSIGNED'
  | 'INVALID_STAGE_TRANSITION'
  | 'APPLICATION_NOT_ACTIVE'
  | 'STAGE_CONFLICT'
  | 'FEEDBACK_ALREADY_SUBMITTED'
  | 'INTERVIEW_CANCELLED'
  | 'DECISION_ALREADY_RECORDED'
  | 'INTERNAL_ERROR';

/** Field-keyed validation messages, keyed by request-body field name (VAL-5). */
export type ErrorDetails = Record<string, Array<string>>;

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(status: number, code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 400 — zod rejected the payload. The only error carrying `details`. */
export class ValidationError extends AppError {
  constructor(details: ErrorDetails) {
    super(400, 'VALIDATION_ERROR', 'Invalid request body', details);
    this.name = 'ValidationError';
  }
}

/**
 * 401 — login failed. Deliberately identical for an unknown email and a wrong
 * password so the response cannot be used to enumerate accounts (SEC-2, AC-B08).
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * 401 — "we don't know who you are". Recoverable via /api/auth/refresh (AZ-2).
 * Carries no reason: the client never learns whether a token was malformed,
 * expired, revoked, or belonged to a deleted user (AC-B14).
 */
export class UnauthenticatedError extends AppError {
  constructor() {
    super(401, 'UNAUTHENTICATED', 'Authentication required');
    this.name = 'UnauthenticatedError';
  }
}

/** 403 — "we know who you are, and you may not". Terminal, never a 401 (AZ-2). */
export class ForbiddenError extends AppError {
  constructor() {
    super(403, 'FORBIDDEN', 'You do not have access to this resource');
    this.name = 'ForbiddenError';
  }
}

/** 404 — unknown route, including endpoints that deliberately do not exist (EC-09). */
export class NotFoundError extends AppError {
  constructor() {
    super(404, 'NOT_FOUND', 'Resource not found');
    this.name = 'NotFoundError';
  }
}

/** 409 — derived from the database unique constraint, never a read-then-write check (ERR-4). */
export class EmailTakenError extends AppError {
  constructor() {
    super(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    this.name = 'EmailTakenError';
  }
}

/**
 * 409 — `POST /api/applications` for a requisition this candidate has already
 * applied to.
 *
 * Derived from the `Application_candidateUserId_roleId_key` unique violation the
 * insert itself raises, NOT from a preceding `findFirst` — a check-then-insert
 * loses to a second concurrent apply and would let both commit. Same discipline
 * as `EmailTakenError` and `RoleHasApplicationsError` (ERR-4, EC-06).
 *
 * The message names no application id and no date: the candidate's own list is
 * where those live. Applying to a DIFFERENT role is unaffected — the constraint
 * is on the pair.
 */
export class AlreadyAppliedError extends AppError {
  constructor() {
    super(409, 'ALREADY_APPLIED', 'You have already applied to this position');
    this.name = 'AlreadyAppliedError';
  }
}

/**
 * 409 — `DELETE /api/roles/:roleId` on a role that is still `OPEN` (FR-6.6).
 *
 * Deleting a requisition is deliberately a TWO-STEP act: close it, then delete
 * it. This is what remains of the original no-delete rule — an open req is in
 * circulation, and the one thing a destructive endpoint must not do is make it
 * a single misclick away from gone. The message names the remedy, because
 * "conflict" on its own tells a recruiter nothing.
 */
export class RoleNotClosedError extends AppError {
  constructor() {
    super(409, 'ROLE_NOT_CLOSED', 'Close the role before deleting it');
    this.name = 'RoleNotClosedError';
  }
}

/**
 * 409 — `DELETE /api/roles/:roleId` on a `CLOSED` role that candidates have
 * applied to (candidate spec FR-8.2).
 *
 * Derived from the `P2003` foreign-key violation the delete itself raises, NOT
 * from a preceding `count()` — a check-then-delete loses to a concurrent apply
 * and would either 500 or delete a requisition someone just applied to
 * (FR-8.4, EC-07).
 *
 * Checked AFTER `RoleNotClosedError` (FR-8.3), so a recruiter is always told the
 * first thing they need to do. The message names neither the count nor the
 * candidates — that is not the client's business (ERR-7).
 */
export class RoleHasApplicationsError extends AppError {
  constructor() {
    super(409, 'ROLE_HAS_APPLICATIONS', 'This role has applications and cannot be deleted');
    this.name = 'RoleHasApplicationsError';
  }
}

/**
 * 409 — a well-formed stage or outcome the rules refuse (pipeline FR-2.4,
 * FR-2.5, FR-3.3).
 *
 * The request is valid: `toStage` is a real `PipelineStage`, the application
 * exists and is live. What is refused is the MOVE — `APPLIED → OFFER`, a
 * reversal, a no-op onto the current stage, or `HIRED` from anywhere but
 * `OFFER`.
 *
 * It carries `details.allowed`: the stages (or statuses) actually reachable
 * from where the application sits. The client renders the legal moves from that
 * array rather than owning a second copy of the stage graph — two copies
 * disagree the first time the graph changes (ERR-1, XFE-2).
 *
 * The only error besides `ValidationError` that carries `details`, and the only
 * one whose `message` names the states involved: "not allowed" on its own tells
 * a recruiter nothing about what is.
 */
export class InvalidStageTransitionError extends AppError {
  constructor(message: string, details: ErrorDetails) {
    super(409, 'INVALID_STAGE_TRANSITION', message, details);
    this.name = 'InvalidStageTransitionError';
  }
}

/**
 * 409 — a write against an application that is `HIRED` or `REJECTED`
 * (pipeline D-11, FR-2.6, FR-4.6, ERR-3).
 *
 * Terminal is terminal: there is no un-rejecting and no reopening in this POC,
 * so every one of the three writes refuses. It is a 409 and not a 400 because
 * the request is well-formed — it is the resource that is in a state which
 * refuses it, which is the definition of a conflict.
 *
 * Distinct from `InvalidStageTransitionError` on purpose: that one means "not
 * from here", this one means "not any more", and a client that cannot tell them
 * apart cannot decide whether to hide its move controls.
 */
export class ApplicationNotActiveError extends AppError {
  constructor() {
    super(409, 'APPLICATION_NOT_ACTIVE', 'This application is closed and cannot be changed');
    this.name = 'ApplicationNotActiveError';
  }
}

/**
 * 409 — another request moved this application first (pipeline FR-6.2, D-10).
 *
 * Derived from a guarded `updateMany` matching **zero** rows — the stage the
 * caller observed is part of the `where`, so a row someone else moved in the
 * meantime no longer matches. Never from a read-then-compare, which loses to
 * the second request exactly as it would here.
 *
 * A SEPARATE code from `INVALID_STAGE_TRANSITION` (FR-6.4, ERR-2). The remedies
 * differ — refetch and decide again, versus "this move is not allowed" — and
 * collapsing them makes the client's message wrong half the time.
 *
 * It names no actor (SEC-6). "Someone else moved this" is all the loser is
 * told; who is working on which candidate is an access decision nobody made.
 */
export class StageConflictError extends AppError {
  constructor() {
    super(
      409,
      'STAGE_CONFLICT',
      'Someone else changed this application first — refresh and try again',
    );
    this.name = 'StageConflictError';
  }
}

/**
 * 400 — `POST /api/interviews/:id/assignments` naming a user who does not
 * exist, or who exists but is not an `INTERVIEWER` (interviews FR-3.3, VAL-6).
 *
 * Produced by a `findFirst({ where: { id, role: INTERVIEWER } })` that matched
 * no row — **the role requirement is in the `where`**, not in an `if` after
 * fetching the user, so the service never holds a user row it had no right to
 * read (EC-03).
 *
 * A **400 and not a 404**, even though a lookup missed: the recruiter supplied
 * a value their own picker should have constrained, and that is a bad request
 * rather than a missing resource. The two cases answer identically, so the
 * endpoint does not reveal whether the id exists as some other role (EC-04).
 */
export class NotAnInterviewerError extends AppError {
  constructor() {
    super(400, 'NOT_AN_INTERVIEWER', 'That user is not an interviewer');
    this.name = 'NotAnInterviewerError';
  }
}

/**
 * 409 — that interviewer is already on that round (interviews FR-3.4, D-5).
 *
 * Derived from the `InterviewAssignment_interviewId_interviewerId_key` unique
 * violation the insert itself raises, NOT from a preceding `findFirst` — a
 * check-then-insert loses to a second concurrent click and would let both
 * commit. Same discipline as `AlreadyAppliedError` and `EmailTakenError`
 * (ERR-3, EC-01).
 *
 * The remedy is "this person is already on the panel". A client should also
 * disable already-assigned interviewers in its picker, but that is UX and this
 * is the control (XFE-5).
 */
export class AlreadyAssignedError extends AppError {
  constructor() {
    super(409, 'ALREADY_ASSIGNED', 'That interviewer is already assigned to this round');
    this.name = 'AlreadyAssignedError';
  }
}

/**
 * 409 — this interviewer has already filed feedback on this round (feedback
 * FR-3.3, D-1).
 *
 * Derived from the `Feedback_interviewId_interviewerId_key` unique violation the
 * insert itself raises, NOT from a preceding `findFirst` — **and that is the
 * whole of the brief's §3.4 answer.** A check-then-insert loses to two
 * overlapping submissions from one person: both read "nothing here yet" and
 * both commit, or one silently overwrites the other. Postgres cannot be raced
 * this way. Same discipline as `AlreadyAssignedError` and `AlreadyAppliedError`
 * (ERR-4, EC-02).
 *
 * **The message names the remedy** — the remedy is a different verb on the same
 * path, and a client that does not know that shows a dead end where an edit form
 * belongs (ERR-3, XFE-3).
 *
 * Two DIFFERENT interviewers submitting at the same instant never reach this:
 * their unique-key tuples differ, so there is nothing to contend on and both
 * succeed. That is the panel case, and it is a non-event by design (FR-3.2).
 */
export class FeedbackAlreadySubmittedError extends AppError {
  constructor() {
    super(
      409,
      'FEEDBACK_ALREADY_SUBMITTED',
      'You have already submitted feedback for this round. Edit it instead.',
    );
    this.name = 'FeedbackAlreadySubmittedError';
  }
}

/**
 * 409 — feedback submitted against a `CANCELLED` round (feedback FR-2.7, D-12).
 *
 * A cancelled round did not happen, so there is nothing to assess. The status is
 * read by the SAME scoped `findFirst` that authorizes the submission, so this
 * costs no extra query (PERF-1).
 *
 * A 409 and not a 400 because the request is well-formed — it is the resource
 * that is in a state which refuses it, matching `ApplicationNotActiveError`
 * (ERR-5).
 *
 * It governs NEW submissions only. Cancelling a round does not unmake feedback
 * already written for it, and that feedback stays readable (EC-19).
 */
export class InterviewCancelledError extends AppError {
  constructor() {
    super(409, 'INTERVIEW_CANCELLED', 'This interview was cancelled and cannot receive feedback');
    this.name = 'InterviewCancelledError';
  }
}

/**
 * 409 — a second verdict on a round that already has one (applications FR-3.6).
 *
 * A decision is **not** an editable field. It moved the candidate's stage or
 * closed their application in the same transaction, and letting it be
 * overwritten would leave a timeline claiming something the `StageHistory` and
 * audit rows behind it contradict. Undoing one is an override, with a reason —
 * which is the path the brief's §3.3 already provides.
 *
 * Raised from the `outcome: null` guard on the update itself, not from a
 * preceding read (`recordDecision`): two recruiters clicking Select at the same
 * instant both reach the statement, one matches zero rows, and that one is told
 * this rather than silently winning.
 */
export class DecisionAlreadyRecordedError extends AppError {
  constructor() {
    super(
      409,
      'DECISION_ALREADY_RECORDED',
      'A decision has already been recorded for this interview',
    );
    this.name = 'DecisionAlreadyRecordedError';
  }
}
