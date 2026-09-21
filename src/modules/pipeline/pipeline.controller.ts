import type { Request, Response } from 'express';
import { UnauthenticatedError } from '../../lib/errors.js';
import type {
  ApplicationIdParam,
  ChangeStageInput,
  PipelineQuery,
  SetOutcomeInput,
  StageOverrideInput,
} from './pipeline.schema.js';
import * as pipelineService from './pipeline.service.js';

/**
 * HTTP only: read the request, call a service, shape a response (BE-1). No
 * stage rules, no Prisma, no transactions — all of that is the service, and the
 * graph itself is `pipeline.rules`.
 *
 * Handlers don't catch — Express 5 forwards a rejected promise to the error
 * middleware, which is also what keeps a Prisma error and any raw-SQL text off
 * the wire (ERR-5).
 *
 * Input comes from `req.validatedParams`, `req.validatedQuery` and `req.body`,
 * never the raw `req.params` / `req.query`, which are un-coerced strings
 * (BE-4). Each cast is safe because the route that reaches a handler is the
 * route that installed its schema.
 */

/**
 * The actor on every row this feature writes (AZ-5, SEC-2).
 *
 * `req.user.id`, established by `requireAuth` from a verified token, and
 * **nothing else**. No body field can set it — the schemas have no such key, so
 * a body carrying `"performedBy": 9` reaches no code that could read it
 * (VAL-5). That is what makes an override's attribution trustworthy, which is
 * the whole of brief §3.3.
 */
function actorId(req: Request): number {
  if (req.user === undefined) {
    throw new UnauthenticatedError();
  }

  return req.user.id;
}

/** 200 with the moved application, so a board cell updates without a refetch (XFE-10). */
export async function changeStage(req: Request, res: Response): Promise<void> {
  const { applicationId } = req.validatedParams as ApplicationIdParam;
  const { toStage } = req.body as ChangeStageInput;

  const application = await pipelineService.changeStage(
    applicationId,
    toStage,
    actorId(req),
    req.log,
  );

  res.status(200).json({ application });
}

/**
 * 201 — an override CREATES a row, and the row is the point (FR-4.7).
 *
 * The body carries both the moved application and the override itself, so the
 * recruiter sees the record their reason produced rather than having to trust
 * that one was written.
 */
export async function overrideStage(req: Request, res: Response): Promise<void> {
  const { applicationId } = req.validatedParams as ApplicationIdParam;

  const { application, override } = await pipelineService.overrideStage(
    applicationId,
    req.body as StageOverrideInput,
    actorId(req),
    req.log,
  );

  res.status(201).json({ application, override });
}

/** 200 with the closed application — `currentStage` deliberately unchanged (FR-3.5). */
export async function setOutcome(req: Request, res: Response): Promise<void> {
  const { applicationId } = req.validatedParams as ApplicationIdParam;

  const application = await pipelineService.setOutcome(
    applicationId,
    req.body as SetOutcomeInput,
    actorId(req),
    req.log,
  );

  res.status(200).json({ application });
}

/**
 * The board. An empty result is `200 { roles: [] }`, never a 404 — a filter that
 * matched nothing is a valid answer to a question about counts (EC-13).
 *
 * No `actorId` is passed: this read has no per-row scoping to do. The recruiter
 * guard on the route is the whole of its authorization (AZ-2).
 */
export async function getPipeline(req: Request, res: Response): Promise<void> {
  const roles = await pipelineService.getPipeline(req.validatedQuery as PipelineQuery, req.log);

  res.status(200).json({ roles });
}

/** The dashboard headline. Six keys, and no `interviews` until that table exists (FR-8.4). */
export async function getSummary(req: Request, res: Response): Promise<void> {
  const summary = await pipelineService.getSummary(req.log);

  res.status(200).json({ summary });
}
