import { env } from '../src/config/env.js';
import { RoleStatus, UserRole } from '../src/generated/prisma/enums.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/lib/password.js';
import { disconnect, prisma } from '../src/lib/prisma.js';
import { ROLE_SELECT } from '../src/modules/roles/role.select.js';
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
  { name: 'Rhea Recruiter', email: 'recruiter@demo.test', role: UserRole.RECRUITER },
  { name: 'Ivan Interviewer', email: 'interviewer1@demo.test', role: UserRole.INTERVIEWER },
  { name: 'Ingrid Interviewer', email: 'interviewer2@demo.test', role: UserRole.INTERVIEWER },
] as const;

/**
 * Demo roles for the POC (FR-9.1, FR-9.2).
 *
 * THREE roles: two OPEN and one CLOSED, so a status filter has something to
 * prove. A fresh database plus one command gives the frontend something to
 * render and later features something to attach to — and, as with login, no UI
 * path creates this data.
 */
const SEED_ROLES = [
  {
    title: 'Senior Backend Engineer',
    description:
      'Owns the pipeline service: the API behind candidate progression, stage transitions and the ageing views.',
    status: RoleStatus.OPEN,
  },
  {
    title: 'Product Designer',
    description:
      'Owns the candidate-facing surfaces and the recruiter pipeline board, from first wireframe to shipped UI.',
    status: RoleStatus.OPEN,
  },
  {
    title: 'Engineering Manager',
    description:
      'Closed requisition, kept so the status filter and the reopen path have something real to act on.',
    status: RoleStatus.CLOSED,
  },
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

  // Roles come AFTER the demo accounts (FR-9.1).
  //
  // Idempotency is `findFirst`-then-`create`, not `upsert`, because `title` is
  // deliberately not unique (FR-1.3) — two teams hiring the same title is
  // ordinary, so there is no key to upsert on.
  //
  // A CHECK-THEN-WRITE IS ACCEPTABLE HERE AND NOWHERE ELSE IN THIS CODEBASE
  // (FR-9.3): the seed is a single-process script with no concurrent caller,
  // whereas a request path must derive conflicts from a database constraint
  // (ERR-2).
  for (const seed of SEED_ROLES) {
    const existing = await prisma.role.findFirst({
      where: { title: seed.title },
      select: { id: true },
    });

    if (existing !== null) {
      logger.info(
        { event: 'role.seed_skipped', roleId: existing.id, source: 'seed' },
        `role already present: ${seed.title}`,
      );
      continue;
    }

    const role = await prisma.role.create({ data: seed, select: ROLE_SELECT });

    logger.info(
      // `role.seeded`, NOT `role.created`: the latter is the request-path audit
      // event, which carries an `actorId` and must never carry title text
      // (FR-8.2, FR-8.4, AC-B28). A seeded title is a constant in this repo,
      // not user data, so echoing it in the human message is safe — and mirrors
      // the account loop above.
      { event: 'role.seeded', roleId: role.id, status: role.status, source: 'seed' },
      `seeded role: ${role.title}`,
    );
  }
}

try {
  await main();
  logger.info({ accounts: SEED_ACCOUNTS.length, roles: SEED_ROLES.length }, 'seed complete');
} catch (error) {
  logger.error({ err: error }, 'seed failed');
  await disconnect();
  process.exit(1);
}

await disconnect();
