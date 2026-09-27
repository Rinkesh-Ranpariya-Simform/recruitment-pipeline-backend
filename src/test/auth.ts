import { UserRole } from '../../generated/prisma/enums.js';
import { prisma } from '../lib/prisma.js';
import { signAccessToken } from '../lib/tokens.js';

export async function upsertTestUser(options: {
  email: string;
  name: string;
  role: UserRole;
  passwordHash?: string;
}) {
  return prisma.user.upsert({
    where: { email: options.email },
    update: {
      name: options.name,
      role: options.role,
      passwordHash: options.passwordHash ?? 'unused-for-tests',
    },
    create: {
      email: options.email,
      name: options.name,
      role: options.role,
      passwordHash: options.passwordHash ?? 'unused-for-tests',
    },
  });
}

export function authHeader(userId: number, role: UserRole): Record<'Authorization', string> {
  return {
    Authorization: `Bearer ${signAccessToken({ sub: userId, role }).token}`,
  };
}
