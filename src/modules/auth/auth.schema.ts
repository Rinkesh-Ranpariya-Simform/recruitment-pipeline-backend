import { z } from 'zod';
import { UserRole } from '../../generated/prisma/enums.js';

/**
 * The two body schemas in this feature (VAL-4). `GET /api/users` takes no body
 * and therefore has no schema and no `validate()` in its chain.
 *
 * Both strip unknown keys (zod object default), so an unexpected field is
 * dropped rather than carried into a Prisma `data` object (BE-2.3).
 */

/**
 * Normalisation lives in the schema, not in a service (VAL-3). `validate()`
 * replaces `req.body` with the parsed result, so every downstream consumer sees
 * the trimmed, lowercased value and no code path can forget to normalise
 * (EC-07, AC-B05).
 */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254, 'Email must be at most 254 characters'));

export const signupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(100, 'Name must be at most 100 characters'),
  email: emailField,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    // bcrypt silently truncates beyond 72 bytes; rejecting instead means two
    // different long passwords can never authenticate the same account
    // (VAL-1, EC-08). Bytes, not characters — a multi-byte password hits this
    // sooner than its length suggests.
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 bytes'),
  // Required, with no default: no code path may silently mint a privileged
  // account (MIG-2, EC-13, AC-B04).
  role: z.enum(UserRole, 'Role must be one of INTERVIEWER, RECRUITER'),
});

/**
 * Shape only — deliberately NO password length minimum (VAL-6, AC-B08).
 *
 * Applying the signup rules here would return 400 where 401 belongs, and would
 * reveal that no account can have a short password. Credential correctness is
 * decided by the service, which answers identically for every failure.
 */
export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Password is required'),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
