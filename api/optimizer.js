const { readJson, storageProvider, writeJson } = require("./storage");

const RESEARCH_PATH = "meme-coin-control-center/moonshot-research.json";
const OPTIMIZER_PATH = "meme-coin-control-center/strategy-optimizer.json";

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

function launchAgeMinutes(sample) {
  return sample.pairCreatedAt ? Math.max(0, (sample.firstSeenAt - sample.pairCreatedAt) / 60000) : 99999;
}

function likelyEntryGate(sample, config) {
  const ratio = buySellRatio(sample);
  const tx = tradeCount(sample);
  const vl = volLiq(sample);
  const liq = safeNum(sample.firstLiq);
  const change = safeNum(sample.firstChange5);
  const moon = safeNum(sample.firstMoonshotScore);
  if (moon >= config.moonshotBypassScore && tx >= 35 && liq >= config.minLiquidity * 0.75 && change <= config.maxImpulse) return true;
  if (tx >= config.minTx && ratio >= config.minBuyRatio && vl >= config.minVolLiq && vl <= config.maxVolLiq && liq >= config.minLiquidity && change <= config.maxImpulse) return true;
  if (ratio >= config.strongBuyRatio && tx >= 35 && liq >= config.minLiquidity && change >= config.minImpulse && change <= config.maxImpulse) return true;
  return false;
}

function cleanMissedWinner(sample) {
  const ratio = buySellRatio(sample);
  const tx = tradeCount(sample);
  const vl = volLiq(sample);
  const liq = safeNum(sample.firstLiq);
  const change = safeNum(sample.firstChange5);
  const age = launchAgeMinutes(sample);
  return safeNum(sample.maxMultiplier) >= 1.35
    && liq >= 10000
    && tx >= 35
    && ratio >= 1.25
    && vl >= 0.15
    && vl <= 6
    && change >= -5
    && change <= 260
    && age <= 45;
}

function toxicAccepted(sample) {
  const tx = tradeCount(sample);
  const liq = safeNum(sample.firstLiq);
  const change = safeNum(sample.firstChange5);
  return liq < 10000
    || change > 300
    || safeNum(sample.firstSells5) > safeNum(sample.firstBuys5) * 1.25 && tx >= 25
    || volLiq(sample) > 7
    || buySellRatio(sample) < 1.05 && tx >= 35;
}

function baseConfig() {
  return {
    version: 1,
    mode: "strict-learning",
    minLiquidity: 12000,
    maxLiquidity: 180000,
    minTx: 80,
    minBuyRatio: 1.6,
    strongBuyRatio: 2.4,
    minVolLiq: 0.25,
    maxVolLiq: 4.5,
    minImpulse: 10,
    maxImpulse: 180,
    moonshotBypassScore: 82,
    evGate: 4,
    maxSizePct: 0.10,
    normalSizePct: 0.05,
    updatedAt: Date.now(),
    rationale: "Default strict gate while the system collects labeled outcomes."
  };
}

function optimize(samples) {
  const completed = samples.filter((sample) => sample.complete15m);
  const current = baseConfig();
  const cleanMissed = completed.filter((sample) => cleanMissedWinner(sample) && !likelyEntryGate(sample, current));
  const badEntries = completed.filter((sample) => likelyEntryGate(sample, current) && safeNum(sample.maxMultiplier) < 1.15);
  const toxicBad = badEntries.filter(toxicAccepted);
  const missedPressure = cleanMissed.length / Math.max(1, completed.length);
  const badPressure = badEntries.length / Math.max(1, completed.length);
  const toxicPressure = toxicBad.length / Math.max(1, badEntries.length);
  const config = { ...current };

  if (completed.length < 200) {
    config.mode = "strict-learning";
    config.rationale = "Not enough completed outcomes; keep strict filters and collect more labels.";
  } else if (cleanMissed.length > badEntries.length * 1.25) {
    config.mode = "surgical-open";
    config.minTx = 55;
    config.minBuyRatio = 1.35;
    config.minVolLiq = 0.18;
    config.maxVolLiq = 5.5;
    config.minImpulse = -5;
    config.maxImpulse = 240;
    config.moonshotBypassScore = 76;
    config.evGate = 3;
    config.rationale = "Clean missed winners dominate bad entries; open the gate only for clean liquidity and early flow.";
  } else if (badEntries.length > cleanMissed.length || toxicPressure > 0.35) {
    config.mode = "defensive-tighten";
    config.minLiquidity = 18000;
    config.minTx = 90;
    config.minBuyRatio = 1.75;
    config.minVolLiq = 0.28;
    config.maxVolLiq = 4.0;
    config.minImpulse = 15;
    config.maxImpulse = 170;
    config.moonshotBypassScore = 84;
    config.evGate = 6;
    config.rationale = "Bad entries are not beaten by missed winners; require cleaner follow-through.";
  } else {
    config.mode = "balanced-surgical";
    config.minTx = 65;
    config.minBuyRatio = 1.45;
    config.minVolLiq = 0.20;
    config.maxVolLiq = 5.0;
    config.minImpulse = 0;
    config.maxImpulse = 220;
    config.moonshotBypassScore = 78;
    config.evGate = 4;
    config.rationale = "Missed winners and bad entries are balanced; open only the clean early-flow corridor.";
  }

  config.updatedAt = Date.now();
  return {
    config,
    diagnostics: {
      completed: completed.length,
      total: samples.length,
      cleanMissed: cleanMissed.length,
      badEntries: badEntries.length,
      toxicBad: toxicBad.length,
      missedPressure,
      badPressure,
      toxicPressure,
      readiness: Math.max(0, Math.min(100, Math.round(Math.min(50, completed.length / 20) + Math.min(30, cleanMissed.length * 2) - Math.min(30, badEntries.length * 2) + 35)))
    }
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    }
    const research = await readJson(RESEARCH_PATH, { samples: [] });
    const samples = Array.isArray(research.samples) ? research.samples : [];
    const result = optimize(samples);
    let persisted = false;
    let storage = { provider: storageProvider() };
    if (req.method === "POST" || req.query?.persist === "1" || req.query?.persist === "true") {
      storage = await writeJson(OPTIMIZER_PATH, result);
      persisted = true;
    }
    return sendJson(res, 200, {
      ok: true,
      persisted,
      storage,
      ...result
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      persisted: false,
      storage: { provider: storageProvider() },
      error: error.message
    });
  }
};
