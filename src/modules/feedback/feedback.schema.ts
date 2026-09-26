import { z } from 'zod';

/**
 * Validation schemas for feedback endpoints.
 * Enforces valid ratings (integers 1-5), trimmed non-empty notes (up to 5000 chars),
 * and positive integer interview IDs. Unknown keys are stripped during parsing.
 */

const RATING_MESSAGE = 'Rating must be an integer between 1 and 5';
const NOTES_MESSAGE = 'Notes must be between 1 and 5000 characters';

/**
 * Validates that rating is an integer between 1 and 5.
 * Rejects strings or floating-point numbers.
 */
const ratingField = z
  .number(RATING_MESSAGE)
  .int(RATING_MESSAGE)
  .min(1, RATING_MESSAGE)
  .max(5, RATING_MESSAGE);

/**
 * Validates that notes are non-empty after trimming whitespace, up to 5000 characters.
 */
const notesField = z.string(NOTES_MESSAGE).trim().min(1, NOTES_MESSAGE).max(5000, NOTES_MESSAGE);

/**
 * Validates the :interviewId route parameter coerced to a positive integer.
 */
export const interviewIdParamSchema = z.object({
  interviewId: z.coerce
    .number('Interview id must be a positive integer')
    .int('Interview id must be a positive integer')
    .positive('Interview id must be a positive integer'),
});

/**
 * Schema for submitting feedback. Both rating and notes are required.
 * The interviewer ID is taken from the authenticated session, not from the payload.
 */
export const createFeedbackSchema = z.object({
  rating: ratingField,
  notes: notesField,
});

/**
 * Schema for updating feedback. At least one of rating or notes must be provided.
 */
export const updateFeedbackSchema = z
  .object({
    rating: ratingField.optional(),
    notes: notesField.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one of rating, notes');

export type InterviewIdParam = z.infer<typeof interviewIdParamSchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export type UpdateFeedbackInput = z.infer<typeof updateFeedbackSchema>;
