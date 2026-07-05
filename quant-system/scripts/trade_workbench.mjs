import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const quantRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(quantRoot, "..");
const dataDir = path.join(repoRoot, "reports/data");
const outputPath = path.join(dataDir, "latest-trade-workbench.json");

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function codeOf(row) {
  return String(row?.code || "").replace(/\D/g, "").padStart(6, "0");
}

function limitWeight(state) {
  if (state === "LIMIT_UP") return 5;
  if (state === "NEAR_LIMIT") return 4;
  if (state === "STRONG") return 3;
  return 0;
}

function executionRank(status = "") {
  if (String(status).startsWith("READY")) return 1;
  if (status === "WAIT_PULLBACK" || status === "POST_LIMIT_CONFIRM") return 2;
  if (status === "WATCH_THEME_WEAK" || status === "WAIT_RECOVER_BUY_ZONE") return 4;
  return 8;
}

function phaseFromOpening(summary = {}, themeFrontline = {}, radarRows = []) {
  if (toNumber(summary.ready) > 0) return "EXECUTE";
  if (themeFrontline?.marketGate?.status === "RISK_ON") return "ATTACK_WAIT_EXECUTION";
  if (radarRows.some((row) => ["LIMIT_UP", "NEAR_LIMIT"].includes(row.limitState))) return "RADAR_WATCH";
  if (toNumber(summary.wait) > 0) return "WAIT_PULLBACK";
  return "RISK_CONTROL";
}

function platformAction(phase) {
  if (phase === "EXECUTE") return "只允许买区限价和 Paper 预检，不允许追价";
  if (phase === "ATTACK_WAIT_EXECUTION") return "主线可进攻，但必须等个股进入买区";
  if (phase === "RADAR_WATCH") return "先记录涨停/近涨停前排，重点准备次日承接计划";
  if (phase === "WAIT_PULLBACK") return "空仓或轻仓等待回踩，不主动追高";
  return "风控优先，禁止主动开新仓";
}

function normalizeOpeningRow(row) {
  const decision = row.decision || {};
  return {
    code: codeOf(row),
    name: row.name || "",
    bucket: row.bucket || "",
    status: decision.status || "UNKNOWN",
    label: decision.label || "",
    orderStyle: decision.orderStyle || "",
    reason: decision.reason || "",
    maxPosition: decision.maxPosition || row.maxPosition || "",
    theme: row.theme?.primary || row.themeGate?.primaryTheme || "",
    themeState: row.themeGate?.state || row.theme?.state || "",
    themeTradeGate: row.themeGate?.tradeGate || row.theme?.tradeGate || "",
    price: row.quote?.price ?? null,
    pct: row.quote?.pct ?? null,
    buyZone: row.buyZone?.raw || "",
    stopLoss: row.stopLoss ?? null,
    targetPrice: row.targetPrice ?? null,
  };
}

function normalizeRadarRow(row, themeMap = {}) {
  const code = codeOf(row);
  const theme = themeMap[code] || {};
  return {
    code,
    name: row.name || "",
    theme: row.primaryTheme || theme.primaryTheme || row.theme || "",
    themeRank: row.themeRank ?? theme.themeRank ?? null,
    leaderRole: row.leaderRole || theme.leaderRole || "",
    limitState: row.limitState || theme.limitState || "NORMAL",
    price: row.price ?? null,
    pct: row.pct ?? null,
    turnover: row.turnover ?? null,
    volumeRatio: row.volumeRatio ?? null,
    emotionScore: row.emotionScore ?? null,
    inTodayPool: Boolean(row.inTodayPool || theme.inTodayPool),
    shouldHaveFlagged: Boolean(row.shouldHaveFlagged),
    decision: row.decision || "",
    nextAction: row.nextAction || "",
    missReason: row.missReason || "",
  };
}

function radarScore(row) {
  return (
    limitWeight(row.limitState) * 1000 +
    toNumber(row.emotionScore) * 10 +
    toNumber(row.pct) * 4 +
    (row.inTodayPool ? 35 : 0) +
    (row.shouldHaveFlagged ? 25 : 0)
  );
}

