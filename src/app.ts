// `env` first, deliberately: importing it validates the environment and exits
// the process on failure, before any other module gets a chance to read a
// half-configured value or bind anything (EC-10, AC-B33).
import { env } from './config/env.js';

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';

import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { requestId } from './middleware/requestId.js';
import { applicationsRouter } from './modules/applications/applications.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { rolesRouter } from './modules/roles/roles.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

/**
 * The wired application, with no listener attached — `server.ts` owns the port.
 * Keeping the two apart means the app can be imported and inspected (route
 * enumeration for AC-B00, for one) without taking a port.
 *
 * Middleware order below is load-bearing, not cosmetic.
 */
export const app = express();

app.use(requestId);

// An explicit origin, never a wildcard — which is incompatible with
// credentialed requests in any case (BE-7.1, SEC-7). `credentials: true` is
// what allows the client to send the refresh cookie cross-origin (XFE-2).
//
// `maxAge` caches the preflight for 10 minutes. Every call this API serves
// carries `Authorization` or `Content-Type: application/json`, neither of which
// is CORS-safelisted, so each one is preceded by an `OPTIONS`. Without a
// `maxAge` the browser's own default applies — 5 seconds in Chrome — so in
// practice every request paid for two round trips. This does not widen what is
// allowed; it only stops re-asking the same question.
app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true, maxAge: 600 }));

app.use(express.json());
app.use(cookieParser());

// For operators and `docker compose` readiness, not the frontend. The
// `{ message }` shape is a published contract — keep it stable.
app.get('/', (_req, res) => {
  res.json({ message: 'My API is working!' });
});

app.use('/api/auth', authRouter);
// Read-only: a GET route and nothing else. `POST /api/users` is not registered
// anywhere and therefore falls through to `notFound` (EC-09, AC-B26).
app.use('/api/users', usersRouter);
// Reads are open to any authenticated user; writes are recruiter-only
// (candidate spec FR-4.1, FR-4.2).
app.use('/api/roles', rolesRouter);
// Two routes, both CANDIDATE-only. `GET /api/applications/:id` is deliberately
// not among them and therefore falls through to `notFound` (FR-6.8, EC-09).
app.use('/api/applications', applicationsRouter);

// Last, and in this order: every unmatched path must reach `notFound` before
// the error handler renders it.
app.use(notFound);
app.use(errorHandler);
