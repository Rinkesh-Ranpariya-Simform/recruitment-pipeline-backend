-- One statement, in its own migration, and that separation is deliberate.
--
-- `ALTER TYPE … ADD VALUE` is permitted inside a transaction block on
-- PostgreSQL 12+, but the new value cannot be USED by the same transaction.
-- Prisma wraps each migration file in one transaction, so keeping the enum
-- widening apart from the migration that follows it means no later statement
-- can ever be added beside it that writes the value and fails at deploy time.

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'INTERVIEW_DECISION_RECORDED';
