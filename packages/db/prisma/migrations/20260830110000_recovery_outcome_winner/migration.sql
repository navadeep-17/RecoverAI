ALTER TABLE "revenue_risk_cases"
  ADD COLUMN "recoveryOutcomeId" TEXT;

CREATE UNIQUE INDEX "revenue_risk_cases_recoveryOutcomeId_key"
  ON "revenue_risk_cases"("recoveryOutcomeId");

ALTER TABLE "revenue_risk_cases"
  ADD CONSTRAINT "revenue_risk_cases_recoveryOutcomeId_fkey"
  FOREIGN KEY ("recoveryOutcomeId") REFERENCES "recovery_outcomes"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
