import { env } from '../src/config/env.js';
import { Role } from '../src/generated/prisma/enums.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/lib/password.js';
import { disconnect, prisma } from '../src/lib/prisma.js';
import { SAFE_USER_SELECT } from '../src/modules/users/user.select.js';

/**
 * Demo accounts for the POC (FR-8).
 *
 * This is the second of the two provisioning paths, and the only one that needs
 * no HTTP at all. Idempotent by `upsert` on the unique email, so a fresh
 * database plus one command gives a demoable system and re-running it restores
 * the baseline mid-verification (AC-B36, R-8).
 */
const SEED_ACCOUNTS = [
  { name: 'Rhea Recruiter', email: 'recruiter@demo.test', role: Role.RECRUITER },
  { name: 'Ivan Interviewer', email: 'interviewer1@demo.test', role: Role.INTERVIEWER },
  { name: 'Ingrid Interviewer', email: 'interviewer2@demo.test', role: Role.INTERVIEWER },
] as const;

async function main(): Promise<void> {
  const password = env.SEED_PASSWORD;

  if (password === undefined) {
    throw new Error(
      'SEED_PASSWORD is not set. See .env.example — the seed has no default password.',
    );
  }

  for (const account of SEED_ACCOUNTS) {
    // Hashed per account rather than once, so each row gets its own bcrypt salt.
    const passwordHash = await hashPassword(password);

    const user = await prisma.user.upsert({
      where: { email: account.email },
      // Re-seeding resets the password and role, so the baseline is restorable
      // after a verification pass has mutated things.
      update: { name: account.name, passwordHash, role: account.role },
      create: { name: account.name, email: account.email, passwordHash, role: account.role },
      select: SAFE_USER_SELECT,
    });

    logger.info(
      { event: 'user.created', createdUserId: user.id, role: user.role, source: 'seed' },
      `seeded ${user.email}`,
    );
  }
}

try {
  await main();
  logger.info({ count: SEED_ACCOUNTS.length }, 'seed complete');
} catch (error) {
  logger.error({ err: error }, 'seed failed');
  await disconnect();
  process.exit(1);
}

await disconnect();
