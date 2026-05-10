# BTCUSDT Order Flow Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a BTCUSDT paper-trading agent driven by order-book and recent-trade flow, while fixing equity history retention for the control center.

**Architecture:** Keep Solana memecoin trading isolated and add a BTCUSDT module with its own virtual balance, positions, journal, order-flow tape, and equity curve. A Vercel API route proxies Binance public market data, and the dashboard runs the BTC paper cycle from those snapshots.

**Tech Stack:** Static HTML/CSS/JS, Vercel Functions, Binance public Spot REST market data, existing Upstash-backed shared state.

---

### Task 1: Add Binance BTCUSDT Snapshot API

**Files:**
- Create: `api/btcusdt.js`

- [ ] Add a serverless endpoint that fetches Binance depth, recent trades, ticker, and klines for `BTCUSDT`.
- [ ] Compute bid/ask liquidity, spread, recent taker buy/sell quote volume, CVD, book imbalance, short momentum, and signal direction.
- [ ] Return a compact JSON payload usable by the browser without exposing any API key.

### Task 2: Extend Shared State

**Files:**
- Modify: `app.js`

- [ ] Add `btc` state under the existing paper state.
- [ ] Preserve old saved states via `normalizeState`.
- [ ] Keep account equity history complete enough for full-history charting instead of slicing to 200 points.

### Task 3: Add BTCUSDT Dashboard Panel

**Files:**
- Modify: `index.html`
- Modify: `styles.css`

- [ ] Add a BTCUSDT command panel with live price, signal, book imbalance, CVD, spread, paper position, BTC equity, and order-flow tape.
- [ ] Style it consistently with the Bloomberg-style console.

### Task 4: Add BTC Paper Trading Loop

**Files:**
- Modify: `app.js`

- [ ] Poll `/api/btcusdt` on an interval.
- [ ] Run a separate BTC paper strategy using order flow alignment.
- [ ] Add BTC order-flow events, position management, journal entries, and BTC equity chart.

### Task 5: Verify and Deploy

**Files:**
- Verify: `app.js`
- Deploy: Vercel production

- [ ] Run `node --check app.js`.
- [ ] Run `node --check api/btcusdt.js`.
- [ ] Run `vercel build --prod`.
- [ ] Deploy prebuilt output to Vercel production and alias `meme-coin-control-center.vercel.app`.
