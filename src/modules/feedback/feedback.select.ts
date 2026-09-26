/**
 * Feedback select projection for database queries.
 *
 * Provides a unified projection for all roles reading feedback.
 * Includes feedback fields and interviewer details (id and name), but deliberately
 * excludes candidate data or contact info to prevent unintended data exposure.
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
 * Shape of feedback object returned across feedback endpoints.
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
