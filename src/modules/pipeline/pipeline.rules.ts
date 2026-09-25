import { ApplicationStatus, PipelineStage } from '../../../generated/prisma/enums.js';

/**
 * The stage progression rule, and nothing else (BE-2).
 *
 * **This file imports the Prisma enums and nothing more** — no `prisma`, no
 * Express, no logger, no error classes. It is the file a reviewer opens to
 * answer *"where is the stage progression rule enforced?"* (brief §7.1), so it
 * has to be readable without following an import out of it. Everything here is
 * a pure function over two constants.
 *
 * The brief's §3.1 sketch treats `hired` and `rejected` as stages. **The
 * shipped schema does not** (D-1): they live on `ApplicationStatus`, kept
 * disjoint from `PipelineStage` so that `status: ACTIVE, currentStage:
 * REJECTED` is unrepresentable without a CHECK constraint. So the single map
 * that sketch implies splits in two here — `ALLOWED_STAGE_TRANSITIONS` governs
 * movement along the pipeline, `ALLOWED_OUTCOMES` governs leaving it.
 */

/**
 * The canonical order of the live pipeline (FR-1.1).
 *
 * Declared ONCE, here. Two things read it and neither re-derives it: the
 * densifier that gives every role all four stage cells in board order
 * (FR-7.8), and `stagesSkipped` below. It is not the enum's declaration order
 * by coincidence — it is the order, and `PipelineStage`'s declaration is kept
 * to match.
 */
export const STAGE_ORDER = [
  PipelineStage.APPLIED,
  PipelineStage.SCREEN,
  PipelineStage.INTERVIEW,
  PipelineStage.OFFER,
] as const;

/**
 * The stage graph (FR-2.1). One step forward, no skips, no reversals.
 *
 * `OFFER` is empty: there is nowhere further to walk. What follows an offer is
 * an outcome, which is `ALLOWED_OUTCOMES` below, not a fifth stage.
 *
 * Everything this map refuses is reachable only through an override (FR-4),
 * which records who did it and why. That is the whole of the brief's "cannot
 * skip a stage without an explicit override".
 *
 * Typed `Record<PipelineStage, …>` and therefore **total over the enum**
 * (FR-1.4): adding a stage to `PipelineStage` is a compile error here until
 * every transition out of it has been decided. A partial map would be a silent
 * hole that refuses every move from the new stage with no one having chosen
 * that.
 */
export const ALLOWED_STAGE_TRANSITIONS: Record<PipelineStage, ReadonlyArray<PipelineStage>> = {
  [PipelineStage.APPLIED]: [PipelineStage.SCREEN],
  [PipelineStage.SCREEN]: [PipelineStage.INTERVIEW],
  [PipelineStage.INTERVIEW]: [PipelineStage.OFFER],
  [PipelineStage.OFFER]: [],
};

/**
 * Which terminal outcomes are reachable from each live stage (FR-3.1).
 *
 * Rejection is possible from anywhere — a candidate can be turned down at any
 * point, and a process that pretended otherwise would just be recorded
 * dishonestly.
 *
 * **`HIRED` is reachable only from `OFFER`.** Hiring someone who was never
 * offered is precisely the stage skip this feature exists to prevent, so it is
 * refused here and must instead go through an override to `OFFER` — which
 * leaves a reason and an actor behind it (FR-4.9).
 *
 * `ACTIVE` appears in no list: it is the state an application starts in, not an
 * outcome it can be moved to, and the request schema does not accept it either
 * (VAL-4).
 *
 * Total over `PipelineStage` for the same reason as the map above.
 */
export const ALLOWED_OUTCOMES: Record<PipelineStage, ReadonlyArray<ApplicationStatus>> = {
  [PipelineStage.APPLIED]: [ApplicationStatus.REJECTED],
  [PipelineStage.SCREEN]: [ApplicationStatus.REJECTED],
  [PipelineStage.INTERVIEW]: [ApplicationStatus.REJECTED],
  [PipelineStage.OFFER]: [ApplicationStatus.HIRED, ApplicationStatus.REJECTED],
};

/**
 * Is this move one the graph permits? (FR-2.4, FR-2.5)
 *
 * `to === from` is false, not true: a transition to where you already are is a
 * client bug, and answering `200` to it hides the bug and writes a history row
 * describing nothing. It is false here rather than special-cased at the call
 * site because no map lists a stage as reachable from itself.
 */
export function canTransition(from: PipelineStage, to: PipelineStage): boolean {
  return ALLOWED_STAGE_TRANSITIONS[from].includes(to);
}

/** Is this outcome one the current stage permits? (FR-3.1, FR-3.3) */
export function canSetOutcome(from: PipelineStage, status: ApplicationStatus): boolean {
  return ALLOWED_OUTCOMES[from].includes(status);
}

/**
 * How many stages a move jumps over (FR-4.8).
 *
 * Recorded on every override so that *"was a stage actually skipped, or did a
 * recruiter use the override path for a move the graph would have allowed?"* is
 * answerable at read time without re-deriving the graph (FR-4.5).
 *
 * Floored at 0, which is what a backwards override produces: moving from
 * `OFFER` to `APPLIED` skips nothing, it undoes. A negative count would read as
 * a fact about stages when it is really a direction.
 */
export function stagesSkipped(from: PipelineStage, to: PipelineStage): number {
  const skipped = STAGE_ORDER.indexOf(to) - STAGE_ORDER.indexOf(from) - 1;

  return Math.max(skipped, 0);
}
