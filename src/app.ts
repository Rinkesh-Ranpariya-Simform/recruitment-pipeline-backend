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
import { authRouter } from './modules/auth/auth.routes.js';
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
app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true }));

app.use(express.json());
app.use(cookieParser());

// Health check. The frontend's ApiStatusCard already polls this; its shape is
// unchanged by this feature.
app.get('/', (_req, res) => {
  res.json({ message: 'My API is working!' });
});

app.use('/api/auth', authRouter);
// Read-only: a GET route and nothing else. `POST /api/users` is not registered
// anywhere and therefore falls through to `notFound` (EC-09, AC-B26).
app.use('/api/users', usersRouter);

// Terminal 404 in the standard error shape, then the error handler last.
app.use(notFound);
app.use(errorHandler);
