-- Add token_id column to real_fills so the reconciler can store and retrieve
-- the CLOB asset ID without deriving it from clobTradeId or joining to orders.
ALTER TABLE "real_fills" ADD COLUMN "token_id" TEXT;
