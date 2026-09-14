import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * The single `PrismaClient` for the process.
 *
 * Prisma 7 requires an explicit driver adapter — the client no longer reads
 * `datasource.url` at runtime, which is why the connection string is passed
 * here rather than in `schema.prisma` (that block now only serves the CLI).
 */
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