function normalizeLimitProofRow(row) {
  const limitDays = String(row.limitDays || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    code: codeOf(row),
    name: row.trueName || row.name || "",
    theme: row.theme || "其他",
    qLayer: row.qLayer || "",
    qScore: row.qScore ?? null,
    risk: row.risk || "",
    pools: row.pools || "",
    futureMaxPct: row.futureMaxPct ?? null,
    futureMaxDate: row.futureMaxDate || null,
    limitDays,
    limitDayCount: limitDays.length,
    missReason: row.missReason || "",
    modelFailureType: classifyHistoricalFailure(row),
  };
}

function classifyHistoricalFailure(row) {
  const reason = `${row.missReason || ""} ${row.risk || ""} ${row.qLayer || ""}`;
  if (/风险剔除|风险项|高换手|大幅波动|ST/.test(reason)) return "RISK_FALSE_NEGATIVE";
  if (/观察|没有进入涨停风格/.test(reason)) return "STYLE_NOT_PROMOTED";
  if (/高分识别|Q1/.test(reason)) return "SIGNAL_NOT_ESCALATED";
  if (/字段不完整/.test(reason)) return "DATA_FIELD_PENALTY";
  return "UNCLASSIFIED";
}

function historicalProofScore(row) {
  return toNumber(row.limitDayCount) * 1000 + toNumber(row.futureMaxPct) * 10 + (/Q1/.test(row.qLayer || "") ? 100 : 0);
}

function normalizeFullPoolRow(row, themeMap = {}, proofMap = {}, openingMap = {}) {
  const code = codeOf(row);
  const theme = themeMap[code] || {};
  const proof = proofMap[code] || null;
  const opening = openingMap[code] || null;
  const limitState = row.limitState || theme.limitState || "NORMAL";
  const themeRank = row.themeRank ?? theme.themeRank ?? null;
  const poolCategory = classifyPoolRow({ ...row, code, limitState, themeRank, proof, opening });
  return {
    code,
    name: row.name || theme.name || proof?.name || "",
    theme: row.primaryTheme || theme.primaryTheme || row.theme || proof?.theme || "其他",
    themeRank,
    leaderRole: row.leaderRole || theme.leaderRole || "",
    poolCategory,
    priorityScore: poolPriorityScore({ ...row, limitState, themeRank, proof, opening, poolCategory }),
    limitState,
    price: row.price ?? null,
    pct: row.pct ?? null,
    turnover: row.turnover ?? null,
    volumeRatio: row.volumeRatio ?? null,
    emotionScore: row.emotionScore ?? null,
    inTodayPool: Boolean(row.inTodayPool || theme.inTodayPool),
    todayScore: row.todayScore ?? theme.recommendation?.score ?? null,
    todayAction: row.todayAction || theme.recommendation?.action || "",
    todayRisk: row.todayRisk || "",
    shouldHaveFlagged: Boolean(row.shouldHaveFlagged),
    executionStatus: opening?.status || "",
    executionLabel: opening?.label || "",
    executionReason: opening?.reason || "",
    historicalLimit: proof
      ? {
          futureMaxPct: proof.futureMaxPct,
          futureMaxDate: proof.futureMaxDate,
          limitDayCount: proof.limitDayCount,
          modelFailureType: proof.modelFailureType,
          missReason: proof.missReason,
        }
      : null,
    nextAction: nextPoolAction({ ...row, limitState, proof, opening, poolCategory }),
  };
}

function classifyPoolRow({ limitState, proof, opening, inTodayPool, shouldHaveFlagged, themeRank, pct, volumeRatio, todayAction }) {
  if (opening && String(opening.status || "").startsWith("READY")) return "EXECUTION_READY";
  if (opening && ["WAIT_PULLBACK", "POST_LIMIT_CONFIRM"].includes(opening.status)) return "EXECUTION_WAIT";
  if (["LIMIT_UP", "NEAR_LIMIT", "STRONG"].includes(limitState) || shouldHaveFlagged) return "FRONTLINE_STRONG";
  if (proof) return "HISTORICAL_PROVEN";
  if (todayAction === "TRADE" || inTodayPool) return "MODEL_TRACK";
  if (toNumber(themeRank) > 0 && toNumber(themeRank) <= 3 && toNumber(pct) > 0) return "THEME_FOLLOW";
  if (toNumber(volumeRatio) >= 3 && toNumber(pct) >= 0) return "VOLUME_WATCH";
  return "POOL_BASE";
}

