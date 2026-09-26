import type { Request, Response } from 'express';
import type { UserRole } from '../../../generated/prisma/enums.js';
import { UnauthenticatedError } from '../../lib/errors.js';
import * as candidateService from './candidate.service.js';
import type {
  CandidateIdParam,
  ListCandidatesQuery,
  UpdateCandidateContactInput,
} from './candidate.schema.js';

/**
 * HTTP only: read the request, call a service, shape a response. No scoping,
 * no Prisma, no transactions — the interviewer predicate lives in
 * `candidate.repository.ts` and nowhere else.
 *
 * **Nothing here filters or reshapes a response.** The two reads pass
 * `req.user.role` down so the SERVICE can pick a query before it runs; no
 * handler inspects a fetched candidate and decides what to send.
 *
 * Handlers don't catch — Express 5 forwards a rejected promise to the error
 * middleware, which is what keeps a Prisma code off the wire.
 *
 * Input comes from `req.validatedParams`, `req.validatedQuery` and `req.body`,
 * never the raw `req.params` / `req.query`, which are un-coerced strings.
 * Each cast is safe because the route that reaches a handler is the route that
 * installed its schema.
 */

/**
 * The actor every scoped read resolves against, and the actor on the one row
 * this feature writes.
 *
 * `req.user.id`, established by `requireAuth` from a verified token, and
 * **nothing else**. No body, query parameter or header supplies one.
 */
function actorId(req: Request): number {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.id;
}

/**
 * The caller's user role, which the two reads scope and project by.
 *
 * Read from `req.user` — a verified JWT claim — and never from a request the
 * caller controls. **A client cannot ask for the recruiter projection.**
 */
function actorRole(req: Request): UserRole {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.role;
}

/**
 * One endpoint, two response shapes, chosen by the caller's role.
 *
 * An empty result is `200 { candidates: [], pagination }`, never a `404` and
 * never a `403` — an interviewer with no assignments has a valid, empty answer.
 */
export async function list(req: Request, res: Response): Promise<void> {
  const { candidates, pagination } = await candidateService.listCandidates(
    req.validatedQuery as ListCandidatesQuery,
    actorRole(req),
    actorId(req),
    req.log,
  );

  res.status(200).json({ candidates, pagination });
}

/**
 * The scoped by-id read.
 *
 * The service returns either `{ candidate }` or `{ candidate, interviews }` and
 * this spreads whichever it got — so the interviewer's `interviews` key is
 * present and the recruiter's is absent, without this handler deciding
 * anything.
 *
 * `404` — never `403` — when the caller's scope does not contain the candidate.
 */
export async function get(req: Request, res: Response): Promise<void> {
  const { candidateId } = req.validatedParams as CandidateIdParam;

  const result = await candidateService.getCandidateDetail(
    candidateId,
    actorRole(req),
    actorId(req),
    req.log,
  );

  res.status(200).json(result);
}

/**
 * `200` with the **full recruiter detail**, not a diff and not just the profile,
 * so the client writes it straight into its detail cache without a refetch.
 */
export async function updateContact(req: Request, res: Response): Promise<void> {
  const { candidateId } = req.validatedParams as CandidateIdParam;

  const candidate = await candidateService.updateCandidateContact(
    candidateId,
    req.body as UpdateCandidateContactInput,
    actorId(req),
    req.log,
  );

  res.status(200).json({ candidate });
}
