const API = "https://api.dexscreener.com";
const ONLINE_URL = "https://meme-coin-control-center.vercel.app/";
const STORAGE_KEY = "solana-memecoin-paper-v1";
const FULL_SCAN_INTERVAL_MS = 30000;
const FOCUSED_ORDER_SCAN_MS = 1000;
const SHARED_STATE_PULL_MS = 30000;
const RESEARCH_SYNC_MS = 60000;
const SERVER_COLLECTOR_MS = 30 * 60000;
const BTC_SCAN_INTERVAL_MS = 60000;
const MAX_FOCUSED_ORDER_TARGETS = 3;
const MOONSHOT_SAMPLE_TARGET = 10000;
const MAX_EQUITY_POINTS = 10000;
const PAIR_STOP_COOLDOWN_MS = 45 * 60000;
const SYMBOL_STOP_COOLDOWN_MS = 2 * 60 * 60000;

const DEFAULT_STRATEGY_CONFIG = {
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
  evGate: 8,
  maxSizePct: 0.05,
  normalSizePct: 0.03,
  rationale: "Default strict gate while the system collects labeled outcomes."
};

const createDefaultBtcState = () => ({
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
  lastError: ""
});

const createDefaultState = () => ({
  cash: 1000,
  startingCapital: 1000,
  positions: [],
  journal: [],
  equityCurve: [{ time: Date.now(), equity: 1000 }],
  marketHistory: {},
  orderFlow: [],
  btc: createDefaultBtcState(),
  cycles: 0,
  sharedUpdatedAt: Date.now()
});

const agents = [
  ["Scout Agent", "Scans latest Solana token profiles and boosts"],
  ["Filter Agent", "Rejects weak liquidity, stale pairs, and broken pricing"],
  ["Momentum Agent", "Scores buy/sell pressure, volume, price action, and age"],
  ["Entry Agent", "Allocates 5% or 10% paper size when score confirms"],
  ["Risk Manager", "Caps exposure at 3 positions and 10% per trade"],
  ["Exit Agent", "Stops, partial profits, trailing exits, and momentum exits"],
  ["Research Agent", "Runs 30m rotating token-batch edge analysis"],
  ["BTCUSDT Agent", "Trades BTCUSDT paper 24/7 from Binance order-flow snapshots"],
  ["Journal Agent", "Persists decisions to shared paper state"]
];

const sources = [
  ["Latest Profiles", "/token-profiles/latest/v1"],
  ["Latest Boosts", "/token-boosts/latest/v1"],
  ["Top Boosts", "/token-boosts/top/v1"],
  ["Token Pairs", "/token-pairs/v1/solana/{tokenAddress}"],
  ["Focused Order Scan", "1s focused token-pairs loop"],
  ["Shared Paper State", "/api/state Vercel Blob"],
  ["Moonshot Research", "/api/research 10000 samples"],
  ["Backtest Optimizer", "/api/backtest edge replay"],
  ["Strategy Optimizer", "/api/optimizer adaptive gate"],
  ["Internal Dataset", "/api/collect Vercel Cron"],
  ["External Dataset", "Bitquery Solana Trading API"],
  ["Research Agent", "30m rotating dataset cycle"],
  ["Storage Backend", "Upstash Redis or Vercel Blob"],
  ["Sheet Database", "/api/sheets CSV workbook"],
  ["BTCUSDT Order Flow", "/api/btc-agent persistent Binance depth + trades"]
];

let appState = loadState();
let latestCandidates = [];
let sourceStatus = new Map();
let fullScanInFlight = false;
let focusedScanInFlight = false;
let remoteSaveTimer = null;
let remoteStateAvailable = false;
let moonshotResearch = {
  target: MOONSHOT_SAMPLE_TARGET,
  total: 0,
  complete15m: 0,
  learning: 0,
  plus10: 0,
  plus100: 0,
  plus700: 0,
  top: []
};
let datasetStatus = {
  internal: { enabled: false, source: "DexScreener server collector" },
  external: { enabled: false, source: "Bitquery Solana Trading API", requiredEnv: "BITQUERY_TOKEN" }
};
let serverCollectInFlight = false;
let researchAgentStatus = {
  lastCycleAt: 0,
  nextCycleAt: 0,
  lastCollected: 0,
  persisted: false,
  storageProvider: ""
};
let sheetStatus = {
  cycles: 0,
  observations: 0,
  edges: 0
};
let strategyOptimizer = {
  config: { ...DEFAULT_STRATEGY_CONFIG },
  diagnostics: {
    completed: 0,
    cleanMissed: 0,
    badEntries: 0,
    readiness: 0
  },
  persisted: false,
  updatedAt: 0
};
let equityZoomLevel = 0;

const $ = (id) => document.getElementById(id);

function isLocalFileMode() {
  return window.location.protocol === "file:";
}

function showProtocolWarning() {
  const warning = $("protocolWarning");
  if (warning) warning.hidden = !isLocalFileMode();
  if (isLocalFileMode()) {
    setTimeout(() => {
      window.location.href = ONLINE_URL;
    }, 1400);
  }
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    const defaults = createDefaultState();
    return {
      ...defaults,
      ...parsed,
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      journal: Array.isArray(parsed.journal) ? parsed.journal : [],
      equityCurve: Array.isArray(parsed.equityCurve) ? parsed.equityCurve : defaults.equityCurve,
      marketHistory: parsed.marketHistory && typeof parsed.marketHistory === "object" ? parsed.marketHistory : {},
      orderFlow: Array.isArray(parsed.orderFlow) ? parsed.orderFlow : [],
      btc: normalizeBtcState(parsed.btc)
    };
  } catch {
    return createDefaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  queueRemoteStateSave();
}

function normalizeState(candidate) {
  const parsed = candidate && typeof candidate === "object" ? candidate : {};
  const defaults = createDefaultState();
  return {
    ...defaults,
    ...parsed,
    positions: Array.isArray(parsed.positions) ? parsed.positions : [],
    journal: Array.isArray(parsed.journal) ? parsed.journal : [],
    equityCurve: Array.isArray(parsed.equityCurve) ? parsed.equityCurve : defaults.equityCurve,
    marketHistory: parsed.marketHistory && typeof parsed.marketHistory === "object" ? parsed.marketHistory : {},
    orderFlow: Array.isArray(parsed.orderFlow) ? parsed.orderFlow : [],
    btc: normalizeBtcState(parsed.btc)
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

async function loadRemoteState() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.state) {
      appState = normalizeState(payload.state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    } else {
      await saveRemoteStateNow();
    }
    remoteStateAvailable = true;
    sourceStatus.set("Shared Paper State", { ok: true, ms: 0, error: "" });
  } catch (error) {
    remoteStateAvailable = false;
    sourceStatus.set("Shared Paper State", { ok: false, ms: 0, error: "local fallback" });
    console.warn("Shared state unavailable, using local fallback", error);
  }
}

function queueRemoteStateSave() {
  if (remoteSaveTimer) clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(saveRemoteStateNow, 500);
}

async function saveRemoteStateNow() {
  try {
    const response = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: appState })
    });
    remoteStateAvailable = response.ok;
    sourceStatus.set("Shared Paper State", { ok: response.ok, ms: 0, error: response.ok ? "" : "save failed" });
  } catch (error) {
    remoteStateAvailable = false;
    sourceStatus.set("Shared Paper State", { ok: false, ms: 0, error: "save failed" });
  }
}

async function refreshRemoteStateFromCloud() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    if (!payload?.state) return;
    const remoteUpdatedAt = safeNum(payload.state.sharedUpdatedAt);
    const localUpdatedAt = safeNum(appState.sharedUpdatedAt);
    if (remoteUpdatedAt > localUpdatedAt) {
      appState = normalizeState(payload.state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
      render();
    }
    remoteStateAvailable = true;
    sourceStatus.set("Shared Paper State", { ok: true, ms: 0, error: "" });
  } catch {
    remoteStateAvailable = false;
    sourceStatus.set("Shared Paper State", { ok: false, ms: 0, error: "sync failed" });
  }
}

async function loadMoonshotResearch() {
  try {
    const response = await fetch("/api/research", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.summary) moonshotResearch = payload.summary;
    sourceStatus.set("Moonshot Research", { ok: true, ms: 0, error: "" });
  } catch (error) {
    sourceStatus.set("Moonshot Research", { ok: false, ms: 0, error: "research sync failed" });
  }
}

async function loadDatasetStatus() {
  try {
    const response = await fetch("/api/collect?mode=status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    datasetStatus = {
      internal: payload.internal || datasetStatus.internal,
      external: payload.external || datasetStatus.external
    };
    sourceStatus.set("Internal Dataset", { ok: Boolean(datasetStatus.internal.enabled), ms: 0, error: datasetStatus.internal.enabled ? "" : "disabled" });
    sourceStatus.set("External Dataset", { ok: Boolean(datasetStatus.external.enabled), ms: 0, error: datasetStatus.external.enabled ? "" : "missing key" });
    sourceStatus.set("Research Agent", { ok: Boolean(payload.researchAgent?.enabled), ms: 0, error: payload.researchAgent?.enabled ? "30m cycle" : "disabled" });
    sourceStatus.set("Storage Backend", { ok: true, ms: 0, error: payload.storage?.provider || "unknown" });
  } catch {
    sourceStatus.set("Internal Dataset", { ok: false, ms: 0, error: "collector status failed" });
    sourceStatus.set("External Dataset", { ok: false, ms: 0, error: "collector status failed" });
    sourceStatus.set("Research Agent", { ok: false, ms: 0, error: "collector status failed" });
    sourceStatus.set("Storage Backend", { ok: false, ms: 0, error: "status failed" });
  }
}

