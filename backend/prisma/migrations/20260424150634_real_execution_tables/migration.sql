-- AlterTable
ALTER TABLE "fills" ADD COLUMN     "decision_id" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "decision_id" TEXT;

-- CreateTable
CREATE TABLE "real_orders" (
    "id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "paper_order_id" TEXT NOT NULL,
    "condition_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "reject_reason" TEXT,
    "posted_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "tx_hash" TEXT,

    CONSTRAINT "real_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_fills" (
    "id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "paper_fill_id" TEXT NOT NULL,
    "real_order_id" TEXT NOT NULL,
    "condition_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "fill_price" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "hedge_price" DOUBLE PRECISION NOT NULL,
    "realised_pnl_usd" DOUBLE PRECISION NOT NULL,
    "maker_fee_usd" DOUBLE PRECISION NOT NULL,
    "taker_fee_usd" DOUBLE PRECISION NOT NULL,
    "filled_at" TIMESTAMP(3) NOT NULL,
    "hedge_order_id" TEXT,
    "hedge_status" TEXT NOT NULL,
    "tx_hash" TEXT,

    CONSTRAINT "real_fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_positions" (
    "condition_id" TEXT NOT NULL,
    "decision_id" TEXT,
    "question" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "bid_order_id" TEXT,
    "ask_order_id" TEXT,
    "bid_price" DOUBLE PRECISION NOT NULL,
    "ask_price" DOUBLE PRECISION NOT NULL,
    "bid_size" DOUBLE PRECISION NOT NULL,
    "ask_size" DOUBLE PRECISION NOT NULL,
    "capital_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "real_positions_pkey" PRIMARY KEY ("condition_id")
);

-- CreateTable
CREATE TABLE "real_reward" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "total_earned_usd" DOUBLE PRECISION NOT NULL,
    "last_rate_per_day" DOUBLE PRECISION NOT NULL,
    "last_updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "real_reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_capital_5min" (
    "bucket_epoch" BIGINT NOT NULL,
    "sampled_at" TIMESTAMP(3) NOT NULL,
    "total_capital_usd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "real_capital_5min_pkey" PRIMARY KEY ("bucket_epoch")
);

-- CreateTable
CREATE TABLE "real_execution_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pause_reason" TEXT,
    "daily_loss_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "daily_loss_day_utc" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "real_execution_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "real_orders_status_idx" ON "real_orders"("status");

-- CreateIndex
CREATE INDEX "real_orders_decision_id_idx" ON "real_orders"("decision_id");

-- CreateIndex
CREATE INDEX "real_orders_paper_order_id_idx" ON "real_orders"("paper_order_id");

-- CreateIndex
CREATE INDEX "real_fills_filled_at_idx" ON "real_fills"("filled_at" DESC);

-- CreateIndex
CREATE INDEX "real_fills_decision_id_idx" ON "real_fills"("decision_id");

-- CreateIndex
CREATE INDEX "real_fills_paper_fill_id_idx" ON "real_fills"("paper_fill_id");

-- CreateIndex
CREATE INDEX "fills_decision_id_idx" ON "fills"("decision_id");

-- CreateIndex
CREATE INDEX "orders_decision_id_idx" ON "orders"("decision_id");
