-- AlterTable
ALTER TABLE "recovery_commitments" ADD COLUMN "sourceMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "recovery_commitments_caseId_sourceMessageId_key" ON "recovery_commitments"("caseId", "sourceMessageId");
