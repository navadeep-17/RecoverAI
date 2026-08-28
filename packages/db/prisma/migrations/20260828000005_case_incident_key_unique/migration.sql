-- AlterTable
ALTER TABLE "revenue_risk_cases" ADD COLUMN "incidentKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "revenue_risk_cases_merchantId_incidentKey_key" ON "revenue_risk_cases"("merchantId", "incidentKey");
