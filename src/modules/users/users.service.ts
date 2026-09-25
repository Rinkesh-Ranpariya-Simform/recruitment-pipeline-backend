import { prisma } from '../../lib/prisma.js';
import { UserRole } from '../../../generated/prisma/enums.js';
import type { SafeUser } from '../auth/auth.service.js';
import { SAFE_USER_SELECT } from './user.select.js';

/**
 * This is the module's ENTIRE surface (FR-3.2).
 *
 * There is deliberately no `createUser` here. Account creation lives in
 * `auth.service.signup` and nowhere else — no role, recruiter included, can
 * create another user through the API (FR-2.6, contract invariant 5).
 */
export async function listInterviewers(): Promise<Array<SafeUser>> {
  return prisma.user.findMany({
    where: { role: UserRole.INTERVIEWER },
    orderBy: { createdAt: 'desc' },
    select: SAFE_USER_SELECT,
  });
}
