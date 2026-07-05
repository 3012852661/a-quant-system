import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const quantRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(quantRoot, "..");
const outputPath = path.join(repoRoot, "reports/data/latest-user-watchlist-review.json");

function marketPrefix(code) {
  return String(code).startsWith("6") || String(code).startsWith("9") ? "sh" : "sz";
}

function todayCn() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function tencentTradeDate(value = "") {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
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

function normalizeWatchlist(payload) {
  const rows = Array.isArray(payload?.stocks) ? payload.stocks : Array.isArray(payload?.rows) ? payload.rows : [];
  const seen = new Set();
  return rows
    .map((row) => ({
      code: String(row.code || row["股票代码"] || "").replace(/\D/g, "").padStart(6, "0"),
      name: String(row.name || row.trueName || row["股票名称"] || "").trim(),
      theme: String(row.theme || "").trim(),
    }))
    .filter((row) => row.code && !seen.has(row.code) && seen.add(row.code));
}

async function readWatchlist() {
  const configured = normalizeWatchlist(await readJson(path.join(repoRoot, "reports/data/user-watchlist.json"), {}));
  if (configured.length) return { source: "reports/data/user-watchlist.json", rows: configured };
  const attribution = normalizeWatchlist(await readJson(path.join(repoRoot, "reports/data/user-watchlist-attribution.json"), {}));
  return { source: "reports/data/user-watchlist-attribution.json", rows: attribution };
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

async function fetchTencentQuotes(watchlist) {
  const nameByCode = new Map(watchlist.map((item) => [item.code, item.name]));
  const rows = [];
  for (let index = 0; index < watchlist.length; index += 55) {
    const chunk = watchlist.slice(index, index + 55);
    const query = chunk.map((item) => `${marketPrefix(item.code)}${item.code}`).join(",");
    const response = await fetch(`https://qt.gtimg.cn/q=${query}`);
    if (!response.ok) throw new Error(`腾讯实时接口失败：HTTP ${response.status}`);
    const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
    rows.push(...parseTencentRows(text, nameByCode));
  }
  return rows;
}

function inferTheme(row) {
  const text = `${row.name || ""} ${row.theme || ""}`;
  const tags = [];
  if (/电力|华能|华电|风电|能源|新能|西电|电缆|电瓷|光伏|中环|三峡/.test(text)) tags.push("电力/新能源/电网");
  if (/半导体|先进封装|HBM|玻璃基板|Chiplet|芯|微|PCB|电子|通信|光电|科技|君正|兆易|长电|通富|华天|沪电|鹏鼎|京东方|TCL|网宿|烽火|中京|兴森|晶方|深科技|太极实业/.test(text)) {
    tags.push("半导体/PCB/通信算力");
  }
  if (/新型显示|OLED|Mini.?LED|Micro.?LED|消费电子|面板|京东方|TCL|木林森|深科技/.test(text)) tags.push("新型显示/消费电子");
  if (/铜|铝|稀土|矿业|钽|锗|有研|金田|北方/.test(text)) tags.push("有色/小金属");
  if (/机器人|智能|汽车|动力|拓普|三花|潍柴|徐工|中大力德|巨轮/.test(text)) tags.push("机器人/汽车链");
  if (/传媒|广告|在线|互联|省广|引力|天地/.test(text)) tags.push("传媒互联网");
  if (/ST|退|皇庭|雅博|洲际/.test(text)) tags.push("ST/困境反转");
  return tags.length ? tags.join("、") : "其他";
}

function limitThreshold(code, name) {
  if (/ST|\*ST/.test(name || "")) return 5;
  if (/^(30|68)/.test(String(code))) return 20;
  return 10;
}

async function klineStats(code, tradeDate) {
  const payload = await readJson(path.join(repoRoot, "reports/data/kline-cache", `${code}.daily.json`), {});
  const klines = Array.isArray(payload.klines) ? payload.klines : [];
  const latest = klines.at(-1);
  const recent = klines.filter((item) => String(item.date || "") >= tradeDate).slice(-10);
  return {
    source: payload.source || null,
    generatedAt: payload.generatedAt || null,
    latestDate: latest?.date || null,
    recentMaxPct: recent.reduce((max, item, index) => {
      if (index === 0) return max;
      const prev = Number(recent[index - 1]?.close || 0);
      const close = Number(item.close || 0);
      return prev > 0 ? Math.max(max, ((close - prev) / prev) * 100) : max;
    }, null),
    missing: !klines.length,
  };
}

function scoreEmotion(row, themeBreadth) {
  let score = 0;
  const pct = Number(row.pct || 0);
  const vr = Number(row.volumeRatio || 0);
  const turnover = Number(row.turnover || 0);
  if (pct >= 9) score += 42;
  else if (pct >= 7) score += 32;
  else if (pct >= 5) score += 24;
  else if (pct >= 3) score += 15;
  if (vr >= 3) score += 22;
  else if (vr >= 2) score += 15;
  else if (vr >= 1.3) score += 8;
  if (turnover >= 10) score += 12;
  else if (turnover >= 5) score += 8;
  else if (turnover >= 3) score += 4;
  if (themeBreadth >= 10) score += 18;
  else if (themeBreadth >= 6) score += 12;
  else if (themeBreadth >= 3) score += 6;
  return Math.min(100, score);
}

function limitPriority(row) {
  if (row.limitState === "LIMIT_UP") return 5;
  if (row.limitState === "NEAR_LIMIT") return 4;
  if (row.limitState === "STRONG") return 3;
  if (row.shouldHaveFlagged) return 2;
  if (row.inTodayPool) return 1;
  return 0;
}

function leaderScore(row) {
  return (
    limitPriority(row) * 1000 +
    Number(row.emotionScore || 0) * 10 +
    Number(row.pct || 0) * 3 +
    Math.min(Number(row.turnover || 0), 30) +
    Math.min(Number(row.amountYi || 0), 100) * 0.08
  );
}

function nextAction(row) {
  if (row.limitState === "LIMIT_UP") return "不追板；记录封板质量，次日看竞价强弱和开板承接";
  if (row.limitState === "NEAR_LIMIT") return "不追高；只看能否放量回封或回踩不破分时均线";
  if (row.limitState === "STRONG") return "可加入盘中观察；回踩承接优先，放量冲高不追";
  if (row.inTodayPool) return "按主模型买区、止损和仓位规则执行";
  return "普通跟踪";
}

function buildThemeLadder(rows) {
  const groups = new Map();
  for (const row of rows) {
    for (const theme of String(row.theme || "其他").split("、")) {
      if (!groups.has(theme)) groups.set(theme, []);
      groups.get(theme).push(row);
    }
  }
  return [...groups.entries()]
    .map(([theme, members]) => {
      const ranked = members
        .filter((row) => row.limitState !== "NORMAL" || row.shouldHaveFlagged || row.inTodayPool)
        .sort((a, b) => leaderScore(b) - leaderScore(a));
      const limitCount = members.filter((row) => row.limitState === "LIMIT_UP").length;
      const nearLimitCount = members.filter((row) => row.limitState === "NEAR_LIMIT").length;
      const strongCount = members.filter((row) => row.limitState === "STRONG").length;
      const flaggedCount = members.filter((row) => row.shouldHaveFlagged).length;
      const missedCount = members.filter((row) => row.shouldHaveFlagged && !row.inTodayPool).length;
      const heatScore = limitCount * 35 + nearLimitCount * 24 + strongCount * 10 + flaggedCount * 3 - missedCount * 2;
      return {
        theme,
        heatScore,
        total: members.length,
        limitCount,
        nearLimitCount,
        strongCount,
        flaggedCount,
        missedCount,
        leaders: ranked.slice(0, 3).map((row, index) => ({
          rank: index + 1,
          code: row.code,
          name: row.name,
          pct: row.pct,
          limitState: row.limitState,
          emotionScore: row.emotionScore,
        })),
      };
    })
    .filter((row) => row.limitCount || row.nearLimitCount || row.strongCount || row.flaggedCount)
    .sort((a, b) => b.heatScore - a.heatScore || b.limitCount - a.limitCount || b.strongCount - a.strongCount);
}

async function main() {
  const expectedTradeDate = process.env.TRADE_DATE || todayCn();
  const { source, rows: watchlist } = await readWatchlist();
  if (!watchlist.length) throw new Error("未找到用户票池，请写入 reports/data/user-watchlist.json");

  const quotes = await fetchTencentQuotes(watchlist);
  const quoteMap = new Map(quotes.map((row) => [row.code, row]));
  const pool = await readJson(path.join(repoRoot, "quant-system/backend/data/stock_pool_latest.json"), {});
  const poolMap = new Map((Array.isArray(pool.signals) ? pool.signals : []).map((row) => [String(row.code || "").padStart(6, "0"), row]));

  const enriched = watchlist.map((item) => {
    const quote = quoteMap.get(item.code) || {};
    const theme = inferTheme({ ...item, ...quote });
    return { ...item, ...quote, theme };
  });
  const themeBreadth = new Map();
  for (const row of enriched) {
    if (Number(row.pct || 0) < 3) continue;
    for (const tag of String(row.theme || "其他").split("、")) themeBreadth.set(tag, (themeBreadth.get(tag) || 0) + 1);
  }

  const reviewRows = [];
  for (const item of enriched) {
    const poolRow = poolMap.get(item.code);
    const threshold = limitThreshold(item.code, item.name);
    const pct = Number(item.pct || 0);
    const openPct = Number(item.prevClose || 0) > 0 && Number(item.open || 0) > 0 ? (Number(item.open) / Number(item.prevClose) - 1) * 100 : 0;
    const highFadePct = Number(item.high || 0) > Number(item.price || 0) && Number(item.price || 0) > 0 ? (Number(item.high) / Number(item.price) - 1) * 100 : 0;
    const themeMaxBreadth = Math.max(...String(item.theme || "其他").split("、").map((tag) => themeBreadth.get(tag) || 0));
    const emotionScore = scoreEmotion(item, themeMaxBreadth);
    const kline = await klineStats(item.code, expectedTradeDate);
    const isLimit = pct >= threshold - 0.05;
    const isNearLimit = pct >= threshold - 0.6;
    const isStrong = pct >= 5 || (pct >= 3 && Number(item.volumeRatio || 0) >= 1.5);
    const shouldHaveFlagged = isLimit || isNearLimit || emotionScore >= 55 || (themeMaxBreadth >= 6 && pct >= 3);
    const inTodayPool = Boolean(poolRow);
    reviewRows.push({
      code: item.code,
      name: item.name || item.trueName || quoteMap.get(item.code)?.name || "",
      theme: item.theme,
      source: "Tencent qt.gtimg.cn + sina:kline-daily cache",
      time: item.time || null,
      price: item.price ?? null,
      pct: item.pct ?? null,
      turnover: item.turnover ?? null,
      volumeRatio: item.volumeRatio ?? null,
      open: item.open ?? null,
      high: item.high ?? null,
      low: item.low ?? null,
      prevClose: item.prevClose ?? null,
      openPct,
      highFadePct,
      amountYi: item.amountYi ?? null,
      limitThreshold: threshold,
      limitState: isLimit ? "LIMIT_UP" : isNearLimit ? "NEAR_LIMIT" : isStrong ? "STRONG" : "NORMAL",
      themeBreadth: themeMaxBreadth,
      emotionScore,
      inTodayPool,
      todayScore: poolRow?.score ?? null,
      todayAction: poolRow?.action ?? null,
      todayRisk: poolRow?.risk_level ?? null,
      shouldHaveFlagged,
      decision: isLimit || isNearLimit ? "LIMIT_REVIEW" : shouldHaveFlagged ? "PRIORITY_TRACK" : inTodayPool ? "POOL_TRACK" : "NORMAL_TRACK",
      missReason: shouldHaveFlagged && !inTodayPool
        ? "用户票池情绪/题材信号达到追踪阈值，但未进入今日系统候选池"
        : inTodayPool
          ? "已进入今日系统候选池"
          : "未触发涨停、近涨停或题材强度阈值",
      kline,
    });
  }

  reviewRows.sort((a, b) => {
    return limitPriority(b) - limitPriority(a) || Number(b.emotionScore || 0) - Number(a.emotionScore || 0);
  });
  const themeLadder = buildThemeLadder(reviewRows);
  const themeRank = new Map(themeLadder.map((item, index) => [item.theme, index + 1]));
  const leaderByTheme = new Map();
  for (const theme of themeLadder) {
    for (const leader of theme.leaders) {
      const key = `${theme.theme}:${leader.code}`;
      leaderByTheme.set(key, leader.rank);
    }
  }
  for (const row of reviewRows) {
    const themes = String(row.theme || "其他").split("、");
    const bestTheme = themes.sort((a, b) => (themeRank.get(a) || 999) - (themeRank.get(b) || 999))[0] || "其他";
    const roleRank = leaderByTheme.get(`${bestTheme}:${row.code}`);
    row.primaryTheme = bestTheme;
    row.themeRank = themeRank.get(bestTheme) || null;
    row.leaderRole = roleRank === 1 ? "题材龙头" : roleRank === 2 ? "前排核心" : roleRank === 3 ? "前排跟踪" : row.shouldHaveFlagged ? "题材跟风" : "普通跟踪";
    row.nextAction = nextAction(row);
  }

  const quoteDates = quotes.map((row) => tencentTradeDate(row.time)).filter(Boolean);
  const latestQuoteDate = quoteDates.sort().at(-1) || null;
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceWatchlist: source,
    expectedTradeDate,
    dataQuality: {
      quoteSource: "Tencent qt.gtimg.cn",
      klineSource: "sina:kline-daily cache",
      quoteRows: quotes.length,
      total: watchlist.length,
      latestQuoteDate,
      isStale: Boolean(latestQuoteDate && latestQuoteDate !== expectedTradeDate),
      missingQuotes: watchlist.length - quotes.length,
      missingKlines: reviewRows.filter((row) => row.kline.missing).length,
    },
    summary: {
      total: watchlist.length,
      quoted: quotes.length,
      inTodayPool: reviewRows.filter((row) => row.inTodayPool).length,
      limitOrNearLimit: reviewRows.filter((row) => ["LIMIT_UP", "NEAR_LIMIT"].includes(row.limitState)).length,
      strong: reviewRows.filter((row) => row.limitState === "STRONG").length,
      shouldHaveFlagged: reviewRows.filter((row) => row.shouldHaveFlagged).length,
      missedFlagged: reviewRows.filter((row) => row.shouldHaveFlagged && !row.inTodayPool).length,
    },
    themeBreadth: themeLadder,
    rows: reviewRows,
  };
  await atomicWriteJson(outputPath, payload);
  console.log(
    `user watchlist reviewed: ${payload.summary.quoted}/${payload.summary.total}; flagged=${payload.summary.shouldHaveFlagged}; missed=${payload.summary.missedFlagged}`,
  );
}

await main();
