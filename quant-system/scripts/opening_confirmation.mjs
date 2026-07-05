import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const quantRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(quantRoot, "..");
const dataDir = path.join(repoRoot, "reports/data");
const recommendationPath = path.join(dataDir, "latest-quant-recommendation.json");
const staleQuotePath = path.join(dataDir, "live-tencent-candidate-quotes.json");
const themeFrontlinePath = path.join(dataDir, "latest-theme-frontline.json");
const outputPath = path.join(dataDir, "latest-opening-confirmation.json");

function marketPrefix(code) {
  return String(code).startsWith("6") || String(code).startsWith("9") ? "sh" : "sz";
}

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

function pctChange(price, base) {
  return base > 0 ? ((price - base) / base) * 100 : 0;
}

function parseBuyZone(value) {
  const match = String(value || "").match(/([\d.]+)\s*[-~至]\s*([\d.]+)/);
  if (!match) return { raw: value || "", lower: 0, upper: 0 };
  return { raw: value || "", lower: Number(match[1]), upper: Number(match[2]) };
}

function parseTencentRows(text, nameByCode) {
  return text
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const value = item.split("=", 2)[1]?.replace(/^"|"$/g, "") || "";
      const parts = value.split("~");
      const code = String(parts[2] || "").padStart(6, "0");
      return {
        code,
        name: nameByCode.get(code) || parts[1] || "",
        price: Number(parts[3] || 0),
        pct: Number(parts[32] || 0),
        change: Number(parts[31] || 0),
        turnover: Number(parts[38] || 0),
        amountYi: Number(parts[37] || 0) / 10000,
        totalMvYi: Number(parts[45] || 0),
        floatMvYi: Number(parts[44] || 0),
        volumeRatio: Number(parts[49] || 0),
        prevClose: Number(parts[4] || 0),
        open: Number(parts[5] || 0),
        high: Number(parts[33] || 0),
        low: Number(parts[34] || 0),
        time: parts[30] || "",
      };
    })
    .filter((row) => row.code && row.price > 0 && row.time);
}

async function fetchTencentQuotes(rows) {
  const nameByCode = new Map(rows.map((item) => [item.code, item.name]));
  const quotes = [];
  for (let index = 0; index < rows.length; index += 55) {
    const chunk = rows.slice(index, index + 55);
    const query = chunk.map((item) => `${marketPrefix(item.code)}${item.code}`).join(",");
    const response = await fetch(`https://qt.gtimg.cn/q=${query}`);
    if (!response.ok) throw new Error(`腾讯实时接口失败：HTTP ${response.status}`);
    const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
    quotes.push(...parseTencentRows(text, nameByCode));
  }
  return {
    source: "Tencent qt.gtimg.cn",
    generatedAt: new Date().toISOString(),
    rows: quotes,
  };
}

async function loadFallbackQuotes() {
  const payload = await readJson(staleQuotePath, {});
  return {
    source: payload.source ? `${payload.source} stale-fallback` : "stale-fallback",
    generatedAt: payload.generatedAt || null,
    rows: Array.isArray(payload.rows) ? payload.rows : [],
  };
}

function normalizeTheme(row) {
  if (row.theme && typeof row.theme === "object") return row.theme;
  return {
    primary: row.primary_theme || "",
    rank: row.theme_rank ?? null,
    heatScore: row.theme_heat_score ?? null,
    leaderRole: row.theme_leader_role || "",
  };
}

function enrichTheme(theme, themeGate) {
  if (!themeGate) return theme;
  return {
    ...theme,
    primary: theme.primary || themeGate.primaryTheme || "",
    rank: theme.rank ?? themeGate.themeRank ?? null,
    leaderRole: theme.leaderRole || themeGate.leaderRole || "",
    state: themeGate.themeState || "UNKNOWN",
    tradeGate: themeGate.themeTradeGate || "REDUCE",
    positionScale: themeGate.themePositionScale ?? null,
  };
}

