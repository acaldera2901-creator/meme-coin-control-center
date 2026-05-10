# Solana Memecoin Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Bloomberg-style control center for aggressive paper trading of Solana meme coins using real DexScreener API data.

**Architecture:** A static browser app fetches DexScreener token profiles, boosted tokens, and token-pair data, scores candidates, simulates paper entries/exits, and stores portfolio state in localStorage. The first deployment is local via a static HTTP server.

**Tech Stack:** HTML, CSS, vanilla JavaScript, DexScreener public API, browser localStorage.

---

### Task 1: Static App Shell

**Files:**
- Create: `index.html`
- Create: `styles.css`
- Create: `app.js`

- [x] **Step 1: Create the dashboard shell**

Build a dense trading cockpit with header controls, agent status, data-source health, candidate table, open positions, trade journal, and evaluator panels.

- [x] **Step 2: Add Bloomberg-inspired styling**

Use a dark high-density interface with amber highlights, compact tables, fixed panels, and strong numeric contrast.

- [x] **Step 3: Add DexScreener data client**

Fetch:
- `https://api.dexscreener.com/token-profiles/latest/v1`
- `https://api.dexscreener.com/token-boosts/latest/v1`
- `https://api.dexscreener.com/token-boosts/top/v1`
- `https://api.dexscreener.com/token-pairs/v1/solana/{tokenAddress}`

- [x] **Step 4: Implement paper trading**

Start with 1,000 USDC virtual capital, 5% base size, 10% max size, 3 open positions, simulated slippage, stop loss, partial take profit, trailing exit, and momentum-failure exit.

- [x] **Step 5: Deploy locally**

Serve the static app with `python3 -m http.server 4173` and verify in the browser.

