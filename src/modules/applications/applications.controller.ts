import type { Request, Response } from 'express';
import { UserRole } from '../../../generated/prisma/enums.js';
import { UnauthenticatedError } from '../../lib/errors.js';
import type {
  ApplicationIdParam,
  CreateApplicationInput,
  ListApplicationsQuery,
} from './applications.schema.js';
import * as applicationsService from './applications.service.js';

/**
 * HTTP concerns only: read the request, call a service, shape a response. No
 * eligibility rules, no Prisma (BE-1).
 *
 * **Nothing here filters a response.** The two reads pick which SERVICE
 * FUNCTION runs from `req.user.role`, and each of those has its own `where` and
 * its own select; no handler inspects a fetched row and decides what to send
 * (BE-4). The dispatch is a choice between two queries, made before either runs.
 *
 * Handlers don't catch — Express 5 forwards a rejected promise from an async
 * handler to the error middleware.
 */

/**
 * The authenticated caller's id.
 *
 * This is the ONLY source of `candidateUserId` in the feature. It comes from
 * `req.user`, established by `requireAuth` from a verified token, and never from
 * a body, query parameter or header (AZ-5).
 */
function actorId(req: Request): number {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.id;
}

/**
 * The caller's user role, which the two reads dispatch on.
 *
 * Read from `req.user` — a verified token claim — and never from a request the
 * caller controls. **A client cannot ask for the recruiter projection**, and a
 * candidate reaching the recruiter branch is not something a body or a header
 * can arrange.
 */
function actorRole(req: Request): UserRole {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.role;
}

/** 201 with the created application, so the client can render it without a refetch. */
export async function create(req: Request, res: Response): Promise<void> {
  const { roleId } = req.body as CreateApplicationInput;

  const application = await applicationsService.createApplication(roleId, actorId(req), req.log);

  res.status(201).json({ application });
}

/**
 * One endpoint, two response shapes, chosen by the caller's role.
 *
 * - **Candidate** — `200 { applications }`, their own, unpaged. The query
 *   parameters are parsed by the route's `validateQuery` and then **not passed
 *   to the service**, which takes none: no filter can reach a `where` that is
 *   hardcoded to `{ candidateUserId }`.
 * - **Recruiter** — `200 { applications, pagination }`, every application,
 *   filtered and paged.
 *
 * An empty result is `200 { applications: [] }` for either role, never a 404.
 */
export async function list(req: Request, res: Response): Promise<void> {
  if (actorRole(req) === UserRole.RECRUITER) {
    const { applications, pagination } = await applicationsService.listRecruiterApplications(
      req.validatedQuery as ListApplicationsQuery,
    );

    res.status(200).json({ applications, pagination });
    return;
  }

  const applications = await applicationsService.listApplications(actorId(req));

  res.status(200).json({ applications });
}

/**
 * One application, in whichever shape the caller's role is served.
 *
 * `404` — never `403` — when the id is outside the caller's scope, for the same
 * reason the interviews by-id read answers that way: a `403` confirms the row
 * exists. For a candidate the scope is their own applications, enforced by a
 * predicate in the query.
 */
export async function get(req: Request, res: Response): Promise<void> {
  const { applicationId } = req.validatedParams as ApplicationIdParam;

  if (actorRole(req) === UserRole.RECRUITER) {
    const application = await applicationsService.getRecruiterApplication(applicationId);

    res.status(200).json({ application });
    return;
  }

  const application = await applicationsService.getCandidateApplication(
    applicationId,
    actorId(req),
  );

  res.status(200).json({ application });
}