function normalizeConfirmation(row) {
  if (row.openingConfirmation && typeof row.openingConfirmation === "object") return row.openingConfirmation;
  const type = String(row.recommendation_type || row.recommendationType || "").toUpperCase();
  const execution = String(row.execution_status || row.execution?.status || "").toUpperCase();
  const status =
    row.confirmation_status ||
    (type === "LIMIT_REVIEW" || execution === "BLOCKED_LIMIT_UP"
      ? "POST_LIMIT_CONFIRM"
      : row.action === "TRADE"
        ? "THEME_OPEN_CONFIRM"
        : "WATCH_CONFIRM");
  return {
    status,
    previousOpenPct: row.open_pct ?? null,
    previousHighFadePct: row.high_fade_pct ?? null,
    checklist: Array.isArray(row.opening_checklist) ? row.opening_checklist : row.entry_conditions || [],
    noBuyConditions: Array.isArray(row.no_buy_conditions) ? row.no_buy_conditions : row.invalidation_conditions || [],
  };
}

function collectCandidates(recommendation) {
  const buckets = [
    ["recommendedBuys", "首选"],
    ["watchPlan", "观察"],
    ["qualityRadar", "雷达"],
  ];
  const seen = new Set();
  const rows = [];
  for (const [bucket, bucketLabel] of buckets) {
    const sourceRows = Array.isArray(recommendation?.[bucket]) ? recommendation[bucket] : [];
    for (const row of sourceRows) {
      const code = String(row.code || "").replace(/\D/g, "").padStart(6, "0");
      if (!code || seen.has(code)) continue;
      seen.add(code);
      rows.push({
        ...row,
        code,
        name: String(row.name || ""),
        bucket,
        bucketLabel,
        theme: normalizeTheme(row),
        openingConfirmation: normalizeConfirmation(row),
      });
    }
  }
  return rows;
}

function maxPosition(row) {
  const text = `${row.position_hint || ""} ${row.risk_level || ""}`;
  const match = text.match(/(\d+(?:\.\d+)?)%/);
  if (match) return `${match[1]}%`;
  if (row.risk_level === "高") return "3%-5%";
  return "10%";
}

function decide(row, quote) {
  if (!quote) {
    return {
      status: "DATA_MISSING",
      label: "缺行情",
      orderStyle: "不下单",
      reason: "没有实时行情，不能做开盘执行判断",
    };
  }

  const buyZone = parseBuyZone(row.buy_zone);
  const stopLoss = toNumber(row.stop_loss);
  const price = toNumber(quote.price);
  const pct = toNumber(quote.pct);
  const openPct = pctChange(toNumber(quote.open), toNumber(quote.prevClose));
  const highFadePct = toNumber(quote.high) > 0 ? ((toNumber(quote.high) - price) / toNumber(quote.high)) * 100 : 0;
  const volumeRatio = toNumber(quote.volumeRatio);
  const type = String(row.recommendation_type || row.recommendationType || "").toUpperCase();
  const execution = String(row.execution_status || row.execution?.status || "").toUpperCase();
  const blockedLimit = type === "LIMIT_REVIEW" || execution === "BLOCKED_LIMIT_UP";

  if (stopLoss > 0 && price <= stopLoss) {
    return {
      status: "NO_BUY_STOP_BROKEN",
      label: "放弃",
      orderStyle: "不下单",
      reason: `现价 ${price.toFixed(2)} 已跌破止损 ${stopLoss.toFixed(2)}`,
    };
  }

  if (openPct >= 3 && pct < openPct && highFadePct >= 2.2) {
    return {
      status: "NO_BUY_HIGH_OPEN_FADE",
      label: "放弃",
      orderStyle: "不下单",
      reason: `高开 ${openPct.toFixed(1)}% 后回落 ${highFadePct.toFixed(1)}%，不追`,
    };
  }

  if (highFadePct >= 3.5 && volumeRatio >= 2.5) {
    return {
      status: "NO_BUY_VOLUME_FADE",
      label: "放弃",
      orderStyle: "不下单",
      reason: `冲高回落 ${highFadePct.toFixed(1)}% 且量比 ${volumeRatio.toFixed(1)}，分歧加重`,
    };
  }

  if (blockedLimit) {
    if (buyZone.lower > 0 && price >= buyZone.lower && price <= buyZone.upper && highFadePct < 2.5) {
      return {
        status: "READY_POST_LIMIT_PULLBACK",
        label: "小仓试错",
        orderStyle: "买区限价",
        reason: "涨停后进入买区且回落可控，只能按承接试错",
      };
    }
    return {
      status: "POST_LIMIT_CONFIRM",
      label: "观察不追",
      orderStyle: "等回踩",
      reason: "涨停/近涨停票先看开板承接，未进入买区不追",
    };
  }

  if (buyZone.lower > 0 && price >= buyZone.lower && price <= buyZone.upper && pct >= -1 && highFadePct < 2.8) {
    return {
      status: "READY_TO_BUY",
      label: "可执行",
      orderStyle: "买区限价",
      reason: `现价 ${price.toFixed(2)} 在买区 ${buyZone.raw} 内，未触发冲高回落否决`,
    };
  }

  if (buyZone.upper > 0 && price > buyZone.upper) {
    return {
      status: "WAIT_PULLBACK",
      label: "等回踩",
      orderStyle: "不追价",
      reason: `现价 ${price.toFixed(2)} 高于买区上沿 ${buyZone.upper.toFixed(2)}`,
    };
  }

  if (buyZone.lower > 0 && price < buyZone.lower) {
    return {
      status: "WAIT_RECOVER_BUY_ZONE",
      label: "等收回",
      orderStyle: "不下单",
      reason: `现价 ${price.toFixed(2)} 低于买区下沿 ${buyZone.lower.toFixed(2)}，先看能否收回`,
    };
  }

  return {
    status: "WATCH_CONFIRM",
    label: "观察",
    orderStyle: "等待确认",
    reason: "买区或确认条件不足，继续观察盘口承接",
  };
}

