import type { NextFunction, Request, Response } from 'express';
import { UnauthenticatedError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { verifyAccessToken } from '../lib/tokens.js';

/**
 * Establishes `req.user` for every protected route.
 *
 * Every failure mode — no header, wrong scheme, bad signature, expired, claims
 * of the wrong shape, or a user row that no longer exists — produces the same
 * bare 401. The client learns that it is not authenticated and nothing else.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization');

  if (header === undefined) {
    next(new UnauthenticatedError());
    return;
  }

  // Exactly `Bearer <token>` — two parts, correct scheme. Anything else is a
  // 401, never a 500.
  const [scheme, token, ...rest] = header.split(' ');

  if (scheme !== 'Bearer' || token === undefined || token === '' || rest.length > 0) {
    next(new UnauthenticatedError());
    return;
  }

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    next(new UnauthenticatedError());
    return;
  }

  // A valid signature proves the token was issued by us, not that its subject
  // still exists. Resolve the row; a deleted user is a 401, never a fabricated
  // identity. Exactly one query per request.
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, role: true },
  });

  if (user === null) {
    next(new UnauthenticatedError());
    return;
  }

  req.user = { id: user.id, role: user.role };
  next();
}
