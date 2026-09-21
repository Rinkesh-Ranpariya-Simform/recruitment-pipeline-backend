import { env } from '../src/config/env.js';
import {
  ApplicationStatus,
  AuditAction,
  AuditEntityType,
  PipelineStage,
  RoleStatus,
  UserRole,
} from '../src/generated/prisma/enums.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/lib/password.js';
import { disconnect, prisma } from '../src/lib/prisma.js';
import { APPLICATION_SELECT } from '../src/modules/applications/application.select.js';
import { recordAudit } from '../src/modules/audit/audit.service.js';
import { stagesSkipped } from '../src/modules/pipeline/pipeline.rules.js';
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
 * The actor on every seeded audit row (audit spec FR-2.3, FR-7.2).
 *
 * The seed is the SINGLE exception to "the actor is always `req.user.id`"
 * (FR-2.1) and the SINGLE writer that calls `recordAudit` outside an HTTP
 * request (FR-7.3) - the second exception this file carries, alongside the
 * check-then-write note on the role loop above. A demo database with an empty
 * audit table teaches the wrong thing about the feature.
 */
const SEED_AUDIT_ACTOR_EMAIL = 'recruiter@demo.test';

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
 * The timeline behind each seeded application (audit FR-7.1, pipeline FR-10.3).
 *
 * These are the steps that EXPLAIN the seeded state rather than inventing a
 * separate history: `SEED_APPLICATIONS` places one application at `INTERVIEW`
 * and one at `REJECTED`/`SCREEN`, and a database that shows those states with
 * no account of how they were reached is worse than one with no trace at all.
 *
 * **One declaration drives three tables.** Each step below produces its
 * `StageHistory` row, its `StageOverride` row where there is one, and its
 * `AuditLog` row — from the same literal, in the same transaction, through the
 * same `recordAudit` a request path uses. Declaring the history and the audit
 * trace separately would let a reseed produce two accounts of one application
 * that disagree, which is precisely the state these tables exist to rule out.
 *
 * It also closes the placeholder the audit feature shipped with: the seeded
 * override's `overrideId` was a hard-coded `1` naming a row in a table that did
 * not exist yet. It is now the real row's id, read back from the insert.
 *
 * Keyed by role title, matching `SEED_APPLICATIONS`, because `Role.id` and
 * `Application.id` are not stable across a reseed.
 *
 * Listed in CHRONOLOGICAL order and applied in that order. Every seeded row
 * shares roughly one `createdAt` — neither `recordAudit` nor these inserts take
 * a timestamp, because the column is the database's `now()` and never a
 * caller's (audit FR-1.6) — so the feed's `id desc` tiebreak is what actually
 * orders them (FR-5.1). Applying oldest-first is what makes the newest-first
 * feed read correctly.
 *
 * "Product Designer" appears here with NO steps, deliberately: it is the
 * application that proves an entity with no audit trace answers
 * `200 { entries: [] }` rather than a 404 (AC-B06). It still gets the entry
 * `StageHistory` row every application gets — a blank timeline and a blank
 * audit feed are different facts (pipeline AC-B49).
 */
interface SeedStageStep {
  kind: 'stage';
  fromStage: PipelineStage;
  toStage: PipelineStage;
}

/** A skip, with the reason that makes it accountable (brief §3.3). */
interface SeedOverrideStep {
  kind: 'override';
  fromStage: PipelineStage;
  toStage: PipelineStage;
  reason: string;
}

/** A terminal outcome. It does NOT move the stage (pipeline FR-3.5). */
interface SeedOutcomeStep {
  kind: 'outcome';
  atStage: PipelineStage;
  toStatus: typeof ApplicationStatus.HIRED | typeof ApplicationStatus.REJECTED;
}

type SeedTimelineStep = SeedStageStep | SeedOverrideStep | SeedOutcomeStep;

