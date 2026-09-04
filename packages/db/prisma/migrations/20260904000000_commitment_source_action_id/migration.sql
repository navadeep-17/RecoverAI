ALTER TABLE "recovery_commitments" ADD COLUMN "sourceActionId" TEXT;

CREATE UNIQUE INDEX "recovery_commitments_caseId_sourceActionId_key"
ON "recovery_commitments"("caseId", "sourceActionId");
