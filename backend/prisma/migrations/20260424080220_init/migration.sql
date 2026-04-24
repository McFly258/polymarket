-- CreateTable
CREATE TABLE "engine_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "config_json" JSONB,
    "last_alloc_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engine_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "total_earned_usd" DOUBLE PRECISION NOT NULL,
    "last_rate_per_day" DOUBLE PRECISION NOT NULL,
    "last_updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "condition_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL,
    "posted_best_bid" DOUBLE PRECISION,
    "posted_best_ask" DOUBLE PRECISION,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fills" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
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

    CONSTRAINT "fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "condition_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "bid_order_id" TEXT,
    "ask_order_id" TEXT,
    "bid_price" DOUBLE PRECISION NOT NULL,
    "ask_price" DOUBLE PRECISION NOT NULL,
    "bid_size" DOUBLE PRECISION NOT NULL,
    "ask_size" DOUBLE PRECISION NOT NULL,
    "max_spread_dollars" DOUBLE PRECISION NOT NULL,
    "daily_pool" DOUBLE PRECISION NOT NULL,
    "mid_price" DOUBLE PRECISION,
    "best_bid" DOUBLE PRECISION,
    "best_ask" DOUBLE PRECISION,
    "reward_share_pct" DOUBLE PRECISION NOT NULL,
    "expected_rate_per_day" DOUBLE PRECISION NOT NULL,
    "capital_usd" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("condition_id")
);

-- CreateTable
CREATE TABLE "reward_hourly" (
    "hour_epoch" BIGINT NOT NULL,
    "snapshot_at" TIMESTAMP(3) NOT NULL,
    "total_earned_usd" DOUBLE PRECISION NOT NULL,
    "rate_per_day" DOUBLE PRECISION NOT NULL,
    "total_capital_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "reward_hourly_pkey" PRIMARY KEY ("hour_epoch")
);

-- CreateTable
CREATE TABLE "position_reward_hourly" (
    "id" SERIAL NOT NULL,
    "hour_epoch" BIGINT NOT NULL,
    "snapshot_at" TIMESTAMP(3) NOT NULL,
    "condition_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "reward_share_pct" DOUBLE PRECISION NOT NULL,
    "expected_rate_per_day" DOUBLE PRECISION NOT NULL,
    "earned_this_hour_usd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "position_reward_hourly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capital_5min" (
    "bucket_epoch" BIGINT NOT NULL,
    "sampled_at" TIMESTAMP(3) NOT NULL,
    "total_capital_usd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "capital_5min_pkey" PRIMARY KEY ("bucket_epoch")
);

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_token_id_idx" ON "orders"("token_id");

-- CreateIndex
CREATE INDEX "fills_filled_at_idx" ON "fills"("filled_at" DESC);

-- CreateIndex
CREATE INDEX "position_reward_hourly_hour_epoch_idx" ON "position_reward_hourly"("hour_epoch" DESC);

-- CreateIndex
CREATE INDEX "position_reward_hourly_condition_id_hour_epoch_idx" ON "position_reward_hourly"("condition_id", "hour_epoch" DESC);