const SEED_TIMELINES: ReadonlyArray<{
  roleTitle: string;
  steps: ReadonlyArray<SeedTimelineStep>;
}> = [
  {
    roleTitle: 'Senior Backend Engineer',
    steps: [
      { kind: 'stage', fromStage: PipelineStage.APPLIED, toStage: PipelineStage.SCREEN },
      { kind: 'stage', fromStage: PipelineStage.SCREEN, toStage: PipelineStage.INTERVIEW },
    ],
  },
  {
    roleTitle: 'Engineering Manager',
    steps: [
      /**
       * The one seeded override, and the only free text anywhere in the seeded
       * data (audit FR-4.5, AC-B25). Without it there is no `reason` in the
       * database to check that claim against, and the recruiter feed has
       * nothing to show for the brief's §3.3 requirement.
       *
       * `skipped` works out to 0: `APPLIED → SCREEN` is a move the graph would
       * have allowed anyway, which the override path permits and records as
       * such (pipeline FR-4.5). That is the more interesting demo row of the
       * two — it shows the distinction is captured rather than assumed.
       */
      {
        kind: 'override',
        fromStage: PipelineStage.APPLIED,
        toStage: PipelineStage.SCREEN,
        reason: 'Candidate completed an equivalent external screening; skipping ours.',
      },
      {
        kind: 'outcome',
        atStage: PipelineStage.SCREEN,
        toStatus: ApplicationStatus.REJECTED,
      },
    ],
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

  const auditActor = await prisma.user.findUnique({
    where: { email: SEED_AUDIT_ACTOR_EMAIL },
    select: { id: true },
  });

  if (candidate === null) {
    throw new Error(
      `Seeded candidate ${SEED_CANDIDATE_EMAIL} is missing — account seeding failed.`,
    );
  }

  if (auditActor === null) {
    throw new Error(
      `Seeded audit actor ${SEED_AUDIT_ACTOR_EMAIL} is missing — account seeding failed.`,
    );
  }

  // The seeded applications' audit rows go FIRST, before the applications
  // themselves are deleted, because the ids are the only thing linking them:
  // `AuditLog.entityId` is deliberately not a foreign key (FR-1.5), so nothing
  // in the database would clean these up on its own.
  //
  // Scoped to exactly the application ids about to be removed - not to
  // `entityType: APPLICATION` wholesale, and not to the recruiter's rows -
  // so a reseed cannot erase a trace this seed did not write (FR-7.2, EC-11).
  // This is the ONLY code path in the repository that deletes an audit row,
  // and it is a local reset script, not a request path (FR-6.1).
  const doomed = await prisma.application.findMany({
    where: { candidateUserId: candidate.id },
    select: { id: true },
  });

  if (doomed.length > 0) {
    const clearedAudit = await prisma.auditLog.deleteMany({
      where: {
        entityType: AuditEntityType.APPLICATION,
        entityId: { in: doomed.map((application) => application.id) },
      },
    });

    if (clearedAudit.count > 0) {
      logger.info(
        { event: 'audit.seed_cleared', count: clearedAudit.count, source: 'seed' },
        'cleared previously seeded audit entries',
      );
    }
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

    // The application and its trace are written in ONE transaction, the same
    // rule every request path will follow (audit FR-3.2): a seeded application
    // with half a history is the exact state the feature exists to make
    // impossible, and a seed that can produce it is a seed that misrepresents
    // the invariant.
    const application = await prisma.$transaction(async (tx) => {
      const created = await tx.application.create({
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

      // The ENTRY row, for EVERY seeded application including the one with no
      // timeline (pipeline FR-5.3, AC-B49). `fromStage`/`fromStatus` are null
      // here and only here, and the actor is the candidate: entry into APPLIED
      // is the act of applying. Mirrors what `POST /api/applications` now writes
      // inside its own transaction (pipeline FR-9.1).
      await tx.stageHistory.create({
        data: {
          applicationId: created.id,
          fromStage: null,
          toStage: PipelineStage.APPLIED,
          fromStatus: null,
          toStatus: ApplicationStatus.ACTIVE,
          changedByUserId: candidate.id,
          overrideId: null,
          createdAt: at,
        },
        select: { id: true },
      });

      const timeline = SEED_TIMELINES.find((entry) => entry.roleTitle === seed.roleTitle);

      for (const step of timeline?.steps ?? []) {
        // Each step writes its history row and its audit row together, exactly
        // as the request path does. `recordAudit` is called rather than a direct
        // `tx.auditLog.create` - the seed is the one writer outside a request,
        // but it is still not allowed a second way of creating a row (audit
        // FR-3.1, FR-7.3).
        if (step.kind === 'override') {
          // The override row FIRST, then the history row that points at it -
          // the same order the service uses, so the seeded rows are
          // indistinguishable in shape from ones a recruiter produced
          // (pipeline FR-4.7).
          const override = await tx.stageOverride.create({
            data: {
              applicationId: created.id,
              fromStage: step.fromStage,
              toStage: step.toStage,
              reason: step.reason,
              performedByUserId: auditActor.id,
              createdAt: at,
            },
            select: { id: true },
          });

          await tx.stageHistory.create({
            data: {
              applicationId: created.id,
              fromStage: step.fromStage,
              toStage: step.toStage,
              fromStatus: ApplicationStatus.ACTIVE,
              toStatus: ApplicationStatus.ACTIVE,
              changedByUserId: auditActor.id,
              overrideId: override.id,
              createdAt: at,
            },
            select: { id: true },
          });

          await recordAudit(
            tx,
            {
              action: AuditAction.STAGE_OVERRIDE_CREATED,
              entityType: AuditEntityType.APPLICATION,
              entityId: created.id,
              actorUserId: auditActor.id,
              metadata: {
                fromStage: step.fromStage,
                toStage: step.toStage,
                reason: step.reason,
                // The REAL row's id, replacing the hard-coded `1` the audit
                // feature had to ship before this table existed.
                overrideId: override.id,
                // Computed from the canonical order rather than written down,
                // so the seeded row cannot claim a skip count the stages
                // contradict (pipeline FR-4.8).
                skipped: stagesSkipped(step.fromStage, step.toStage),
              },
            },
            logger,
          );
          continue;
        }

        if (step.kind === 'outcome') {
          // `fromStage === toStage`: an outcome moves the status, not the stage
          // (pipeline FR-3.5, FR-3.7).
          await tx.stageHistory.create({
            data: {
              applicationId: created.id,
              fromStage: step.atStage,
              toStage: step.atStage,
              fromStatus: ApplicationStatus.ACTIVE,
              toStatus: step.toStatus,
              changedByUserId: auditActor.id,
              overrideId: null,
              createdAt: at,
            },
            select: { id: true },
          });

          await recordAudit(
            tx,
            {
              action: AuditAction.APPLICATION_OUTCOME_SET,
              entityType: AuditEntityType.APPLICATION,
              entityId: created.id,
              actorUserId: auditActor.id,
              metadata: {
                fromStatus: ApplicationStatus.ACTIVE,
                toStatus: step.toStatus,
                atStage: step.atStage,
              },
            },
            logger,
          );
          continue;
        }

        await tx.stageHistory.create({
          data: {
            applicationId: created.id,
            fromStage: step.fromStage,
            toStage: step.toStage,
            fromStatus: ApplicationStatus.ACTIVE,
            toStatus: ApplicationStatus.ACTIVE,
            changedByUserId: auditActor.id,
            overrideId: null,
            createdAt: at,
          },
          select: { id: true },
        });

        await recordAudit(
          tx,
          {
            action: AuditAction.CANDIDATE_STAGE_CHANGED,
            entityType: AuditEntityType.APPLICATION,
            entityId: created.id,
            actorUserId: auditActor.id,
            metadata: { fromStage: step.fromStage, toStage: step.toStage },
          },
          logger,
        );
      }

      return created;
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
      timelineSteps: SEED_TIMELINES.reduce((count, trace) => count + trace.steps.length, 0),
    },
    'seed complete',
  );
} catch (error) {
  logger.error({ err: error }, 'seed failed');
  await disconnect();
  process.exit(1);
}

await disconnect();
