import type { Response } from 'express';
import { env } from '../config/env.js';

/**
 * The single definition of the refresh cookie's attributes. No other
 * file sets or clears this cookie.
 *
 * The name is part of the cross-repo contract — the frontend's route guard keys
 * its cookie-presence check on exactly this string.
 */
export const REFRESH_COOKIE_NAME = 'refresh_token';

/**
 * `Path=/api/auth` scopes the cookie to `/refresh` and `/logout` only, so it is
 * NOT attached to ordinary API calls. This looks like a bug when debugging — it
 * isn't. Ordinary endpoints authenticate via the `Authorization` header; keeping
 * the cookie off them is also what makes the CSRF posture hold.
 */
const COOKIE_PATH = '/api/auth';

function baseOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: COOKIE_PATH,
    // If this ever becomes 'none', a CSRF token or origin check becomes
    // mandatory. Do not change `sameSite` without revisiting that requirement.
    secure: env.COOKIE_SECURE,
  };
}

export function setRefreshCookie(res: Response, rawToken: string): void {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, {
    ...baseOptions(),
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response): void {
  // `maxAge: 0` rather than clearCookie(), so the expiry is explicit in the
  // response.
  res.cookie(REFRESH_COOKIE_NAME, '', { ...baseOptions(), maxAge: 0 });
}
