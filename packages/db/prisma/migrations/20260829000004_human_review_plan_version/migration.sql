-- AlterTable
ALTER TABLE "human_reviews" ADD COLUMN "planVersionId" TEXT;

-- CreateIndex
CREATE INDEX "human_reviews_caseId_planVersionId_idx" ON "human_reviews"("caseId", "planVersionId");

-- AddForeignKey
ALTER TABLE "human_reviews" ADD CONSTRAINT "human_reviews_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "recovery_plan_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
