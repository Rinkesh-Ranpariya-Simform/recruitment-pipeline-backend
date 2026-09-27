import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../app.js';
import { prisma, disconnect } from '../../lib/prisma.js';
import { UserRole } from '../../../generated/prisma/enums.js';
import { authHeader, upsertTestUser } from '../../test/auth.js';
import { getInterviewerCandidate } from './candidate.repository.js';

describe('candidate access authorization', () => {
  let interviewerId: number;
  let assignedCandidateId: number;
  let unassignedCandidateId: number;
  let createdRoleId: number;

  beforeAll(async () => {
    const interviewer = await upsertTestUser({
      email: 'vitest-interviewer@demo.test',
      name: 'Vitest Interviewer',
      role: UserRole.INTERVIEWER,
    });

    const assignedCandidate = await upsertTestUser({
      email: 'vitest-assigned-candidate@demo.test',
      name: 'Assigned Candidate',
      role: UserRole.CANDIDATE,
    });

    const unassignedCandidate = await upsertTestUser({
      email: 'vitest-unassigned-candidate@demo.test',
      name: 'Unassigned Candidate',
      role: UserRole.CANDIDATE,
    });

    const role = await prisma.role.create({
      data: {
        title: 'Vitest Role',
        description: 'Used to create a real interview assignment fixture.',
        status: 'OPEN',
      },
    });
    createdRoleId = role.id;

    const application = await prisma.application.create({
      data: {
        candidateUserId: assignedCandidate.id,
        roleId: role.id,
        status: 'ACTIVE',
        currentStage: 'APPLIED',
        stageEnteredAt: new Date(),
      },
    });

    const interview = await prisma.interview.create({
      data: {
        applicationId: application.id,
        type: 'TECHNICAL',
        stage: 'INTERVIEW',
        status: 'SCHEDULED',
        createdByUserId: interviewer.id,
      },
    });

    await prisma.interviewAssignment.create({
      data: {
        interviewId: interview.id,
        interviewerId: interviewer.id,
        assignedByUserId: interviewer.id,
      },
    });

    interviewerId = interviewer.id;
    assignedCandidateId = assignedCandidate.id;
    unassignedCandidateId = unassignedCandidate.id;
  });

  afterAll(async () => {
    await prisma.interviewAssignment.deleteMany({
      where: {
        interviewerId: interviewerId,
      },
    });

    await prisma.interview.deleteMany({
      where: {
        createdByUserId: interviewerId,
      },
    });

    await prisma.application.deleteMany({
      where: {
        OR: [
          { roleId: createdRoleId },
          { candidateUserId: assignedCandidateId },
          { candidateUserId: unassignedCandidateId },
        ],
      },
    });

    await prisma.role.deleteMany({
      where: {
        id: createdRoleId,
      },
    });

    await prisma.user.deleteMany({
      where: {
        id: {
          in: [interviewerId, assignedCandidateId, unassignedCandidateId],
        },
      },
    });

    await disconnect();
  });

  it('refuses an interviewer who requests a candidate they are not assigned to by id', async () => {
    const response = await request(app)
      .get(`/api/candidates/${unassignedCandidateId}`)
      .set(authHeader(interviewerId, UserRole.INTERVIEWER))
      .expect(404);

    expect(response.body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Resource not found',
    });
  });

  it('repository refuses a direct lookup for an unassigned candidate', async () => {
    const result = await getInterviewerCandidate(unassignedCandidateId, interviewerId);

    expect(result).toBeNull();
  });

  it('allows an interviewer to read a candidate they are assigned to', async () => {
    const response = await request(app)
      .get(`/api/candidates/${assignedCandidateId}`)
      .set(authHeader(interviewerId, UserRole.INTERVIEWER))
      .expect(200);

    expect(response.body).toMatchObject({
      candidate: {
        id: assignedCandidateId,
      },
    });
  });
});
