-- Add hedge retry counter. Fills whose retry count reaches the service-level
-- threshold are marked 'abandoned' and permanently removed from the retry queue.
ALTER TABLE "real_fills" ADD COLUMN "hedge_retry_count" INTEGER NOT NULL DEFAULT 0;
