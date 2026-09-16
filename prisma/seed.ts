import { env } from '../src/config/env.js';
import {
  ApplicationStatus,
  PipelineStage,
  RoleStatus,
  UserRole,
} from '../src/generated/prisma/enums.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/lib/password.js';
import { disconnect, prisma } from '../src/lib/prisma.js';
import { APPLICATION_SELECT } from '../src/modules/applications/application.select.js';
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
  // The candidate feature's demo account (FR-10.1). This is the ONLY seeded
  // account a real user could also have created for themselves — signup mints
  // candidates and nothing else now, so the other three have no HTTP path at
  // all (FR-3.1).
  { name: 'Cara Candidate', email: 'candidate@demo.test', role: UserRole.CANDIDATE },
] as const;

/** The candidate whose applications are seeded below. */
const SEED_CANDIDATE_EMAIL = 'candidate@demo.test';

/**
 * Demo applications for that candidate (FR-10.2, FR-10.3).
 *
 * These cover MORE than the default `(ACTIVE, APPLIED)` that `POST
 * /api/applications` writes, deliberately: nothing in this feature can produce
 * an `INTERVIEW` stage or a `REJECTED` status — stage transitions belong to a
 * later feature — so without seeded rows the frontend's badge states and the
 * brief's own `Status: Interview` example would be unrenderable.
 *
 * Keyed by role title because `Role.id` is not stable across a reseed.
 *
 * Each entry names a DIFFERENT role: one application per candidate per
 * requisition is a unique index now, so two rows for the same title would make
 * the seed fail on `P2002`. The rejected one hangs off the CLOSED requisition,
 * which is also the more realistic story — the req was closed after the fact.
 */
const SEED_APPLICATIONS = [
  {
    roleTitle: 'Senior Backend Engineer',
    status: ApplicationStatus.ACTIVE,
    currentStage: PipelineStage.INTERVIEW,
    daysAgo: 1,
  },
  {
    roleTitle: 'Product Designer',
    status: ApplicationStatus.ACTIVE,
    currentStage: PipelineStage.APPLIED,
    daysAgo: 3,
  },
  {
    roleTitle: 'Engineering Manager',
    status: ApplicationStatus.REJECTED,
    currentStage: PipelineStage.SCREEN,
    daysAgo: 30,
  },
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

  // Applications come LAST — they reference both a user and a role (FR-10.2).
  //
  // Idempotency here is DELETE-then-CREATE. `(candidateUserId, roleId)` is now
  // unique, so an upsert would work — but it would leave behind any application
  // this candidate made by hand to a role the seed no longer lists, and the
  // point of a reseed is to restore a known baseline, not merge into one.
  // Scoped to the seeded candidate, so a hand-created candidate's applications
  // survive a reseed (FR-10.4, AC-B55).
  const candidate = await prisma.user.findUnique({
    where: { email: SEED_CANDIDATE_EMAIL },
    select: { id: true },
  });

  if (candidate === null) {
    throw new Error(
      `Seeded candidate ${SEED_CANDIDATE_EMAIL} is missing — account seeding failed.`,
    );
  }

  const removed = await prisma.application.deleteMany({
    where: { candidateUserId: candidate.id },
  });

  if (removed.count > 0) {
    logger.info(
      { event: 'application.seed_cleared', count: removed.count, source: 'seed' },
      'cleared previously seeded applications',
    );
  }

  for (const seed of SEED_APPLICATIONS) {
    const role = await prisma.role.findFirst({
      where: { title: seed.roleTitle },
      select: { id: true },
    });

    if (role === null) {
      throw new Error(`Seeded role "${seed.roleTitle}" is missing — role seeding failed.`);
    }

    // Backdated so "Applied: …" and the ageing column have a realistic spread
    // rather than three identical timestamps.
    const at = new Date(Date.now() - seed.daysAgo * 24 * 60 * 60 * 1000);

    const application = await prisma.application.create({
      data: {
        candidateUserId: candidate.id,
        roleId: role.id,
        status: seed.status,
        currentStage: seed.currentStage,
        stageEnteredAt: at,
        createdAt: at,
      },
      select: APPLICATION_SELECT,
    });

    logger.info(
      // `application.seeded`, NOT `application.created`: the latter is the
      // request-path audit event (FR-5.9). Ids only, as there.
      {
        event: 'application.seeded',
        applicationId: application.id,
        candidateUserId: candidate.id,
        roleId: role.id,
        status: application.status,
        currentStage: application.currentStage,
        source: 'seed',
      },
      `seeded application: ${seed.roleTitle}`,
    );
  }
}

try {
  await main();
  logger.info(
    {
      accounts: SEED_ACCOUNTS.length,
      roles: SEED_ROLES.length,
      applications: SEED_APPLICATIONS.length,
    },
    'seed complete',
  );
} catch (error) {
  logger.error({ err: error }, 'seed failed');
  await disconnect();
  process.exit(1);
}

await disconnect();
