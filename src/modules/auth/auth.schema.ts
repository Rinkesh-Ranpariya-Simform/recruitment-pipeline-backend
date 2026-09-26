import { z } from 'zod';

/**
 * Both schemas strip unknown keys (zod object default), so an unexpected field
 * is dropped rather than carried into a Prisma `data` object.
 */

/**
 * Normalisation lives in the schema, not in a service. `validate()` replaces
 * `req.body` with the parsed result, so every downstream consumer sees the
 * trimmed, lowercased value and no code path can forget to normalise.
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
    // different long passwords can never authenticate the same account. Bytes,
    // not characters — a multi-byte password hits this sooner than its length
    // suggests.
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 bytes'),
  // THERE IS DELIBERATELY NO `role` FIELD.
  // Signup is anonymous and is the only HTTP account-creation path, so a `role`
  // it honoured would let anyone mint a RECRUITER. A body carrying one is
  // stripped, answering 201 with a CANDIDATE account.
  //
  // Do not add it back — see `auth.service.signup`.
});

/**
 * Shape only — deliberately NO password length minimum.
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
