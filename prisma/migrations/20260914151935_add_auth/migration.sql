/*
  MIG-1 — DESTRUCTIVE / NON-BACKWARD-COMPATIBLE MIGRATION. Read before applying.

  `passwordHash` and `role` are NOT NULL columns added to an existing `User`
  table with no default value (`role` deliberately has no default — MIG-2 — so
  that no code path can silently mint a privileged account).

  Consequence: this migration only applies to an EMPTY `User` table. Against a
  table holding rows it ABORTS; it does not truncate and it does not invent
  values. Any pre-existing `User` data must therefore be dropped by the operator
  before applying, and is not recoverable from this migration.

  This was safe to author because the only `User` rows that have ever existed
  came from the placeholder scaffold in `20260914094336_init`, which no
  application code ever wrote to. The table was verified empty (0 rows)
  immediately before this migration was generated.

  If a non-empty deployed `User` table ever exists, do NOT reuse this migration.
  Replace it with three steps: add the columns nullable -> backfill -> set NOT NULL.
*/
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('INTERVIEWER', 'RECRUITER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordHash" TEXT NOT NULL,
ADD COLUMN     "role" "Role" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
