import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import * as authController from './auth.controller.js';
import { loginSchema, signupSchema } from './auth.schema.js';

export const authRouter = Router();

/**
 * The three anonymous endpoints in the API (FR-7.3). Adding a fourth is a
 * spec-level decision, not a local one.
 *
 * SEC-11.1: `/signup` is anonymous AND accepts a `role`, and it is the only
 * account-creation path there is. Anyone who can reach this API can mint a
 * RECRUITER. That is accepted ONLY because the POC binds to localhost. Before
 * this API is reachable from anywhere else, this route must be gated behind an
 * operator secret or deleted in favour of `npm run db:seed`.
 */
authRouter.post('/signup', validate(signupSchema), authController.signup);
authRouter.post('/login', validate(loginSchema), authController.login);

// Cookie-gated, no body — so no `validate()` in the chain.
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);

// requireAuth before anything else on protected routes (PERF-7).
authRouter.get('/me', requireAuth, authController.me);
