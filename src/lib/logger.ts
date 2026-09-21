import { pino } from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logging (BE-9). `console.log` is not used anywhere in `src/`.
 *
 * The `redact` list below is belt-and-braces: nothing in this codebase logs a
 * credential deliberately, and this catches the case where a future caller
 * passes a whole `req`, `res` or user row into a log line by accident. The
 * binding rule is still "never log these" — this is the second line of defence,
 * not the first.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'accessToken',
  'refreshToken',
  'rawRefreshToken',
  '*.password',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
  // A stage override's free text (audit spec FR-8.3, SEC-7). Nothing logs an
  // override's metadata today - `recordAudit` logs ids and enum values only -
  // so this is here purely so that a future line which accidentally does
  // prints `[redacted]` rather than a recruiter's own words about a candidate.
  'reason',
  '*.reason',
];

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  ...(env.NODE_ENV === 'production'
    ? {}
    : { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }),
});

/** A logger bound to one request, so every line it emits carries the request id. */
export function child(bindings: { requestId: string }) {
  return logger.child(bindings);
}

export type Logger = typeof logger;
