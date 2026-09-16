/**
 * The single definition of the candidate-facing application projection
 * (FR-6.3, FR-6.4, FR-6.5).
 *
 * Both endpoints in this module use it, so `POST` and `GET` cannot drift into
 * two different shapes — the same construction as `SAFE_USER_SELECT` and
 * `ROLE_SELECT`.
 *
 * This list is the mechanism behind the feature's sharpest guarantee. A
 * candidate must never see interviewer feedback, a rating, an internal note, an
 * interviewer's identity, or an override reason. None of those are columns
 * *yet* — rounds, feedback and overrides are later features — and the point of
 * writing the projection explicitly now is that when they arrive, they arrive
 * outside this list rather than inside a `include: true` that quietly widened.
 *
 * `stageEnteredAt` and `updatedAt` are deliberately absent too: the candidate
 * view is a flat row (D-13), and `stageEnteredAt` is the pipeline feature's
 * ageing column, not an applicant's business.
 *
 * The nested role select is `{ id, title }` and nothing more (FR-6.5). Widening
 * it would turn a candidate's application list into a second, unpaged view of
 * the requisition table — one that does not carry the forced `status: OPEN`
 * predicate the roles module applies.
 */
export const APPLICATION_SELECT = {
  id: true,
  status: true,
  currentStage: true,
  createdAt: true,
  role: { select: { id: true, title: true } },
} as const;
