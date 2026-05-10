const { readJson, storageProvider } = require("./storage");

const RESEARCH_PATH = "meme-coin-control-center/moonshot-research.json";

const HEADERS = {
  cycles: [
    "snapshot_at", "agent", "collected", "total_samples", "learning", "complete_15m",
    "plus_10x", "plus_100x", "plus_700x", "live_edge", "live_edge_score",
    "statistical_edge", "statistical_edge_score"
  ],
  observations: [
    "first_seen_at", "pair_address", "token_address", "symbol", "name", "first_price",
    "last_price", "max_multiplier", "outcome", "complete_15m", "liquidity_usd",
    "fdv", "market_cap", "volume_5m", "buys_5m", "sells_5m", "change_5m",
    "boosts", "moonshot_score", "url"
  ],
  edges: [
    "snapshot_at", "cohort", "samples", "completed", "edge_score", "confidence",
    "avg_moon", "avg_buy_sell", "avg_vol_liq", "avg_tx", "avg_liq",
    "hit_rate_10x", "hit_rate_100x", "hit_rate_700x"
  ]
};

function send(res, status, body, contentType = "application/json") {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(contentType === "application/json" ? JSON.stringify(body) : body);
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(values) {
  return `${values.map(csvValue).join(",")}\n`;
}

async function readResearch() {
  return readJson(RESEARCH_PATH, { samples: [], updatedAt: 0 });
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)));
  return sorted[index];
}

function buySellRatio(sample) {
  const sells = safeNum(sample.firstSells5);
  const buys = safeNum(sample.firstBuys5);
  return sells === 0 ? buys : buys / Math.max(1, sells);
}

function tradeCount(sample) {
  return safeNum(sample.firstBuys5) + safeNum(sample.firstSells5);
}

function volLiq(sample) {
  const liq = safeNum(sample.firstLiq);
  return liq > 0 ? safeNum(sample.firstVolume5) / liq : 0;
}

function fdvLiq(sample) {
  const liq = safeNum(sample.firstLiq);
  return liq > 0 ? safeNum(sample.firstFdv) / liq : 0;
}

function launchAgeMinutes(sample) {
  if (!sample.pairCreatedAt) return 99999;
  return Math.max(0, (sample.firstSeenAt - sample.pairCreatedAt) / 60000);
}

function cohortRules() {
  return [
    ["Moon >= 80 + first 15m", (s) => safeNum(s.firstMoonshotScore) >= 80 && launchAgeMinutes(s) <= 15],
    ["Buy/Sell >= 2.4", (s) => buySellRatio(s) >= 2.4 && tradeCount(s) >= 35],
    ["80+ trades in 5m", (s) => tradeCount(s) >= 80],
    ["Vol/Liq 0.35-4.5", (s) => volLiq(s) >= 0.35 && volLiq(s) <= 4.5],
    ["5m impulse 20-180%", (s) => safeNum(s.firstChange5) >= 20 && safeNum(s.firstChange5) <= 180],
    ["Liq $12k-$180k", (s) => safeNum(s.firstLiq) >= 12000 && safeNum(s.firstLiq) <= 180000],
    ["FDV/Liq <= 120", (s) => fdvLiq(s) > 0 && fdvLiq(s) <= 120],
    ["Boost confirmed", (s) => safeNum(s.firstBoosts) > 0 && safeNum(s.firstBoosts) <= 80]
  ];
}

function liveFlowStats(label, samples) {
  const count = samples.length;
  const avg = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  if (!count) return { label, samples: 0, completed: 0, edgeScore: 0, confidence: 0 };
  const moon = samples.map((sample) => safeNum(sample.firstMoonshotScore));
  const avgBuySell = avg(samples.map(buySellRatio));
  const avgVolLiq = avg(samples.map(volLiq));
  const avgTx = avg(samples.map(tradeCount));
  const avgLiq = avg(samples.map((sample) => safeNum(sample.firstLiq)));
  const confidence = Math.min(1, count / 250);
  return {
    label,
    samples: count,
    completed: samples.filter((sample) => sample.complete15m).length,
    edgeScore: Math.round((avg(moon) + Math.min(30, avgBuySell * 5) + Math.min(20, avgVolLiq * 6) + Math.min(20, avgTx / 8)) * confidence),
    confidence,
    avgMoon: avg(moon),
    avgBuySell,
    avgVolLiq,
    avgTx,
    avgLiq,
    hitRate10: 0,
    hitRate100: 0,
    hitRate700: 0
  };
}

