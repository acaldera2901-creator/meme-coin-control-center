const { readJson, storageProvider, writeJson } = require("./storage");

const RESEARCH_PATH = "meme-coin-control-center/moonshot-research.json";
const MAX_SAMPLES = 10000;
const MARKS = [
  ["m0", 0],
  ["m1", 1],
  ["m3", 3],
  ["m5", 5],
  ["m10", 10],
  ["m15", 15]
];

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readResearch() {
  return readJson(RESEARCH_PATH, { samples: [], cycles: [], updatedAt: 0 });
}

async function writeResearch(research) {
  return writeJson(RESEARCH_PATH, research);
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function compactObservation(item) {
  return {
    pairAddress: String(item.pairAddress || ""),
    tokenAddress: String(item.tokenAddress || ""),
    symbol: String(item.symbol || "UNKNOWN").slice(0, 24),
    name: String(item.name || "Unknown").slice(0, 64),
    url: String(item.url || ""),
    pairCreatedAt: safeNum(item.pairCreatedAt),
    price: safeNum(item.price),
    liq: safeNum(item.liq),
    fdv: safeNum(item.fdv),
    marketCap: safeNum(item.marketCap),
    volume5: safeNum(item.volume5),
    volume1h: safeNum(item.volume1h),
    buys5: safeNum(item.buys5),
    sells5: safeNum(item.sells5),
    change5: safeNum(item.change5),
    boosts: safeNum(item.boosts),
    score: safeNum(item.score),
    moonshotScore: safeNum(item.moonshotScore),
    observedAt: safeNum(item.observedAt) || Date.now()
  };
}

function snapshot(obs) {
  return {
    t: obs.observedAt,
    p: obs.price,
    l: obs.liq,
    v5: obs.volume5,
    b5: obs.buys5,
    s5: obs.sells5,
    c5: obs.change5,
    ms: obs.moonshotScore
  };
}

function markKey(sample, observedAt) {
  const ageMin = Math.max(0, (observedAt - sample.firstSeenAt) / 60000);
  let selected = "m0";
  let selectedDistance = Infinity;
  for (const [key, minute] of MARKS) {
    const distance = Math.abs(ageMin - minute);
    if (distance < selectedDistance) {
      selected = key;
      selectedDistance = distance;
    }
  }
  return selected;
}

function classify(sample) {
  const prices = Object.values(sample.marks || {}).map((mark) => safeNum(mark.p)).filter((price) => price > 0);
  const maxPrice = Math.max(sample.firstPrice || 0, ...prices);
  const maxMultiplier = sample.firstPrice > 0 ? maxPrice / sample.firstPrice : 1;
  const ageMin = (Date.now() - sample.firstSeenAt) / 60000;
  const hasM15 = Boolean(sample.marks?.m15);
  let outcome = "learning";
  if (maxMultiplier >= 700) outcome = "700x-plus";
  else if (maxMultiplier >= 100) outcome = "100x-plus";
  else if (maxMultiplier >= 50) outcome = "50x-plus";
  else if (maxMultiplier >= 10) outcome = "10x-plus";
  else if (hasM15 || ageMin >= 17) outcome = "under-10x";
  return {
    ...sample,
    maxMultiplier,
    outcome,
    complete15m: hasM15 || ageMin >= 17,
    updatedAt: Date.now()
  };
}

function markPrice(sample, key) {
  return safeNum(sample.marks?.[key]?.p);
}

function returnToMark(sample, key) {
  const first = safeNum(sample.firstPrice);
  const price = markPrice(sample, key);
  return first > 0 && price > 0 ? ((price - first) / first) * 100 : 0;
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)));
  return sorted[index];
}

