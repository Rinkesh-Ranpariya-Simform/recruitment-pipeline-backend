import type { Request, Response } from 'express';
import { clearRefreshCookie, REFRESH_COOKIE_NAME, setRefreshCookie } from '../../lib/cookies.js';
import { UnauthenticatedError } from '../../lib/errors.js';
import type { LoginInput, SignupInput } from './auth.schema.js';
import * as authService from './auth.service.js';

/**
 * HTTP concerns only: read the request, call a service, shape a response. No
 * hashing, no token minting, no Prisma.
 *
 * Express 5 forwards a rejected promise from an async handler to the error
 * middleware, so these deliberately do not catch — a thrown AppError becomes
 * the response, and anything else becomes a generic 500.
 */

/** 201, safe user, and deliberately NO cookie and no token. */
export async function signup(req: Request, res: Response): Promise<void> {
  const user = await authService.signup(req.body as SignupInput, req.log);

  res.status(201).json({ user });
}

export async function login(req: Request, res: Response): Promise<void> {
  const session = await authService.login(req.body as LoginInput, req.log);

  // The raw refresh token leaves the process here and only here — it is never
  // part of the response body.
  setRefreshCookie(res, session.rawRefreshToken);

  res.status(200).json({
    user: session.user,
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
  });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const rawToken: unknown = req.cookies?.[REFRESH_COOKIE_NAME];

  if (typeof rawToken !== 'string' || rawToken === '') {
    throw new UnauthenticatedError();
  }

  const rotated = await authService.refresh(rawToken, req.log);

  setRefreshCookie(res, rotated.rawRefreshToken);

  res.status(200).json({ accessToken: rotated.accessToken, expiresIn: rotated.expiresIn });
}

/**
 * Always 204, even with no cookie or an already-invalid one. The cookie is
 * cleared regardless, so a client can never be left holding a credential the
 * server has forgotten.
 */
export async function logout(req: Request, res: Response): Promise<void> {
  const rawToken: unknown = req.cookies?.[REFRESH_COOKIE_NAME];

  await authService.logout(typeof rawToken === 'string' ? rawToken : undefined, req.log);

  clearRefreshCookie(res);

  res.status(204).send();
}

export async function me(req: Request, res: Response): Promise<void> {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  const user = await authService.getById(req.user.id);

  if (user === null) {
    // The row disappeared between requireAuth and here. A token never implies
    // existence.
    throw new UnauthenticatedError();
  }

  res.status(200).json({ user });
}
