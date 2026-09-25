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
import { auditRouter } from './modules/audit/audit.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { candidatesRouter } from './modules/candidates/candidate.routes.js';
import { interviewsRouter } from './modules/interviews/interviews.routes.js';
import { pipelineRouter } from './modules/pipeline/pipeline.routes.js';
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
// Two CANDIDATE-only routes, plus the pipeline feature's three RECRUITER-only
// writes on `/:applicationId` — stage, override and outcome (pipeline BE-5).
// `GET /api/applications/:id` is deliberately not among them and therefore
// falls through to `notFound` (FR-6.8, EC-09).
app.use('/api/applications', applicationsRouter);
// Two RECRUITER-only GETs: the board and the dashboard headline. The feature's
// WRITES are not here — they mount on `/api/applications` above, because the
// resource being changed is an application (pipeline BE-5). There is no history
// endpoint on this router and none is planned: that read belongs to the
// candidate-access feature (pipeline FR-5.6).
app.use('/api/pipeline', pipelineRouter);
// Two reads open to RECRUITER and INTERVIEWER — an interviewer's rows are
// narrowed to their own assignments by `buildInterviewWhere`, in the query, not
// after it (interviews AZ-4). Plus three RECRUITER-only writes: the status
// change and the two assignment routes. The feature's other two routes are not
// here — they mount on `/api/applications` above, because the resource they
// hang off is an application (interviews BE-2).
app.use('/api/interviews', interviewsRouter);
// Two reads open to RECRUITER and INTERVIEWER, and one RECRUITER-only PATCH.
// An interviewer's rows are narrowed to candidates they have a round with by
// `buildCandidateWhere`, in the query, not after it — and an unassigned
// interviewer's by-id read is a 404 produced by a query that returned no row,
// never a 403 (candidate-access AZ-2, AZ-6). **There is deliberately no POST**:
// provisioning is signup or the seed, and this router adds no second
// account-creation path, so that verb falls through to `notFound` and answers
// 404 (candidate-access FR-1.4).
app.use('/api/candidates', candidatesRouter);
// One RECRUITER-only GET. There is no PATCH, DELETE or `/:id` on this router:
// an audit row is never updated or deleted, so those paths fall through to
// `notFound` and answer 404 (audit spec FR-6.1, AZ-4).
app.use('/api/audit', auditRouter);

// Last, and in this order: every unmatched path must reach `notFound` before
// the error handler renders it.
app.use(notFound);
app.use(errorHandler);