function cohortRules() {
  return [
    {
      id: "moon_80_first15",
      label: "Moon >= 80 + first 15m",
      test: (s) => safeNum(s.firstMoonshotScore) >= 80 && launchAgeMinutes(s) <= 15
    },
    {
      id: "buy_imbalance_24",
      label: "Buy/Sell >= 2.4",
      test: (s) => buySellRatio(s) >= 2.4 && tradeCount(s) >= 35
    },
    {
      id: "tx_burst_80",
      label: "80+ trades in 5m",
      test: (s) => tradeCount(s) >= 80
    },
    {
      id: "vol_liq_expansion",
      label: "Vol/Liq 0.35-4.5",
      test: (s) => volLiq(s) >= 0.35 && volLiq(s) <= 4.5
    },
    {
      id: "impulse_not_vertical",
      label: "5m impulse 20-180%",
      test: (s) => safeNum(s.firstChange5) >= 20 && safeNum(s.firstChange5) <= 180
    },
    {
      id: "liq_band",
      label: "Liq $12k-$180k",
      test: (s) => safeNum(s.firstLiq) >= 12000 && safeNum(s.firstLiq) <= 180000
    },
    {
      id: "clean_fdv_liq",
      label: "FDV/Liq <= 120",
      test: (s) => fdvLiq(s) > 0 && fdvLiq(s) <= 120
    },
    {
      id: "boost_confirmed",
      label: "Boost confirmed",
      test: (s) => safeNum(s.firstBoosts) > 0 && safeNum(s.firstBoosts) <= 80
    }
  ];
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

function cohortStats(label, samples) {
  const completed = samples.filter((sample) => sample.complete15m);
  const analysisSet = completed.length ? completed : samples;
  const multipliers = analysisSet.map((sample) => Math.max(1, safeNum(sample.maxMultiplier)));
  const hits10 = completed.filter((sample) => safeNum(sample.maxMultiplier) >= 10).length;
  const hits100 = completed.filter((sample) => safeNum(sample.maxMultiplier) >= 100).length;
  const hits700 = completed.filter((sample) => safeNum(sample.maxMultiplier) >= 700).length;
  const average = multipliers.length ? multipliers.reduce((sum, value) => sum + value, 0) / multipliers.length : 0;
  const median = percentile(multipliers, 0.5);
  const p90 = percentile(multipliers, 0.9);
  const sampleConfidence = Math.min(1, completed.length / 200);
  const hitRate700 = completed.length ? hits700 / completed.length : 0;
  const hitRate100 = completed.length ? hits100 / completed.length : 0;
  const hitRate10 = completed.length ? hits10 / completed.length : 0;
  return {
    label,
    samples: samples.length,
    completed: completed.length,
    hitRate10,
    hitRate100,
    hitRate700,
    avgMax: average,
    medianMax: median,
    p90Max: p90,
    confidence: sampleConfidence,
    edgeScore: Math.round((hitRate700 * 700 + hitRate100 * 80 + hitRate10 * 12 + Math.log10(Math.max(1, p90)) * 8) * sampleConfidence)
  };
}

function liveFlowStats(label, samples) {
  const count = samples.length;
  if (!count) {
    return {
      label,
      samples: 0,
      medianMoon: 0,
      avgMoon: 0,
      avgBuySell: 0,
      avgVolLiq: 0,
      avgTx: 0,
      avgLiq: 0,
      confidence: 0,
      edgeScore: 0
    };
  }
  const moon = samples.map((sample) => safeNum(sample.firstMoonshotScore));
  const avg = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const avgBuySell = avg(samples.map(buySellRatio));
  const avgVolLiq = avg(samples.map(volLiq));
  const avgTx = avg(samples.map(tradeCount));
  const avgLiq = avg(samples.map((sample) => safeNum(sample.firstLiq)));
  const medianMoon = percentile(moon, 0.5);
  const avgMoon = avg(moon);
  const confidence = Math.min(1, count / 250);
  return {
    label,
    samples: count,
    medianMoon,
    avgMoon,
    avgBuySell,
    avgVolLiq,
    avgTx,
    avgLiq,
    confidence,
    edgeScore: Math.round((avgMoon + Math.min(30, avgBuySell * 5) + Math.min(20, avgVolLiq * 6) + Math.min(20, avgTx / 8)) * confidence)
  };
}

function analyzeEdges(samples) {
  const completed = samples.filter((sample) => sample.complete15m);
  const baseline = cohortStats("Baseline all labeled launches", samples);
  const cohorts = cohortRules().map((rule) => cohortStats(rule.label, samples.filter(rule.test)));
  const liveFlow = cohortRules()
    .map((rule) => liveFlowStats(rule.label, samples.filter(rule.test)))
    .sort((a, b) => b.edgeScore - a.edgeScore)
    .slice(0, 8);
  const ranked = cohorts
    .map((cohort) => ({
      ...cohort,
      lift700: baseline.hitRate700 ? cohort.hitRate700 / baseline.hitRate700 : cohort.hitRate700 > 0 ? 999 : 0,
      lift100: baseline.hitRate100 ? cohort.hitRate100 / baseline.hitRate100 : cohort.hitRate100 > 0 ? 999 : 0
    }))
    .sort((a, b) => b.edgeScore - a.edgeScore)
    .slice(0, 8);

  const status = completed.length < 100
    ? "collecting"
    : completed.length < 1000
      ? "early-signal"
      : "statistical";

  return {
    status,
    baseline,
    topCohorts: ranked,
    liveFlow,
    currentEdge: ranked[0] || null,
    currentLiveEdge: liveFlow[0] || null,
    intelligence: edgeIntelligence(samples),
    minSamplesForConfidence: 1000,
    completedNeeded: Math.max(0, 1000 - completed.length)
  };
}

function likelyEntryGate(sample) {
  const ratio = buySellRatio(sample);
  const tx = tradeCount(sample);
  const vl = volLiq(sample);
  const liq = safeNum(sample.firstLiq);
  const change = safeNum(sample.firstChange5);
  const moon = safeNum(sample.firstMoonshotScore);
  if (moon >= 78 && tx >= 35 && liq >= 8000 && change <= 260) return true;
  if (tx >= 80 && ratio >= 1.55 && vl >= 0.22 && vl <= 5 && liq >= 10000 && change <= 260) return true;
  if (ratio >= 2.3 && tx >= 35 && liq >= 12000 && change >= 0 && change <= 220) return true;
  return false;
}

function avoidReason(sample) {
  const ratio = buySellRatio(sample);
  const tx = tradeCount(sample);
  const vl = volLiq(sample);
  const liq = safeNum(sample.firstLiq);
  const change = safeNum(sample.firstChange5);
  const age = launchAgeMinutes(sample);
  if (liq < 8000) return "thin liquidity";
  if (change > 320) return "late vertical impulse";
  if (safeNum(sample.firstSells5) > safeNum(sample.firstBuys5) * 1.25 && tx >= 25) return "sell pressure";
  if (vl > 7) return "toxic volume/liquidity";
  if (age > 45 && change < 15) return "stale launch";
  if (ratio < 1.05 && tx >= 35) return "weak buy pressure";
  return "";
}

function edgeIntelligence(samples) {
  const completed = samples.filter((sample) => sample.complete15m);
  const learning = samples.filter((sample) => !sample.complete15m);
  const winners = completed.filter((sample) => safeNum(sample.maxMultiplier) >= 1.35);
  const missedWinners = winners
    .filter((sample) => !likelyEntryGate(sample))
    .sort((a, b) => safeNum(b.maxMultiplier) - safeNum(a.maxMultiplier))
    .slice(0, 8)
    .map((sample) => ({
      symbol: sample.symbol,
      maxMultiplier: safeNum(sample.maxMultiplier),
      firstMoonshotScore: safeNum(sample.firstMoonshotScore),
      buySellRatio: buySellRatio(sample),
      txCount: tradeCount(sample),
      volLiq: volLiq(sample),
      liq: safeNum(sample.firstLiq),
      change5: safeNum(sample.firstChange5),
      reason: "winner missed by current gate"
    }));
  const badEntries = completed
    .filter((sample) => likelyEntryGate(sample) && safeNum(sample.maxMultiplier) < 1.15)
    .sort((a, b) => returnToMark(a, "m15") - returnToMark(b, "m15"))
    .slice(0, 8)
    .map((sample) => ({
      symbol: sample.symbol,
      maxMultiplier: safeNum(sample.maxMultiplier),
      m15Return: returnToMark(sample, "m15"),
      firstMoonshotScore: safeNum(sample.firstMoonshotScore),
      buySellRatio: buySellRatio(sample),
      txCount: tradeCount(sample),
      volLiq: volLiq(sample),
      liq: safeNum(sample.firstLiq),
      change5: safeNum(sample.firstChange5),
      reason: avoidReason(sample) || "gate accepted but no follow-through"
    }));
  const liveAvoid = learning
    .map((sample) => ({ sample, reason: avoidReason(sample) }))
    .filter((item) => item.reason)
    .slice(0, 8)
    .map(({ sample, reason }) => ({
      symbol: sample.symbol,
      firstMoonshotScore: safeNum(sample.firstMoonshotScore),
      buySellRatio: buySellRatio(sample),
      txCount: tradeCount(sample),
      volLiq: volLiq(sample),
      liq: safeNum(sample.firstLiq),
      change5: safeNum(sample.firstChange5),
      reason
    }));
  const completedScore = Math.min(40, completed.length / 25);
  const missPenalty = Math.min(20, missedWinners.length * 2.5);
  const badPenalty = Math.min(20, badEntries.length * 2.5);
  const edgeScore = Math.max(0, Math.min(100, Math.round(completedScore + Math.min(30, winners.length * 2) - missPenalty - badPenalty + 30)));
  return {
    edgeScore,
    completed: completed.length,
    learning: learning.length,
    missedWinners,
    badEntries,
    liveAvoid,
    recommendation: completed.length < 200
      ? "Collect more labeled outcomes; use live flow only with reduced size."
      : missedWinners.length > badEntries.length
        ? "Open the gate slightly for early winners with clean liquidity."
        : "Keep filters strict; most accepted entries still need cleaner follow-through."
  };
}

function upsertSamples(samples, observations) {
  const byPair = new Map(samples.map((sample) => [sample.pairAddress, sample]));
  for (const raw of observations) {
    const obs = compactObservation(raw);
    if (!obs.pairAddress || !obs.tokenAddress || obs.price <= 0) continue;
    const existing = byPair.get(obs.pairAddress);
    if (!existing) {
      const sample = {
        pairAddress: obs.pairAddress,
        tokenAddress: obs.tokenAddress,
        symbol: obs.symbol,
        name: obs.name,
        url: obs.url,
        pairCreatedAt: obs.pairCreatedAt,
        firstSeenAt: obs.observedAt,
        firstPrice: obs.price,
        firstLiq: obs.liq,
        firstFdv: obs.fdv,
        firstMarketCap: obs.marketCap,
        firstVolume5: obs.volume5,
        firstBuys5: obs.buys5,
        firstSells5: obs.sells5,
        firstChange5: obs.change5,
        firstBoosts: obs.boosts,
        firstScore: obs.score,
        firstMoonshotScore: obs.moonshotScore,
        marks: { m0: snapshot(obs) }
      };
      byPair.set(obs.pairAddress, classify(sample));
      continue;
    }
    const key = markKey(existing, obs.observedAt);
    existing.marks = { ...(existing.marks || {}), [key]: snapshot(obs) };
    existing.lastPrice = obs.price;
    existing.lastMoonshotScore = obs.moonshotScore;
    existing.lastObservedAt = obs.observedAt;
    byPair.set(obs.pairAddress, classify(existing));
  }
  return [...byPair.values()]
    .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
    .slice(0, MAX_SAMPLES);
}

function summarize(samples) {
  const complete = samples.filter((sample) => sample.complete15m);
  const plus10 = samples.filter((sample) => sample.maxMultiplier >= 10);
  const plus100 = samples.filter((sample) => sample.maxMultiplier >= 100);
  const plus700 = samples.filter((sample) => sample.maxMultiplier >= 700);
  const learning = samples.filter((sample) => !sample.complete15m);
  const top = [...samples]
    .sort((a, b) => (b.maxMultiplier || 1) - (a.maxMultiplier || 1))
    .slice(0, 12);
  return {
    target: MAX_SAMPLES,
    total: samples.length,
    complete15m: complete.length,
    learning: learning.length,
    plus10: plus10.length,
    plus100: plus100.length,
    plus700: plus700.length,
    edge: analyzeEdges(samples),
    top
  };
}

function cycleRecord(payload, summary) {
  const liveEdge = summary.edge?.currentLiveEdge || {};
  const statisticalEdge = summary.edge?.currentEdge || {};
  return {
    at: Date.now(),
    agent: String(payload.agent || "research"),
    collected: Array.isArray(payload.observations) ? payload.observations.length : 0,
    persisted: true,
    total: summary.total,
    learning: summary.learning,
    complete15m: summary.complete15m,
    plus10: summary.plus10,
    plus100: summary.plus100,
    plus700: summary.plus700,
    liveEdge: liveEdge.label || "",
    liveEdgeScore: safeNum(liveEdge.edgeScore),
    statisticalEdge: statisticalEdge.label || "",
    statisticalEdgeScore: safeNum(statisticalEdge.edgeScore)
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const research = await readResearch();
      return sendJson(res, 200, {
        ok: true,
        storage: { provider: storageProvider(), persisted: true },
        summary: summarize(research.samples || []),
        updatedAt: research.updatedAt || 0
      });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const observations = Array.isArray(payload.observations) ? payload.observations : [];
      const research = await readResearch();
      const samples = upsertSamples(Array.isArray(research.samples) ? research.samples : [], observations);
      const summary = summarize(samples);
      const cycles = [...(Array.isArray(research.cycles) ? research.cycles : []), cycleRecord(payload, summary)].slice(-500);
      const next = { samples, cycles, updatedAt: Date.now() };
      try {
        const stored = await writeResearch(next);
        return sendJson(res, 200, {
          ok: true,
          persisted: true,
          storage: { provider: stored.provider },
          summary,
          updatedAt: next.updatedAt
        });
      } catch (error) {
        return sendJson(res, 200, {
          ok: true,
          persisted: false,
          storage: { provider: storageProvider(), error: error.message },
          storageError: error.message,
          summary,
          updatedAt: next.updatedAt
        });
      }
    }

    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message });
  }
};
