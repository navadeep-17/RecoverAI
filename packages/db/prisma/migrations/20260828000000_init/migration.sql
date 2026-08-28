-- CreateEnum
CREATE TYPE "Role" AS ENUM ('MERCHANT_ADMIN', 'REVIEWER');

-- CreateEnum
CREATE TYPE "RiskType" AS ENUM ('PAYMENT_FAILURE', 'SUBSCRIPTION_FAILURE', 'CHECKOUT_ABANDONMENT', 'OVERDUE_RECEIVABLE');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'WAITING', 'NEEDS_REVIEW', 'RECOVERED', 'STOPPED', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "PolicyDecision" AS ENUM ('ALLOW', 'DENY', 'REVIEW');

-- CreateEnum
CREATE TYPE "RecoveryActionType" AS ENUM ('RETRY_PAYMENT', 'REQUEST_PAYMENT_UPDATE', 'CREATE_OR_SEND_PAYMENT_LINK', 'SEND_CHECKOUT_RECOVERY', 'SEND_RECEIVABLE_REMINDER', 'RECORD_PROMISE_TO_PAY', 'SCHEDULE_FOLLOWUP', 'ESCALATE_TO_HUMAN', 'STOP_RECOVERY');

-- CreateEnum
CREATE TYPE "ActionExecutionStatus" AS ENUM ('PENDING', 'EXECUTING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('RAZORPAY', 'MERCHANT', 'SIMULATOR', 'TIMER');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('SYSTEM', 'AGENT', 'POLICY', 'HUMAN', 'PROVIDER');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'TAKEN_OVER', 'CLOSED');

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "killSwitchActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'REVIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "externalCustomerId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "name" TEXT,
    "contactConsent" BOOLEAN NOT NULL DEFAULT true,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "lastContactedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_events" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "source" "EventSource" NOT NULL,
    "externalEventId" TEXT,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,

    CONSTRAINT "merchant_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT,
    "signature" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,
    "rawPayload" TEXT NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_risk_cases" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT,
    "riskType" "RiskType" NOT NULL,
    "amountAtRisk" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "contextJson" JSONB NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextEvaluationAt" TIMESTAMP(3),
    "recoveredAmount" DECIMAL(12,2),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_risk_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_plan_versions" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "diagnosisCode" TEXT NOT NULL,
    "diagnosisSummary" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "proposedActionType" "RecoveryActionType" NOT NULL,
    "proposedActionParams" JSONB NOT NULL,
    "reasoningSummary" TEXT NOT NULL,
    "followUpAfterSeconds" INTEGER,
    "shouldStop" BOOLEAN NOT NULL DEFAULT false,
    "shouldEscalate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_plan_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_actions" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "planVersionId" TEXT,
    "actionType" "RecoveryActionType" NOT NULL,
    "actionParams" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "policyDecision" "PolicyDecision" NOT NULL,
    "policyRationale" TEXT NOT NULL,
    "status" "ActionExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "providerName" TEXT,
    "externalActionId" TEXT,
    "executionMetadata" JSONB,
    "errorMessage" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_outcomes" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actionId" TEXT,
    "merchantEventId" TEXT,
    "outcomeType" TEXT NOT NULL,
    "amountRecovered" DECIMAL(12,2),
    "detailsJson" JSONB,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_configs" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "maxRetriesPerCase" INTEGER NOT NULL DEFAULT 3,
    "maxContactsPerCase" INTEGER NOT NULL DEFAULT 3,
    "cooldownHoursBetweenActions" INTEGER NOT NULL DEFAULT 24,
    "highValueThreshold" DECIMAL(12,2) NOT NULL DEFAULT 50000.00,
    "minConfidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.65,
    "reviewFirstMode" BOOLEAN NOT NULL DEFAULT false,
    "checkoutAbandonmentThresholdMinutes" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_reviews" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actionId" TEXT,
    "reviewerId" TEXT,
    "reasonForReview" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewDecision" TEXT,
    "reviewNotes" TEXT,
    "revalidatedAt" TIMESTAMP(3),
    "revalidatedPolicyDecision" "PolicyDecision",
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "human_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_commitments" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "promisedAmount" DECIMAL(12,2) NOT NULL,
    "promisedDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "extractedFromText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "caseId" TEXT,
    "eventType" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "inputSummaryJson" JSONB,
    "outputSummaryJson" JSONB,
    "reasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "jobType" TEXT NOT NULL,
    "pgBossJobId" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "payloadJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_slug_key" ON "merchants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_merchantId_idx" ON "users"("merchantId");

-- CreateIndex
CREATE INDEX "customers_merchantId_idx" ON "customers"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_merchantId_externalCustomerId_key" ON "customers"("merchantId", "externalCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_events_dedupeKey_key" ON "merchant_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "merchant_events_merchantId_type_idx" ON "merchant_events"("merchantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_dedupeKey_key" ON "webhook_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "webhook_events_provider_externalEventId_idx" ON "webhook_events"("provider", "externalEventId");

-- CreateIndex
CREATE INDEX "revenue_risk_cases_merchantId_status_idx" ON "revenue_risk_cases"("merchantId", "status");

-- CreateIndex
CREATE INDEX "revenue_risk_cases_merchantId_riskType_idx" ON "revenue_risk_cases"("merchantId", "riskType");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_plan_versions_caseId_version_key" ON "recovery_plan_versions"("caseId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_actions_idempotencyKey_key" ON "recovery_actions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "recovery_actions_caseId_status_idx" ON "recovery_actions"("caseId", "status");

-- CreateIndex
CREATE INDEX "recovery_outcomes_caseId_idx" ON "recovery_outcomes"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "policy_configs_merchantId_key" ON "policy_configs"("merchantId");

-- CreateIndex
CREATE INDEX "human_reviews_merchantId_status_idx" ON "human_reviews"("merchantId", "status");

-- CreateIndex
CREATE INDEX "recovery_commitments_caseId_idx" ON "recovery_commitments"("caseId");

-- CreateIndex
CREATE INDEX "audit_events_merchantId_eventType_idx" ON "audit_events"("merchantId", "eventType");

-- CreateIndex
CREATE INDEX "audit_events_caseId_idx" ON "audit_events"("caseId");

-- CreateIndex
CREATE INDEX "scheduled_jobs_caseId_idx" ON "scheduled_jobs"("caseId");

-- CreateIndex
CREATE INDEX "scheduled_jobs_scheduledFor_status_idx" ON "scheduled_jobs"("scheduledFor", "status");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_events" ADD CONSTRAINT "merchant_events_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_risk_cases" ADD CONSTRAINT "revenue_risk_cases_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_risk_cases" ADD CONSTRAINT "revenue_risk_cases_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_plan_versions" ADD CONSTRAINT "recovery_plan_versions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "revenue_risk_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "revenue_risk_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "recovery_plan_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_outcomes" ADD CONSTRAINT "recovery_outcomes_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "revenue_risk_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_outcomes" ADD CONSTRAINT "recovery_outcomes_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "recovery_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_outcomes" ADD CONSTRAINT "recovery_outcomes_merchantEventId_fkey" FOREIGN KEY ("merchantEventId") REFERENCES "merchant_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_configs" ADD CONSTRAINT "policy_configs_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_reviews" ADD CONSTRAINT "human_reviews_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_reviews" ADD CONSTRAINT "human_reviews_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "revenue_risk_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_reviews" ADD CONSTRAINT "human_reviews_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "recovery_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_reviews" ADD CONSTRAINT "human_reviews_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_commitments" ADD CONSTRAINT "recovery_commitments_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "revenue_risk_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "revenue_risk_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "revenue_risk_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

