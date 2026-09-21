-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CANDIDATE_STAGE_CHANGED', 'STAGE_OVERRIDE_CREATED', 'APPLICATION_OUTCOME_SET', 'INTERVIEW_CREATED', 'INTERVIEWER_ASSIGNED', 'INTERVIEWER_UNASSIGNED', 'FEEDBACK_SUBMITTED', 'FEEDBACK_UPDATED', 'CANDIDATE_CONTACT_UPDATED');

-- CreateEnum
CREATE TYPE "AuditEntityType" AS ENUM ('APPLICATION', 'INTERVIEW', 'FEEDBACK', 'CANDIDATE');

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "actorUserId" INTEGER NOT NULL,
    "action" "AuditAction" NOT NULL,
    "entityType" "AuditEntityType" NOT NULL,
    "entityId" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