function summary(samples) {
  const complete = samples.filter((sample) => sample.complete15m);
  const liveFlow = cohortRules()
    .map(([label, test]) => liveFlowStats(label, samples.filter(test)))
    .sort((a, b) => b.edgeScore - a.edgeScore);
  return {
    total: samples.length,
    learning: samples.filter((sample) => !sample.complete15m).length,
    complete15m: complete.length,
    plus10: samples.filter((sample) => safeNum(sample.maxMultiplier) >= 10).length,
    plus100: samples.filter((sample) => safeNum(sample.maxMultiplier) >= 100).length,
    plus700: samples.filter((sample) => safeNum(sample.maxMultiplier) >= 700).length,
    currentEdge: liveFlow[0] || null,
    liveFlow
  };
}

function cyclesCsv(research) {
  const samples = Array.isArray(research.samples) ? research.samples : [];
  const cycles = Array.isArray(research.cycles) ? research.cycles : [];
  const s = summary(samples);
  const fallback = [{
    at: research.updatedAt || Date.now(),
    agent: "research",
    collected: samples.length,
    total: s.total,
    learning: s.learning,
    complete15m: s.complete15m,
    plus10: s.plus10,
    plus100: s.plus100,
    plus700: s.plus700,
    liveEdge: s.currentEdge?.label || "",
    liveEdgeScore: safeNum(s.currentEdge?.edgeScore),
    statisticalEdge: "",
    statisticalEdgeScore: 0
  }];
  return csvRow(HEADERS.cycles) + (cycles.length ? cycles : fallback).map((cycle) => csvRow([
    new Date(cycle.at || Date.now()).toISOString(),
    cycle.agent || "",
    safeNum(cycle.collected),
    safeNum(cycle.total),
    safeNum(cycle.learning),
    safeNum(cycle.complete15m),
    safeNum(cycle.plus10),
    safeNum(cycle.plus100),
    safeNum(cycle.plus700),
    cycle.liveEdge || "",
    safeNum(cycle.liveEdgeScore),
    cycle.statisticalEdge || "",
    safeNum(cycle.statisticalEdgeScore)
  ])).join("");
}

function observationsCsv(research) {
  const samples = Array.isArray(research.samples) ? research.samples : [];
  return csvRow(HEADERS.observations) + samples.map((sample) => csvRow([
    sample.firstSeenAt ? new Date(sample.firstSeenAt).toISOString() : "",
    sample.pairAddress,
    sample.tokenAddress,
    sample.symbol,
    sample.name,
    sample.firstPrice,
    sample.lastPrice || sample.firstPrice,
    sample.maxMultiplier,
    sample.outcome,
    sample.complete15m,
    sample.firstLiq,
    sample.firstFdv,
    sample.firstMarketCap,
    sample.firstVolume5,
    sample.firstBuys5,
    sample.firstSells5,
    sample.firstChange5,
    sample.firstBoosts,
    sample.firstMoonshotScore,
    sample.url
  ])).join("");
}

function edgesCsv(research) {
  const samples = Array.isArray(research.samples) ? research.samples : [];
  const s = summary(samples);
  const snapshot = new Date(research.updatedAt || Date.now()).toISOString();
  return csvRow(HEADERS.edges) + s.liveFlow.map((cohort) => csvRow([
    snapshot,
    cohort.label,
    cohort.samples,
    cohort.completed,
    cohort.edgeScore,
    cohort.confidence,
    cohort.avgMoon,
    cohort.avgBuySell,
    cohort.avgVolLiq,
    cohort.avgTx,
    cohort.avgLiq,
    cohort.hitRate10,
    cohort.hitRate100,
    cohort.hitRate700
  ])).join("");
}

function status(research) {
  const samples = Array.isArray(research.samples) ? research.samples : [];
  const cycles = Array.isArray(research.cycles) ? research.cycles : [];
  const s = summary(samples);
  return {
    ok: true,
    mode: "derived-from-internal-research-dataset",
    storage: { provider: storageProvider() },
    sheets: [
      { name: "cycles", rows: Math.max(1, cycles.length), path: "/api/sheets?sheet=cycles" },
      { name: "observations", rows: samples.length, path: "/api/sheets?sheet=observations" },
      { name: "edges", rows: s.liveFlow.length, path: "/api/sheets?sheet=edges" }
    ]
  };
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const sheet = url.searchParams.get("sheet") || "status";
    const research = await readResearch();
    if (sheet === "status") return send(res, 200, status(research));
    if (sheet === "cycles") return send(res, 200, cyclesCsv(research), "text/csv; charset=utf-8");
    if (sheet === "observations") return send(res, 200, observationsCsv(research), "text/csv; charset=utf-8");
    if (sheet === "edges") return send(res, 200, edgesCsv(research), "text/csv; charset=utf-8");
    return send(res, 404, { ok: false, error: "unknown-sheet" });
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message });
  }
};
