import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { env } from '../../config/env.js';
import { Prisma } from '../../generated/prisma/client.js';
import { UserRole } from '../../generated/prisma/enums.js';
import {
  EmailTakenError,
  InvalidCredentialsError,
  UnauthenticatedError,
} from '../../lib/errors.js';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../../lib/password.js';
import { prisma } from '../../lib/prisma.js';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from '../../lib/tokens.js';
import { SAFE_USER_SELECT } from '../users/user.select.js';
import type { LoginInput, SignupInput } from './auth.schema.js';

/**
 * All password, token and rotation logic lives here. Controllers perform none
 * of it — they shape HTTP and delegate (BE-1).
 */

export interface SafeUser {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  createdAt: Date;
}

export interface Session {
  user: SafeUser;
  accessToken: string;
  expiresIn: number;
  /** Raw refresh token. Goes into `Set-Cookie` and nowhere else (FR-5.4). */
  rawRefreshToken: string;
}

function refreshTokenExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Starts a brand-new rotation family. Called on every login, so a second login
 * never disturbs a session already running on another device (FR-4.5, AC-B11).
 */
async function issueSession(user: SafeUser): Promise<Session> {
  const rawRefreshToken = generateRefreshToken();

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashRefreshToken(rawRefreshToken),
      familyId: crypto.randomUUID(),
      expiresAt: refreshTokenExpiry(),
    },
    select: { id: true },
  });

  const { token, expiresIn } = signAccessToken({ sub: user.id, role: user.role });

  return { user, accessToken: token, expiresIn, rawRefreshToken };
}

/**
 * The only code path in the entire API that writes a `User` row (contract
 * invariant 5, AC-B00). Creates only — it issues no token and sets no cookie
 * (FR-2.2, AC-B01).
 *
 * **It can only ever create a `CANDIDATE`** (candidate spec FR-2.4). `role` is a
 * literal below, not `input.role`, and `signupSchema` has no such field to read
 * — so there is no input to validate and no escalation path (SEC-11.1). No HTTP
 * path creates an `INTERVIEWER` or `RECRUITER`; both come from `npm run db:seed`
 * (FR-3.1, FR-3.2, FR-3.4).
 */
export async function signup(input: SignupInput, log: Logger): Promise<SafeUser> {
  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        role: UserRole.CANDIDATE,
      },
      select: SAFE_USER_SELECT,
    });

    // No actor field: no authenticated user can create another (FR-2.6, SEC-10).
    log.info(
      { event: 'user.created', createdUserId: user.id, role: user.role, source: 'signup' },
      'user created',
    );

    return user;
  } catch (error) {
    // Derived from the database constraint, not a preceding findUnique — a
    // check-then-insert loses under a race and can produce a 500 or two rows
    // (ERR-4, EC-06).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new EmailTakenError();
    }
    throw error;
  }
}

/**
 * Deletes this user's refresh tokens that are already past `expiresAt`.
 *
 * Nothing else ever removed a row. Every rotation writes a successor and
 * revokes its predecessor, so one active session accumulates roughly a row per
 * access-token lifetime — around 96 a day at the 15-minute TTL — and the table
 * grew without bound for the life of the deployment.
 *
 * **Only expired rows go, and that limit is load-bearing.** A revoked but
 * still-unexpired row is precisely what a replayed token is matched against:
 * delete it and `refresh` reads the replay as `unknown` instead of `reused`,
 * answers the same 401, and silently leaves the rest of the stolen family
 * usable — the tripwire in FR-5.6 would fire on nothing.
 *
 * What is knowingly given up is narrower: once a stolen token is itself past
 * `expiresAt`, replaying it no longer revokes its family, because the row it
 * would have matched is gone. Accepted, and the standard line — such a token is
 * refused on its own expiry and confers no access either way, so all that is
 * lost is the *detection* of a replay that could not have succeeded. Retention
 * for the whole window in which a token can still be redeemed is intact.
 *
 * Runs at login: a new family is starting, the request is already paying ~200ms
 * of bcrypt, and it is one indexed delete on `@@index([userId])`. Deliberately
 * NOT in `refresh`, which answers to a 50ms budget (PERF-2).
 */
