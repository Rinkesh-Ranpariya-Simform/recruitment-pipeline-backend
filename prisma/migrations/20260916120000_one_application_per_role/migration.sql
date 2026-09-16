-- One application per candidate per requisition.
--
-- Reverses the POC allowance for repeat applies (D-6). A candidate may still
-- apply to any number of DIFFERENT roles; the constraint is on the pair.

-- Existing duplicates must go before the index can be built. The EARLIEST row
-- per (candidateUserId, roleId) survives — it carries the date the candidate
-- actually first applied, which is the one the pipeline ages from.
--
-- This is safe to run as a plain delete because no write path in the
-- application updates `status`, `currentStage` or `stageEnteredAt` after the
-- insert: every duplicate is byte-identical to the row that survives apart from
-- `id` and `createdAt`. If a stage-advance path ever lands BEFORE this
-- migration is applied somewhere, revisit this — the row to keep would then be
-- the furthest along, not the oldest.
DELETE FROM "Application" a
USING "Application" b
WHERE a."candidateUserId" = b."candidateUserId"
  AND a."roleId" = b."roleId"
  AND a."id" > b."id";

-- CreateIndex
CREATE UNIQUE INDEX "Application_candidateUserId_roleId_key" ON "Application"("candidateUserId", "roleId");
