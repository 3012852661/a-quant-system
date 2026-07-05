import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const quantRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(quantRoot, "..");
const dataDir = path.join(repoRoot, "reports/data");
const watchlistPath = path.join(dataDir, "latest-user-watchlist-review.json");
const openLimitPath = path.join(dataDir, "latest-open-limit-watch.json");
const recommendationPath = path.join(dataDir, "latest-quant-recommendation.json");
const outputPath = path.join(dataDir, "latest-theme-frontline.json");

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

function splitThemes(value) {
  return String(value || "")
    .split(/[、,，/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function classifyTheme(theme) {
  const heat = toNumber(theme.heatScore);
  const limitCount = toNumber(theme.limitCount);
  const nearLimitCount = toNumber(theme.nearLimitCount);
  const strongCount = toNumber(theme.strongCount);
  const flaggedCount = toNumber(theme.flaggedCount);
  const missedCount = toNumber(theme.missedCount);
  const frontCount = limitCount + nearLimitCount;
  const missedRatio = flaggedCount > 0 ? missedCount / flaggedCount : 0;

  let state = "COOLING";
  if (heat >= 120 && frontCount >= 2 && strongCount >= 5) state = "ATTACK";
  else if (heat >= 60 && (limitCount >= 1 || strongCount >= 3)) state = "ACTIVE";
  else if (heat >= 25 && (limitCount >= 1 || strongCount >= 1 || flaggedCount >= 3)) state = "WATCH";

  let tradeGate = "BLOCK_BUY";
  let positionScale = 0;
  if (state === "ATTACK") {
    tradeGate = missedRatio >= 0.65 ? "REDUCE" : "ALLOW";
    positionScale = missedRatio >= 0.65 ? 0.6 : 1;
  } else if (state === "ACTIVE") {
    tradeGate = missedRatio >= 0.75 ? "REDUCE" : "ALLOW";
    positionScale = missedRatio >= 0.75 ? 0.5 : 0.8;
  } else if (state === "WATCH") {
    tradeGate = "REDUCE";
    positionScale = 0.4;
  }

  const risks = [];
  if (frontCount === 0) risks.push("没有涨停/近涨停前排，主动进攻不足");
  if (missedRatio >= 0.6) risks.push(`强势扩散漏判较多，分化率 ${(missedRatio * 100).toFixed(0)}%`);
  if (strongCount === 0 && state !== "COOLING") risks.push("强势梯队不足，持续性需要开盘确认");
  if (state === "COOLING") risks.push("主题热度不足，不能作为主动买入主线");

  const supports = [];
  if (limitCount > 0) supports.push(`${limitCount} 只涨停`);
  if (nearLimitCount > 0) supports.push(`${nearLimitCount} 只近涨停`);
  if (strongCount > 0) supports.push(`${strongCount} 只强势股`);
  if (heat >= 100) supports.push(`热度 ${heat}`);

  return {
    state,
    tradeGate,
    positionScale,
    frontCount,
    missedRatio,
    supports,
    risks,
  };
}

function buildThemeMembers(rows) {
  const groups = new Map();
  for (const row of rows) {
    const themes = splitThemes(row.theme || row.primaryTheme || "其他");
    for (const theme of themes) {
      if (!groups.has(theme)) groups.set(theme, []);
      groups.get(theme).push(row);
    }
  }
  return groups;
}

function themeRow(theme, membersByTheme) {
  const classified = classifyTheme(theme);
  const members = membersByTheme.get(theme.theme) || [];
  const leaders = Array.isArray(theme.leaders) ? theme.leaders : [];
  const strongMembers = members
    .filter((row) => ["LIMIT_UP", "NEAR_LIMIT", "STRONG"].includes(String(row.limitState || "")) || row.shouldHaveFlagged)
    .sort((a, b) => toNumber(b.emotionScore) - toNumber(a.emotionScore))
    .slice(0, 12)
    .map((row) => ({
      code: codeOf(row),
      name: row.name || "",
      pct: toNumber(row.pct),
      limitState: row.limitState || "NORMAL",
      leaderRole: row.leaderRole || "",
      inTodayPool: Boolean(row.inTodayPool),
      decision: row.decision || "",
      nextAction: row.nextAction || "",
    }));

  return {
    theme: theme.theme,
    rank: 0,
    state: classified.state,
    tradeGate: classified.tradeGate,
    positionScale: classified.positionScale,
    heatScore: toNumber(theme.heatScore),
    total: toNumber(theme.total),
    limitCount: toNumber(theme.limitCount),
    nearLimitCount: toNumber(theme.nearLimitCount),
    strongCount: toNumber(theme.strongCount),
    flaggedCount: toNumber(theme.flaggedCount),
    missedCount: toNumber(theme.missedCount),
    frontCount: classified.frontCount,
    missedRatio: Number(classified.missedRatio.toFixed(3)),
    supports: classified.supports,
    risks: classified.risks,
    leaders: leaders.map((leader) => ({
      rank: leader.rank,
      code: codeOf(leader),
      name: leader.name || "",
      pct: toNumber(leader.pct),
      limitState: leader.limitState || "",
      emotionScore: toNumber(leader.emotionScore),
    })),
    strongMembers,
    executionRule:
      classified.tradeGate === "ALLOW"
        ? "可按个股买区执行，但必须确认前排不炸板"
        : classified.tradeGate === "REDUCE"
          ? "只允许低仓位分歧承接，不允许开盘追价"
          : "不作为主动买入主线，只观察",
  };
}

function marketGate(themes, openLimitWatch) {
  const attack = themes.filter((item) => item.state === "ATTACK").length;
  const active = themes.filter((item) => item.state === "ACTIVE").length;
  const frontCount = themes.reduce((sum, item) => sum + item.frontCount, 0);
  const top = themes[0];
  const marketState = openLimitWatch?.marketState || {};

  if (attack > 0 && frontCount >= 3) {
    return {
      status: "RISK_ON",
      positionScale: top?.tradeGate === "REDUCE" ? 0.7 : 1,
      reason: `存在 ${attack} 条进攻主线，前排数量 ${frontCount}`,
      sourceMarketState: marketState,
    };
  }
  if (attack + active > 0) {
    return {
      status: "RISK_NEUTRAL",
      positionScale: 0.65,
      reason: `有活跃主线但前排宽度不足，优先低吸核心`,
      sourceMarketState: marketState,
    };
  }
  return {
    status: "RISK_OFF",
    positionScale: 0.3,
    reason: "没有可确认进攻主线，禁止主动追高",
    sourceMarketState: marketState,
  };
}

function recommendationCodes(recommendation) {
  const buckets = ["recommendedBuys", "watchPlan", "qualityRadar"];
  const map = new Map();
  for (const bucket of buckets) {
    for (const row of Array.isArray(recommendation?.[bucket]) ? recommendation[bucket] : []) {
      const code = codeOf(row);
      if (!code || map.has(code)) continue;
      map.set(code, {
        bucket,
        action: row.action || "",
        recommendationType: row.recommendation_type || row.recommendationType || "",
        score: row.score,
        buyZone: row.buy_zone,
        stopLoss: row.stop_loss,
      });
    }
  }
  return map;
}

async function main() {
  const watchlist = await readJson(watchlistPath, {});
  const openLimitWatch = await readJson(openLimitPath, {});
  const recommendation = await readJson(recommendationPath, {});
  const themeBreadth = Array.isArray(watchlist.themeBreadth) ? watchlist.themeBreadth : [];
  const rows = Array.isArray(watchlist.rows) ? watchlist.rows : [];
  if (!themeBreadth.length) throw new Error("latest-user-watchlist-review.json 没有 themeBreadth，无法生成主题前排监控");

  const membersByTheme = buildThemeMembers(rows);
  const recommendationByCode = recommendationCodes(recommendation);
  const themes = themeBreadth
    .map((item) => themeRow(item, membersByTheme))
    .sort((a, b) => b.heatScore - a.heatScore)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const themeByName = new Map(themes.map((theme) => [theme.theme, theme]));
  const codeThemeMap = {};

  for (const row of rows) {
    const code = codeOf(row);
    if (!code) continue;
    const primaryTheme = row.primaryTheme || splitThemes(row.theme)[0] || "其他";
    const theme = themeByName.get(primaryTheme) || themeByName.get("其他") || null;
    codeThemeMap[code] = {
      code,
      name: row.name || "",
      primaryTheme,
      themeRank: theme?.rank ?? row.themeRank ?? null,
      themeState: theme?.state || "UNKNOWN",
      themeTradeGate: theme?.tradeGate || "REDUCE",
      themePositionScale: theme?.positionScale ?? 0.5,
      leaderRole: row.leaderRole || "",
      limitState: row.limitState || "",
      pct: toNumber(row.pct),
      inTodayPool: Boolean(row.inTodayPool),
      recommendation: recommendationByCode.get(code) || null,
    };
  }

  const gate = marketGate(themes, openLimitWatch);
  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      watchlistReview: "reports/data/latest-user-watchlist-review.json",
      openLimitWatch: "reports/data/latest-open-limit-watch.json",
      recommendation: "reports/data/latest-quant-recommendation.json",
    },
    dataQuality: {
      watchlistGeneratedAt: watchlist.generatedAt || null,
      openLimitGeneratedAt: openLimitWatch.generatedAt || null,
      recommendationGeneratedAt: recommendation.generatedAt || null,
      watchlistQuoteSource: watchlist.dataQuality?.quoteSource || null,
      watchlistIsStale: Boolean(watchlist.dataQuality?.isStale),
      themeCount: themes.length,
      mappedCodes: Object.keys(codeThemeMap).length,
    },
    marketGate: gate,
    summary: {
      attack: themes.filter((item) => item.state === "ATTACK").length,
      active: themes.filter((item) => item.state === "ACTIVE").length,
      watch: themes.filter((item) => item.state === "WATCH").length,
      cooling: themes.filter((item) => item.state === "COOLING").length,
      allow: themes.filter((item) => item.tradeGate === "ALLOW").length,
      reduce: themes.filter((item) => item.tradeGate === "REDUCE").length,
      block: themes.filter((item) => item.tradeGate === "BLOCK_BUY").length,
    },
    themes,
    codeThemeMap,
    executionRules: [
      "只有 ATTACK/ACTIVE 主线允许按买区执行；WATCH 主线只允许低仓位承接；COOLING 主线不主动买。",
      "任何候选若所属主线 tradeGate=BLOCK_BUY，即使个股进入买区，也降级为观察或放弃。",
      "前排龙头炸板、近涨停回落或强势股掉队时，positionScale 至少降半档。",
    ],
  };

  await atomicWriteJson(outputPath, payload);
  console.log(
    `theme frontline: attack=${payload.summary.attack} active=${payload.summary.active} watch=${payload.summary.watch} cooling=${payload.summary.cooling} gate=${payload.marketGate.status}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