async function pruneExpiredRefreshTokens(userId: number, log: Logger): Promise<void> {
  try {
    const { count } = await prisma.refreshToken.deleteMany({
      where: { userId, expiresAt: { lte: new Date() } },
    });

    if (count > 0) {
      log.info({ event: 'auth.tokens.pruned', userId, count }, 'expired refresh tokens pruned');
    }
  } catch (error) {
    // Housekeeping must never cost a user their login. The rows it failed to
    // remove are expired and therefore already unusable; the next login retries.
    log.warn(
      { event: 'auth.tokens.prune_failed', userId, err: error },
      'expired refresh token prune failed',
    );
  }
}

/**
 * Unknown email and wrong password are indistinguishable to the caller: the
 * same error object, and the same bcrypt cost on both paths (SEC-2, SEC-3,
 * AC-B07, AC-B08).
 */
export async function login(input: LoginInput, log: Logger): Promise<Session> {
  const record = await prisma.user.findUnique({
    where: { email: input.email },
    select: { ...SAFE_USER_SELECT, passwordHash: true },
  });

  if (record === null) {
    // Burn the same ~200ms bcrypt cost so response timing does not reveal that
    // no such account exists (BE-3.3).
    await verifyDummyPassword(input.password);
    log.warn(
      { event: 'auth.login.failure', email: input.email, reason: 'invalid_credentials' },
      'login failed',
    );
    throw new InvalidCredentialsError();
  }

  const { passwordHash, ...user } = record;

  if (!(await verifyPassword(input.password, passwordHash))) {
    log.warn(
      { event: 'auth.login.failure', email: input.email, reason: 'invalid_credentials' },
      'login failed',
    );
    throw new InvalidCredentialsError();
  }

  const session = await issueSession(user);

  // After the new family exists, so a prune that somehow removed too much still
  // cannot cost this login its own token.
  await pruneExpiredRefreshTokens(user.id, log);

  log.info({ event: 'auth.login.success', userId: user.id, role: user.role }, 'login succeeded');

  return session;
}

/**
 * What the rotation transaction decided. The transaction DECIDES and rotates;
 * it never throws for an expected outcome.
 *
 * That split is not stylistic. A throw inside `prisma.$transaction` rolls the
 * transaction back, so raising the 401 from inside it would also undo the
 * family revocation that the 401 is supposed to accompany — the tripwire would
 * log that it fired and then quietly leave every stolen token usable (AC-B18).
 * Failure outcomes are therefore returned, acted on after the commit, and only
 * then converted into an error.
 */
type RotationOutcome =
  | {
      kind: 'rotated';
      accessToken: string;
      expiresIn: number;
      rawRefreshToken: string;
      userId: number;
      familyId: string;
    }
  | { kind: 'unknown' }
  | { kind: 'expired' }
  | { kind: 'reused'; userId: number; familyId: string };

/**
 * Rotation with reuse detection (BE-5, FR-5.5, FR-5.6).
 *
 * The presented token is claimed with a CONDITIONAL update (`revokedAt: null`
 * in the WHERE) rather than a read followed by a write. That is what makes
 * AC-B21 hold: under two genuinely concurrent requests carrying the same token,
 * Postgres serialises the two UPDATEs and re-evaluates the predicate after the
 * first commits, so the second matches zero rows. A read-then-write inside a
 * transaction would let both proceed under READ COMMITTED.
 *
 * The loser of that race then finds the row revoked and trips reuse detection,
 * killing the family. That is the specified behaviour, not a bug: correctness
 * (a stolen token is always detected) is chosen over convenience (EC-04).
 */
