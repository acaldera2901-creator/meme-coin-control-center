const DEXSCREENER_API = "https://api.dexscreener.com";
const RESEARCH_ENDPOINT = "/api/research";
const SHEETS_ENDPOINT = "/api/sheets";
const BITQUERY_ENDPOINT = "https://streaming.bitquery.io/graphql";
const RESEARCH_INTERVAL_MS = 30 * 60000;
const { storageProvider } = require("./storage");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function bestPair(pairs, sourceToken) {
  const solPairs = pairs.filter((pair) => pair.chainId === "solana" && pair.priceUsd);
  if (!solPairs.length) return null;
  const sorted = solPairs.sort((a, b) => {
    const aAge = safeNum(a.pairCreatedAt);
    const bAge = safeNum(b.pairCreatedAt);
    const aLiq = safeNum(a.liquidity?.usd);
    const bLiq = safeNum(b.liquidity?.usd);
    return bLiq + bAge / 1_000_000 - (aLiq + aAge / 1_000_000);
  });
  return { ...sorted[0], sourceToken };
}

function moonshotScore(pair) {
  const buys = safeNum(pair.txns?.m5?.buys);
  const sells = safeNum(pair.txns?.m5?.sells);
  const volume5 = safeNum(pair.volume?.m5);
  const liq = safeNum(pair.liquidity?.usd);
  const change5 = safeNum(pair.priceChange?.m5);
  const ageMinutes = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 99999;
  const txCount = buys + sells;
  const buyRatio = sells === 0 ? buys : buys / Math.max(1, sells);
  const volLiq = liq > 0 ? volume5 / liq : 0;
  let score = 0;
  if (ageMinutes <= 15) score += 24;
  else if (ageMinutes <= 45) score += 10;
  if (txCount >= 80) score += 16;
  else if (txCount >= 35) score += 9;
  if (buyRatio >= 2.4) score += 18;
  else if (buyRatio >= 1.6) score += 10;
  if (volLiq >= 0.35 && volLiq <= 4.5) score += 16;
  else if (volLiq > 0.12 && volLiq < 7) score += 8;
  if (change5 >= 20 && change5 <= 180) score += 14;
  else if (change5 > 0 && change5 < 260) score += 7;
  if (liq >= 12000 && liq <= 180000) score += 10;
  else if (liq >= 6000) score += 5;
  if (change5 > 350) score -= 28;
  if (liq < 5000) score -= 22;
  if (sells > buys * 1.15 && txCount > 20) score -= 20;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function dexPairToObservation(pair) {
  return {
    pairAddress: pair.pairAddress,
    tokenAddress: pair.baseToken?.address,
    symbol: pair.baseToken?.symbol,
    name: pair.baseToken?.name,
    url: pair.url,
    pairCreatedAt: pair.pairCreatedAt,
    price: safeNum(pair.priceUsd),
    liq: safeNum(pair.liquidity?.usd),
    fdv: safeNum(pair.fdv),
    marketCap: safeNum(pair.marketCap),
    volume5: safeNum(pair.volume?.m5),
    volume1h: safeNum(pair.volume?.h1),
    buys5: safeNum(pair.txns?.m5?.buys),
    sells5: safeNum(pair.txns?.m5?.sells),
    change5: safeNum(pair.priceChange?.m5),
    boosts: safeNum(pair.boosts?.active),
    score: 0,
    moonshotScore: moonshotScore(pair),
    observedAt: Date.now()
  };
}

function rotateItems(items, seed) {
  if (!items.length) return items;
  const offset = Math.abs(seed) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

async function collectDexScreener(options = {}) {
  const [profilesRaw, boostsRaw, topBoostsRaw] = await Promise.all([
    fetchJson(`${DEXSCREENER_API}/token-profiles/latest/v1`),
    fetchJson(`${DEXSCREENER_API}/token-boosts/latest/v1`),
    fetchJson(`${DEXSCREENER_API}/token-boosts/top/v1`)
  ]);

  const tokens = [...asArray(profilesRaw), ...asArray(boostsRaw), ...asArray(topBoostsRaw)]
    .filter((token) => token.chainId === "solana" && token.tokenAddress);
  const unique = [...new Map(tokens.map((token) => [token.tokenAddress, token])).values()];
  const rotated = rotateItems(unique, safeNum(options.seed));
  const limit = Math.max(20, Math.min(160, safeNum(options.limit) || 140));
  const batch = rotated.slice(0, limit);
  const pairBatches = await Promise.all(batch.map(async (token) => {
    try {
      const pairs = await fetchJson(`${DEXSCREENER_API}/token-pairs/v1/solana/${token.tokenAddress}`);
      return bestPair(asArray(pairs), token);
    } catch {
      return null;
    }
  }));
  return pairBatches.filter(Boolean).map(dexPairToObservation);
}

function bitqueryQuery() {
  return `{
    Trading {
      Trades(
        limit: {count: 100}
        orderBy: {descendingByField: "net_flow"}
        where: {Block: {Time: {since_relative: {hours_ago: 1}}}, Pair: {Market: {Network: {is: "Solana"}}}}
      ) {
        count
        total_volume: sum(of: AmountsInUsd_Quote)
        buy_volume: sum(of: AmountsInUsd_Quote, if: {Side: {is: "Buy"}})
        sell_volume: sum(of: AmountsInUsd_Quote, if: {Side: {is: "Sell"}})
        buys: count(if: {Side: {is: "Buy"}})
        sells: count(if: {Side: {is: "Sell"}})
        net_flow: calculate(expression: "$buys - $sells")
        Pair {
          Pool { Address }
          Token { Address Symbol }
        }
      }
    }
  }`;
}

async function collectBitquery() {
  const token = process.env.BITQUERY_TOKEN || process.env.BITQUERY_API_KEY;
  if (!token) {
    return { observations: [], enabled: false, error: "missing BITQUERY_TOKEN" };
  }
  const payload = await fetchJson(BITQUERY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ query: bitqueryQuery() })
  });
  const trades = asArray(payload?.data?.Trading?.Trades);
  const observations = trades.map((row) => {
    const buys = safeNum(row.buys);
    const sells = safeNum(row.sells);
    const volume = safeNum(row.total_volume);
    const buyRatio = sells === 0 ? buys : buys / Math.max(1, sells);
    const moonshot = Math.max(0, Math.min(100, Math.round(
      (buyRatio >= 2.4 ? 28 : buyRatio >= 1.6 ? 16 : 0) +
      (buys + sells >= 80 ? 22 : buys + sells >= 35 ? 12 : 0) +
      (volume >= 25000 ? 18 : volume >= 7500 ? 10 : 0)
    )));
    return {
      pairAddress: row.Pair?.Pool?.Address,
      tokenAddress: row.Pair?.Token?.Address,
      symbol: row.Pair?.Token?.Symbol,
      name: row.Pair?.Token?.Symbol,
      url: row.Pair?.Pool?.Address ? `https://dexscreener.com/solana/${row.Pair.Pool.Address}` : "",
      pairCreatedAt: Date.now() - 60 * 60000,
      price: 1,
      liq: 0,
      fdv: 0,
      marketCap: 0,
      volume5: volume,
      volume1h: volume,
      buys5: buys,
      sells5: sells,
      change5: 0,
      boosts: 0,
      score: 0,
      moonshotScore: moonshot,
      observedAt: Date.now()
    };
  }).filter((item) => item.pairAddress && item.tokenAddress);
  return { observations, enabled: true, error: "" };
}

