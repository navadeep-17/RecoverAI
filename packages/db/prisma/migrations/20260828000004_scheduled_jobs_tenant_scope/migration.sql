-- AlterTable
ALTER TABLE "scheduled_jobs" ADD COLUMN "merchantId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "scheduled_jobs_merchantId_status_idx" ON "scheduled_jobs"("merchantId", "status");

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
