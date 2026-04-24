-- Reconciliation fields on real_orders
ALTER TABLE "real_orders"
  ADD COLUMN "filled_size" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "last_reconciled_at" TIMESTAMP(3),
  ADD COLUMN "discrepancy" TEXT;

CREATE INDEX "real_orders_last_reconciled_at_idx" ON "real_orders"("last_reconciled_at");

-- Reconciliation fields on real_fills. paper_fill_id relaxes to nullable so the
-- reconciler can insert CLOB-originated trades that have no paper counterpart.
ALTER TABLE "real_fills" ALTER COLUMN "paper_fill_id" DROP NOT NULL;

ALTER TABLE "real_fills"
  ADD COLUMN "clob_trade_id" TEXT,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'paper';

CREATE UNIQUE INDEX "real_fills_clob_trade_id_key" ON "real_fills"("clob_trade_id");
CREATE INDEX "real_fills_real_order_id_idx" ON "real_fills"("real_order_id");
