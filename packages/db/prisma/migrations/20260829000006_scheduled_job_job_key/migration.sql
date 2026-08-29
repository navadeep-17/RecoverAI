-- AlterTable
ALTER TABLE "scheduled_jobs" ADD COLUMN "jobKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_jobs_merchantId_jobKey_key" ON "scheduled_jobs"("merchantId", "jobKey");