export async function refresh(
  rawToken: string,
  log: Logger,
): Promise<{ accessToken: string; expiresIn: number; rawRefreshToken: string }> {
  const tokenHash = hashRefreshToken(rawToken);

  const outcome: RotationOutcome = await prisma.$transaction(async (tx) => {
    const now = new Date();

    const claimed = await tx.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });

    if (claimed.count === 0) {
      // We did not get the token. Find out why — the answer to the client is
      // 401 either way, but a replayed token must take the whole family with it.
      const existing = await tx.refreshToken.findUnique({
        where: { tokenHash },
        select: { userId: true, familyId: true, revokedAt: true },
      });

      if (existing === null) {
        return { kind: 'unknown' };
      }

      if (existing.revokedAt !== null) {
        return { kind: 'reused', userId: existing.userId, familyId: existing.familyId };
      }

      return { kind: 'expired' };
    }

    // We claimed it. Mint the successor into the same family.
    const presented = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: { userId: true, familyId: true, user: { select: { id: true, role: true } } },
    });

    if (presented === null) {
      return { kind: 'unknown' };
    }

    const rawRefreshToken = generateRefreshToken();

    await tx.refreshToken.create({
      data: {
        userId: presented.userId,
        tokenHash: hashRefreshToken(rawRefreshToken),
        familyId: presented.familyId,
        expiresAt: refreshTokenExpiry(),
      },
      select: { id: true },
    });

    const { token, expiresIn } = signAccessToken({
      sub: presented.user.id,
      role: presented.user.role,
    });

    return {
      kind: 'rotated',
      accessToken: token,
      expiresIn,
      rawRefreshToken,
      userId: presented.userId,
      familyId: presented.familyId,
    };
  });

  if (outcome.kind === 'reused') {
    // The stolen-token tripwire (FR-5.6, EC-03, AC-B18). Committed in its own
    // statement, AFTER the deciding transaction, so revoking the lineage
    // survives the 401 we are about to raise. The legitimate session dies too —
    // that is the point: theft becomes visible rather than silent.
    await prisma.refreshToken.updateMany({
      where: { familyId: outcome.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    log.error(
      {
        event: 'auth.refresh.reuse_detected',
        userId: outcome.userId,
        familyId: outcome.familyId,
        action: 'family_revoked',
      },
      'refresh token reuse detected — family revoked',
    );

    throw new UnauthenticatedError();
  }

  if (outcome.kind !== 'rotated') {
    // Unknown or expired: the same bare 401 as every other refresh failure
    // (EC-02, AC-B20).
    throw new UnauthenticatedError();
  }

  log.info(
    { event: 'auth.refresh.rotated', userId: outcome.userId, familyId: outcome.familyId },
    'refresh token rotated',
  );

  return {
    accessToken: outcome.accessToken,
    expiresIn: outcome.expiresIn,
    rawRefreshToken: outcome.rawRefreshToken,
  };
}

/**
 * Revokes the presented token's entire family (FR-5.7).
 *
 * Never throws for a missing, unknown or already-revoked token — logout is
 * idempotent and the controller answers 204 regardless (EC-05, AC-B24). Unlike
 * `refresh`, presenting a revoked token here is not treated as reuse: a client
 * logging out twice is not a theft signal.
 */
export async function logout(rawToken: string | undefined, log: Logger): Promise<void> {
  if (rawToken === undefined || rawToken === '') {
    return;
  }

  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    select: { userId: true, familyId: true },
  });

  if (record === null) {
    return;
  }

  await prisma.refreshToken.updateMany({
    where: { familyId: record.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  log.info(
    { event: 'auth.logout', userId: record.userId, familyId: record.familyId },
    'session logged out',
  );
}

/** Reads the authenticated user's own record, explicit-select only (PERF-3). */
export async function getById(id: number): Promise<SafeUser | null> {
  return prisma.user.findUnique({ where: { id }, select: SAFE_USER_SELECT });
}