function applyThemeGate(decision, themeGate) {
  if (!themeGate) return decision;
  const tradeGate = String(themeGate.themeTradeGate || "").toUpperCase();
  const themeState = themeGate.themeState || "UNKNOWN";
  const primaryTheme = themeGate.primaryTheme || "未知主线";
  const positionScale = toNumber(themeGate.themePositionScale, 0.5);
  const isReady = String(decision.status || "").startsWith("READY");

  if (isReady && tradeGate === "BLOCK_BUY") {
    return {
      status: "NO_BUY_THEME_WEAK",
      label: "主线弱放弃",
      orderStyle: "不下单",
      reason: `${primaryTheme} 当前为 ${themeState}，主题闸门禁止主动买入`,
      maxPosition: "0%",
      themePositionScale: 0,
    };
  }
  if (isReady && tradeGate === "REDUCE") {
    return {
      ...decision,
      status: "READY_REDUCED_POSITION",
      label: "小仓确认",
      reason: `${decision.reason}；但 ${primaryTheme} 为 ${themeState}，只能降仓承接`,
      themePositionScale: positionScale,
    };
  }
  if (tradeGate === "BLOCK_BUY" && ["WAIT_PULLBACK", "WAIT_RECOVER_BUY_ZONE", "WATCH_CONFIRM"].includes(decision.status)) {
    return {
      ...decision,
      status: "WATCH_THEME_WEAK",
      label: "主线弱观察",
      reason: `${decision.reason}；${primaryTheme} 当前为 ${themeState}，未转强前不主动买`,
      themePositionScale: 0,
    };
  }
  return {
    ...decision,
    themePositionScale: positionScale,
  };
}

function decisionRank(status) {
  if (status === "READY_TO_BUY") return 1;
  if (status === "READY_REDUCED_POSITION" || status === "READY_POST_LIMIT_PULLBACK") return 2;
  if (status === "WAIT_PULLBACK" || status === "POST_LIMIT_CONFIRM") return 3;
  if (status === "WAIT_RECOVER_BUY_ZONE" || status === "WATCH_CONFIRM") return 4;
  if (status === "DATA_MISSING") return 8;
  return 9;
}

function summarize(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.decision.status.startsWith("READY")) acc.ready += 1;
      else if (row.decision.status.startsWith("WAIT") || row.decision.status === "POST_LIMIT_CONFIRM") acc.wait += 1;
      else if (row.decision.status === "DATA_MISSING") acc.dataMissing += 1;
      else acc.noBuy += 1;
      return acc;
    },
    { total: 0, ready: 0, wait: 0, noBuy: 0, dataMissing: 0 },
  );
}

