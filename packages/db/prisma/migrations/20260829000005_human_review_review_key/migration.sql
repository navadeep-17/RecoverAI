-- AlterTable
ALTER TABLE "human_reviews" ADD COLUMN "reviewKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "human_reviews_merchantId_caseId_reviewKey_key" ON "human_reviews"("merchantId", "caseId", "reviewKey");