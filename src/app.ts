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

export const app = express();

app.use(requestId);

app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true, maxAge: 600 }));

app.use(express.json());

app.use(cookieParser());

app.get('/', (_req, res) => {
  res.json({ message: 'My API is working!' });
});

app.use('/api/auth', authRouter);

app.use('/api/users', usersRouter);

app.use('/api/roles', rolesRouter);

app.use('/api/applications', applicationsRouter);

app.use('/api/pipeline', pipelineRouter);

app.use('/api/interviews', interviewsRouter);

app.use('/api/candidates', candidatesRouter);

app.use('/api/audit', auditRouter);

app.use(notFound);

app.use(errorHandler);
