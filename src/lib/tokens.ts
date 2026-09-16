import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { JwtPayload, SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { UserRole } from '../generated/prisma/enums.js';

/**
 * The only module that imports `jsonwebtoken` and `node:crypto` (BE-4).
 *
 * A raw refresh token exists exactly twice: as the return value of
 * `generateRefreshToken()` and in the `Set-Cookie` header. It is never
 * persisted, never logged, and never serialised into a response body — the
 * database stores only `hashRefreshToken()` of it (FR-5.4).
 */
export interface AccessTokenClaims {
  sub: number;
  role: UserRole;
}

/** Access token: short-lived, stateless, carries nothing sensitive (BE-4.1, AC-B10). */
export function signAccessToken(claims: AccessTokenClaims): {
  token: string;
  expiresIn: number;
} {
  // ACCESS_TOKEN_TTL is validated as a non-empty string at boot; `jsonwebtoken`
  // types it as a template-literal duration, which no env var can satisfy statically.
  const options: SignOptions = {
    expiresIn: env.ACCESS_TOKEN_TTL as NonNullable<SignOptions['expiresIn']>,
  };

  const token = jwt.sign({ sub: String(claims.sub), role: claims.role }, env.JWT_SECRET, options);

  // `expiresIn` is read back off the token we just signed rather than restated
  // as a constant, so the number the client is told and the number the token
  // actually carries cannot drift if ACCESS_TOKEN_TTL changes (AC-B10).
  const decoded = jwt.decode(token) as JwtPayload | null;
  const expiresIn =
    decoded?.exp !== undefined && decoded.iat !== undefined ? decoded.exp - decoded.iat : 0;

  return { token, expiresIn };
}

/**
 * Whether a claim is a role this API issues.
 *
 * Derived from the `UserRole` enum rather than a list of literals. The literal
 * form — `role !== INTERVIEWER && role !== RECRUITER` — was what this function
 * used until the candidate feature, and it rejected every `CANDIDATE` token with
 * a 401 before `requireRole` ever ran. Adding a third literal would have fixed
 * that case and left the next one, so the check now reads the enum: a role added
 * to the schema is accepted here without an edit.
 *
 * This is a shape check, not an authorization one. Deciding what a role may do
 * is `requireRole`'s job, on a route.
 */
function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && Object.hasOwn(UserRole, value);
}

/**
 * Verifies and narrows a token's claims. Throws on anything unacceptable —
 * malformed, bad signature, expired, or claims of an unexpected shape. Callers
 * turn every throw into an identical 401 (AC-B14).
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  // 30s of clock tolerance absorbs skew between issuer and verifier (EC-12).
  const payload = jwt.verify(token, env.JWT_SECRET, { clockTolerance: 30 });

  if (typeof payload === 'string' || payload.sub === undefined) {
    throw new Error('Malformed access-token payload');
  }

  const sub = Number(payload.sub);
  const role = (payload as JwtPayload).role;

  if (!Number.isInteger(sub) || !isUserRole(role)) {
    throw new Error('Malformed access-token claims');
  }

  return { sub, role };
}

/** Refresh token: 32 random bytes, opaque to the client (BE-4.2). */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * SHA-256, not bcrypt, deliberately: the input is already 256 bits of entropy,
 * so there is nothing to brute-force, and `/refresh` must stay off the bcrypt
 * cost curve to meet its 50ms budget (PERF-2).
 */
export function hashRefreshToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
