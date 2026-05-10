const { readJson, storageProvider, writeJson } = require("./storage");

const MARKET_APIS = [
  { name: "binance.com-public-spot", base: "https://api.binance.com" },
  { name: "binance.us-public-spot", base: "https://api.binance.us" }
];
const SYMBOL = "BTCUSDT";
const STATE_PATH = "meme-coin-control-center/shared-paper-state.json";
const MAX_EQUITY_POINTS = 10000;
const MIN_CYCLE_INTERVAL_MS = 60 * 1000;
let activeMarketApi = MARKET_APIS[0];

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function createDefaultBtcState() {
  return {
    cash: 1000,
    startingCapital: 1000,
    position: null,
    journal: [],
    equityCurve: [{ time: Date.now(), equity: 1000 }],
    orderFlow: [],
    snapshots: [],
    cycles: 0,
    lastSnapshot: null,
    lastSignal: "WAIT",
    lastError: "",
    updatedAt: Date.now()
  };
}

function normalizeBtcState(candidate) {
  const parsed = candidate && typeof candidate === "object" ? candidate : {};
  const defaults = createDefaultBtcState();
  return {
    ...defaults,
    ...parsed,
    position: parsed.position && typeof parsed.position === "object" ? parsed.position : null,
    journal: Array.isArray(parsed.journal) ? parsed.journal : [],
    equityCurve: Array.isArray(parsed.equityCurve) ? parsed.equityCurve : defaults.equityCurve,
    orderFlow: Array.isArray(parsed.orderFlow) ? parsed.orderFlow : [],
    snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : []
  };
}

