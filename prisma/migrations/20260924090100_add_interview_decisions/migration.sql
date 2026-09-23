-- The per-round decision — "selected" or "rejected" at THIS round — and the
-- undated round it is recorded against.
--
-- `scheduledAt` becomes nullable because a round is now created the moment a
-- recruiter decides to run it, before a date exists (applications FR-2.3). The
-- alternative — inventing `now()` as a placeholder — would put a lie in the
-- column that nothing downstream could distinguish from a real time.

-- CreateEnum
CREATE TYPE "InterviewOutcome" AS ENUM ('SELECTED', 'REJECTED');

-- AlterTable
ALTER TABLE "Interview" ALTER COLUMN "scheduledAt" DROP NOT NULL;
ALTER TABLE "Interview" ADD COLUMN "outcome" "InterviewOutcome";
ALTER TABLE "Interview" ADD COLUMN "decidedAt" TIMESTAMP(3);
ALTER TABLE "Interview" ADD COLUMN "decidedByUserId" INTEGER;

-- AddForeignKey
-- `RESTRICT`, matching `Interview.createdBy` and `StageOverride.performedBy`:
-- who decided a round is a historical fact and must not be erasable.
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
-- The stage timeline reads an application's rounds in CREATION order, not in
-- scheduled order: `scheduledAt` is now nullable, so it cannot be the column a
-- timeline is ordered by without undated rounds collapsing to one end of it.
CREATE INDEX "Interview_applicationId_createdAt_idx" ON "Interview"("applicationId", "createdAt");

-- APPENDED BY HAND. Prisma has no schema-level attribute for a CHECK
-- constraint, and the three decision columns must move together: an `outcome`
-- with no actor behind it is exactly the "recorded, not inferred" failure the
-- brief's §3.3 names for overrides, applied to rounds. zod guards only the HTTP
-- boundary; the seed, `psql` and any future admin path go through this.
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_decision_complete_check" CHECK (
  ("outcome" IS NULL AND "decidedAt" IS NULL AND "decidedByUserId" IS NULL)
  OR ("outcome" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL)
);
