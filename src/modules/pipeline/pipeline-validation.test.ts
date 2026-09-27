import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../app.js';
import { prisma, disconnect } from '../../lib/prisma.js';
import { UserRole } from '../../../generated/prisma/enums.js';
import { authHeader, upsertTestUser } from '../../test/auth.js';

describe('pipeline validation', () => {
  let recruiterId: number;
  let applicationId: number;
  let roleId: number;

  beforeAll(async () => {
    const recruiter = await upsertTestUser({
      email: 'vitest-recruiter@demo.test',
      name: 'Vitest Recruiter',
      role: UserRole.RECRUITER,
    });

    const candidate = await upsertTestUser({
      email: 'vitest-pipeline-candidate@demo.test',
      name: 'Pipeline Candidate',
      role: UserRole.CANDIDATE,
    });

    const role = await prisma.role.create({
      data: {
        title: 'Vitest Pipeline Role',
        description: 'Used to create a real invalid-stage fixture.',
        status: 'OPEN',
      },
    });

    const application = await prisma.application.create({
      data: {
        candidateUserId: candidate.id,
        roleId: role.id,
        status: 'ACTIVE',
        currentStage: 'APPLIED',
        stageEnteredAt: new Date(),
      },
    });

    recruiterId = recruiter.id;
    applicationId = application.id;
    roleId = role.id;
  });

  afterAll(async () => {
    await prisma.application.deleteMany({
      where: {
        id: applicationId,
      },
    });

    await prisma.role.deleteMany({
      where: {
        id: roleId,
      },
    });

    await prisma.user.deleteMany({
      where: {
        id: recruiterId,
      },
    });

    await disconnect();
  });

  it('rejects an undefined stage name before business logic', async () => {
    const response = await request(app)
      .patch(`/api/applications/${applicationId}/stage`)
      .set(authHeader(recruiterId, UserRole.RECRUITER))
      .send({ toStage: 'PROBATION' })
      .expect(400);

    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Invalid request body',
    });
    expect(response.body.details).toHaveProperty('toStage');
  });
});