function poolPriorityScore(row) {
  const categoryScore = {
    EXECUTION_READY: 10000,
    EXECUTION_WAIT: 9000,
    FRONTLINE_STRONG: 8000,
    HISTORICAL_PROVEN: 7000,
    MODEL_TRACK: 6000,
    THEME_FOLLOW: 4500,
    VOLUME_WATCH: 3500,
    POOL_BASE: 1000,
  }[row.poolCategory] || 0;
  return (
    categoryScore +
    limitWeight(row.limitState) * 300 +
    toNumber(row.emotionScore) * 8 +
    toNumber(row.todayScore) * 5 +
    toNumber(row.pct) * 12 +
    Math.min(toNumber(row.volumeRatio), 50) * 4 +
    (row.proof ? 250 : 0) +
    (row.themeRank ? Math.max(0, 80 - toNumber(row.themeRank) * 12) : 0)
  );
}

function upsideCatalyst(row) {
  if (row.opening?.status?.startsWith("READY")) return "已进买区，先做 Paper 预检";
  if (row.opening?.status === "WAIT_PULLBACK") return "接近交易计划，等回踩承接";
  if (row.limitState === "LIMIT_UP") return "已封板，重点看次日竞价和开板承接";
  if (row.limitState === "NEAR_LIMIT") return "近涨停，短线情绪已经确认";
  if (row.limitState === "STRONG") return "强势票，观察是否扩散到同题材";
  if (row.proof) return "历史涨停验证样本，不能被普通因子忽略";
  if (row.inTodayPool || row.todayAction === "TRADE") return "主模型已经跟踪，等待更明确触发";
  if (toNumber(row.themeRank) > 0 && toNumber(row.themeRank) <= 3) return "强主题跟随，等待前排确认";
  if (toNumber(row.volumeRatio) >= 2 && toNumber(row.pct) >= 0) return "量能先动，等待价格同步转强";
  return "保留观察，暂未出现明确上涨触发";
}

function upsideRisk(row) {
  const risks = [];
  if (row.opening?.reason) risks.push(row.opening.reason);
  if (toNumber(row.pct) >= 8) risks.push("涨幅偏高，不能追价");
  if (toNumber(row.turnover) >= 12) risks.push("换手偏高，容易分歧");
  if (!row.inTodayPool && row.shouldHaveFlagged) risks.push("主模型漏标，需要人工复核");
  if (row.proof?.modelFailureType === "RISK_FALSE_NEGATIVE") risks.push("历史曾被风险项误杀");
  return risks.slice(0, 3);
}

function upsideScore(row) {
  return (
    limitWeight(row.limitState) * 120 +
    toNumber(row.emotionScore) * 1.6 +
    Math.max(0, toNumber(row.pct)) * 7 +
    Math.min(toNumber(row.volumeRatio), 8) * 8 +
    Math.min(toNumber(row.turnover), 15) * 2 +
    toNumber(row.todayScore) * 0.8 +
    (row.opening?.status?.startsWith("READY") ? 120 : 0) +
    (row.opening?.status === "WAIT_PULLBACK" ? 80 : 0) +
    (row.inTodayPool ? 45 : 0) +
    (row.shouldHaveFlagged ? 55 : 0) +
    (row.proof ? 70 + toNumber(row.proof.limitDayCount) * 18 : 0) +
    (row.themeRank ? Math.max(0, 80 - toNumber(row.themeRank) * 14) : 0)
  );
}

function normalizeUpsideRow(row) {
  const score = upsideScore(row);
  let label = "观察";
  if (row.opening?.status?.startsWith("READY")) label = "可预检";
  else if (row.limitState === "LIMIT_UP") label = "封板";
  else if (row.limitState === "NEAR_LIMIT") label = "近板";
  else if (row.limitState === "STRONG") label = "强势";
  else if (row.proof) label = "历史验证";
  else if (row.shouldHaveFlagged) label = "漏标复核";
  else if (toNumber(row.themeRank) > 0 && toNumber(row.themeRank) <= 3) label = "主题跟随";
  return {
    code: row.code,
    name: row.name,
    theme: row.theme,
    themeRank: row.themeRank,
    leaderRole: row.leaderRole,
    label,
    score: Number(score.toFixed(1)),
    limitState: row.limitState,
    price: row.price ?? null,
    pct: row.pct ?? null,
    turnover: row.turnover ?? null,
    volumeRatio: row.volumeRatio ?? null,
    emotionScore: row.emotionScore ?? null,
    todayScore: row.todayScore ?? null,
    inTodayPool: Boolean(row.inTodayPool),
    shouldHaveFlagged: Boolean(row.shouldHaveFlagged),
    historicalLimit: row.historicalLimit,
    catalyst: upsideCatalyst(row),
    risks: upsideRisk(row),
    nextAction: nextPoolAction(row),
  };
}

