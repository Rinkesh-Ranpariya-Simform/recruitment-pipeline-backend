/**
 * The two projections every write in this feature returns.
 *
 * Both endpoints' success bodies are built from these, so `PATCH …/stage`,
 * `POST …/stage-override` and `PATCH …/outcome` cannot drift into three
 * different shapes.
 */

/**
 * What a recruiter gets back from a successful write.
 *
 * Enough to update one board cell without a refetch — `status`, `currentStage`
 * and the `stageEnteredAt` the ageing column is computed from — and nothing
 * more.
 *
 * **`candidateUserId` is deliberately absent.** A recruiter navigating to a
 * candidate does it through `GET /api/candidates`, which is scoped for that
 * purpose; handing back a raw user id here would invite a client to build its
 * own candidate link around an endpoint that never authorized one.
 *
 * The nested role is `{ id, title }` and nothing more. There is **no
 * `candidate` relation in this list at all** — not a narrowed one — so no
 * response from this feature can carry a person's name, email or phone. A shape
 * that never selects the columns cannot leak them; a shape that strips them
 * afterwards is one missed call site away from doing so.
 */
export const PIPELINE_APPLICATION_SELECT = {
  id: true,
  status: true,
  currentStage: true,
  stageEnteredAt: true,
  role: { select: { id: true, title: true } },
} as const;

/**
 * The override row as `POST …/stage-override` returns it.
 *
 * `performedBy` is expanded to `{ id, name }` — and **this is the one name any
 * endpoint in this feature returns**. It is a recruiter's, not a candidate's:
 * the record is only accountable if it says who made the exception.
 *
 * `reason` is here because the recruiter who just typed it is the one reading
 * the response. It is also in the pino `redact` list, so it is returned but
 * never logged.
 *
 * `applicationId` is absent: the response already carries the application it
 * belongs to, one key across.
 */
export const STAGE_OVERRIDE_SELECT = {
  id: true,
  fromStage: true,
  toStage: true,
  reason: true,
  createdAt: true,
  performedBy: { select: { id: true, name: true } },
} as const;

/**
 * The pre-flight read every write performs.
 *
 * A primary-key lookup: five columns plus `Role` joined on its own primary key.
 * The role title is fetched here rather than by re-reading the application
 * after the update, because once the guarded update reports success everything
 * else the response needs is already known — the stage is the one we asked for,
 * `stageEnteredAt` is the timestamp we passed, and `status` is whatever the
 * write set. That keeps the transaction to four statements instead of adding a
 * fifth read to it.
 *
 * It selects **no candidate relation**, so the application row this feature
 * loads carries no person on it at any point — not even to be dropped later.
 */
export const APPLICATION_STATE_SELECT = {
  id: true,
  status: true,
  currentStage: true,
  stageEnteredAt: true,
  role: { select: { id: true, title: true } },
} as const;
