import 'dotenv/config';
import { z } from 'zod';

/**
 * Boot-time environment validation.
 *
 * Parsed at import time so that a malformed environment kills the process
 * before anything binds a port. `JWT_SECRET` deliberately has no default and no
 * fallback — a server that cannot prove where its signing key came from must
 * not start.
 */
const booleanFromEnv = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url({ message: 'DATABASE_URL must be a valid connection URL' }),
  PORT: z.coerce.number().int().positive().default(3000),
  FRONTEND_ORIGIN: z.url({ message: 'FRONTEND_ORIGIN must be a valid URL' }),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters — it has no default'),
  ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(1),
  COOKIE_SECURE: booleanFromEnv.default(false),
  SEED_PASSWORD: z.string().min(8).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  // Written straight to stderr: the logger itself depends on this module.
  process.stderr.write(
    `Invalid environment configuration. The server will not start.\n${problems}\n` +
      `See .env.example for the required variables.\n`,
  );
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
