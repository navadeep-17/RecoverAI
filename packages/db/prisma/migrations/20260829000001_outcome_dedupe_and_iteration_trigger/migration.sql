-- AlterTable
ALTER TABLE "recovery_outcomes" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "recovery_outcomes_caseId_dedupeKey_key" ON "recovery_outcomes"("caseId", "dedupeKey");

-- CreateTable
CREATE TABLE "recovery_iteration_triggers" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "triggerKey" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CLAIMED',
    "resultJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "recovery_iteration_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recovery_iteration_triggers_merchantId_caseId_idx" ON "recovery_iteration_triggers"("merchantId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_iteration_triggers_merchantId_caseId_triggerKey_key" ON "recovery_iteration_triggers"("merchantId", "caseId", "triggerKey");

-- AddForeignKey
ALTER TABLE "recovery_iteration_triggers" ADD CONSTRAINT "recovery_iteration_triggers_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_iteration_triggers" ADD CONSTRAINT "recovery_iteration_triggers_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "revenue_risk_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