async function main() {
  const recommendation = await readJson(recommendationPath, {});
  const themeFrontline = await readJson(themeFrontlinePath, {});
  const candidates = collectCandidates(recommendation);
  if (!candidates.length) throw new Error("latest-quant-recommendation.json 没有可确认候选");

  let quotePayload;
  let fetchError = "";
  try {
    quotePayload = await fetchTencentQuotes(candidates);
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
    quotePayload = await loadFallbackQuotes();
  }

  const quoteByCode = new Map((quotePayload.rows || []).map((row) => [String(row.code || "").padStart(6, "0"), row]));
  const themeByCode = themeFrontline?.codeThemeMap && typeof themeFrontline.codeThemeMap === "object" ? themeFrontline.codeThemeMap : {};
  const rows = candidates
    .map((row) => {
      const quote = quoteByCode.get(row.code);
      const themeGate = themeByCode[row.code] || null;
      const decision = applyThemeGate(decide(row, quote), themeGate);
      const previousClose = toNumber(quote?.prevClose);
      const price = toNumber(quote?.price);
      const quoteBlock = quote
        ? {
            price,
            pct: toNumber(quote.pct),
            open: toNumber(quote.open),
            openPct: pctChange(toNumber(quote.open), previousClose),
            high: toNumber(quote.high),
            low: toNumber(quote.low),
            highFadePct: toNumber(quote.high) > 0 ? ((toNumber(quote.high) - price) / toNumber(quote.high)) * 100 : 0,
            turnover: toNumber(quote.turnover),
            volumeRatio: toNumber(quote.volumeRatio),
            prevClose: previousClose,
            time: quote.time || "",
          }
        : null;
      return {
        bucket: row.bucket,
        bucketLabel: row.bucketLabel,
        code: row.code,
        name: row.name,
        action: row.action,
        recommendationType: row.recommendation_type || row.recommendationType || "",
        executionStatus: row.execution_status || row.execution?.status || "",
        riskLevel: row.risk_level || "",
        score: row.score,
        theme: enrichTheme(row.theme, themeGate),
        themeGate: themeGate
          ? {
              state: themeGate.themeState,
              tradeGate: themeGate.themeTradeGate,
              positionScale: themeGate.themePositionScale,
              leaderRole: themeGate.leaderRole,
              limitState: themeGate.limitState,
            }
          : null,
        buyZone: parseBuyZone(row.buy_zone),
        stopLoss: row.stop_loss,
        targetPrice: row.target_price,
        positionHint: row.position_hint,
        maxPosition: maxPosition(row),
        openingConfirmation: row.openingConfirmation,
        quote: quoteBlock,
        decision: {
          ...decision,
          maxPosition: decision.maxPosition || maxPosition(row),
        },
      };
    })
    .sort((a, b) => decisionRank(a.decision.status) - decisionRank(b.decision.status) || Number(b.score || 0) - Number(a.score || 0));

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceRecommendation: "reports/data/latest-quant-recommendation.json",
    sourceThemeFrontline: "reports/data/latest-theme-frontline.json",
    quoteSource: quotePayload.source,
    quoteGeneratedAt: quotePayload.generatedAt,
    fetchError: fetchError || null,
    dataQuality: {
      liveQuote: !fetchError,
      fallbackUsed: Boolean(fetchError),
      sourceRecommendationGeneratedAt: recommendation.generatedAt || null,
      themeFrontlineGeneratedAt: themeFrontline.generatedAt || null,
      marketGate: themeFrontline.marketGate || null,
      recommendationStatus: recommendation.status || null,
    },
    summary: summarize(rows),
    rows,
  };

  await atomicWriteJson(outputPath, payload);
  console.log(
    `opening confirmation: ready=${payload.summary.ready} wait=${payload.summary.wait} noBuy=${payload.summary.noBuy} missing=${payload.summary.dataMissing}`,
  );
  if (fetchError) console.error(`live quote fallback used: ${fetchError}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
