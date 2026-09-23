import { env } from '../src/config/env.js';
import {
  ApplicationStatus,
  AuditAction,
  AuditEntityType,
  InterviewStatus,
  InterviewType,
  PipelineStage,
  RoleStatus,
  UserRole,
} from '../src/generated/prisma/enums.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/lib/password.js';
import { disconnect, prisma } from '../src/lib/prisma.js';
import { APPLICATION_SELECT } from '../src/modules/applications/application.select.js';
import { recordAudit } from '../src/modules/audit/audit.service.js';
import { FEEDBACK_SELECT } from '../src/modules/feedback/feedback.select.js';
import { ASSIGNMENT_SELECT } from '../src/modules/interviews/interview.select.js';
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

/**
 * Demo interview rounds and their panels (interviews FR-7.3).
 *
 * Two rounds, and the SHAPE of the pair is the point rather than the rounds
 * themselves:
 *
 *   - **Technical, on the `INTERVIEW`-stage application, with BOTH seeded
 *     interviewers.** This is the panel the brief's §3.4 concurrent-feedback
 *     case needs, demonstrable out of the box.
 *   - **System Design, on a second application, with `interviewer1` ONLY.** So
 *     that `interviewer2` has a real, live round they are **not** on. That is
 *     the round AC-B18 fires against — without it, "an interviewer requesting a
 *     round outside their assignment" has nothing to request, and the sharpest
 *     check in the POC is unverifiable on a fresh database.
 *
 * Its `stage` is `SCREEN` while that application sits at `APPLIED`, deliberately
 * (D-13, FR-1.4): a round's stage is what it is FOR, not an assertion about now,
 * and the seed should show that rather than only describe it.
 *
 * Keyed by role title, matching `SEED_APPLICATIONS`, because neither `Role.id`
 * nor `Application.id` is stable across a reseed. Interviewers are keyed by
 * email for the same reason.
 */