async function pushResearch(req, observations) {
  const host = req.headers.host;
  const protocol = host?.includes("localhost") ? "http" : "https";
  const response = await fetch(`${protocol}://${host}${RESEARCH_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ observations })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || `research HTTP ${response.status}`);
  return payload;
}

async function pushSheets(req, payload) {
  const host = req.headers.host;
  const protocol = host?.includes("localhost") ? "http" : "https";
  const response = await fetch(`${protocol}://${host}${SHEETS_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `sheets HTTP ${response.status}`);
  return body;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    const mode = url.searchParams.get("mode");
    if (mode === "status") {
      return sendJson(res, 200, {
        ok: true,
        storage: { provider: storageProvider() },
        internal: { enabled: true, source: "DexScreener server collector" },
        researchAgent: { enabled: true, intervalMinutes: 30, rotation: "time-seeded token batch" },
        external: {
          enabled: Boolean(process.env.BITQUERY_TOKEN || process.env.BITQUERY_API_KEY),
          source: "Bitquery Solana Trading API",
          requiredEnv: "BITQUERY_TOKEN"
        }
      });
    }

    const isCronRun = req.headers["x-vercel-cron"] === "1" || req.headers["x-vercel-cron"] === "true";
    const isResearchAgent = url.searchParams.get("agent") === "research" || isCronRun;
    const source = url.searchParams.get("source") || (isCronRun ? "internal" : "all");
    const cycle = safeNum(url.searchParams.get("cycle")) || Date.now();
    const seed = isResearchAgent ? Math.floor(cycle / RESEARCH_INTERVAL_MS) : Math.floor(Date.now() / 60000);
    const internal = source === "all" || source === "internal" ? await collectDexScreener({ seed, limit: isResearchAgent ? 160 : 140 }) : [];
    const bitquery = source === "all" || source === "external" ? await collectBitquery() : { observations: [], enabled: false, error: "" };
    const observations = [...internal, ...bitquery.observations];
    let summary = null;
    let persisted = false;
    let storage = null;
    let storageError = "";
    let sheets = null;
    let sheetsError = "";
    if (observations.length) {
      try {
        const research = await pushResearch(req, observations);
        summary = research.summary || null;
        persisted = Boolean(research.persisted);
        storage = research.storage || null;
        storageError = research.storageError || "";
      } catch (error) {
        storageError = error.message;
      }
      try {
        sheets = await pushSheets(req, {
          cycleAt: cycle,
          agent: isResearchAgent ? "research" : "collector",
          collected: observations.length,
          persisted,
          storageError,
          observations,
          summary
        });
      } catch (error) {
        sheetsError = error.message;
      }
    }

    return sendJson(res, 200, {
      ok: true,
      collected: observations.length,
      persisted,
      storage,
      storageError,
      sheets,
      sheetsError,
      agent: isResearchAgent ? "research" : "collector",
      cycle,
      nextResearchCycleAt: isResearchAgent ? cycle + RESEARCH_INTERVAL_MS : null,
      internal: { collected: internal.length },
      external: { enabled: bitquery.enabled, collected: bitquery.observations.length, error: bitquery.error },
      summary
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message });
  }
};
