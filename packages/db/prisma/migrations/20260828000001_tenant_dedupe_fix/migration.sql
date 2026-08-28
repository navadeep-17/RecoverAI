-- DropIndex
DROP INDEX "merchant_events_dedupeKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "merchant_events_merchantId_dedupeKey_key" ON "merchant_events"("merchantId", "dedupeKey");
