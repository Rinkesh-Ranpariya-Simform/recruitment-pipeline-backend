-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('APPLIED', 'SCREEN', 'INTERVIEW', 'OFFER');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('ACTIVE', 'HIRED', 'REJECTED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'CANDIDATE';

-- CreateTable
CREATE TABLE "Application" (
    "id" SERIAL NOT NULL,
    "candidateUserId" INTEGER NOT NULL,
    "roleId" INTEGER NOT NULL,
    "status" "ApplicationStatus" NOT NULL,
    "currentStage" "PipelineStage" NOT NULL,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Application_candidateUserId_createdAt_idx" ON "Application"("candidateUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Application_roleId_currentStage_idx" ON "Application"("roleId", "currentStage");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
