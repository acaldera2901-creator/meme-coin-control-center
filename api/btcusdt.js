const MARKET_APIS = [
  { name: "binance.com-public-spot", base: "https://api.binance.com" },
  { name: "binance.us-public-spot", base: "https://api.binance.us" }
];
const SYMBOL = "BTCUSDT";
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
  const cvd = takerBuyQuote - takerSellQuote;
  return {
    count: trades.length,
    takerBuyQuote,
    takerSellQuote,
    totalQuote,
    cvd,
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

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    }

    const [book, trades, ticker, klines] = await Promise.all([
      fetchJson(`/api/v3/depth?symbol=${SYMBOL}&limit=100`),
      fetchJson(`/api/v3/trades?symbol=${SYMBOL}&limit=500`),
      fetchJson(`/api/v3/ticker/price?symbol=${SYMBOL}`),
      fetchJson(`/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=16`)
    ]);

    const snapshot = buildSignal({
      book,
      trades: Array.isArray(trades) ? trades : [],
      klines: Array.isArray(klines) ? klines : [],
      price: safeNum(ticker.price)
    });

    return sendJson(res, 200, { ok: true, source: activeMarketApi.name, snapshot });
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: error.message });
  }
};