function nextPoolAction(row) {
  if (row.opening?.status?.startsWith("READY")) return "进入执行队列，先做 Paper dry-run 和限价预检";
  if (row.opening?.status === "WAIT_PULLBACK") return "等待回踩到买区，确认 3-5 分钟承接";
  if (row.limitState === "LIMIT_UP") return "记录封板质量，准备次日竞价/开板承接计划";
  if (["NEAR_LIMIT", "STRONG"].includes(row.limitState)) return "纳入盘中前排观察，先看主题扩散和承接";
  if (row.proof) return "历史涨停验证票，不能被普通风控剔除，等待新触发信号";
  if (row.inTodayPool || row.todayAction === "TRADE") return "按模型买区、止损和仓位规则跟踪";
  if (row.poolCategory === "THEME_FOLLOW") return "同主题跟踪，等待前排确认后再看补涨";
  if (row.poolCategory === "VOLUME_WATCH") return "量能异动观察，等待价格同步转强";
  return "保留在全池，不主动交易";
}

function categorySummary(rows) {
  return rows.reduce((acc, row) => {
    acc[row.poolCategory] = (acc[row.poolCategory] || 0) + 1;
    return acc;
  }, {});
}

function buildPlaybook(openingRows, radarRows, themeRows, limitProofRows, fullPoolRows) {
  const ready = openingRows.filter((row) => String(row.status).startsWith("READY"));
  const wait = openingRows.filter((row) => ["WAIT_PULLBACK", "POST_LIMIT_CONFIRM"].includes(row.status));
  const noBuy = openingRows.filter((row) => row.status.startsWith("NO_BUY"));
  const missed = radarRows.filter((row) => row.shouldHaveFlagged && !row.inTodayPool);
  const frontThemes = themeRows.filter((row) => ["ATTACK", "ACTIVE", "WATCH"].includes(row.state));
  const riskFalseNegatives = limitProofRows.filter((row) => row.modelFailureType === "RISK_FALSE_NEGATIVE");
  const categories = categorySummary(fullPoolRows);

  const steps = [];
  if (fullPoolRows.length) {
    steps.push(`已覆盖分析用户股票池 ${fullPoolRows.length} 只，先做全池分层，再看涨停/买点。`);
  }
  if (categories.MODEL_TRACK || categories.THEME_FOLLOW || categories.VOLUME_WATCH) {
    steps.push(`非涨停跟踪：模型跟踪 ${categories.MODEL_TRACK || 0} 只，主题跟随 ${categories.THEME_FOLLOW || 0} 只，量能观察 ${categories.VOLUME_WATCH || 0} 只。`);
  }
  if (limitProofRows.length) {
    steps.push(`用户票池历史验证已有 ${limitProofRows.length} 只涨停/近涨停，必须作为短线风格正样本。`);
  }
  if (riskFalseNegatives.length) {
    steps.push(`${riskFalseNegatives.length} 只历史涨停样本曾被风险项压低，短线雷达不能再直接按高波动/高换手剔除。`);
  }
  if (ready.length) {
    steps.push(`执行 ${ready.length} 只买区内候选，先做 dry-run 预检，单票按 maxPosition 降一档。`);
  } else {
    steps.push("没有买区内候选，不做市价追单。");
  }
  if (wait.length) steps.push(`等待 ${wait.length} 只候选回到买区，回踩后 3-5 分钟不破再评估。`);
  if (radarRows.length) steps.push(`涨停雷达跟踪前 ${Math.min(8, radarRows.length)} 只强势/近涨停票，区分今日交易和次日计划。`);
  if (missed.length) steps.push(`${missed.length} 只用户票池强势票未进主池，必须人工复核，不能被普通多因子直接剔除。`);
  if (frontThemes.length) steps.push(`主题只按 ${frontThemes.map((row) => `${row.theme}:${row.state}`).join("、")} 分层执行。`);
  if (noBuy.length) steps.push(`${noBuy.length} 只已触发放弃条件，不允许因为拉升重新追买。`);
  return steps;
}

