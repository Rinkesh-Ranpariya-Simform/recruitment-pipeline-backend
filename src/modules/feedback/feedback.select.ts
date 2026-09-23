/**
 * ONE projection, for both roles (BE-6).
 *
 * The interviews feature needed two selects because a recruiter may see a
 * candidate's `{ id, name }` and an interviewer's payload may not name their
 * colleagues. **Feedback needs one**, because neither role may see more than the
 * other on this resource: an assessment is the same row whoever is reading it.
 *
 * **It names no `interview` relation, and therefore reaches no candidate**
 * (FR-5.6, SEC-1). The brief's §3.6 names a feedback-submission endpoint by name
 * as the leak path to worry about:
 *
 * > never to interviewers, under any circumstance, including through a
 * > feedback-submission endpoint that happens to also carry candidate data.
 *
 * The answer here is not that contact details are stripped afterwards — it is
 * that **the row Postgres returns contains no candidate column at all**. There is
 * nothing to redact, and no future call site can accidentally include what was
 * never fetched. `grep -rniE "sanitis|sanitiz|strip|redact" src/modules/feedback/`
 * returns nothing, and that absence is the design (SEC-2, AC-B38).
 *
 * **If a field must be kept from a reader, take it out of this object** — never
 * out of a mapping function afterwards.
 *
 * `interviewer` IS expanded to `{ id, name }` (FR-5.5). That is the disclosure
 * the interviews feature deliberately withheld from a round payload so that it
 * happens here, once, where it is specified — reading a panel's notes is
 * pointless if you cannot tell who wrote which. It is a relation select, which
 * JOINs; it is not an N+1 lookup per row (PERF-4).
 *
 * The raw `interviewerId` foreign key is NOT named: the expanded object replaces
 * it (contract invariant 4), matching `ASSIGNMENT_SELECT` in the interviews
 * module.
 */
export const FEEDBACK_SELECT = {
  id: true,
  interviewId: true,
  rating: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  interviewer: { select: { id: true, name: true } },
} as const;

/**
 * One assessment, exactly as all three endpoints return it (API Contract).
 *
 * There is deliberately no second view type in this module. A single shape for
 * both roles is what makes contract invariants 1–3 checkable by reading one
 * interface: no `email`, no `phone`, no candidate field of any kind.
 */
export interface FeedbackView {
  id: number;
  interviewId: number;
  rating: number;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
  interviewer: { id: number; name: string };
}
