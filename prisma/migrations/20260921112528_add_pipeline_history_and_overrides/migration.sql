-- CreateTable
CREATE TABLE "StageHistory" (
    "id" SERIAL NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "fromStage" "PipelineStage",
    "toStage" "PipelineStage" NOT NULL,
    "fromStatus" "ApplicationStatus",
    "toStatus" "ApplicationStatus" NOT NULL,
    "changedByUserId" INTEGER NOT NULL,
    "overrideId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageOverride" (
    "id" SERIAL NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "fromStage" "PipelineStage" NOT NULL,
    "toStage" "PipelineStage" NOT NULL,
    "reason" TEXT NOT NULL,
    "performedByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StageOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StageHistory_overrideId_key" ON "StageHistory"("overrideId");

-- CreateIndex
CREATE INDEX "StageHistory_applicationId_createdAt_idx" ON "StageHistory"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "StageOverride_applicationId_createdAt_idx" ON "StageOverride"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "Application_status_roleId_currentStage_idx" ON "Application"("status", "roleId", "currentStage");

-- AddForeignKey
ALTER TABLE "StageHistory" ADD CONSTRAINT "StageHistory_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageHistory" ADD CONSTRAINT "StageHistory_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageHistory" ADD CONSTRAINT "StageHistory_overrideId_fkey" FOREIGN KEY ("overrideId") REFERENCES "StageOverride"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageOverride" ADD CONSTRAINT "StageOverride_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageOverride" ADD CONSTRAINT "StageOverride_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill (MIG-5). One entry row per application that already exists, so a
-- pre-existing application's timeline is not blank and a reader cannot mistake
-- "history never captured" for "nothing ever happened".
--
-- The actor is the candidate themselves: entry into APPLIED is the act of
-- applying, and it is the one transition this API does not attribute to a
-- recruiter. `createdAt` is the application's own, not now(), so the
-- reconstructed row sits where it belongs in the timeline.
--
-- This backfills StageHistory ONLY. It invents no AuditLog rows (audit MIG-7):
-- history is a reconstruction of known facts, an audit trail is a record of
-- observed actions, and manufacturing the second would be a lie about what was
-- seen.
--
-- Guarded by NOT EXISTS so re-running against a partially-migrated database
-- cannot double-write.
INSERT INTO "StageHistory" (
    "applicationId", "fromStage", "toStage", "fromStatus", "toStatus", "changedByUserId", "createdAt"
)
SELECT a."id", NULL, 'APPLIED', NULL, 'ACTIVE', a."candidateUserId", a."createdAt"
  FROM "Application" a
 WHERE NOT EXISTS (
     SELECT 1 FROM "StageHistory" h WHERE h."applicationId" = a."id"
 );