async function main() {
  const watchlist = await readJson(path.join(dataDir, "latest-user-watchlist-review.json"), {});
  const attribution = await readJson(path.join(dataDir, "user-watchlist-attribution.json"), {});
  const themeFrontline = await readJson(path.join(dataDir, "latest-theme-frontline.json"), {});
  const opening = await readJson(path.join(dataDir, "latest-opening-confirmation.json"), {});
  const recommendation = await readJson(path.join(dataDir, "latest-quant-recommendation.json"), {});
  const signals = await readJson(path.join(dataDir, "latest-trading-signals.json"), {});

  const themeMap = themeFrontline.codeThemeMap || {};
  const openingRows = (Array.isArray(opening.rows) ? opening.rows : [])
    .map(normalizeOpeningRow)
    .sort((a, b) => executionRank(a.status) - executionRank(b.status));
  const openingMap = Object.fromEntries(openingRows.map((row) => [row.code, row]));
  const limitProofRows = (Array.isArray(attribution.rows) ? attribution.rows : [])
    .map(normalizeLimitProofRow)
    .filter((row) => row.limitDayCount > 0 || toNumber(row.futureMaxPct) >= 9.5)
    .sort((a, b) => historicalProofScore(b) - historicalProofScore(a));
  const proofMap = Object.fromEntries(limitProofRows.map((row) => [row.code, row]));
  const fullPoolRows = (Array.isArray(watchlist.rows) ? watchlist.rows : [])
    .map((row) => normalizeFullPoolRow(row, themeMap, proofMap, openingMap))
    .sort((a, b) => b.priorityScore - a.priorityScore);
  const upsideRadar = fullPoolRows
    .map(normalizeUpsideRow)
    .filter((row) => row.score >= 120 || row.shouldHaveFlagged || row.inTodayPool || ["LIMIT_UP", "NEAR_LIMIT", "STRONG"].includes(row.limitState))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  const radarRows = (Array.isArray(watchlist.rows) ? watchlist.rows : [])
    .map((row) => normalizeRadarRow(row, themeMap))
    .filter((row) => row.shouldHaveFlagged || row.inTodayPool || ["LIMIT_UP", "NEAR_LIMIT", "STRONG"].includes(row.limitState))
    .sort((a, b) => radarScore(b) - radarScore(a));
  const themeRows = Array.isArray(themeFrontline.themes) ? themeFrontline.themes : [];
  const phase = phaseFromOpening(opening.summary || {}, themeFrontline, radarRows);
  const missedRadar = radarRows.filter((row) => row.shouldHaveFlagged && !row.inTodayPool);
  const failureBreakdown = limitProofRows.reduce((acc, row) => {
    acc[row.modelFailureType] = (acc[row.modelFailureType] || 0) + 1;
    return acc;
  }, {});

  const payload = {
    generatedAt: new Date().toISOString(),
    status: phase,
    action: platformAction(phase),
    sources: {
      watchlistReview: "reports/data/latest-user-watchlist-review.json",
      themeFrontline: "reports/data/latest-theme-frontline.json",
      openingConfirmation: "reports/data/latest-opening-confirmation.json",
      recommendation: "reports/data/latest-quant-recommendation.json",
      tradingSignals: "reports/data/latest-trading-signals.json",
      watchlistAttribution: "reports/data/user-watchlist-attribution.json",
    },
    dataQuality: {
      watchlistGeneratedAt: watchlist.generatedAt || null,
      openingGeneratedAt: opening.generatedAt || null,
      openingQuoteGeneratedAt: opening.quoteGeneratedAt || null,
      themeGeneratedAt: themeFrontline.generatedAt || null,
      recommendationGeneratedAt: recommendation.generatedAt || null,
      quoteSource: opening.quoteSource || watchlist.dataQuality?.quoteSource || null,
      fallbackUsed: Boolean(opening.dataQuality?.fallbackUsed),
      liveBuyAllowed: Boolean(recommendation.liveBuyAllowed),
    },
    summary: {
      ready: toNumber(opening.summary?.ready),
      wait: toNumber(opening.summary?.wait),
      noBuy: toNumber(opening.summary?.noBuy),
      radar: radarRows.length,
      limitOrNearLimit: radarRows.filter((row) => ["LIMIT_UP", "NEAR_LIMIT"].includes(row.limitState)).length,
      strong: radarRows.filter((row) => row.limitState === "STRONG").length,
      missed: missedRadar.length,
      attackThemes: toNumber(themeFrontline.summary?.attack),
      activeThemes: toNumber(themeFrontline.summary?.active),
      watchThemes: toNumber(themeFrontline.summary?.watch),
      fullPool: fullPoolRows.length,
      executionReadyPool: fullPoolRows.filter((row) => row.poolCategory === "EXECUTION_READY").length,
      executionWaitPool: fullPoolRows.filter((row) => row.poolCategory === "EXECUTION_WAIT").length,
      modelTrackPool: fullPoolRows.filter((row) => row.poolCategory === "MODEL_TRACK").length,
      themeFollowPool: fullPoolRows.filter((row) => row.poolCategory === "THEME_FOLLOW").length,
      volumeWatchPool: fullPoolRows.filter((row) => row.poolCategory === "VOLUME_WATCH").length,
      basePool: fullPoolRows.filter((row) => row.poolCategory === "POOL_BASE").length,
      historicalLimitHits: limitProofRows.length,
      historicalLimitDays: limitProofRows.reduce((sum, row) => sum + toNumber(row.limitDayCount), 0),
      riskFalseNegatives: toNumber(failureBreakdown.RISK_FALSE_NEGATIVE),
      styleNotPromoted: toNumber(failureBreakdown.STYLE_NOT_PROMOTED),
      signalNotEscalated: toNumber(failureBreakdown.SIGNAL_NOT_ESCALATED),
    },
    marketGate: themeFrontline.marketGate || null,
    playbook: buildPlaybook(openingRows, radarRows, themeRows, limitProofRows, fullPoolRows),
    upsideRadar,
    fullPoolAnalysis: fullPoolRows,
    fullPoolCategorySummary: categorySummary(fullPoolRows),
    executionQueue: {
      ready: openingRows.filter((row) => String(row.status).startsWith("READY")),
      wait: openingRows.filter((row) => ["WAIT_PULLBACK", "POST_LIMIT_CONFIRM"].includes(row.status)),
      blocked: openingRows.filter((row) => row.status.startsWith("NO_BUY") || row.status === "WATCH_THEME_WEAK"),
    },
    emotionRadar: radarRows.slice(0, 30),
    missedRadar,
    historicalLimitProof: limitProofRows,
    styleCalibration: {
      totalWatchlist: attribution.summary?.total ?? null,
      localLimitHits: attribution.summary?.localLimitHits ?? limitProofRows.length,
      hitRatePct:
        toNumber(attribution.summary?.total) > 0
          ? Number(((limitProofRows.length / toNumber(attribution.summary.total)) * 100).toFixed(2))
          : null,
      failureBreakdown,
      requiredModelChange: [
        "用户票池先进入短线情绪雷达，再进入普通多因子排序。",
        "高换手、大幅波动、ST、字段不完整只能降仓或标记风险，不能直接剔除涨停风格样本。",
        "Q1/Q2 且后续涨停的样本必须升格为涨停风格正样本，用于次日承接计划。",
      ],
    },
    themeLadder: themeRows.slice(0, 8).map((row) => ({
      theme: row.theme,
      rank: row.rank,
      state: row.state,
      tradeGate: row.tradeGate,
      positionScale: row.positionScale,
      heatScore: row.heatScore,
      supports: row.supports || [],
      risks: row.risks || [],
      leaders: row.leaders || [],
    })),
    modelSeparation: {
      emotionLayer: "识别涨停、近涨停、强势扩散、用户票池漏判，不直接给买点。",
      executionLayer: "只处理买区、止损、仓位、主题闸门和不买条件。",
      riskLayer: "只负责降仓、否决和复盘，不能覆盖情绪雷达事实。",
    },
    rawCounts: {
      recommendationTrade: Array.isArray(recommendation.recommendedBuys) ? recommendation.recommendedBuys.length : 0,
      signalTrade: Array.isArray(signals.trade) ? signals.trade.length : 0,
      signalWatch: Array.isArray(signals.watch) ? signals.watch.length : 0,
    },
  };

  await atomicWriteJson(outputPath, payload);
  console.log(
    `trade workbench: status=${payload.status} ready=${payload.summary.ready} wait=${payload.summary.wait} radar=${payload.summary.radar} missed=${payload.summary.missed}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
