-- CreateTable
CREATE TABLE "Feedback" (
    "id" SERIAL NOT NULL,
    "interviewId" INTEGER NOT NULL,
    "interviewerId" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "notes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Feedback_interviewId_createdAt_idx" ON "Feedback"("interviewId", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_interviewerId_idx" ON "Feedback"("interviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_interviewId_interviewerId_key" ON "Feedback"("interviewId", "interviewerId");

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_interviewerId_fkey" FOREIGN KEY ("interviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- APPENDED BY HAND (feedback MIG-4). Prisma has no schema-level attribute for a
-- CHECK constraint, and zod guards only the HTTP boundary: the seed, `psql` and
-- any future admin path would otherwise be free to write a 0 or a 99. Nothing
-- above this line was rewritten — the statement is added, and the generated SQL
-- is left exactly as Prisma emitted it.
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_rating_check" CHECK ("rating" >= 1 AND "rating" <= 5);