async function fetchJson(path) {
  const ordered = [activeMarketApi, ...MARKET_APIS.filter((api) => api.base !== activeMarketApi.base)];
  let lastError = null;
  for (const api of ordered) {
    try {
      const response = await fetch(`${api.base}${path}`, {
        headers: { Accept: "application/json", "User-Agent": "meme-coin-control-center/1.0" }
      });
      if (!response.ok) throw new Error(`${api.name}-${response.status}`);
      activeMarketApi = api;
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("market-api-unavailable");
}

function sumBook(levels) {
  return levels.reduce((sum, [price, qty]) => sum + safeNum(price) * safeNum(qty), 0);
}

function analyzeTrades(trades) {
  let takerBuyQuote = 0;
  let takerSellQuote = 0;
  let largestBuy = 0;
  let largestSell = 0;

  for (const trade of trades) {
    const quote = safeNum(trade.quoteQty) || safeNum(trade.price) * safeNum(trade.qty);
    if (trade.isBuyerMaker) {
      takerSellQuote += quote;
      largestSell = Math.max(largestSell, quote);
    } else {
      takerBuyQuote += quote;
      largestBuy = Math.max(largestBuy, quote);
    }
  }

  const totalQuote = takerBuyQuote + takerSellQuote;
  return {
    count: trades.length,
    takerBuyQuote,
    takerSellQuote,
    totalQuote,
    cvd: takerBuyQuote - takerSellQuote,
    buyRatio: takerSellQuote ? takerBuyQuote / takerSellQuote : takerBuyQuote ? 99 : 1,
    largestBuy,
    largestSell
  };
}

function analyzeKlines(klines) {
  const closes = klines.map((row) => safeNum(row[4])).filter(Boolean);
  const last = closes.at(-1) || 0;
  const prev5 = closes.at(-6) || closes[0] || last;
  const prev15 = closes[0] || last;
  return {
    momentum5m: prev5 ? ((last - prev5) / prev5) * 100 : 0,
    momentum15m: prev15 ? ((last - prev15) / prev15) * 100 : 0
  };
}

function buildSignal({ book, trades, klines, price }) {
  const bidDepth = sumBook(book.bids.slice(0, 25));
  const askDepth = sumBook(book.asks.slice(0, 25));
  const topBid = safeNum(book.bids[0]?.[0]);
  const topAsk = safeNum(book.asks[0]?.[0]);
  const mid = topBid && topAsk ? (topBid + topAsk) / 2 : price;
  const spreadPct = mid ? ((topAsk - topBid) / mid) * 100 : 0;
  const imbalance = bidDepth + askDepth ? ((bidDepth - askDepth) / (bidDepth + askDepth)) * 100 : 0;
  const tape = analyzeTrades(trades);
  const momentum = analyzeKlines(klines);
  const cvdPct = tape.totalQuote ? (tape.cvd / tape.totalQuote) * 100 : 0;
  const buyAligned = cvdPct >= 8 && imbalance >= 4 && momentum.momentum5m >= -0.25;
  const sellAligned = cvdPct <= -8 && imbalance <= -4 && momentum.momentum5m <= 0.25;
  const score = Math.max(0, Math.min(100,
    42
    + Math.abs(cvdPct) * 0.85
    + Math.abs(imbalance) * 0.55
    + Math.min(16, tape.totalQuote / 2_000_000)
    - Math.max(0, spreadPct - 0.015) * 900
  ));
  const direction = buyAligned && score >= 58 ? "LONG" : sellAligned && score >= 58 ? "SHORT" : "WAIT";
  const reason = direction === "LONG"
    ? "taker buy flow + bid depth aligned"
    : direction === "SHORT"
      ? "taker sell flow + ask depth aligned"
      : "flow not aligned";

  return {
    symbol: SYMBOL,
    time: Date.now(),
    price,
    topBid,
    topAsk,
    spreadPct,
    bidDepth,
    askDepth,
    imbalance,
    cvd: tape.cvd,
    cvdPct,
    takerBuyQuote: tape.takerBuyQuote,
    takerSellQuote: tape.takerSellQuote,
    buyRatio: tape.buyRatio,
    tradeCount: tape.count,
    largestBuy: tape.largestBuy,
    largestSell: tape.largestSell,
    momentum5m: momentum.momentum5m,
    momentum15m: momentum.momentum15m,
    signal: { direction, score: Math.round(score), reason }
  };
}

async function fetchBtcSnapshot() {
  const [book, trades, ticker, klines] = await Promise.all([
    fetchJson(`/api/v3/depth?symbol=${SYMBOL}&limit=100`),
    fetchJson(`/api/v3/trades?symbol=${SYMBOL}&limit=500`),
    fetchJson(`/api/v3/ticker/price?symbol=${SYMBOL}`),
    fetchJson(`/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=16`)
  ]);
  return buildSignal({
    book,
    trades: Array.isArray(trades) ? trades : [],
    klines: Array.isArray(klines) ? klines : [],
    price: safeNum(ticker.price)
  });
}

function btcEquity(btc) {
  if (!btc.position) return btc.cash;
  const direction = btc.position.side === "SHORT" ? -1 : 1;
  const pnl = (safeNum(btc.position.lastPrice) - safeNum(btc.position.entryPrice)) * safeNum(btc.position.qty) * direction;
  return btc.cash + safeNum(btc.position.margin) + pnl;
}

function maybeOpenBtcPosition(btc, snapshot) {
  const direction = snapshot.signal?.direction;
  const score = safeNum(snapshot.signal?.score);
  const aligned = direction === "LONG" || direction === "SHORT";
  const spread = safeNum(snapshot.spreadPct);
  const tapeQuote = safeNum(snapshot.takerBuyQuote) + safeNum(snapshot.takerSellQuote);
  const cleanSpread = spread <= 0.04;
  const enoughTape = tapeQuote >= 200000;
  const conviction = score >= 68 || (score >= 62 && spread <= 0.025 && tapeQuote >= 350000);
  if (!aligned || !conviction || !cleanSpread || !enoughTape) return;

  const marginPct = score >= 76 && tapeQuote >= 350000 ? 0.10 : 0.05;
  const margin = Math.min(btc.cash, btc.startingCapital * marginPct);
  if (margin < 25) return;
  btc.cash -= margin;
  btc.position = {
    id: crypto.randomUUID(),
    symbol: SYMBOL,
    side: direction,
    entryTime: Date.now(),
    entryPrice: safeNum(snapshot.price),
    lastPrice: safeNum(snapshot.price),
    qty: margin / safeNum(snapshot.price),
    margin,
    score,
    highWater: safeNum(snapshot.price),
    lowWater: safeNum(snapshot.price),
    thesis: `${direction} ${score} / ${snapshot.signal?.reason || "flow aligned"} / ${Math.round(tapeQuote / 1000)}k tape`
  };
}

function manageBtcPosition(btc, snapshot) {
  const position = btc.position;
  if (!position) return;
  const price = safeNum(snapshot.price);
  const direction = position.side === "SHORT" ? -1 : 1;
  const pnl = (price - position.entryPrice) * position.qty * direction;
  const pnlPct = position.margin ? (pnl / position.margin) * 100 : 0;
  const signal = snapshot.signal?.direction || "WAIT";
  const flip = (position.side === "LONG" && signal === "SHORT") || (position.side === "SHORT" && signal === "LONG");
  const ageMs = Date.now() - safeNum(position.entryTime);
  const flowFade = position.side === "LONG"
    ? safeNum(snapshot.cvdPct) < -5 || safeNum(snapshot.imbalance) < -8
    : safeNum(snapshot.cvdPct) > 5 || safeNum(snapshot.imbalance) > 8;
  let reason = "";

  position.lastPrice = price;
  position.highWater = Math.max(safeNum(position.highWater), price);
  position.lowWater = Math.min(safeNum(position.lowWater) || price, price);

  if (pnlPct <= -0.45) reason = "BTC hard stop -0.45%";
  if (!reason && pnlPct >= 0.9) reason = "BTC scalp take profit +0.90%";
  if (!reason && pnlPct >= 0.35 && flowFade) reason = "BTC flow fade exit";
  if (!reason && flip && pnlPct > -0.15) reason = "BTC signal flip";
  if (!reason && ageMs > 45 * 60000 && pnlPct < 0.2) reason = "BTC time stop";
  if (!reason) return;

  btc.cash += position.margin + pnl;
  btc.journal.unshift({
    id: crypto.randomUUID(),
    time: Date.now(),
    symbol: SYMBOL,
    side: `CLOSE ${position.side}`,
    size: position.margin,
    entryPrice: position.entryPrice,
    exitPrice: price,
    pnl,
    reason
  });
  btc.journal = btc.journal.slice(0, 120);
  btc.position = null;
}

function runBtcCycle(btc, snapshot) {
  btc.cycles += 1;
  btc.lastSnapshot = snapshot;
  btc.lastSignal = snapshot.signal?.direction || "WAIT";
  btc.lastError = "";
  btc.updatedAt = Date.now();
  btc.snapshots = [...btc.snapshots, snapshot].slice(-240);

  if (btc.position) manageBtcPosition(btc, snapshot);
  if (!btc.position) maybeOpenBtcPosition(btc, snapshot);

  btc.orderFlow.unshift({
    id: crypto.randomUUID(),
    time: snapshot.time || Date.now(),
    side: snapshot.signal?.direction || "WAIT",
    price: safeNum(snapshot.price),
    score: safeNum(snapshot.signal?.score),
    imbalance: safeNum(snapshot.imbalance),
    cvdPct: safeNum(snapshot.cvdPct),
    buyQuote: safeNum(snapshot.takerBuyQuote),
    sellQuote: safeNum(snapshot.takerSellQuote),
    reason: snapshot.signal?.reason || "flow scan"
  });
  btc.orderFlow = btc.orderFlow.slice(0, 120);
  btc.equityCurve.push({ time: Date.now(), equity: btcEquity(btc) });
  btc.equityCurve = btc.equityCurve.slice(-MAX_EQUITY_POINTS);
  return btc;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    }

    const state = await readJson(STATE_PATH, {});
    const btc = normalizeBtcState(state?.btc);
    const force = req.query?.force === "1" || req.query?.force === "true";
    const recentSnapshot = btc.lastSnapshot && Date.now() - safeNum(btc.updatedAt) < MIN_CYCLE_INTERVAL_MS;
    if (recentSnapshot && !force) {
      return sendJson(res, 200, {
        ok: true,
        source: activeMarketApi.name,
        storage: { provider: storageProvider() },
        persisted: true,
        throttled: true,
        nextCycleAt: safeNum(btc.updatedAt) + MIN_CYCLE_INTERVAL_MS,
        snapshot: btc.lastSnapshot,
        btc
      });
    }

    const snapshot = await fetchBtcSnapshot();
    const updatedBtc = runBtcCycle(btc, snapshot);
    const nextState = {
      ...(state && typeof state === "object" ? state : {}),
      btc: updatedBtc,
      sharedUpdatedAt: Date.now()
    };
    const stored = await writeJson(STATE_PATH, nextState);

    return sendJson(res, 200, {
      ok: true,
      source: activeMarketApi.name,
      storage: { provider: stored.provider || storageProvider() },
      persisted: true,
      snapshot,
      btc: updatedBtc
    });
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      persisted: false,
      storage: { provider: storageProvider() },
      error: error.message
    });
  }
};
