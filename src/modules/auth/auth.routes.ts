import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import * as authController from './auth.controller.js';
import { loginSchema, signupSchema } from './auth.schema.js';

export const authRouter = Router();

/**
 * The three anonymous endpoints in the API. Adding a fourth is a spec-level
 * decision, not a local one.
 *
 * `/signup` can only create a CANDIDATE — see `signupSchema`. Interviewers and
 * recruiters come from `npm run db:seed`. Do not reintroduce a role field or a
 * second creation path.
 *
 * What is still accepted, and still POC-only: this endpoint has no rate limit,
 * no CAPTCHA and no email verification, so anyone who can reach it can create
 * unlimited *candidate* accounts.
 */
authRouter.post('/signup', validate(signupSchema), authController.signup);
authRouter.post('/login', validate(loginSchema), authController.login);

// Cookie-gated, no body — so no `validate()` in the chain.
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);

// requireAuth before anything else on protected routes.
authRouter.get('/me', requireAuth, authController.me);