async function loadSheetStatus() {
  try {
    const response = await fetch("/api/sheets?sheet=status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const byName = new Map((payload.sheets || []).map((sheet) => [sheet.name, sheet]));
    sheetStatus = {
      cycles: safeNum(byName.get("cycles")?.rows),
      observations: safeNum(byName.get("observations")?.rows),
      edges: safeNum(byName.get("edges")?.rows)
    };
    sourceStatus.set("Sheet Database", { ok: true, ms: 0, error: `${sheetStatus.observations} rows` });
  } catch {
    sourceStatus.set("Sheet Database", { ok: false, ms: 0, error: "sheet sync failed" });
  }
}

async function loadBacktestStatus() {
  try {
    const response = await fetch("/api/backtest", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const completed = safeNum(payload.dataset?.completed);
    const best = payload.best?.label || "collecting";
    sourceStatus.set("Backtest Optimizer", { ok: true, ms: 0, error: `${completed} labeled / ${best}` });
  } catch {
    sourceStatus.set("Backtest Optimizer", { ok: false, ms: 0, error: "backtest failed" });
  }
}

async function loadStrategyOptimizer(persist = false) {
  try {
    const response = await fetch(`/api/optimizer${persist ? "?persist=1" : ""}`, {
      method: persist ? "POST" : "GET",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    strategyOptimizer = {
      config: { ...DEFAULT_STRATEGY_CONFIG, ...(payload.config || {}) },
      diagnostics: payload.diagnostics || strategyOptimizer.diagnostics,
      persisted: Boolean(payload.persisted),
      updatedAt: Date.now()
    };
    sourceStatus.set("Strategy Optimizer", { ok: true, ms: 0, error: strategyOptimizer.config.mode || "online" });
  } catch {
    sourceStatus.set("Strategy Optimizer", { ok: false, ms: 0, error: "optimizer offline" });
  }
}

async function triggerServerCollector(manual = false) {
  if (serverCollectInFlight) return;
  serverCollectInFlight = true;
  const researchBtn = $("researchBtn");
  if (manual && researchBtn) {
    researchBtn.disabled = true;
    researchBtn.textContent = "Research Running";
  }
  try {
    const cycle = Date.now();
    const response = await fetch(`/api/collect?source=internal&agent=research&cycle=${cycle}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    if (payload?.summary) moonshotResearch = payload.summary;
    researchAgentStatus = {
      lastCycleAt: cycle,
      nextCycleAt: safeNum(payload.nextResearchCycleAt) || cycle + SERVER_COLLECTOR_MS,
      lastCollected: safeNum(payload.collected),
      persisted: Boolean(payload.persisted),
      storageProvider: payload.storage?.provider || ""
    };
    if (payload?.sheets?.sheets) {
      const byName = new Map(payload.sheets.sheets.map((sheet) => [sheet.name, sheet]));
      sheetStatus = {
        cycles: safeNum(byName.get("cycles")?.rows),
        observations: safeNum(byName.get("observations")?.rows),
        edges: safeNum(byName.get("edges")?.rows)
      };
      sourceStatus.set("Sheet Database", { ok: !payload.sheetsError, ms: 0, error: payload.sheetsError || `${sheetStatus.observations} rows` });
    }
    sourceStatus.set("Internal Dataset", {
      ok: Boolean(payload.persisted),
      ms: 0,
      error: payload.persisted ? "" : payload.storageError || "storage offline"
    });
    sourceStatus.set("Storage Backend", {
      ok: Boolean(payload.persisted),
      ms: 0,
      error: payload.persisted ? payload.storage?.provider || "online" : payload.storageError || "offline"
    });
    sourceStatus.set("Research Agent", { ok: true, ms: 0, error: `${payload.collected || 0} tokens` });
  } catch (error) {
    sourceStatus.set("Internal Dataset", { ok: false, ms: 0, error: "collector failed" });
    sourceStatus.set("Research Agent", { ok: false, ms: 0, error: "cycle failed" });
  } finally {
    serverCollectInFlight = false;
    if (manual && researchBtn) {
      researchBtn.disabled = false;
      researchBtn.textContent = "Run Research Cycle";
    }
  }
}

async function pushMoonshotObservations(candidates) {
  if (!candidates.length) return;
  const observations = candidates.slice(0, 60).map((candidate) => ({
    pairAddress: candidate.pair.pairAddress,
    tokenAddress: candidate.pair.baseToken?.address,
    symbol: candidate.pair.baseToken?.symbol,
    name: candidate.pair.baseToken?.name,
    url: candidate.pair.url,
    pairCreatedAt: candidate.pair.pairCreatedAt,
    price: candidate.price,
    liq: candidate.liq,
    fdv: safeNum(candidate.pair.fdv),
    marketCap: safeNum(candidate.pair.marketCap),
    volume5: candidate.volume5,
    volume1h: candidate.volume1h,
    buys5: candidate.buys,
    sells5: candidate.sells,
    change5: candidate.change5,
    boosts: safeNum(candidate.pair.boosts?.active),
    score: candidate.score,
    moonshotScore: candidate.moonshotScore,
    observedAt: Date.now()
  }));
  try {
    const response = await fetch("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ observations })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    if (payload?.summary) moonshotResearch = payload.summary;
    sourceStatus.set("Moonshot Research", { ok: true, ms: 0, error: "" });
  } catch (error) {
    sourceStatus.set("Moonshot Research", { ok: false, ms: 0, error: "research save failed" });
  }
}

function fmtUsd(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (Math.abs(value) > 0 && Math.abs(value) < 0.01) return `$${value.toExponential(2)}`;
  return `$${value.toFixed(digits)}`;
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function ageFrom(timestamp) {
  if (!timestamp) return "--";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fetchJson(path, label) {
  const started = performance.now();
  try {
    const res = await fetch(`${API}${path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    sourceStatus.set(label, { ok: true, ms: Math.round(performance.now() - started), error: "" });
    return json;
  } catch (error) {
    sourceStatus.set(label, { ok: false, ms: 0, error: error.message });
    return null;
  }
}

async function scanDexScreener() {
  if (fullScanInFlight) return;
  fullScanInFlight = true;
  setAgents("warn", "SCANNING");
  try {
    const [profilesRaw, boostsRaw, topBoostsRaw] = await Promise.all([
      fetchJson("/token-profiles/latest/v1", "Latest Profiles"),
      fetchJson("/token-boosts/latest/v1", "Latest Boosts"),
      fetchJson("/token-boosts/top/v1", "Top Boosts")
    ]);

    const allTokens = [...asArray(profilesRaw), ...asArray(boostsRaw), ...asArray(topBoostsRaw)]
      .filter((token) => token.chainId === "solana" && token.tokenAddress);

    const unique = [...new Map(allTokens.map((token) => [token.tokenAddress, token])).values()].slice(0, 28);
    const pairBatches = await Promise.all(unique.map(async (token) => {
      const pairs = await fetchJson(`/token-pairs/v1/solana/${token.tokenAddress}`, "Token Pairs");
      return bestPair(asArray(pairs), token);
    }));

    latestCandidates = pairBatches.filter(Boolean).map(scoreCandidate).sort((a, b) => candidatePriority(b) - candidatePriority(a));
    recordMarketHistory(latestCandidates);
    await pushMoonshotObservations(latestCandidates);
    appState.cycles += 1;
    runPaperCycle();
    buildOrderFlow(latestCandidates);
    saveState();
    render();
    setAgents("ok", "ONLINE");
  } finally {
    fullScanInFlight = false;
  }
}

async function scanFocusedOrderFlow() {
  if (focusedScanInFlight || !latestCandidates.length) return;
  focusedScanInFlight = true;
  try {
    const targets = focusedOrderTargets();
    if (!targets.length) return;
    const focusedPairs = await Promise.all(targets.map(async (target) => {
      const pairs = await fetchJson(`/token-pairs/v1/solana/${target.tokenAddress}`, "Focused Order Scan");
      return bestPair(asArray(pairs), target);
    }));
    const focusedCandidates = focusedPairs.filter(Boolean).map(scoreCandidate);
    mergeFocusedCandidates(focusedCandidates);
    recordMarketHistory(focusedCandidates);
    updateOpenPositions();
    buildOrderFlow(focusedCandidates);
    recordEquity();
    saveState();
    render();
  } finally {
    focusedScanInFlight = false;
  }
}

function focusedOrderTargets() {
  const targets = [];
  const seen = new Set();
  for (const position of appState.positions) {
    if (!position.tokenAddress || seen.has(position.tokenAddress)) continue;
    targets.push({ tokenAddress: position.tokenAddress, chainId: "solana" });
    seen.add(position.tokenAddress);
  }
  for (const candidate of latestCandidates) {
    const tokenAddress = candidate.pair.baseToken?.address;
    if (!tokenAddress || seen.has(tokenAddress)) continue;
    targets.push({ tokenAddress, chainId: "solana" });
    seen.add(tokenAddress);
    if (targets.length >= MAX_FOCUSED_ORDER_TARGETS) break;
  }
  return targets.slice(0, MAX_FOCUSED_ORDER_TARGETS);
}

function mergeFocusedCandidates(focusedCandidates) {
  const byPair = new Map(latestCandidates.map((candidate) => [candidate.pair.pairAddress, candidate]));
  for (const candidate of focusedCandidates) {
    byPair.set(candidate.pair.pairAddress, candidate);
  }
    latestCandidates = [...byPair.values()].sort((a, b) => candidatePriority(b) - candidatePriority(a));
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

function scoreCandidate(pair) {
  const tx5 = pair.txns?.m5 || {};
  const buys = safeNum(tx5.buys);
  const sells = safeNum(tx5.sells);
  const volume5 = safeNum(pair.volume?.m5);
  const volume1h = safeNum(pair.volume?.h1);
  const liq = safeNum(pair.liquidity?.usd);
  const change5 = safeNum(pair.priceChange?.m5);
  const change1h = safeNum(pair.priceChange?.h1);
  const ageMinutes = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 99999;
  const buyRatio = sells === 0 ? buys : buys / Math.max(1, sells);
  const volLiq = liq > 0 ? volume5 / liq : 0;
  const boosts = safeNum(pair.boosts?.active);
  const fdv = safeNum(pair.fdv);
  const fdvLiq = liq > 0 ? fdv / liq : 0;
  let score = 0;
  const notes = [];

  if (ageMinutes <= 180) { score += 12; notes.push("fresh"); }
  if (liq >= 10000) { score += 16; notes.push("liquidity ok"); }
  if (volume5 >= 5000) { score += 16; notes.push("5m volume"); }
  if (volume1h >= 15000) score += 8;
  if (buys + sells >= 25) score += 12;
  if (buyRatio >= 1.5) { score += 18; notes.push("buy pressure"); }
  if (change5 > 2 && change5 < 120) score += 12;
  if (change1h > 5 && change1h < 350) score += 8;
  if (volLiq > 0.08 && volLiq < 2.5) score += 8;
  if (change5 > 250) { score -= 28; notes.push("vertical pump"); }
  if (liq < 5000) { score -= 28; notes.push("thin liq"); }
  if (sells > buys * 1.25 && buys + sells > 10) { score -= 22; notes.push("sell pressure"); }
  if (fdv > 0 && liq > 0 && fdvLiq > 1000) { score -= 16; notes.push("fdv/liquidity stretched"); }

  const moonshot = moonshotProfile({ ageMinutes, buys, sells, volume5, volume1h, liq, change5, change1h, volLiq, fdvLiq, boosts });
  const combinedScore = Math.max(score, moonshot.score - 8);
  const risk = riskLevel({ liq, ageMinutes, sells, buys, change5, score: combinedScore, moonshotScore: moonshot.score, fdvLiq, boosts });
  return {
    pair,
    score: Math.max(0, Math.min(100, Math.round(combinedScore))),
    baseScore: Math.max(0, Math.min(100, Math.round(score))),
    moonshotScore: moonshot.score,
    moonshotNotes: moonshot.notes,
    notes: [...notes, ...moonshot.notes].slice(0, 6),
    risk,
    price: safeNum(pair.priceUsd),
    buys,
    sells,
    volume5,
    volume1h,
    liq,
    change5,
    ageMinutes
  };
}

function moonshotProfile(data) {
  let score = 0;
  const notes = [];
  const txCount = data.buys + data.sells;
  const buyRatio = data.sells === 0 ? data.buys : data.buys / Math.max(1, data.sells);

  if (data.ageMinutes <= 15) { score += 24; notes.push("first-15m"); }
  else if (data.ageMinutes <= 45) { score += 10; notes.push("early"); }

  if (txCount >= 80) { score += 16; notes.push("tx burst"); }
  else if (txCount >= 35) score += 9;

  if (buyRatio >= 2.4) { score += 18; notes.push("buy imbalance"); }
  else if (buyRatio >= 1.6) score += 10;

  if (data.volLiq >= 0.35 && data.volLiq <= 4.5) { score += 16; notes.push("vol/liq expansion"); }
  else if (data.volLiq > 0.12 && data.volLiq < 7) score += 8;

  if (data.change5 >= 20 && data.change5 <= 180) { score += 14; notes.push("impulse not vertical"); }
  else if (data.change5 > 0 && data.change5 < 260) score += 7;

  if (data.liq >= 12000 && data.liq <= 180000) { score += 10; notes.push("moonshot liq band"); }
  else if (data.liq >= 6000) score += 5;

  if (data.fdvLiq > 0 && data.fdvLiq <= 120) score += 7;
  if (data.boosts > 0 && data.boosts <= 80) { score += 5; notes.push("boost signal"); }

  if (data.change5 > 350) { score -= 28; notes.push("late vertical"); }
  if (data.liq < 5000) { score -= 22; notes.push("too thin"); }
  if (data.sells > data.buys * 1.15 && txCount > 20) { score -= 20; notes.push("sell wall"); }
  if (data.fdvLiq > 650) { score -= 14; notes.push("fdv/liquidity danger"); }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    notes
  };
}

function recordMarketHistory(candidates) {
  const now = Date.now();
  for (const candidate of candidates) {
    const key = candidate.pair.pairAddress;
    const symbol = candidate.pair.baseToken?.symbol || "UNKNOWN";
    const prev = appState.marketHistory[key] || [];
    prev.push({
      time: now,
      symbol,
      price: candidate.price,
      liq: candidate.liq,
      volume5: candidate.volume5,
      buys: candidate.buys,
      sells: candidate.sells,
      score: candidate.score,
      change5: candidate.change5
    });
    appState.marketHistory[key] = prev.slice(-80);
  }
  const liveKeys = new Set(candidates.map((candidate) => candidate.pair.pairAddress));
  for (const key of Object.keys(appState.marketHistory)) {
    if (!liveKeys.has(key) && !appState.positions.some((position) => position.pairAddress === key)) {
      appState.marketHistory[key] = appState.marketHistory[key].slice(-20);
    }
  }
}

function buildOrderFlow(candidates) {
  const now = Date.now();
  const openPairs = new Set(appState.positions.map((position) => position.pairAddress));
  const focus = candidates.filter((candidate) => candidate.score >= 65 || openPairs.has(candidate.pair.pairAddress)).slice(0, 18);
  const events = [];
  for (const candidate of focus) {
    const history = appState.marketHistory[candidate.pair.pairAddress] || [];
    const prev = history.at(-2);
    const latest = history.at(-1);
    if (!prev || !latest) continue;
    let buyDelta = Math.max(0, latest.buys - prev.buys);
    let sellDelta = Math.max(0, latest.sells - prev.sells);
    const priceDelta = prev.price ? ((latest.price - prev.price) / prev.price) * 100 : 0;
    let volDelta = Math.max(0, latest.volume5 - prev.volume5);
    const snapshotMode = buyDelta + sellDelta === 0 && Math.abs(priceDelta) < 0.3;
    if (snapshotMode) {
      buyDelta = latest.buys;
      sellDelta = latest.sells;
      volDelta = latest.volume5;
    }
    const flowScore = buyDelta - sellDelta;
    const inPosition = openPairs.has(candidate.pair.pairAddress);
    let side = "WATCH";
    if (flowScore > 0 && priceDelta >= -1) side = snapshotMode ? "5M BUY PRESSURE" : "BUY FLOW";
    if (flowScore < 0 || priceDelta < -8) side = snapshotMode ? "5M SELL PRESSURE" : "SELL FLOW";
    if (buyDelta + sellDelta === 0 && latest.volume5 <= 0) continue;
    events.push({
      id: crypto.randomUUID(),
      time: now,
      symbol: candidate.pair.baseToken?.symbol || "UNKNOWN",
      pairAddress: candidate.pair.pairAddress,
      side,
      inPosition,
      price: latest.price,
      priceDelta,
      buyDelta,
      sellDelta,
      volDelta,
      score: candidate.score,
      snapshotMode
    });
  }
  appState.orderFlow = [...events, ...appState.orderFlow].slice(0, 90);
}

function riskLevel(data) {
  const txCount = data.buys + data.sells;
  const sellWall = data.sells > data.buys * 1.35 && txCount > 30;
  const fdvDanger = data.fdvLiq > 450;
  const deadBoost = data.boosts >= 250 && data.score < 55;
  if (data.liq < 8000 || data.change5 > 380 || sellWall || fdvDanger || deadBoost) return "HIGH";
  if (data.score < 64 || data.ageMinutes > 1440 || data.liq < 18000 || data.change5 > 250) return "MED";
  return "LOW";
}

function candidatePriority(candidate) {
  const edge = edgeCandidate(candidate);
  const flowBoost = Math.min(30, edge.txCount / 20) + Math.min(24, edge.buyRatio * 6) + Math.min(24, edge.volLiq * 12);
  return candidate.score + candidate.moonshotScore + flowBoost + (edge.ok ? 80 : 0) - (candidate.risk === "HIGH" ? 120 : 0);
}

function edgeCandidate(candidate) {
  const cfg = strategyOptimizer.config || DEFAULT_STRATEGY_CONFIG;
  const txCount = candidate.buys + candidate.sells;
  const buyRatio = candidate.sells === 0 ? candidate.buys : candidate.buys / Math.max(1, candidate.sells);
  const volLiq = candidate.liq > 0 ? candidate.volume5 / candidate.liq : 0;
  const liqBand = candidate.liq >= safeNum(cfg.minLiquidity) && candidate.liq <= safeNum(cfg.maxLiquidity);
  const impulse = candidate.change5 >= safeNum(cfg.minImpulse) && candidate.change5 <= safeNum(cfg.maxImpulse);
  const flowBurst = txCount >= safeNum(cfg.minTx) && buyRatio >= safeNum(cfg.minBuyRatio);
  const volumeExpansion = volLiq >= safeNum(cfg.minVolLiq) && volLiq <= safeNum(cfg.maxVolLiq);
  return {
    ok: flowBurst && volumeExpansion && liqBand && impulse && candidate.risk !== "HIGH",
    buyRatio,
    volLiq,
    txCount
  };
}

function pairKeyFromUrl(url) {
  return String(url || "").split("/").pop()?.toLowerCase() || "";
}

function candidatePairKey(candidate) {
  return String(candidate?.pair?.pairAddress || "").toLowerCase();
}

function recentHardStops(candidate) {
  const pairKey = candidatePairKey(candidate);
  const symbol = candidate?.pair?.baseToken?.symbol || "";
  const now = Date.now();
  const hardStops = appState.journal.filter((trade) => /hard stop|flow break stop/i.test(trade.reason || ""));
  const pairStops = hardStops.filter((trade) => pairKeyFromUrl(trade.url) === pairKey && now - safeNum(trade.time) <= PAIR_STOP_COOLDOWN_MS);
  const symbolStops = hardStops.filter((trade) => trade.symbol === symbol && now - safeNum(trade.time) <= SYMBOL_STOP_COOLDOWN_MS);
  return { pairStops, symbolStops };
}

function lastCandidateSnapshotMove(candidate) {
  const history = appState.marketHistory[candidate?.pair?.pairAddress] || [];
  const prev = history.at(-2);
  const latest = history.at(-1);
  if (!prev?.price || !latest?.price) return 0;
  return ((safeNum(latest.price) - safeNum(prev.price)) / safeNum(prev.price)) * 100;
}

function stopLossAvoidance(candidate) {
  const edge = edgeCandidate(candidate);
  const stops = recentHardStops(candidate);
  const snapshotMove = lastCandidateSnapshotMove(candidate);
  const txCount = candidate.buys + candidate.sells;
  const buyRatio = candidate.sells === 0 ? candidate.buys : candidate.buys / Math.max(1, candidate.sells);
  const volLiq = candidate.liq > 0 ? candidate.volume5 / candidate.liq : 0;
  const fallingKnife = candidate.change5 <= -12 || snapshotMove <= -8;
  const weakFlow = txCount < 80 || buyRatio < 1.45;
  const overheatedChurn = volLiq > 2.8 && candidate.change5 < 20;

  if (stops.pairStops.length) return { block: true, reason: "pair stop cooldown" };
  if (stops.symbolStops.length >= 2) return { block: true, reason: "symbol repeated stop cooldown" };
  if (fallingKnife) return { block: true, reason: "falling knife filter" };
  if (!edge.ok && weakFlow && candidate.moonshotScore < 82) return { block: true, reason: "weak flow after stop analysis" };
  if (overheatedChurn) return { block: true, reason: "churn without price follow-through" };
  return { block: false, reason: "" };
}

function marketRegime() {
  if (!latestCandidates.length) return { label: "NO DATA", quality: 0, tradable: false };
  const sample = latestCandidates.slice(0, 40);
  const positive = sample.filter((candidate) => candidate.change5 > 0).length / sample.length;
  const strongFlow = sample.filter((candidate) => candidate.buys > candidate.sells * 1.4 && candidate.buys + candidate.sells >= 35).length / sample.length;
  const thin = sample.filter((candidate) => candidate.liq < 10000).length / sample.length;
  const vertical = sample.filter((candidate) => candidate.change5 > 250).length / sample.length;
  const quality = Math.max(0, Math.min(100, Math.round(positive * 38 + strongFlow * 52 - thin * 18 - vertical * 22 + 28)));
  const label = quality >= 68 ? "ATTACK" : quality >= 38 ? "AGGRESSIVE SELECTIVE" : "DEFENSIVE";
  return { label, quality, tradable: quality >= 38 };
}

function profitabilityProfile(candidate) {
  const cfg = strategyOptimizer.config || DEFAULT_STRATEGY_CONFIG;
  if (!candidate) {
    return { entryAllowed: false, expectancyPct: 0, sizePct: 0, slippagePct: 0, reason: "no candidate", regime: marketRegime() };
  }
  const edge = edgeCandidate(candidate);
  const regime = marketRegime();
  const txCount = candidate.buys + candidate.sells;
  const buyRatio = candidate.sells === 0 ? candidate.buys : candidate.buys / Math.max(1, candidate.sells);
  const volLiq = candidate.liq > 0 ? candidate.volume5 / candidate.liq : 0;
  const slippagePct = candidate.liq < 12000 ? 8 : candidate.liq < 25000 ? 5 : candidate.liq < 75000 ? 3 : 2;
  const toxicLiquidity = candidate.liq < 8000 || volLiq > 8.5 || candidate.change5 > 380;
  const sellWall = candidate.sells > candidate.buys * 1.35 && txCount > 35;
  const stopAvoidance = stopLossAvoidance(candidate);
  const agePenalty = candidate.ageMinutes > 45 ? 0.08 : candidate.ageMinutes > 20 ? 0.03 : 0;
  const baseProbability = 0.39
    + Math.min(0.20, candidate.score / 600)
    + Math.min(0.18, candidate.moonshotScore / 600)
    + (edge.ok ? 0.14 : 0)
    + Math.min(0.10, Math.max(0, buyRatio - 1.15) * 0.04)
    - (candidate.risk === "HIGH" ? 0.22 : candidate.risk === "MED" ? 0.08 : 0)
    - (toxicLiquidity ? 0.18 : 0)
    - (sellWall ? 0.14 : 0)
    - agePenalty;
  const winProbability = Math.max(0.20, Math.min(0.82, baseProbability));
  const avgWinPct = Math.min(115, 26 + candidate.moonshotScore * 0.48 + Math.min(22, volLiq * 6) + (edge.ok ? 22 : 0));
  const avgLossPct = 8 + slippagePct * 1.2 + (candidate.risk === "MED" ? 3 : 0) + (candidate.risk === "HIGH" ? 8 : 0);
  const expectancyPct = winProbability * avgWinPct - (1 - winProbability) * avgLossPct - slippagePct * 2;
  const adaptiveMoonshot = candidate.moonshotScore >= safeNum(cfg.moonshotBypassScore)
    && candidate.liq >= safeNum(cfg.minLiquidity) * 0.75
    && txCount >= 35
    && candidate.change5 <= safeNum(cfg.maxImpulse);
  const entryAllowed = expectancyPct >= safeNum(cfg.evGate)
    && regime.tradable
    && !toxicLiquidity
    && !sellWall
    && !stopAvoidance.block
    && candidate.risk !== "HIGH"
    && (edge.ok || adaptiveMoonshot || candidate.score >= 76);
  const sizePct = !entryAllowed ? 0 : expectancyPct >= 10 && (edge.ok || candidate.moonshotScore >= safeNum(cfg.moonshotBypassScore) || candidate.score >= 88)
    ? safeNum(cfg.maxSizePct)
    : safeNum(cfg.normalSizePct);
  const reason = toxicLiquidity
    ? "toxic liquidity"
    : sellWall
      ? "sell wall"
      : stopAvoidance.block
        ? stopAvoidance.reason
        : !regime.tradable
          ? "market not tradable"
          : entryAllowed
            ? `${edge.ok ? "edge flow" : "selective momentum"} / ${winProbability.toFixed(2)} pWin`
            : "EV below gate";
  return { entryAllowed, expectancyPct, sizePct, slippagePct, reason, regime, winProbability, avgWinPct, avgLossPct, optimizerMode: cfg.mode };
}

function runPaperCycle() {
  updateOpenPositions();
  if (appState.cash < appState.startingCapital * 0.30) return;
  const openAddresses = new Set(appState.positions.map((p) => p.pairAddress));
  for (const candidate of latestCandidates) {
    if (appState.positions.length >= 2) break;
    if (openAddresses.has(candidate.pair.pairAddress)) continue;
    const edge = edgeCandidate(candidate);
    const profile = profitabilityProfile(candidate);
    if (!profile.entryAllowed) continue;
    const allocationPct = profile.sizePct;
    const cashToSpend = Math.min(appState.cash, appState.startingCapital * allocationPct);
    if (cashToSpend < 10 || candidate.price <= 0) continue;
    const slippage = profile.slippagePct / 100;
    const entryPrice = candidate.price * (1 + slippage);
    const units = cashToSpend / entryPrice;
    appState.cash -= cashToSpend;
    appState.positions.push({
      id: crypto.randomUUID(),
      pairAddress: candidate.pair.pairAddress,
      tokenAddress: candidate.pair.baseToken?.address,
      symbol: candidate.pair.baseToken?.symbol || "UNKNOWN",
      name: candidate.pair.baseToken?.name || "Unknown",
      url: candidate.pair.url,
      entryTime: Date.now(),
      entryPrice,
      lastPrice: candidate.price,
      units,
      size: cashToSpend,
      score: candidate.score,
      moonshotScore: candidate.moonshotScore,
      highWater: entryPrice,
      partialTaken: false,
      expectedValuePct: profile.expectancyPct,
      slippagePct: profile.slippagePct,
      stopModel: `adaptive ${profile.optimizerMode || "strict-learning"}`,
      thesis: edge.ok
        ? `EV ${profile.expectancyPct.toFixed(1)}%, ${edge.txCount} tx, ${edge.buyRatio.toFixed(2)} B/S, ${edge.volLiq.toFixed(2)} V/L`
        : `EV ${profile.expectancyPct.toFixed(1)}%, ${profile.reason}`
    });
    openAddresses.add(candidate.pair.pairAddress);
  }
  recordEquity();
}

function updateOpenPositions() {
  const byPair = new Map(latestCandidates.map((candidate) => [candidate.pair.pairAddress, candidate]));
  const survivors = [];
  for (const position of appState.positions) {
    const current = byPair.get(position.pairAddress);
    if (!current) {
      survivors.push(position);
      continue;
    }
    position.lastPrice = current.price;
    position.highWater = Math.max(position.highWater, current.price);
    const pnlPct = ((current.price - position.entryPrice) / position.entryPrice) * 100;
    const dropFromHigh = ((current.price - position.highWater) / position.highWater) * 100;
    const txCount = current.buys + current.sells;
    const buyRatio = current.sells === 0 ? current.buys : current.buys / Math.max(1, current.sells);
    const snapshotMove = lastCandidateSnapshotMove(current);
    const sellPressure = current.sells > current.buys * 1.25 && txCount > 12;
    const flowBreak = (buyRatio < 1.15 || current.change5 <= -18 || snapshotMove <= -8) && txCount >= 40;
    let exitReason = "";

    if (!position.partialTaken && flowBreak && pnlPct <= -5) exitReason = "flow break stop -5%";
    if (!exitReason && pnlPct <= -8) exitReason = "professional hard stop -8%";
    if (!exitReason && pnlPct >= 35 && !position.partialTaken) {
      const halfUnits = position.units * 0.5;
      const proceeds = halfUnits * current.price * 0.99;
      position.units -= halfUnits;
      position.partialTaken = true;
      appState.cash += proceeds;
      appState.journal.unshift(closedTrade(position, current.price, proceeds - position.size * 0.5, "partial take profit +35%", "SELL 50%"));
    }
    if (!exitReason && pnlPct >= 45 && dropFromHigh <= -18) exitReason = "EV trailing stop after pump";
    if (!exitReason && sellPressure) exitReason = "sell pressure dominates";
    if (!exitReason && Date.now() - position.entryTime > 8 * 60000 && pnlPct < 8) exitReason = "momentum timeout";

    if (exitReason) {
      const proceeds = position.units * current.price * 0.99;
      const costBasis = position.partialTaken ? position.size * 0.5 : position.size;
      appState.cash += proceeds;
      appState.journal.unshift(closedTrade(position, current.price, proceeds - costBasis, exitReason, "SELL"));
    } else {
      survivors.push(position);
    }
  }
  appState.positions = survivors;
}

function closedTrade(position, exitPrice, pnl, reason, side) {
  return {
    id: crypto.randomUUID(),
    time: Date.now(),
    symbol: position.symbol,
    name: position.name,
    side,
    size: position.size,
    entryPrice: position.entryPrice,
    exitPrice,
    pnl,
    reason,
    url: position.url
  };
}

function portfolioEquity() {
  return appState.cash + appState.positions.reduce((sum, position) => sum + position.units * safeNum(position.lastPrice), 0);
}

function btcEquity() {
  const btc = appState.btc || createDefaultBtcState();
  if (!btc.position) return btc.cash;
  const direction = btc.position.side === "SHORT" ? -1 : 1;
  const pnl = (safeNum(btc.position.lastPrice) - safeNum(btc.position.entryPrice)) * safeNum(btc.position.qty) * direction;
  return btc.cash + safeNum(btc.position.margin) + pnl;
}

function recordEquity() {
  const equity = portfolioEquity();
  appState.equityCurve.push({ time: Date.now(), equity });
  appState.equityCurve = appState.equityCurve.slice(-MAX_EQUITY_POINTS);
}

function recordBtcEquity() {
  appState.btc.equityCurve.push({ time: Date.now(), equity: btcEquity() });
  appState.btc.equityCurve = appState.btc.equityCurve.slice(-MAX_EQUITY_POINTS);
}

async function scanBtcUsdt() {
  try {
    const response = await fetch("/api/btc-agent", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload?.btc) throw new Error(payload?.error || `HTTP ${response.status}`);
    sourceStatus.set("BTCUSDT Order Flow", { ok: true, ms: 0, error: `${payload.storage?.provider || "online"} / persisted` });
    appState.btc = normalizeBtcState(payload.btc);
    appState.sharedUpdatedAt = Date.now();
    saveState();
    render();
  } catch (error) {
    appState.btc.lastError = error.message;
    sourceStatus.set("BTCUSDT Order Flow", { ok: false, ms: 0, error: "btc feed failed" });
    renderSources();
    renderBtcAgent();
  }
}

function runBtcPaperCycle(snapshot) {
  const btc = appState.btc = normalizeBtcState(appState.btc);
  const price = safeNum(snapshot.price);
  if (!price) return;

  btc.cycles += 1;
  btc.lastSnapshot = snapshot;
  btc.lastSignal = snapshot.signal?.direction || "WAIT";
  btc.lastError = "";
  btc.snapshots = [...btc.snapshots, snapshot].slice(-240);

  if (btc.position) {
    btc.position.lastPrice = price;
    btc.position.highWater = Math.max(safeNum(btc.position.highWater), price);
    btc.position.lowWater = Math.min(safeNum(btc.position.lowWater) || price, price);
    manageBtcPosition(snapshot);
  }

  if (!btc.position) maybeOpenBtcPosition(snapshot);

  btc.orderFlow.unshift({
    id: crypto.randomUUID(),
    time: snapshot.time || Date.now(),
    side: snapshot.signal?.direction || "WAIT",
    price,
    score: safeNum(snapshot.signal?.score),
    imbalance: safeNum(snapshot.imbalance),
    cvdPct: safeNum(snapshot.cvdPct),
    buyQuote: safeNum(snapshot.takerBuyQuote),
    sellQuote: safeNum(snapshot.takerSellQuote),
    reason: snapshot.signal?.reason || "flow scan"
  });
  btc.orderFlow = btc.orderFlow.slice(0, 120);
  recordBtcEquity();
}

function maybeOpenBtcPosition(snapshot) {
  const btc = appState.btc;
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
  const qty = margin / safeNum(snapshot.price);
  btc.cash -= margin;
  btc.position = {
    id: crypto.randomUUID(),
    symbol: "BTCUSDT",
    side: direction,
    entryTime: Date.now(),
    entryPrice: safeNum(snapshot.price),
    lastPrice: safeNum(snapshot.price),
    qty,
    margin,
    score,
    highWater: safeNum(snapshot.price),
    lowWater: safeNum(snapshot.price),
    thesis: `${direction} ${score} / ${snapshot.signal?.reason || "flow aligned"} / ${Math.round(tapeQuote / 1000)}k tape`
  };
}

function manageBtcPosition(snapshot) {
  const btc = appState.btc;
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
    symbol: "BTCUSDT",
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

function render() {
  renderOverview();
  renderAgents();
  renderSources();
  renderDataFlow();
  renderTickerTape();
  renderOrderFlow();
  renderMoonshotResearch();
  renderAccountEquityLine();
  renderBtcAgent();
  renderProfitabilityControl();
  renderMarketChart();
  renderCandidates();
  renderPositions();
  renderJournal();
  renderEvaluator();
  renderRiskConsole();
}

function renderOverview() {
  const equity = portfolioEquity();
  const openRisk = appState.positions.reduce((sum, p) => sum + p.size, 0);
  const best = latestCandidates[0];
  const edge = best ? edgeCandidate(best) : null;
  const currentEdge = moonshotResearch.edge?.currentLiveEdge || moonshotResearch.edge?.currentEdge;
  $("capitalValue").textContent = fmtUsd(appState.cash);
  $("equityValue").textContent = fmtUsd(equity);
  $("riskValue").textContent = fmtUsd(openRisk);
  $("cycleValue").textContent = String(appState.cycles);
  $("bestScore").textContent = best ? best.score : "--";
  $("bestCandidate").textContent = best ? `${best.pair.baseToken?.symbol || "UNKNOWN"} / ${best.pair.quoteToken?.symbol || ""}` : "--";
  $("entryBias").textContent = best && best.moonshotScore >= 82 ? "MOONSHOT LONG" : best && best.score >= 85 ? "AGGRESSIVE LONG" : best && best.score >= 70 ? "SELECTIVE LONG" : "SCANNING";
  $("coverageValue").textContent = `${latestCandidates.length} live pairs`;
  $("edgeQuality").textContent = currentEdge ? `${Math.round(safeNum(currentEdge.edgeScore))} EDGE / ${fmtPct(safeNum(currentEdge.confidence) * 100)}` : "COLLECTING";
  $("tradeGate").textContent = edge?.ok ? "EDGE ENTRY ARMED" : best && best.moonshotScore >= 72 ? "MOONSHOT WATCH" : "WAIT FOR FLOW";
  $("tradeGate").className = edge?.ok ? "positive" : best && best.moonshotScore >= 72 ? "neutral" : "negative";
  $("lastUpdated").textContent = latestCandidates.length ? `Updated ${new Date().toLocaleTimeString()}` : "Waiting for first scan";
}

function renderMoonshotResearch() {
  const total = safeNum(moonshotResearch.total);
  const target = safeNum(moonshotResearch.target) || MOONSHOT_SAMPLE_TARGET;
  const progress = Math.min(100, (total / target) * 100);
  $("moonshotSamples").textContent = `${total.toLocaleString()} / ${target.toLocaleString()}`;
  $("moonshotProgress").style.width = `${progress}%`;
  $("moonshotComplete").textContent = `${safeNum(moonshotResearch.complete15m).toLocaleString()} labeled`;
  $("moonshotLearning").textContent = `${safeNum(moonshotResearch.learning).toLocaleString()} live`;
  $("moonshot700x").textContent = `${safeNum(moonshotResearch.plus700).toLocaleString()} hits`;
  $("datasetInternal").textContent = datasetStatus.internal.enabled ? "ON" : "OFF";
  $("datasetInternal").className = datasetStatus.internal.enabled ? "positive" : "negative";
  $("datasetExternal").textContent = datasetStatus.external.enabled ? "ON" : "WAIT KEY";
  $("datasetExternal").className = datasetStatus.external.enabled ? "positive" : "neutral";
  $("researchAgentCycle").textContent = researchAgentStatus.lastCycleAt
    ? `${researchAgentStatus.lastCollected} tokens / next ${new Date(researchAgentStatus.nextCycleAt).toLocaleTimeString()}`
    : "ARMED 30M";
  $("researchAgentCycle").className = researchAgentStatus.persisted ? "positive" : "neutral";
  $("sheetDbRows").textContent = `${sheetStatus.observations.toLocaleString()} rows`;
  $("sheetDbRows").className = sheetStatus.observations ? "positive" : "neutral";
  renderStatisticalEdge();
  renderEdgeIntelligence();
}

function renderStatisticalEdge() {
  const edge = moonshotResearch.edge || {};
  const current = edge.currentEdge?.samples ? edge.currentEdge : edge.currentLiveEdge;
  const cohorts = Array.isArray(edge.topCohorts) && edge.topCohorts.some((cohort) => cohort.samples)
    ? edge.topCohorts
    : Array.isArray(edge.liveFlow) ? edge.liveFlow : [];
  $("edgeStatus").textContent = String(edge.status || "collecting").toUpperCase();
  $("edgeCurrent").textContent = current?.label || "--";
  $("edgeLift700").textContent = current?.lift700 !== undefined ? `${formatLift(current.lift700)}x` : current ? String(Math.round(safeNum(current.edgeScore))) : "--";
  $("edgeHit100").textContent = current?.hitRate100 !== undefined ? fmtPct(safeNum(current.hitRate100) * 100) : current ? `${safeNum(current.avgBuySell).toFixed(2)} B/S` : "--";
  $("edgeConfidence").textContent = current ? fmtPct(safeNum(current.confidence) * 100) : "--";

  if (!cohorts.length) {
    $("moonshotTopRows").innerHTML = `<tr><td colspan="6"><div class="empty-state">Collecting order-flow cohorts. Edge appears after labeled 15m outcomes.</div></td></tr>`;
    return;
  }
  $("moonshotTopRows").innerHTML = cohorts.map((cohort) => `
    <tr>
      <td>${escapeHtml(cohort.label || "--")}</td>
      <td>${cohort.completed !== undefined ? `${safeNum(cohort.completed).toLocaleString()} / ` : ""}${safeNum(cohort.samples).toLocaleString()}</td>
      <td>${cohort.lift700 !== undefined ? `${formatLift(cohort.lift700)}x` : String(Math.round(safeNum(cohort.edgeScore)))}</td>
      <td>${cohort.hitRate100 !== undefined ? fmtPct(safeNum(cohort.hitRate100) * 100) : `${safeNum(cohort.avgBuySell).toFixed(2)} B/S`}</td>
      <td>${cohort.p90Max !== undefined ? `${(safeNum(cohort.p90Max) || 1).toFixed(2)}x` : `${safeNum(cohort.avgVolLiq).toFixed(2)} V/L`}</td>
      <td>${fmtPct(safeNum(cohort.confidence) * 100)}</td>
    </tr>
  `).join("");
}

function formatLift(value) {
  const n = safeNum(value);
  if (!n) return "0.00";
  if (n >= 999) return "inf";
  return n.toFixed(2);
}

function renderEdgeIntelligence() {
  const intel = moonshotResearch.edge?.intelligence || {};
  const cfg = strategyOptimizer.config || DEFAULT_STRATEGY_CONFIG;
  const diag = strategyOptimizer.diagnostics || {};
  const readiness = safeNum(diag.readiness || intel.edgeScore);
  const missed = Array.isArray(intel.missedWinners) ? intel.missedWinners : [];
  const bad = Array.isArray(intel.badEntries) ? intel.badEntries : [];
  setText("edgeReadiness", readiness ? `${readiness}/100` : "--");
  setClass("edgeReadiness", readiness >= 70 ? "positive" : readiness >= 45 ? "neutral" : "negative");
  setText("missedWinnerCount", String(missed.length));
  setClass("missedWinnerCount", missed.length ? "neutral" : "positive");
  setText("badEntryCount", String(bad.length));
  setClass("badEntryCount", bad.length ? "negative" : "positive");
  setClass("edgeIntelAction", readiness >= 70 ? "positive" : "neutral");
  setText("edgeIntelStatus", `${cfg.mode || "learning"} / ${safeNum(diag.completed || intel.completed).toLocaleString()} labeled`);
  const optimizerLine = `${cfg.mode}: ${cfg.rationale}`;
  setText("edgeIntelAction", optimizerLine);

  const renderItem = (item, fallback) => `
    <div class="intel-item">
      <strong>${escapeHtml(item.symbol || "UNKNOWN")}</strong>
      <span>${fallback(item)}</span>
      <em>${escapeHtml(item.reason || "review")}</em>
    </div>
  `;
  const missedList = $("missedWinnerList");
  if (missedList) {
    missedList.innerHTML = missed.length
      ? missed.map((item) => renderItem(item, (entry) => `${safeNum(entry.maxMultiplier).toFixed(2)}x max / ${safeNum(entry.txCount)} tx / ${safeNum(entry.buySellRatio).toFixed(2)} B/S`)).join("")
      : `<div class="empty-state">No missed winners detected yet.</div>`;
  }
  const badList = $("badEntryList");
  if (badList) {
    badList.innerHTML = bad.length
      ? bad.map((item) => renderItem(item, (entry) => `${fmtPct(safeNum(entry.m15Return))} m15 / ${safeNum(entry.txCount)} tx / ${fmtUsd(safeNum(entry.liq), 0)} liq`)).join("")
      : `<div class="empty-state">No bad entry cluster detected yet.</div>`;
  }
}

function renderAccountEquityLine() {
  const equity = portfolioEquity();
  const values = appState.equityCurve.map((point) => safeNum(point.equity)).filter((value) => value > 0);
  const high = Math.max(appState.startingCapital, equity, ...values);
  const low = Math.min(appState.startingCapital, equity, ...values);
  const ret = appState.startingCapital ? ((equity - appState.startingCapital) / appState.startingCapital) * 100 : 0;
  const dd = high ? ((equity - high) / high) * 100 : 0;
  $("accountEquityNow").textContent = fmtUsd(equity);
  $("accountEquityReturn").textContent = fmtPct(ret);
  $("accountEquityReturn").className = ret >= 0 ? "positive" : "negative";
  $("accountEquityHigh").textContent = fmtUsd(high);
  $("accountEquityDd").textContent = fmtPct(dd);
  $("accountEquityDd").className = dd >= -5 ? "positive" : dd >= -15 ? "neutral" : "negative";
  drawAccountEquityChart({ high, low });
}

function visibleEquityPoints(points) {
  if (!equityZoomLevel || points.length <= 2) return points;
  const windowSize = Math.max(8, Math.ceil(points.length / (equityZoomLevel + 1)));
  return points.slice(-windowSize);
}

function renderBtcAgent() {
  const btc = appState.btc = normalizeBtcState(appState.btc);
  const snapshot = btc.lastSnapshot;
  const equity = btcEquity();
  const ret = btc.startingCapital ? ((equity - btc.startingCapital) / btc.startingCapital) * 100 : 0;
  const position = btc.position;
  const positionPnl = position
    ? (safeNum(position.lastPrice) - safeNum(position.entryPrice)) * safeNum(position.qty) * (position.side === "SHORT" ? -1 : 1)
    : 0;
  const positionPnlPct = position?.margin ? (positionPnl / position.margin) * 100 : 0;

  setText("btcPrice", snapshot ? fmtUsd(snapshot.price, 2) : "--");
  setText("btcSignal", snapshot ? `${snapshot.signal.direction} ${snapshot.signal.score}` : "WAIT");
  setClass("btcSignal", snapshot?.signal.direction === "LONG" ? "positive" : snapshot?.signal.direction === "SHORT" ? "negative" : "neutral");
  setText("btcImbalance", snapshot ? fmtPct(snapshot.imbalance) : "--");
  setClass("btcImbalance", safeNum(snapshot?.imbalance) >= 0 ? "positive" : "negative");
  setText("btcCvd", snapshot ? fmtUsd(snapshot.cvd, 0) : "--");
  setClass("btcCvd", safeNum(snapshot?.cvd) >= 0 ? "positive" : "negative");
  setText("btcSpread", snapshot ? `${safeNum(snapshot.spreadPct).toFixed(3)}%` : "--");
  setText("btcEquity", fmtUsd(equity));
  setText("btcReturn", fmtPct(ret));
  setClass("btcReturn", ret >= 0 ? "positive" : "negative");
  setText("btcPosition", position ? `${position.side} ${fmtUsd(position.margin)} / ${fmtPct(positionPnlPct)}` : "FLAT");
  setClass("btcPosition", position ? positionPnl >= 0 ? "positive" : "negative" : "neutral");
  setText("btcAgentStatus", btc.lastError ? `ERROR / ${btc.lastError}` : snapshot ? `LIVE / ${new Date(snapshot.time).toLocaleTimeString()}` : "WAITING");

  const tape = btc.orderFlow.slice(0, 20);
  const list = $("btcTapeList");
  if (list) {
    list.innerHTML = tape.length ? tape.map((event) => {
      const cls = event.side === "LONG" ? "flow-buy" : event.side === "SHORT" ? "flow-sell" : "flow-watch";
      const tone = event.side === "LONG" ? "positive" : event.side === "SHORT" ? "negative" : "neutral";
      return `
        <div class="flow-event ${cls}">
          <strong>${new Date(event.time).toLocaleTimeString()}</strong>
          <div>
            <strong>BTCUSDT <span class="${tone}">${event.side}</span></strong><br>
            <small>${fmtUsd(event.price, 2)} | CVD ${fmtPct(event.cvdPct)} | Book ${fmtPct(event.imbalance)} | S${event.score}</small>
          </div>
          <span class="flow-chip">${event.reason}</span>
        </div>
      `;
    }).join("") : `<div class="empty-state">Waiting for BTCUSDT order-flow snapshots.</div>`;
  }

  drawBtcEquityChart();
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setClass(id, value) {
  const el = $(id);
  if (el) el.className = value;
}

function renderAgents() {
  $("agentList").innerHTML = agents.map(([name, description]) => `
    <div class="agent-item">
      <div><strong>${name}</strong><br><span class="metric-label">${description}</span></div>
      <span class="status">ONLINE</span>
    </div>
  `).join("");
}

function setAgents(type, label) {
  const className = type === "ok" ? "status" : "status warn";
  $("agentList").innerHTML = agents.map(([name, description]) => `
    <div class="agent-item">
      <div><strong>${name}</strong><br><span class="metric-label">${description}</span></div>
      <span class="${className}">${label}</span>
    </div>
  `).join("");
}

function renderSources() {
  $("sourceList").innerHTML = sources.map(([name, path]) => {
    const state = sourceStatus.get(name);
    const cls = !state ? "status warn" : state.ok ? "status" : "status bad";
    const value = !state ? "WAIT" : state.ok ? `${state.ms}ms` : state.error;
    return `
      <div class="source-item">
        <div><strong>${name}</strong><br><span class="metric-label">${path}</span></div>
        <span class="${cls}">${value}</span>
      </div>
    `;
  }).join("");
}

function flowStatus(id, ok, value) {
  const el = $(id);
  if (!el) return;
  el.textContent = value;
  el.className = ok ? "flow-ok" : "flow-warn";
}

function renderDataFlow() {
  const dexOk = latestCandidates.length > 0;
  const scoutOk = dexOk && latestCandidates.some((candidate) => candidate.score >= 50);
  const momentumOk = dexOk && latestCandidates.some((candidate) => candidate.moonshotScore >= 50 || candidate.score >= 70);
  const researchOk = researchAgentStatus.lastCycleAt > 0;
  const storageOk = researchAgentStatus.persisted || sourceStatus.get("Storage Backend")?.ok;
  const tradingOk = appState.cycles > 0 || appState.positions.length > 0 || appState.journal.length > 0;
  const storageLabel = researchAgentStatus.storageProvider || sourceStatus.get("Storage Backend")?.error || "WAIT";

  flowStatus("flowDexStatus", dexOk, dexOk ? `${latestCandidates.length} PAIRS` : "WAIT");
  flowStatus("flowScoutStatus", scoutOk, scoutOk ? "FILTERING" : "WAIT");
  flowStatus("flowMomentumStatus", momentumOk, momentumOk ? "SCORING" : "WAIT");
  flowStatus("flowResearchStatus", researchOk, researchOk ? `${researchAgentStatus.lastCollected} TOKENS` : "ARMED");
  flowStatus("flowStorageStatus", storageOk, storageOk ? String(storageLabel).toUpperCase() : "OFFLINE");
  flowStatus("flowTradingStatus", tradingOk, tradingOk ? `${appState.positions.length} OPEN` : "PAPER READY");

  $("dataFlowStatus").textContent = storageOk
    ? `Pipeline online / ${String(storageLabel).toUpperCase()}`
    : "Pipeline collecting / storage check";
  $("flowLivePairs").textContent = latestCandidates.length.toLocaleString();
  $("flowSamples").textContent = safeNum(moonshotResearch.total).toLocaleString();
  $("flowSheetRows").textContent = sheetStatus.observations.toLocaleString();
  $("flowOpenPositions").textContent = appState.positions.length.toLocaleString();
}

function renderTickerTape() {
  const tapeItems = latestCandidates.slice(0, 18).map((candidate) => {
    const symbol = escapeHtml(candidate.pair.baseToken?.symbol || "UNKNOWN");
    const pctClass = candidate.change5 >= 0 ? "positive" : "negative";
    return `<span>${symbol} <b class="${pctClass}">${fmtPct(candidate.change5)}</b> VOL ${fmtUsd(candidate.volume5)} LIQ ${fmtUsd(candidate.liq)} S${candidate.score}</span>`;
  });
  $("tickerTapeInner").innerHTML = tapeItems.length ? [...tapeItems, ...tapeItems].join("") : "<span>WAITING FOR DEXSCREENER FLOW</span>";
}

function renderOrderFlow() {
  const positionPairs = new Set(appState.positions.map((position) => position.pairAddress));
  const flow = appState.orderFlow
    .filter((event) => positionPairs.has(event.pairAddress) || event.inPosition || event.score >= 70)
    .slice(0, 32);
  if (!flow.length) {
    $("orderFlowList").innerHTML = `<div class="empty-state">No inferred flow yet. It appears after two DexScreener snapshots.</div>`;
    return;
  }
  $("orderFlowList").innerHTML = flow.map((event) => {
    const isBuy = event.side.includes("BUY");
    const isSell = event.side.includes("SELL");
    const flowClass = isBuy ? "flow-buy" : isSell ? "flow-sell" : "flow-watch";
    const tone = isBuy ? "positive" : isSell ? "negative" : "neutral";
    const focus = event.inPosition ? "IN BOOK" : "WATCH";
    const mode = event.snapshotMode ? "5m snapshot" : "cycle delta";
    return `
      <div class="flow-event ${flowClass}">
        <strong>${new Date(event.time).toLocaleTimeString()}</strong>
        <div>
          <strong>${escapeHtml(event.symbol)} <span class="${tone}">${event.side}</span></strong><br>
          <small>${mode} | B ${event.buyDelta} / S ${event.sellDelta} | Vol ${fmtUsd(event.volDelta)} | ${fmtPct(event.priceDelta)}</small>
        </div>
        <span class="flow-chip">${focus}</span>
      </div>
    `;
  }).join("");
}

function renderCandidates() {
  $("candidateCount").textContent = `${latestCandidates.length} tokens`;
  if (!latestCandidates.length) {
    $("candidateRows").innerHTML = `<tr><td colspan="11"><div class="empty-state">No live candidates loaded yet.</div></td></tr>`;
    return;
  }
  $("candidateRows").innerHTML = latestCandidates.slice(0, 60).map((candidate) => {
    const pair = candidate.pair;
    const profile = profitabilityProfile(candidate);
    const changeClass = candidate.change5 > 0 ? "positive" : candidate.change5 < 0 ? "negative" : "neutral";
    const riskClass = candidate.risk === "LOW" ? "risk-low" : candidate.risk === "MED" ? "risk-med" : "risk-high";
    const flowBias = profile.entryAllowed ? "EV GO" : candidate.buys > candidate.sells * 1.5 ? "ACCUM" : candidate.sells > candidate.buys * 1.25 ? "DISTR" : "MIXED";
    const flowClass = flowBias === "ACCUM" ? "positive" : flowBias === "DISTR" ? "negative" : "neutral";
    return `
      <tr>
        <td>
          <div class="token-name">
            <a href="${pair.url}" target="_blank" rel="noreferrer">${escapeHtml(pair.baseToken?.symbol || "UNKNOWN")}</a>
            <small>${escapeHtml(pair.dexId || "dex")} / ${escapeHtml(pair.quoteToken?.symbol || "--")}</small>
          </div>
        </td>
        <td>${ageFrom(pair.pairCreatedAt)}</td>
        <td><strong>${candidate.score}</strong></td>
        <td><strong>${candidate.moonshotScore}</strong></td>
        <td>${fmtUsd(candidate.price, 8)}</td>
        <td class="${changeClass}">${fmtPct(candidate.change5)}</td>
        <td>${fmtUsd(candidate.volume5)}</td>
        <td>${fmtUsd(candidate.liq)}</td>
        <td>${candidate.buys}/${candidate.sells}</td>
        <td class="${profile.entryAllowed ? "positive" : flowClass}">${flowBias}<br><small>${profile.expectancyPct.toFixed(1)}% EV</small></td>
        <td><span class="risk-pill ${riskClass}">${candidate.risk}</span></td>
      </tr>
    `;
  }).join("");
}

function renderPositions() {
  $("positionCount").textContent = `${appState.positions.length} open`;
  if (!appState.positions.length) {
    $("positionsList").innerHTML = document.getElementById("emptyTemplate").innerHTML;
    return;
  }
  $("positionsList").innerHTML = appState.positions.map((position) => {
    const value = position.units * safeNum(position.lastPrice);
    const pnl = value - (position.partialTaken ? position.size * 0.5 : position.size);
    const pnlPct = ((safeNum(position.lastPrice) - position.entryPrice) / position.entryPrice) * 100;
    const canvasId = `posChart-${position.id}`;
    return `
      <article class="position-card">
        <header><span>${escapeHtml(position.symbol)}</span><span class="${pnl >= 0 ? "positive" : "negative"}">${fmtPct(pnlPct)}</span></header>
        <dl>
          <div><dt>Value</dt><dd>${fmtUsd(value)}</dd></div>
          <div><dt>Paper PnL</dt><dd class="${pnl >= 0 ? "positive" : "negative"}">${fmtUsd(pnl)}</dd></div>
          <div><dt>Entry</dt><dd>${fmtUsd(position.entryPrice, 8)}</dd></div>
          <div><dt>Score</dt><dd>${position.score}</dd></div>
        </dl>
        <canvas class="position-chart" id="${canvasId}" width="360" height="54" aria-label="${escapeHtml(position.symbol)} mini chart"></canvas>
        <span class="metric-label">${escapeHtml(position.thesis)}</span>
      </article>
    `;
  }).join("");
  requestAnimationFrame(() => {
    for (const position of appState.positions) {
      drawMiniChart(`posChart-${position.id}`, appState.marketHistory[position.pairAddress] || [], "price");
    }
  });
}

function renderJournal() {
  $("journalCount").textContent = `${appState.journal.length} closed trades`;
  if (!appState.journal.length) {
    $("journalRows").innerHTML = `<tr><td colspan="8"><div class="empty-state">No closed paper trades yet.</div></td></tr>`;
    return;
  }
  $("journalRows").innerHTML = appState.journal.slice(0, 80).map((trade) => `
    <tr>
      <td>${new Date(trade.time).toLocaleTimeString()}</td>
      <td><a href="${trade.url}" target="_blank" rel="noreferrer">${escapeHtml(trade.symbol)}</a></td>
      <td>${escapeHtml(trade.side)}</td>
      <td>${fmtUsd(trade.size)}</td>
      <td>${fmtUsd(trade.entryPrice, 8)}</td>
      <td>${fmtUsd(trade.exitPrice, 8)}</td>
      <td class="${trade.pnl >= 0 ? "positive" : "negative"}">${fmtUsd(trade.pnl)}</td>
      <td>${escapeHtml(trade.reason)}</td>
    </tr>
  `).join("");
}

function renderEvaluator() {
  const trades = appState.journal.filter((trade) => trade.side !== "SELL 50%");
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const pnl = appState.journal.reduce((sum, trade) => sum + safeNum(trade.pnl), 0);
  const peak = appState.equityCurve.reduce((max, point) => Math.max(max, point.equity), appState.startingCapital);
  const trough = appState.equityCurve.reduce((min, point) => Math.min(min, point.equity), peak);
  const dd = peak ? ((trough - peak) / peak) * 100 : 0;
  $("tradesKpi").textContent = String(trades.length);
  $("winRateKpi").textContent = trades.length ? `${Math.round((wins / trades.length) * 100)}%` : "0%";
  $("pnlKpi").textContent = fmtUsd(pnl);
  $("pnlKpi").className = pnl >= 0 ? "positive" : "negative";
  $("drawdownKpi").textContent = fmtPct(dd);
  drawEquityChart();
}

function renderProfitabilityControl() {
  const ranked = latestCandidates
    .map((candidate) => ({ candidate, profile: profitabilityProfile(candidate) }))
    .sort((a, b) => b.profile.expectancyPct - a.profile.expectancyPct);
  const best = ranked[0];
  const goCount = ranked.filter((item) => item.profile.entryAllowed).length;
  const regime = marketRegime();
  const bestEv = best ? best.profile.expectancyPct : 0;
  $("bestEvKpi").textContent = best ? `${bestEv.toFixed(1)}%` : "--";
  $("bestEvKpi").className = bestEv >= 7 ? "positive" : bestEv >= 0 ? "neutral" : "negative";
  $("entryGateKpi").textContent = `${goCount} EV GO`;
  $("entryGateKpi").className = goCount ? "positive" : "neutral";
  $("suggestedSizeKpi").textContent = best ? `${Math.round(best.profile.sizePct * 100)}% max` : "--";
  $("suggestedSizeKpi").className = best?.profile.sizePct >= 0.1 ? "positive" : best?.profile.sizePct ? "neutral" : "negative";
  $("slippageGuardKpi").textContent = best ? `${best.profile.slippagePct.toFixed(1)}% est` : "--";
  $("slippageGuardKpi").className = best && best.profile.slippagePct <= 3 ? "positive" : best && best.profile.slippagePct <= 5 ? "neutral" : "negative";
  $("marketRegimeKpi").textContent = `${regime.label} ${regime.quality}`;
  $("marketRegimeKpi").className = regime.tradable ? "positive" : "negative";
  $("edgeReasonKpi").textContent = best ? best.profile.reason : "--";
  $("edgeReasonKpi").className = best?.profile.entryAllowed ? "positive" : "neutral";
  $("profitabilityMode").textContent = best?.profile.entryAllowed ? "Positive EV armed" : "Waiting for positive EV";
}

function renderRiskConsole() {
  const equity = portfolioEquity();
  const gross = appState.positions.reduce((sum, position) => sum + position.units * safeNum(position.lastPrice), 0);
  const openPnls = appState.positions.map((position) => {
    const basis = position.partialTaken ? position.size * 0.5 : position.size;
    return position.units * safeNum(position.lastPrice) - basis;
  });
  const avgOpenPnl = openPnls.length ? openPnls.reduce((sum, pnl) => sum + pnl, 0) / openPnls.length : 0;
  const exposurePct = equity ? (gross / equity) * 100 : 0;
  const cashBuffer = equity ? (appState.cash / equity) * 100 : 0;
  const apiOk = [...sourceStatus.values()].filter((state) => state.ok).length;
  const grade = apiOk >= 4 && exposurePct <= 35 ? "A" : apiOk >= 3 && exposurePct <= 45 ? "B" : "C";
  $("grossExposureKpi").textContent = `${fmtUsd(gross)} / ${exposurePct.toFixed(0)}%`;
  $("cashBufferKpi").textContent = `${cashBuffer.toFixed(0)}%`;
  $("avgOpenPnlKpi").textContent = fmtUsd(avgOpenPnl);
  $("avgOpenPnlKpi").className = avgOpenPnl >= 0 ? "positive" : "negative";
  $("systemGradeKpi").textContent = grade;
  $("systemGradeKpi").className = grade === "A" ? "positive" : grade === "B" ? "neutral" : "negative";
}

function selectedChartCandidate() {
  const open = appState.positions[0];
  if (open) {
    const candidate = latestCandidates.find((item) => item.pair.pairAddress === open.pairAddress);
    if (candidate) return candidate;
  }
  return latestCandidates[0];
}

function renderMarketChart() {
  const candidate = selectedChartCandidate();
  if (!candidate) {
    $("chartToken").textContent = "--";
    $("chartPrice").textContent = "--";
    $("chartFlowBias").textContent = "--";
    $("chartLiquidity").textContent = "--";
    drawMarketCanvas([]);
    return;
  }
  const history = appState.marketHistory[candidate.pair.pairAddress] || [];
  const flowBias = candidate.buys > candidate.sells * 1.5 ? "ACCUMULATION" : candidate.sells > candidate.buys * 1.25 ? "DISTRIBUTION" : "MIXED FLOW";
  $("chartTitle").textContent = candidate.pair.url ? "Real DexScreener snapshots" : "Best candidate history";
  $("chartToken").textContent = `${candidate.pair.baseToken?.symbol || "UNKNOWN"} / ${candidate.pair.quoteToken?.symbol || "--"}`;
  $("chartPrice").textContent = fmtUsd(candidate.price, 8);
  $("chartFlowBias").textContent = flowBias;
  $("chartFlowBias").className = flowBias === "ACCUMULATION" ? "positive" : flowBias === "DISTRIBUTION" ? "negative" : "neutral";
  $("chartLiquidity").textContent = fmtUsd(candidate.liq);
  drawMarketCanvas(history);
}

function drawMarketCanvas(history) {
  const canvas = $("marketChart");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid(ctx, canvas.width, canvas.height);
  if (history.length < 2) {
    ctx.fillStyle = "#7f8b99";
    ctx.font = "12px Arial";
    ctx.fillText("Waiting for more snapshots", 18, 34);
    return;
  }
  drawLine(ctx, history, "price", "#2fe07c", canvas.width, canvas.height, 18, 24);
  drawBars(ctx, history, "volume5", "#f5b301", canvas.width, canvas.height);
  ctx.fillStyle = "#7f8b99";
  ctx.font = "11px Arial";
  ctx.fillText("PRICE", 18, 18);
  ctx.fillStyle = "#f5b301";
  ctx.fillText("5M VOLUME", 76, 18);
}

function drawGrid(ctx, width, height) {
  ctx.strokeStyle = "#26313d";
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i += 1) {
    const y = 22 + i * ((height - 44) / 5);
    ctx.beginPath();
    ctx.moveTo(12, y);
    ctx.lineTo(width - 12, y);
    ctx.stroke();
  }
}

function drawLine(ctx, points, key, color, width, height, topPad = 12, bottomPad = 14) {
  const values = points.map((point) => safeNum(point[key])).filter((value) => Number.isFinite(value));
  if (values.length < 2) return;
  const min = Math.min(...values) * 0.995;
  const max = Math.max(...values) * 1.005;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = 12 + (index / Math.max(1, points.length - 1)) * (width - 24);
    const y = height - bottomPad - ((safeNum(point[key]) - min) / Math.max(1e-12, max - min)) * (height - topPad - bottomPad);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawBars(ctx, points, key, color, width, height) {
  const values = points.map((point) => safeNum(point[key]));
  const max = Math.max(...values, 1);
  const barW = Math.max(2, (width - 24) / Math.max(1, points.length) - 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.28;
  points.forEach((point, index) => {
    const x = 12 + (index / Math.max(1, points.length - 1)) * (width - 24);
    const h = (safeNum(point[key]) / max) * 62;
    ctx.fillRect(x, height - 14 - h, barW, h);
  });
  ctx.globalAlpha = 1;
}

function drawMiniChart(canvasId, history, key) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#26313d";
  ctx.beginPath();
  ctx.moveTo(0, canvas.height - 10);
  ctx.lineTo(canvas.width, canvas.height - 10);
  ctx.stroke();
  if (history.length < 2) return;
  const first = safeNum(history[0][key]);
  const last = safeNum(history.at(-1)[key]);
  drawLine(ctx, history, key, last >= first ? "#2fe07c" : "#ff4d5e", canvas.width, canvas.height, 6, 8);
}

function drawEquityChart() {
  const canvas = $("equityChart");
  const ctx = canvas.getContext("2d");
  const points = appState.equityCurve;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#26313d";
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i += 1) {
    const y = 18 + i * 26;
    ctx.beginPath();
    ctx.moveTo(10, y);
    ctx.lineTo(canvas.width - 10, y);
    ctx.stroke();
  }
  if (points.length < 2) return;
  const values = points.map((p) => p.equity);
  const min = Math.min(...values) * 0.995;
  const max = Math.max(...values) * 1.005;
  ctx.strokeStyle = values.at(-1) >= appState.startingCapital ? "#2fe07c" : "#ff4d5e";
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = 12 + (index / Math.max(1, points.length - 1)) * (canvas.width - 24);
    const y = canvas.height - 14 - ((point.equity - min) / Math.max(1, max - min)) * (canvas.height - 28);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawBtcEquityChart() {
  const canvas = $("btcEquityChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const points = appState.btc?.equityCurve || [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid(ctx, canvas.width, canvas.height);
  if (points.length < 2) {
    ctx.fillStyle = "#7f8b99";
    ctx.font = "12px Arial";
    ctx.fillText("Waiting for BTC equity samples", 18, 34);
    return;
  }
  const values = points.map((point) => safeNum(point.equity));
  const min = Math.min(...values, appState.btc.startingCapital) * 0.998;
  const max = Math.max(...values, appState.btc.startingCapital) * 1.002;
  const up = values.at(-1) >= appState.btc.startingCapital;
  ctx.strokeStyle = up ? "#34f589" : "#ff4a5f";
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = 14 + (index / Math.max(1, points.length - 1)) * (canvas.width - 28);
    const y = canvas.height - 18 - ((safeNum(point.equity) - min) / Math.max(1e-8, max - min)) * (canvas.height - 36);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#8895a3";
  ctx.font = "11px Arial";
  ctx.fillText(`${points.length} BTC equity points`, 16, canvas.height - 6);
}

function drawAccountEquityChart({ high, low }) {
  const canvas = $("accountEquityChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const allPoints = appState.equityCurve.length ? appState.equityCurve : [{ time: Date.now(), equity: appState.startingCapital }];
  const points = visibleEquityPoints(allPoints);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const padX = 18;
  const padTop = 22;
  const padBottom = 24;
  const width = canvas.width;
  const height = canvas.height;
  const values = points.map((point) => safeNum(point.equity));
  const current = portfolioEquity();
  const min = Math.min(...values, current, appState.startingCapital) * 0.995;
  const max = Math.max(...values, current, appState.startingCapital) * 1.005;
  const yFor = (value) => height - padBottom - ((value - min) / Math.max(1, max - min)) * (height - padTop - padBottom);
  const xFor = (index) => padX + (index / Math.max(1, points.length - 1)) * (width - padX * 2);

  ctx.strokeStyle = "#26313d";
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i += 1) {
    const y = padTop + i * ((height - padTop - padBottom) / 5);
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(width - padX, y);
    ctx.stroke();
  }

  const startY = yFor(appState.startingCapital);
  ctx.strokeStyle = "rgba(255, 176, 0, 0.65)";
  ctx.setLineDash([8, 7]);
  ctx.beginPath();
  ctx.moveTo(padX, startY);
  ctx.lineTo(width - padX, startY);
  ctx.stroke();
  ctx.setLineDash([]);

  if (points.length >= 2) {
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "#2ecbff");
    gradient.addColorStop(0.55, current >= appState.startingCapital ? "#34f589" : "#ffb000");
    gradient.addColorStop(1, current >= appState.startingCapital ? "#34f589" : "#ff4a5f");
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 4;
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xFor(index);
      const y = yFor(safeNum(point.equity));
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  const lastX = xFor(points.length - 1);
  const lastY = yFor(current);
  ctx.fillStyle = current >= appState.startingCapital ? "#34f589" : "#ff4a5f";
  ctx.beginPath();
  ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#8895a3";
  ctx.font = "12px Arial";
  ctx.fillText(`START ${fmtUsd(appState.startingCapital)}`, padX + 4, Math.max(14, startY - 8));
  ctx.fillStyle = "#f0f4f8";
  ctx.fillText(`NOW ${fmtUsd(current)}`, Math.max(padX, lastX - 96), Math.max(16, lastY - 12));

  const firstPoint = points[0];
  const lastPoint = points.at(-1);
  const rangeLabel = equityZoomLevel
    ? `Last ${points.length} / ${allPoints.length} points`
    : `Full history / ${allPoints.length} points`;
  const range = $("accountEquityRange");
  if (range) range.textContent = rangeLabel;
  ctx.fillStyle = "#8895a3";
  ctx.font = "11px Arial";
  ctx.fillText(new Date(firstPoint.time).toLocaleTimeString(), padX, height - 6);
  ctx.fillText(new Date(lastPoint.time).toLocaleTimeString(), Math.max(padX, width - padX - 78), height - 6);
}

function exportJournal() {
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), state: appState }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `solana-paper-journal-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function resetPaper() {
  if (!confirm("Reset paper portfolio, positions, and journal?")) return;
  appState = createDefaultState();
  latestCandidates = [];
  sourceStatus = new Map();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  render();
  await saveRemoteStateNow();
  await scanDexScreener();
}

$("refreshBtn").addEventListener("click", scanDexScreener);
$("cycleBtn").addEventListener("click", () => {
  runPaperCycle();
  saveState();
  render();
});
$("researchBtn").addEventListener("click", () => triggerServerCollector(true));
$("exportBtn").addEventListener("click", exportJournal);
$("resetBtn").addEventListener("click", resetPaper);
$("equityZoomInBtn").addEventListener("click", () => {
  equityZoomLevel = Math.min(8, equityZoomLevel + 1);
  renderAccountEquityLine();
});
$("equityZoomOutBtn").addEventListener("click", () => {
  equityZoomLevel = Math.max(0, equityZoomLevel - 1);
  renderAccountEquityLine();
});
$("equityResetZoomBtn").addEventListener("click", () => {
  equityZoomLevel = 0;
  renderAccountEquityLine();
});

async function boot() {
  showProtocolWarning();
  if (isLocalFileMode()) {
    sourceStatus.set("Shared Paper State", { ok: false, ms: 0, error: "open live site" });
    sourceStatus.set("Moonshot Research", { ok: false, ms: 0, error: "open live site" });
    sourceStatus.set("Research Agent", { ok: false, ms: 0, error: "open live site" });
    render();
    return;
  }
  render();
  await loadRemoteState();
  await loadDatasetStatus();
  await loadBacktestStatus();
  await loadSheetStatus();
  await loadMoonshotResearch();
  await loadStrategyOptimizer(true);
  render();
  triggerServerCollector();
  await scanDexScreener();
  await scanBtcUsdt();
  setInterval(scanDexScreener, FULL_SCAN_INTERVAL_MS);
  setInterval(scanFocusedOrderFlow, FOCUSED_ORDER_SCAN_MS);
  setInterval(scanBtcUsdt, BTC_SCAN_INTERVAL_MS);
  setInterval(refreshRemoteStateFromCloud, SHARED_STATE_PULL_MS);
  setInterval(loadMoonshotResearch, RESEARCH_SYNC_MS);
  setInterval(loadDatasetStatus, RESEARCH_SYNC_MS);
  setInterval(loadBacktestStatus, RESEARCH_SYNC_MS);
  setInterval(loadSheetStatus, RESEARCH_SYNC_MS);
  setInterval(() => loadStrategyOptimizer(true), SERVER_COLLECTOR_MS);
  setInterval(triggerServerCollector, SERVER_COLLECTOR_MS);
}

boot();