const SEED_INTERVIEWS: ReadonlyArray<{
  roleTitle: string;
  type: InterviewType;
  stage: PipelineStage;
  inDays: number;
  interviewerEmails: ReadonlyArray<string>;
  /// Feedback already on the round (feedback FR-7.3). Each author must also
  /// appear in `interviewerEmails` above - the seed refuses to write an
  /// assessment from somebody who is not on the panel, because the request path
  /// cannot either (feedback FR-1.1).
  feedback: ReadonlyArray<{ interviewerEmail: string; rating: number; notes: string }>;
}> = [
  {
    roleTitle: 'Senior Backend Engineer',
    type: InterviewType.TECHNICAL,
    stage: PipelineStage.INTERVIEW,
    inDays: 2,
    interviewerEmails: ['interviewer1@demo.test', 'interviewer2@demo.test'],
    // ONE entry, from ONE of the two panellists (feedback FR-7.3). The asymmetry
    // is the point: `interviewer2` is assigned to this round and has written
    // nothing, so a fresh database demonstrates BOTH the "read a colleague's
    // prior feedback before your own round" case - the brief's opening
    // complaint - and the "submit your own" case, with no setup.
    feedback: [
      {
        interviewerEmail: 'interviewer1@demo.test',
        rating: 4,
        notes:
          'Strong backend fundamentals. Walked through the indexing trade-offs unprompted; ' +
          'less confident explaining isolation levels under concurrent writes.',
      },
    ],
  },
  {
    roleTitle: 'Product Designer',
    type: InterviewType.SYSTEM_DESIGN,
    stage: PipelineStage.SCREEN,
    inDays: 4,
    interviewerEmails: ['interviewer1@demo.test'],
    // Deliberately empty. This is the round `interviewer2` is NOT on, so it is
    // what the assignment gate is verified against - and a 404 there must not be
    // confusable with "the round happens to have no feedback".
    feedback: [],
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

  // The panel members `SEED_INTERVIEWS` names, resolved once by email because
  // `User.id` is not stable across a reseed. Scoped to `role: INTERVIEWER` in
  // the `where` rather than checked afterwards, exactly as
  // `assignInterviewer` does it (interviews FR-3.3) — a seed that could staff a
  // recruiter onto a panel would be seeding a state the API refuses to create.
  const interviewerEmails = [...new Set(SEED_INTERVIEWS.flatMap((seed) => seed.interviewerEmails))];

  const interviewers = await prisma.user.findMany({
    where: { email: { in: interviewerEmails }, role: UserRole.INTERVIEWER },
    select: { id: true, email: true },
  });

  const interviewerIdByEmail = new Map(
    interviewers.map((interviewer) => [interviewer.email, interviewer.id]),
  );

  for (const email of interviewerEmails) {
    if (!interviewerIdByEmail.has(email)) {
      throw new Error(`Seeded interviewer ${email} is missing — account seeding failed.`);
    }
  }

  // The seed must not write an assessment from somebody who is not on the panel:
  // the request path cannot, because the assignment IS the authorization
  // (feedback FR-1.1), and a seed that could would misrepresent the rule on a
  // fresh database. Checked here, before any application is touched.
  for (const round of SEED_INTERVIEWS) {
    for (const entry of round.feedback) {
      if (!round.interviewerEmails.includes(entry.interviewerEmail)) {
        throw new Error(
          `Seeded feedback author ${entry.interviewerEmail} is not on the ${round.type} panel — ` +
            'the assignment is the authorization (feedback FR-1.1).',
        );
      }
    }
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
    const doomedApplicationIds = doomed.map((application) => application.id);

    // The rounds on those applications will CASCADE away with them (interviews
    // MIG-6), but their audit rows will not: `AuditLog.entityId` is deliberately
    // not a foreign key (audit FR-1.5), so nothing in the database cleans them
    // up. Collected BEFORE the delete, because afterwards there is no way left
    // to learn which INTERVIEW ids belonged to this seed.
    //
    // Scoped to exactly those ids — never to `entityType: INTERVIEW` wholesale —
    // so a reseed cannot erase the trace of a round somebody scheduled by hand
    // (audit FR-7.2, EC-11).
    const doomedInterviews = await prisma.interview.findMany({
      where: { applicationId: { in: doomedApplicationIds } },
      select: { id: true },
    });

    // Feedback cascades away with its round (feedback MIG-5), and its audit rows
    // do not — for the same reason the rounds' do not. Collected here, before
    // the delete, and scoped to exactly these ids so that a reseed cannot erase
    // the trace of an assessment somebody filed by hand (audit FR-7.2).
    const doomedFeedback = await prisma.feedback.findMany({
      where: { interviewId: { in: doomedInterviews.map((interview) => interview.id) } },
      select: { id: true },
    });

    const clearedAudit = await prisma.auditLog.deleteMany({
      where: {
        OR: [
          {
            entityType: AuditEntityType.APPLICATION,
            entityId: { in: doomedApplicationIds },
          },
          {
            entityType: AuditEntityType.INTERVIEW,
            entityId: { in: doomedInterviews.map((interview) => interview.id) },
          },
          {
            entityType: AuditEntityType.FEEDBACK,
            entityId: { in: doomedFeedback.map((feedback) => feedback.id) },
          },
        ],
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

      // The rounds on this application, and their panels (interviews FR-7.3).
      //
      // Inside the SAME transaction as the application, its history and its
      // audit trace: every write in this feature is one transaction holding its
      // row change and its `recordAudit` call (interviews BE-7), and a seed that
      // could produce a round with no audit row would misrepresent that
      // invariant exactly as a half-written history would.
      //
      // `status` is the SCHEDULED literal, not a schema default, and
      // `createdByUserId`/`assignedByUserId` are the recruiter — the same values
      // the request path writes from `req.user.id` (interviews FR-1.5, AZ-7).
      for (const round of SEED_INTERVIEWS.filter((entry) => entry.roleTitle === seed.roleTitle)) {
        const interview = await tx.interview.create({
          data: {
            applicationId: created.id,
            type: round.type,
            stage: round.stage,
            scheduledAt: new Date(Date.now() + round.inDays * 24 * 60 * 60 * 1000),
            status: InterviewStatus.SCHEDULED,
            createdByUserId: auditActor.id,
            createdAt: at,
          },
          select: { id: true, type: true, stage: true, scheduledAt: true },
        });

        await recordAudit(
          tx,
          {
            action: AuditAction.INTERVIEW_CREATED,
            entityType: AuditEntityType.INTERVIEW,
            entityId: interview.id,
            actorUserId: auditActor.id,
            metadata: {
              applicationId: created.id,
              type: interview.type,
              stage: interview.stage,
              scheduledAt: interview.scheduledAt.toISOString(),
            },
          },
          logger,
        );

        for (const email of round.interviewerEmails) {
          // Non-null: every email in `SEED_INTERVIEWS` was resolved and checked
          // above, before any application was touched.
          const interviewerId = interviewerIdByEmail.get(email) as number;

          const assignment = await tx.interviewAssignment.create({
            data: {
              interviewId: interview.id,
              interviewerId,
              assignedByUserId: auditActor.id,
              createdAt: at,
            },
            select: ASSIGNMENT_SELECT,
          });

          await recordAudit(
            tx,
            {
              action: AuditAction.INTERVIEWER_ASSIGNED,
              entityType: AuditEntityType.INTERVIEW,
              entityId: interview.id,
              actorUserId: auditActor.id,
              metadata: { interviewerId },
            },
            logger,
          );

          logger.info(
            // Ids and enum values only — never the interviewer's name or email
            // (interviews FR-7.2).
            {
              event: 'interview.seeded_assignment',
              interviewId: interview.id,
              assignmentId: assignment.id,
              targetUserId: interviewerId,
              source: 'seed',
            },
            'seeded interview assignment',
          );
        }

        // The round's existing feedback (feedback FR-7.3).
        //
        // Inside the SAME transaction as the round and its panel, holding its
        // `recordAudit` call beside the insert — every write in that feature is
        // one transaction (feedback BE-7), and a seeded assessment with no audit
        // row would misrepresent the invariant.
        //
        // `interviewerId` is the panellist's own id, exactly as the request path
        // writes `req.user.id` (feedback FR-2.5, AZ-8); `rating` passes the
        // CHECK constraint the migration added, which is what makes that
        // constraint a real second line of defence rather than decoration
        // (feedback MIG-4).
        for (const entry of round.feedback) {
          // Non-null: every author was resolved and checked against the panel
          // above, before any application was touched.
          const authorId = interviewerIdByEmail.get(entry.interviewerEmail) as number;

          const feedback = await tx.feedback.create({
            data: {
              interviewId: interview.id,
              interviewerId: authorId,
              rating: entry.rating,
              notes: entry.notes,
              createdAt: at,
            },
            select: FEEDBACK_SELECT,
          });

          await recordAudit(
            tx,
            {
              action: AuditAction.FEEDBACK_SUBMITTED,
              entityType: AuditEntityType.FEEDBACK,
              entityId: feedback.id,
              actorUserId: authorId,
              // The rating, never the notes — the same metadata the request path
              // writes (feedback FR-2.8, audit FR-4.4).
              metadata: { interviewId: interview.id, rating: feedback.rating },
            },
            logger,
          );

          logger.info(
            // Ids and the rating only. The notes are never logged, here or on
            // the request path (feedback FR-7.2, SEC-5).
            {
              event: 'feedback.seeded',
              interviewId: interview.id,
              feedbackId: feedback.id,
              authorUserId: authorId,
              rating: feedback.rating,
              source: 'seed',
            },
            'seeded interview feedback',
          );
        }

        logger.info(
          {
            event: 'interview.seeded',
            interviewId: interview.id,
            applicationId: created.id,
            type: interview.type,
            stage: interview.stage,
            panelSize: round.interviewerEmails.length,
            feedbackCount: round.feedback.length,
            source: 'seed',
          },
          `seeded interview: ${round.type} on ${seed.roleTitle}`,
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
      interviews: SEED_INTERVIEWS.length,
      assignments: SEED_INTERVIEWS.reduce(
        (count, round) => count + round.interviewerEmails.length,
        0,
      ),
      feedback: SEED_INTERVIEWS.reduce((count, round) => count + round.feedback.length, 0),
    },
    'seed complete',
  );
} catch (error) {
  logger.error({ err: error }, 'seed failed');
  await disconnect();
  process.exit(1);
}

await disconnect();
