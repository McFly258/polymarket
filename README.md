# Polymarket Liquidity Rewards Monitor

Live dashboard + strategy simulator for the [Polymarket liquidity rewards program](https://help.polymarket.com/en/articles/13364466-liquidity-rewards).

It answers two questions:

1. **Which markets are paying right now?** — sorted by daily USDC pool, with the live book and reward-band status per market.
2. **How much could I earn if I posted resting limit orders on both sides?** — a deployable strategy simulator with a fixed capital budget, per-market cap, fee model, and reprice/fill risk estimates.

Runs entirely off public CLOB endpoints (no API key, no wallet, no signed orders) and a local SQLite snapshot collector for historical context.

---

## Stack

- **UI**: React 19 + TypeScript + Vite 8 (mirrors `../funding-rate`)
- **Charts**: `recharts`
- **Historical store**: `better-sqlite3` with a Node cron-driven collector
- **API**: custom Vite dev-middleware plugin serves `/api/polymarket/*` straight from SQLite — no backend process to run

---

## Run

```bash
npm install
npm run dev           # UI at http://localhost:5173
npm run collect       # one-off snapshot into polymarket.db
```

Put this in crontab for continuous history:

```
*/5 * * * * cd /abs/path/to/polymarket && /usr/bin/node --experimental-strip-types collector/collector.ts >> collector.log 2>&1
```

Vite proxies `/clob-api/*` → `https://clob.polymarket.com` so the browser avoids CORS during dev. In production you'd put the same rule in your reverse proxy.

---

## How Polymarket rewards work

Polymarket pays a **daily USDC pool** to market makers whose resting limit orders satisfy three conditions:

| Rule | Meaning |
|---|---|
| **Inside the reward band** | Order price is within `max_spread` cents of mid |
| **Above min size** | Order is at least `min_size` shares |
| **On both sides when mid < $0.10** | Tight-market rule — must have YES and NO quotes |

Payouts accrue continuously and settle at ~midnight UTC (minimum $1). Your share is proportional to a size-weighted score:

```
weight(d) = max(0, 1 - d / max_spread)     # d = distance from mid
score(side) = Σ weight(d_i) * size_i       # summed over your levels
reward(side) = (pool / 2) * your_score / (your_score + competing_score)
```

So you want to post **inside** the band, **heavy** on size, but **far enough from mid** that you don't get run over.

---

## How this app extracts yield

Implemented in `src/services/strategy.ts` and rendered in the Simulation panel. The full model is:

### 1. Capital allocation

- **Total budget**: `$2,000` (editable)
- **Per-market cap**: `$100` (`$50` per side)
- Markets are ranked by **net yield/day** and funded greedily until the total budget is exhausted — high-yield markets first.
- Markets below `minYieldPct` (default `0.05% /day`) or resolving sooner than `minDaysToResolution` (default 7 days) are skipped.

### 2. Posting price — deliberately fill-resistant

The naïve play (one tick behind best-bid / best-ask) earns the maximum reward weight but gets filled on any breeze. Instead we post **deep inside the reward zone, far from top of book**:

```
targetDistance = postingDistancePct * maxSpreadDollars   # default 85%
bidAnchor = mid - targetDistance                         # deep bid
askAnchor = mid + targetDistance                         # deep ask
bidCap    = bestBid - minTicksBehindTop * tick            # never closer than 2 ticks to touch
askCap    = bestAsk + minTicksBehindTop * tick
bidPrice  = min(bidAnchor, bidCap)    # further-from-mid of the two
askPrice  = max(askAnchor, askCap)
```

Net effect: if the reward band is 4¢, our quotes sit ~3.4¢ from mid (85%) — we earn ~15% of the max reward weight but the probability of being filled on any given day drops sharply. The `minTicksBehindTop` floor guarantees that even if the book is tight, at least two other price levels are eaten before ours.

### 3. Expected fill probability + P&L

Mid drift is modelled as Brownian with daily σ measured from the collector's book history:

```
fillProb(side) ≈ 2 · Φ(-d / σ)         # one-sided barrier crossing
expectedLoss  ≈ fillProb · (shares · d  +  shares · bookSpread/2  +  notional · takerFee)
                            │           │                         │
                            │           │                         └─ taker fee on hedge
                            │           └─ half-spread to hedge back to flat
                            └─ adverse-selection floor: d dollars per share
```

If `hedgeFillsOnBook` is true (default) we assume any fill is immediately flattened by crossing the book. Otherwise we'd carry the directional position to resolution — riskier, no hedge cost, not the default because binary markets can mark to zero.

### 4. Repricing + gas

When the mid drifts past `repriceThresholdCents` (default `1¢`) we cancel and repost both sides.

```
repricesPerDay ≈ min(50, σ_daily / threshold)
gasCostPerDay  = repricesPerDay · 4 · gasPerOrder     # cancel+post both sides
```

Polymarket uses meta-transactions (relayer-paid gas), so `gasCostPerOrderUsd` defaults to `0`. It's still exposed in the UI so you can stress-test a self-relayed scenario (~$0.001 per Polygon tx).

### 5. Fees

Polymarket's CLOB is currently **0% maker / 0% taker**. `makerFeePct` / `takerFeePct` default to `0` and are editable in the panel — set them non-zero to see how sensitive the strategy is if the fee schedule changes.

### 6. Net yield

```
netDaily = grossReward  −  expectedFillCost  −  expectedFeeCost  −  expectedGasCost
yieldPct = netDaily / capitalDeployed · 100
```

The Simulation table shows gross vs. net per market plus a portfolio-level roll-up (annualised naively as `yield/day × 365`, read with a grain of salt — reward pools are not stationary, and `minDaysToResolution` bounds the effective holding period).

---

## Risks the model does NOT fully capture

- **Adverse selection spikes near resolution** — we hard-filter markets resolving in < 7 days, but within that window volatility can change regime fast. Watch the `Vol (24h)` column.
- **Reward pool changes** — Polymarket adjusts pools dynamically. The collector history panel surfaces these so you can see decay.
- **Spread competition** — as more makers notice a hot market, the competing score grows and your share shrinks. The simulator uses the *current* competing score; expect realised yield to be lower on popular markets.
- **Binary resolution risk** — if hedging is disabled, a fill that doesn't revert can lose 100% of the hedged notional at settlement.

---

## Architecture

```
┌──────────────────────────┐
│  Polymarket public CLOB  │  /sampling-markets, /books, /markets/:id
└────────────┬─────────────┘
             │
             │ Vite proxy  /clob-api/*
             ▼
     ┌───────────────┐         ┌─────────────────┐
     │   UI (React)  │◀───────▶│  /api/polymarket │ (Vite plugin, reads SQLite)
     └───────┬───────┘         └────────▲─────────┘
             │                          │
             │  live snapshot           │  history
             ▼                          │
     ┌───────────────┐                  │
     │ Strategy sim  │                  │
     │ (client-side) │                  │
     └───────────────┘                  │
                                        │
                              ┌─────────┴─────────┐
                              │  SQLite collector │  cron every 5 min
                              │  polymarket.db    │
                              └───────────────────┘
```

### Key paths

- `src/services/dashboard.ts` — fetch `/sampling-markets` + batch `/books` (8-way concurrency), build `RewardsRow`s
- `src/services/strategy.ts` — `runSimulation()` + full yield model documented above
- `src/components/SimulationPanel.tsx` — strategy config UI + allocation table
- `src/components/MarketHistoryPanel.tsx` — per-market history drawer (recharts sparklines)
- `collector/collector.ts` — snapshot loop: writes `reward_snapshots` + `book_snapshots` per market
- `collector/db.ts` — schema + read helpers (`getMarketHistory`, `getVolatility`)
- `collector/vite-plugin.ts` — dev-middleware exposing SQLite as `/api/polymarket/*`

---

## Endpoints served locally

| Path | Returns |
|---|---|
| `/api/polymarket/market-history?condition_id=…` | Last 48 reward + book snapshots for one market |
| `/api/polymarket/volatility` | Per-market daily σ of mid moves (used by strategy) |
| `/api/polymarket/summary` | Collector stats: rows, last run, DB size |

All three are read-only, no auth, derived from `polymarket.db`.

---

## Tuning cheatsheet

| Knob | Default | Raise to… | Lower to… |
|---|---|---|---|
| `totalCapitalUsd` | $2,000 | deploy more | reduce exposure |
| `perMarketCapitalUsd` | $100 | concentrate | diversify more |
| `postingDistancePct` | 0.85 | get filled less, earn less | get filled more, earn more weight |
| `minTicksBehindTop` | 2 | extra safety floor | allow closer quotes |
| `minYieldPct` | 0.05% | be pickier | accept thinner markets |
| `minDaysToResolution` | 7 | avoid resolution whipsaw | include short-dated markets |
| `repriceThresholdCents` | 1 | cheaper gas, more drift | tighter tracking, more ops |
