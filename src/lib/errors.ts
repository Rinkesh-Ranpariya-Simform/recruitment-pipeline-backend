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
  | 'INTERNAL_ERROR';

/** Field-keyed validation messages, keyed by request-body field name (VAL-5). */
export type ErrorDetails = Record<string, string[]>;

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
 * 409 — `DELETE /api/roles/:roleId` on a role that is still `OPEN` (FR-6.6).
 *
 * Deleting a requisition is deliberately a TWO-STEP act: close it, then delete
 * it. This is what remains of the original no-delete rule — an open req is in
 * circulation, and the one thing a destructive endpoint must not do is make it
 * a single misclick away from gone.
 *
 * The message names the remedy, because it is rendered verbatim by the client
 * and "conflict" on its own tells a recruiter nothing.
 */
export class RoleNotClosedError extends AppError {
  constructor() {
    super(409, 'ROLE_NOT_CLOSED', 'Close the role before deleting it');
    this.name = 'RoleNotClosedError';
  }
}
