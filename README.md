# Polymarket Liquidity Rewards Monitor

Live dashboard for every Polymarket market paying [liquidity rewards](https://help.polymarket.com/en/articles/13364466-liquidity-rewards) for holding limit orders inside the reward band.

For each reward-eligible market it shows:

- **Daily USDC reward pool** (from `rewards.rates`)
- **Max reward spread** (how close to mid your order must be — in cents)
- **Minimum order size** (shares needed to earn)
- **Live book** — best bid / best ask / mid / current spread per outcome
- **Eligibility** — whether the current book spread is tight enough that maker orders can sit inside the reward band on both sides

Sorted by biggest daily pool first. Filters: search, "only in-band now", and a minimum daily $ pool threshold.

## Stack

React 19 + TypeScript + Vite 8 (mirrors `../funding-rate`).

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

The page polls every 60s; click **Refresh now** to force an update. All CLOB calls are public and read-only — no API key, no wallet, no env variables needed. Vite proxies `/clob-api/*` → `https://clob.polymarket.com` to avoid browser CORS in dev.

## How rewards work (short version)

Polymarket pays a daily USDC pool, split across makers whose limit orders sit within `max_spread` cents of the mid and are above `min_size` shares. Payouts happen automatically at ~midnight UTC (minimum payout $1). If the mid is below $0.10 the rule tightens and you must have orders on both sides. This monitor surfaces the parameters and the live book so you can see at a glance which markets are worth quoting.
