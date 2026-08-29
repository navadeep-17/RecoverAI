-- Bind verified provider receipts to the RecoverAI merchant selected by secure runtime configuration.
ALTER TABLE "webhook_events" ADD COLUMN "merchantId" TEXT;

-- Existing rows predate provider webhook processing. They are not trusted receipts and cannot be safely attributed.
UPDATE "webhook_events" SET "merchantId" = '__legacy_unattributed__' WHERE "merchantId" IS NULL;

ALTER TABLE "webhook_events" ALTER COLUMN "merchantId" SET NOT NULL;

DROP INDEX "webhook_events_dedupeKey_key";

CREATE UNIQUE INDEX "webhook_events_merchantId_provider_dedupeKey_key"
  ON "webhook_events"("merchantId", "provider", "dedupeKey");

CREATE INDEX "webhook_events_merchantId_provider_externalEventId_idx"
  ON "webhook_events"("merchantId", "provider", "externalEventId");
