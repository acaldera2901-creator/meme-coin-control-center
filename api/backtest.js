const { readJson, storageProvider } = require("./storage");

const RESEARCH_PATH = "meme-coin-control-center/moonshot-research.json";

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

function fdvLiq(sample) {
  const liq = safeNum(sample.firstLiq);
  return liq > 0 ? safeNum(sample.firstFdv) / liq : 99999;
}

function launchAgeMinutes(sample) {
  return sample.pairCreatedAt ? Math.max(0, (sample.firstSeenAt - sample.pairCreatedAt) / 60000) : 99999;
}

function rules() {
  return [
    {
      id: "attack_edge",
      label: "Attack Edge",
      test: (s) => tradeCount(s) >= 80 && buySellRatio(s) >= 1.6 && volLiq(s) >= 0.25 && volLiq(s) <= 4.5 && safeNum(s.firstLiq) >= 12000
    },
    {
      id: "moonshot_fresh",
      label: "Moonshot Fresh",
      test: (s) => safeNum(s.firstMoonshotScore) >= 64 && launchAgeMinutes(s) <= 20 && safeNum(s.firstLiq) >= 8000
    },
    {
      id: "strong_flow",
      label: "Strong Flow",
      test: (s) => buySellRatio(s) >= 2.4 && tradeCount(s) >= 35 && safeNum(s.firstChange5) >= 0 && safeNum(s.firstChange5) <= 220
    },
    {
      id: "clean_liq",
      label: "Clean Liquidity",
      test: (s) => safeNum(s.firstLiq) >= 12000 && safeNum(s.firstLiq) <= 180000 && fdvLiq(s) <= 120
    },
    {
      id: "impulse_band",
      label: "Impulse Band",
      test: (s) => safeNum(s.firstChange5) >= 20 && safeNum(s.firstChange5) <= 180 && volLiq(s) >= 0.25 && volLiq(s) <= 4.5
    },
    {
      id: "anti_late_vertical",
      label: "Anti Late Vertical",
      test: (s) => safeNum(s.firstChange5) <= 250 && safeNum(s.firstLiq) >= 10000 && buySellRatio(s) >= 1.25
    }
  ];
}

function evaluate(rule, samples) {
  const matched = samples.filter(rule.test);
  const completed = matched.filter((sample) => sample.complete15m);
  const multipliers = completed.map((sample) => Math.max(1, safeNum(sample.maxMultiplier)));
  const avgMax = multipliers.length ? multipliers.reduce((sum, value) => sum + value, 0) / multipliers.length : 0;
  const hit35 = completed.filter((sample) => safeNum(sample.maxMultiplier) >= 1.35).length;
  const hit2x = completed.filter((sample) => safeNum(sample.maxMultiplier) >= 2).length;
  const hit10x = completed.filter((sample) => safeNum(sample.maxMultiplier) >= 10).length;
  const winRate35 = completed.length ? hit35 / completed.length : 0;
  const winRate2x = completed.length ? hit2x / completed.length : 0;
  const winRate10x = completed.length ? hit10x / completed.length : 0;
  const avgSlippage = completed.length
    ? completed.reduce((sum, sample) => sum + (safeNum(sample.firstLiq) < 12000 ? 8 : safeNum(sample.firstLiq) < 25000 ? 5 : safeNum(sample.firstLiq) < 75000 ? 3 : 2), 0) / completed.length
    : 0;
  const expectancy = winRate35 * 35 + winRate2x * 80 + winRate10x * 400 - (1 - winRate35) * 18 - avgSlippage * 2;
  const confidence = Math.min(1, completed.length / 200);
  return {
    id: rule.id,
    label: rule.label,
    samples: matched.length,
    completed: completed.length,
    avgMax,
    winRate35,
    winRate2x,
    winRate10x,
    avgSlippage,
    expectancy,
    confidence,
    score: Math.round(expectancy * Math.max(0.1, confidence))
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    }
    const research = await readJson(RESEARCH_PATH, { samples: [], cycles: [], updatedAt: 0 });
    const samples = Array.isArray(research.samples) ? research.samples : [];
    const completed = samples.filter((sample) => sample.complete15m);
    const results = rules()
      .map((rule) => evaluate(rule, samples))
      .sort((a, b) => b.score - a.score);
    return sendJson(res, 200, {
      ok: true,
      storage: { provider: storageProvider() },
      dataset: {
        total: samples.length,
        completed: completed.length,
        learning: samples.length - completed.length,
        updatedAt: research.updatedAt || 0
      },
      best: results[0] || null,
      results,
      recommendation: results[0]?.completed >= 50
        ? `Use ${results[0].label} as primary gate, review every 200 completed samples.`
        : "Keep collecting. Backtest confidence becomes useful after 200 completed samples."
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message });
  }
};
