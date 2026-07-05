import fs from "node:fs";
import path from "node:path";

type OrderRequest = {
  side: "BUY" | "SELL";
  code: string;
  name?: string;
  quantity: number;
  price?: number;
  dryRun?: boolean;
};

type AutopilotRunOptions = {
  execute?: boolean;
};

type AutopilotSettingsUpdate = {
  enabled?: boolean;
  mode?: string;
  policy?: Record<string, any>;
};

const repoRoot = path.resolve(process.cwd(), "../..");
const deployDataRoot = path.join(process.cwd(), "deploy-data");
const MAX_INTRADAY_QUOTE_AGE_MINUTES = 2;
const MAX_PRICE_DIVERGENCE_PCT = 0.5;
const STABLE_WORKBENCH_SNAPSHOT = "reports/data/latest-workbench-snapshot.json";

export function isPublicReadOnly() {
  if (process.env.QUANT_ENABLE_PUBLIC_WRITES === "true") return false;
  return process.env.VERCEL === "1" || process.env.QUANT_PUBLIC_READONLY === "true";
}

function readJson<T>(relativePath: string, fallback: T): T {
  try {
    const deployPath = path.join(deployDataRoot, relativePath);
    const filePath = fs.existsSync(deployPath) ? deployPath : path.join(repoRoot, relativePath);
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(relativePath: string, payload: unknown) {
  if (isPublicReadOnly()) return false;
  const filePath = path.join(repoRoot, relativePath);
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

function appendJsonl(relativePath: string, payload: unknown) {
  if (isPublicReadOnly()) return false;
  try {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function stableWorkbenchWithRunningReport(refreshReport: Record<string, any>): Record<string, any> | null {
  const snapshot = readJson<Record<string, any>>(STABLE_WORKBENCH_SNAPSHOT, {});
  if (!snapshot.updatedAt) return null;
  const previousAudit = snapshot.system?.dataAudit || {};
  const runningIssue = { level: "WARN", message: "数据刷新正在后台执行，页面展示上一版完整快照" };
  return {
    ...snapshot,
    snapshotMode: "STABLE_DURING_REFRESH",
    system: {
      ...(snapshot.system || {}),
      dataAudit: {
        ...previousAudit,
        status: previousAudit.status === "BLOCK" ? "BLOCK" : "WARN",
        issues: [runningIssue, ...((previousAudit.issues || []) as Array<Record<string, any>>)],
        refreshReport: {
          ok: refreshReport.ok,
          status: refreshReport.status,
          startedAt: refreshReport.startedAt,
          finishedAt: refreshReport.finishedAt,
          warning: refreshReport.warning,
          detail: refreshReport.detail,
          criticalFailures: refreshReport.criticalFailures,
          steps: Array.isArray(refreshReport.steps) ? refreshReport.steps.slice(0, 8) : [],
        },
      },
    },
  };
}

function shouldPublishStableSnapshot(snapshot: Record<string, any>, refreshReport: Record<string, any>) {
  if (!snapshot.updatedAt) return false;
  if (refreshReport.status === "RUNNING" || refreshReport.ok === false) return false;
  return true;
}

function reportStatus(relativePath: string) {
  const filePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(filePath)) return { path: relativePath, exists: false, size: 0, updatedAt: null };
  const stat = fs.statSync(filePath);
  return { path: relativePath, exists: true, size: stat.size, updatedAt: stat.mtimeMs / 1000, updatedAtIso: stat.mtime.toISOString() };
}

function walkMarkdown(relativePath: string): string[] {
  const root = path.join(repoRoot, relativePath);
  const rows: string[] = [];
  function visit(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) rows.push(path.relative(repoRoot, fullPath));
    }
  }
  visit(root);
  return rows.sort();
}

function buildKnowledgeSnapshot() {
  const layers = [
    { key: "Strategy-KB", cnName: "策略知识", target: 12 },
    { key: "Factor-KB", cnName: "因子知识", target: 8 },
    { key: "Policy-KB", cnName: "政策知识", target: 6 },
    { key: "Report-KB", cnName: "研报知识", target: 8 },
    { key: "Case-KB", cnName: "历史案例", target: 20 },
    { key: "Risk-KB", cnName: "风控知识", target: 8 },
  ];
  const allDocs = walkMarkdown("quant-system/knowledge").filter((item) => !item.includes("/templates/"));
  const layerRows = layers.map((layer) => {
    const docs = allDocs.filter((item) => item.includes(`/knowledge/${layer.key}/`));
    return {
      ...layer,
      docs: docs.length,
      status: docs.length === 0 ? "MISSING" : docs.length >= Math.ceil(layer.target * 0.5) ? "OK" : "SEEDING",
      examples: docs.slice(0, 3).map((item) => item.replace(/^quant-system\/knowledge\//, "")),
    };
  });
  const sourcePlan = [
    { name: "GitHub / Qlib / FinRL / Backtrader", type: "开源策略", priority: 5, status: "待采集", use: "策略原型、许可证、代码参考" },
    { name: "arXiv / SSRN", type: "学术论文", priority: 5, status: "待采集", use: "因子、模型、组合优化" },
    { name: "JoinQuant / BigQuant / RiceQuant", type: "量化平台", priority: 5, status: "待采集", use: "A 股回测样例和参数" },
    { name: "TA-Lib / TradingView", type: "技术指标", priority: 5, status: "待采集", use: "指标公式和脚本转换" },
    { name: "雪球 / 掘金量化", type: "社区论坛", priority: 4, status: "待采集", use: "实盘经验和案例标签" },
    { name: "经典量化书籍", type: "书籍", priority: 4, status: "待采集", use: "方法论摘要和风控框架" },
  ];
  return {
    root: "quant-system/knowledge",
    docs: allDocs.length,
    layers: layerRows,
    sourcePlan,
    nextActions: [
      "把现有趋势突破策略整理成 L2 策略卡片",
      "为每个策略绑定回测脚本和指标口径",
      "把 L3+ 策略接入投委会证据表",
      "只允许 L4 策略进入自动交易预检",
    ],
  };
}

function readMarkdownSummary(relativePath: string) {
  const fullPath = path.join(repoRoot, relativePath);
  try {
    const text = fs.readFileSync(fullPath, "utf8");
    const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(relativePath, ".md");
    const status = text.match(/^status:\s*(.+)$/m)?.[1]?.trim() || "L0 raw";
    const market = text.match(/^market:\s*(.+)$/m)?.[1]?.trim() || "";
    const horizon = text.match(/^horizon:\s*(.+)$/m)?.[1]?.trim() || "";
    const bullets = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2))
      .slice(0, 5);
    return {
      path: relativePath,
      title,
      status,
      market,
      horizon,
      bullets,
    };
  } catch {
    return null;
  }
}

function buildExecutionKnowledge() {
  const docs = walkMarkdown("quant-system/knowledge").filter((item) => !item.includes("/templates/"));
  const summaries = docs.map(readMarkdownSummary).filter(Boolean) as Array<{
    path: string;
    title: string;
    status: string;
    market: string;
    horizon: string;
    bullets: string[];
  }>;
  const riskDocs = summaries.filter((item) => item.path.includes("/Risk-KB/"));
  const strategyDocs = summaries.filter((item) => item.path.includes("/Strategy-KB/"));
  const caseDocs = summaries.filter((item) => item.path.includes("/Case-KB/"));
  return {
    ready: summaries.some((item) => item.status.startsWith("L2") || item.status.startsWith("L3") || item.status.startsWith("L4")),
    docs: summaries.length,
    riskDocs,
    strategyDocs,
    caseDocs,
    references: [...riskDocs.slice(0, 2), ...strategyDocs.slice(0, 3), ...caseDocs.slice(0, 1)].map((item) => ({
      title: item.title,
      status: item.status,
      path: item.path,
      rule: item.bullets[0] || item.horizon || item.market || "执行前需参考该知识条目",
    })),
  };
}

function levelRank(status?: string) {
  const match = String(status || "").match(/^L(\d)/i);
  return match ? Number(match[1]) : 0;
}

function strategyDocsForCenter() {
  return walkMarkdown("quant-system/knowledge/Strategy-KB")
    .map(readMarkdownSummary)
    .filter(Boolean) as Array<{
      path: string;
      title: string;
      status: string;
      market: string;
      horizon: string;
      bullets: string[];
    }>;
}

function normalizeRegistryStrategy(row: Record<string, any>) {
  const backtest = row.backtest || {};
  return {
    key: row.key,
    name: row.name,
    enabled: Boolean(row.enabled),
    status: row.stage || row.status,
    horizon: row.horizon || "待归一化",
    source: row.source || "",
    winRatePct: backtest.winRatePct ?? row.winRatePct ?? null,
    maxDrawdownPct: backtest.maxDrawdownPct ?? row.maxDrawdownPct ?? null,
    recentTrades: [],
    parameters: Array.isArray(row.parameters) ? row.parameters : [],
    gates: Array.isArray(row.gates) ? row.gates : [],
    executionGate: row.execution_gate || row.executionGate || "RESEARCH_ONLY",
    gateReasons: Array.isArray(row.gate_reasons) ? row.gate_reasons : [],
    nextActions: Array.isArray(row.next_actions) ? row.next_actions : [],
    quality: row.quality || null,
    promotion: row.promotion || null,
    note: row.description || row.note || "",
  };
}

function buildStrategyCenter(
  backtest: Record<string, any>,
  signals: Record<string, any>,
  recommendation: Record<string, any>,
  registry: Record<string, any> = {},
) {
  const registryRows = Array.isArray(registry.rows) ? registry.rows.map(normalizeRegistryStrategy) : [];
  if (registryRows.length) {
    const tradeReady = Number(signals.stats?.tradeReady || (Array.isArray(signals.trade) ? signals.trade.length : 0) || 0);
    return {
      summary: {
        enabled: Number(registry.summary?.enabled || registryRows.filter((item: Record<string, any>) => item.enabled).length),
        planned: registryRows.filter((item: Record<string, any>) => !item.enabled).length,
        knowledgeStrategies: Number(registry.summary?.knowledgeStrategies || 0),
        tradeReady,
        productionReady: Number(registry.summary?.productionReady || 0),
        paperAllowed: Number(registry.summary?.paperAllowed || 0),
        paperBlocked: Number(registry.summary?.paperBlocked || 0),
        qualityBlocked: Number(registry.summary?.qualityBlocked || 0),
        averageQualityScore: registry.summary?.averageQualityScore ?? null,
      },
      rows: registryRows.slice(0, 12),
    };
  }
  const docs = strategyDocsForCenter();
  const metrics = backtest.metrics || {};
  const tradeReady = Number(signals.stats?.tradeReady || (Array.isArray(signals.trade) ? signals.trade.length : 0) || 0);
  const strategyRows = [
    {
      key: "strong_pullback",
      name: "强势股回调",
      enabled: true,
      status: "SEED",
      horizon: "1-3个交易日",
      source: "MVP 规则策略",
      winRatePct: null,
      maxDrawdownPct: null,
      recentTrades: [],
      parameters: ["站上5/10/20日均线", "不追高开7%以上", "回踩买区确认", "非ST/非退市"],
      gates: ["推荐闸门", "买区", "止损线", "单票仓位"],
      note: "用于把方案里的第一版主策略落到交易计划，当前以前端展示和风控预检为主。",
    },
    {
      key: "volume_breakout",
      name: "放量突破",
      enabled: true,
      status: metrics.tradeCount || metrics.closedTrades ? "TESTED" : "ACTIVE",
      horizon: recommendation.holdingPeriod || "1-3个交易日",
      source: "backend/strategy/trend_breakout.py",
      winRatePct: metrics.winRatePct ?? metrics.win_rate_pct ?? null,
      maxDrawdownPct: metrics.maxDrawdownPct ?? metrics.max_drawdown_pct ?? null,
      recentTrades: Array.isArray(backtest.trades) ? backtest.trades.slice(0, 10) : [],
      parameters: ["涨幅3%-7%", "量比>=1.5", "均线多头", "趋势评分>=70"],
      gates: ["数据审计", "成交额/换手", "风险等级", "模拟预检"],
      note: "当前实际选股主策略，负责输出股票池、推荐雷达和回测样本。",
    },
    {
      key: "limit_pullback",
      name: "涨停后低吸",
      enabled: false,
      status: "PLANNED",
      horizon: "1-5个交易日",
      source: "Strategy-KB/leader/Limit-Up-Leader.md",
      winRatePct: null,
      maxDrawdownPct: null,
      recentTrades: [],
      parameters: ["涨停后不追板", "回踩5日线", "开板承接", "高波动降仓"],
      gates: ["情绪周期", "一字板过滤", "开板次数", "流动性"],
      note: "已在知识库建档，后续补回测脚本和 L3 指标后再启用。",
    },
  ];
  const kbRows = docs.map((doc) => ({
    key: doc.path,
    name: doc.title,
    enabled: levelRank(doc.status) >= 4,
    status: doc.status,
    horizon: doc.horizon || "待归一化",
    source: doc.path,
    winRatePct: null,
    maxDrawdownPct: null,
    recentTrades: [],
    parameters: doc.bullets.slice(0, 4),
    gates: levelRank(doc.status) >= 2 ? ["知识库L2+", "风控绑定待核验"] : ["仅研究引用"],
    note: doc.market || "知识库策略条目，需补齐参数、样本和禁用条件。",
  }));
  return {
    summary: {
      enabled: strategyRows.filter((item) => item.enabled).length,
      planned: strategyRows.filter((item) => !item.enabled).length,
      knowledgeStrategies: docs.length,
      tradeReady,
      productionReady: docs.filter((item) => levelRank(item.status) >= 4).length,
    },
    rows: [...strategyRows, ...kbRows].slice(0, 12),
  };
}

function buildBacktestReview(backtest: Record<string, any>, paper: Record<string, any>, eventBacktest: Record<string, any> = {}) {
  const activeBacktest = Array.isArray(eventBacktest.trades) && eventBacktest.trades.length ? eventBacktest : backtest;
  const metrics = activeBacktest.metrics || {};
  const trades = Array.isArray(backtest.trades) ? backtest.trades : [];
  const activeTrades = Array.isArray(activeBacktest.trades) ? activeBacktest.trades : trades;
  const closedTrades = Number(metrics.closedTrades || metrics.tradeCount || trades.length || 0);
  const winRate = metrics.winRatePct ?? metrics.win_rate_pct ?? metrics.winRate ?? null;
  const maxDrawdown = metrics.maxDrawdownPct ?? metrics.max_drawdown_pct ?? null;
  const averageReturn = metrics.averageReturnPct ?? metrics.average_return_pct ?? null;
  const totalReturn = metrics.totalReturnPct ?? metrics.total_return_pct ?? null;
  const profitLossRatio = metrics.profitLossRatio ?? metrics.profit_loss_ratio ?? null;
  const rules = [
    { label: "T+1", status: "PLANNED", detail: "后续回测引擎需禁止当日买入当日卖出。" },
    { label: "涨跌停", status: "PLANNED", detail: "需模拟涨停买不进、跌停卖不出。" },
    { label: "手续费/印花税", status: "PLANNED", detail: "当前简易持有期回测未完全计入真实交易成本。" },
    { label: "滑点", status: "PLANNED", detail: "后续按成交额与波动率引入动态滑点。" },
    { label: "成交量不足", status: "PLANNED", detail: "需要限制单笔成交额占当日成交额比例。" },
  ];
  return {
    metrics: {
      closedTrades,
      buyCount: Number(metrics.buyCount || 0),
      winRatePct: winRate,
      maxDrawdownPct: maxDrawdown,
      averageReturnPct: averageReturn,
      totalReturnPct: totalReturn,
      totalPnl: metrics.totalPnl ?? null,
      profitLossRatio,
      paperTotalReturnPct: paper.metrics?.totalReturnPct ?? null,
      paperOpenExposurePct: paper.metrics?.openExposurePct ?? null,
    },
    sampleReady: closedTrades >= 20,
    rules: Array.isArray(activeBacktest.rules)
      ? activeBacktest.rules.map((item: string) => ({ label: item.split(":")[0], status: "DONE", detail: item }))
      : rules,
    recentTrades: activeTrades.slice(0, 12),
  };
}

function shanghaiDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function latestAShareTradeDate(value = new Date()) {
  const base = shanghaiDate(value);
  const date = new Date(`${base}T12:00:00+08:00`);
  const day = date.getUTCDay();
  const offset = day === 0 ? 2 : day === 6 ? 1 : 0;
  if (offset) date.setUTCDate(date.getUTCDate() - offset);
  return shanghaiDate(date);
}

function shanghaiMinutesNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((memo, part) => {
      memo[part.type] = part.value;
      return memo;
    }, {});
  return Number(parts.hour || 0) * 60 + Number(parts.minute || 0);
}

function isAShareTradingTime() {
  const minutes = shanghaiMinutesNow();
  return (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) || (minutes >= 13 * 60 && minutes <= 15 * 60);
}

function daysBetween(fromDate: string, toDate: string) {
  const from = Date.parse(`${fromDate}T00:00:00+08:00`);
  const to = Date.parse(`${toDate}T00:00:00+08:00`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.POSITIVE_INFINITY;
  return Math.floor((to - from) / 86400000);
}

function liveQuoteDateAcceptable(liveDate: string, tradeDate: string) {
  if (!liveDate) return false;
  if (liveDate >= tradeDate) return true;
  const preOpen = shanghaiMinutesNow() < 9 * 60 + 30;
  return preOpen && daysBetween(liveDate, tradeDate) <= 3;
}

function datePart(value: unknown) {
  const text = String(value || "");
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function dateTimePart(value: unknown) {
  const text = String(value || "");
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}:${compact[6]}`;
  const iso = text.match(/\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?/);
  return iso ? iso[0].replace("T", " ") : "";
}

function firstDataDate(row: Record<string, any>, fallback = "") {
  return (
    datePart(row.dataDate) ||
    datePart(row.tradeDate) ||
    datePart(row.trade_date) ||
    datePart(row.generatedAt) ||
    datePart(row.updatedAt) ||
    datePart(row.requestTime) ||
    datePart(row.runAt) ||
    datePart(row.createdAt) ||
    datePart(row.time) ||
    datePart(row.collected_at) ||
    datePart(row.published_at) ||
    datePart(row.buy_date) ||
    datePart(row.sell_date) ||
    datePart(row.latestDate) ||
    datePart(row.quoteTime) ||
    datePart(row.todayTime) ||
    datePart(fallback)
  );
}

function firstDataTime(row: Record<string, any>, fallback = "") {
  return (
    dateTimePart(row.dataTime) ||
    dateTimePart(row.asOf) ||
    dateTimePart(row.quoteTime) ||
    dateTimePart(row.time) ||
    dateTimePart(row.generatedAt) ||
    dateTimePart(row.updatedAt) ||
    dateTimePart(row.requestTime) ||
    dateTimePart(row.runAt) ||
    dateTimePart(row.createdAt) ||
    dateTimePart(row.collected_at) ||
    dateTimePart(row.published_at) ||
    dateTimePart(row.latestDate) ||
    dateTimePart(row.todayTime) ||
    dateTimePart(fallback)
  );
}

function attachDataDates<T>(value: T, fallback = ""): T {
  if (Array.isArray(value)) return value.map((item) => attachDataDates(item, fallback)) as T;
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, any>;
  const ownDate = firstDataDate(row, fallback);
  const ownTime = firstDataTime(row, fallback);
  const normalizedTime = row.dataTime || ownTime || ownDate || datePart(fallback) || shanghaiDate();
  const next: Record<string, any> = {
    ...row,
    dataDate: row.dataDate || ownDate || datePart(normalizedTime) || datePart(fallback) || shanghaiDate(),
    dataTime: normalizedTime,
    asOf: row.asOf || normalizedTime,
  };
  for (const [key, child] of Object.entries(row)) {
    next[key] = attachDataDates(child, next.dataTime);
  }
  return next as T;
}

function tencentTime(value: unknown) {
  const text = String(value || "");
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`;
}

function isToday(value: unknown) {
  return datePart(value) === shanghaiDate();
}

function freshness(records: Array<{ label: string; generatedAt?: unknown }>, source?: unknown, hasLiveQuotes = false) {
  const today = latestAShareTradeDate();
  const stale = records.filter((item) => {
    const date = datePart(item.generatedAt);
    return !date || date < today;
  });
  const sourceText = String(source || "");
  const degraded = sourceText.includes("fallback:");
  const staleFiles = stale.map((item) => item.label);
  if (degraded && !hasLiveQuotes) staleFiles.unshift("实时行情源");
  return {
    tradeDate: today,
    isStale: staleFiles.length > 0,
    staleFiles,
    message: staleFiles.length
      ? degraded && !hasLiveQuotes
        ? `实时行情源未确认，当前使用本地快照；需联网刷新东方财富数据。`
        : `以下数据不是 ${today} 生成：${staleFiles.join("、")}`
      : hasLiveQuotes
        ? "腾讯实时行情已同步到今日"
        : "数据已同步到今日",
  };
}

function liveQuoteRows(liveQuotes: Record<string, any>) {
  const rows = Array.isArray(liveQuotes.rows) ? liveQuotes.rows : [];
  return rows.filter((row) => isToday(tencentTime(row.time)));
}

function minutesSince(value: unknown) {
  const text = String(value || "");
  const date = text.includes("T") ? new Date(text) : new Date(tencentTime(text));
  const time = date.getTime();
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - time) / 60000);
}

function sourceMode(source?: unknown) {
  const text = String(source || "");
  if (!text) return "UNKNOWN";
  if (text.includes("fallback:")) return "LOCAL_FALLBACK";
  if (text.includes("eastmoney-live") || text.includes("eastmoney") || text.includes("EastMoney")) return "LIVE_EASTMONEY";
  if (text.includes("Tencent")) return "LIVE_TENCENT";
  if (text.includes("akshare")) return "LIVE_AKSHARE";
  return "FILE_INPUT";
}

function rowCode(row: Record<string, any>) {
  return String(row.code || "").padStart(6, "0");
}

function rowName(row: Record<string, any>) {
  return String(row.name || "");
}

function rowPct(row: Record<string, any>) {
  return Number(row.pct_chg ?? row.pct ?? 0);
}

function limitUpThreshold(row: Record<string, any>) {
  const code = rowCode(row);
  if (rowName(row).toUpperCase().includes("ST")) return 5;
  if (code.startsWith("83") || code.startsWith("87") || code.startsWith("88") || code.startsWith("92")) return 30;
  if (code.startsWith("30") || code.startsWith("68")) return 20;
  return 10;
}

function isExecutionBlocked(row: Record<string, any>) {
  const status = String(row.execution_status || row.execution?.status || "").toUpperCase();
  if (status) return status === "BLOCKED_LIMIT_UP";
  return rowPct(row) >= limitUpThreshold(row) - 0.08;
}

function isPrimaryTradeCandidate(row: Record<string, any>) {
  const action = String(row.action || "").toUpperCase();
  const recommendationType = String(row.recommendation_type || row.recommendationType || "").toUpperCase();
  return action === "TRADE" && recommendationType !== "LIMIT_REVIEW" && !isExecutionBlocked(row);
}

function isStrategyRadarCandidate(row: Record<string, any>) {
  const recommendationType = String(row.recommendation_type || row.recommendationType || "").toUpperCase();
  return recommendationType !== "LIMIT_REVIEW" && !isExecutionBlocked(row);
}

function badPrimaryRows(rows: Array<Record<string, any>>) {
  return rows
    .filter((row) => !isPrimaryTradeCandidate(row))
    .map((row) => `${rowCode(row)} ${rowName(row)} ${String(row.action || row.recommendation_type || row.recommendationType || "-")}`)
    .slice(0, 8);
}

function buildDataAudit({
  files,
  backendPool,
  liveQuotes,
  liveRadar,
  latestLiveTime,
  latestPoolCodes,
  liveQuoteCodes,
  livePoolOverlap,
  liveQuotesMatchLatestPool,
  refreshReport,
  userWatchlist = {},
  reportDataQuality = {},
  referenceRows,
}: {
  files: Record<string, any>;
  backendPool: Record<string, any>;
  liveQuotes: Record<string, any>;
  liveRadar: Array<Record<string, any>>;
  latestLiveTime?: string;
  latestPoolCodes: Set<string>;
  liveQuoteCodes: Set<string>;
  livePoolOverlap: number;
  liveQuotesMatchLatestPool: boolean;
  refreshReport: Record<string, any>;
  userWatchlist?: Record<string, any>;
  reportDataQuality?: Record<string, any>;
  referenceRows: Array<Record<string, any>>;
}) {
  const today = latestAShareTradeDate();
  const poolRunAt = backendPool.run_at || backendPool.generatedAt || "";
  const poolTradeDate = backendPool.trade_date || datePart(poolRunAt);
  const poolDataQuality = backendPool.data_quality || backendPool.dataQuality || {};
  const liveGeneratedAt = liveQuotes.generatedAt || "";
  const providerMode = poolDataQuality.source
    ? sourceMode(poolDataQuality.source)
    : sourceMode(backendPool.input || liveQuotes.source);
  const issues: Array<{ level: "OK" | "WARN" | "BLOCK"; message: string }> = [];
  const liveByCode = new Map(liveRadar.map((row) => [String(row.code || "").padStart(6, "0"), row]));
  const priceDivergences = referenceRows
    .map((row) => {
      const code = String(row.code || "").padStart(6, "0");
      const live = liveByCode.get(code);
      const referencePrice = Number(row.current_price || row.price || 0);
      const livePrice = Number(live?.current_price || live?.price || 0);
      const divergencePct = livePrice > 0 && referencePrice > 0 ? Math.abs(livePrice / referencePrice - 1) * 100 : 0;
      return {
        code,
        name: row.name || live?.name || code,
        livePrice,
        referencePrice,
        divergencePct: Number(divergencePct.toFixed(3)),
      };
    })
    .filter((row) => row.livePrice > 0 && row.referencePrice > 0 && row.divergencePct > MAX_PRICE_DIVERGENCE_PCT);

  if (poolTradeDate !== today) issues.push({ level: "BLOCK", message: `候选池交易日为 ${poolTradeDate || "未知"}，不是今日 ${today}` });
  if (poolDataQuality.allow_stale_input || reportDataQuality.allow_stale_input) {
    issues.push({ level: "BLOCK", message: "候选池由允许旧输入的演示模式生成，不能作为今日实盘参考" });
  }
  if (poolDataQuality.is_stale || reportDataQuality.is_stale) {
    issues.push({ level: "BLOCK", message: "候选池源数据日期与请求交易日不一致" });
  }
  const sourceTradeDate = poolDataQuality.source_trade_date || reportDataQuality.source_trade_date;
  const requestedTradeDate = poolDataQuality.requested_trade_date || reportDataQuality.requested_trade_date || poolTradeDate;
  if (sourceTradeDate && requestedTradeDate && sourceTradeDate !== requestedTradeDate) {
    issues.push({ level: "BLOCK", message: `候选池源数据日期 ${sourceTradeDate} 与请求交易日 ${requestedTradeDate} 不一致` });
  }
  if (!sourceTradeDate && providerMode !== "LIVE_EASTMONEY" && providerMode !== "LIVE_AKSHARE" && providerMode !== "LIVE_TENCENT") {
    issues.push({ level: "BLOCK", message: "候选池缺少可核验的源行情日期" });
  }
  if (!latestLiveTime) issues.push({ level: "WARN", message: "缺少今日腾讯实时行情时间" });
  if (latestLiveTime && !liveQuoteDateAcceptable(datePart(latestLiveTime), today)) {
    issues.push({ level: "BLOCK", message: `实时行情时间为 ${datePart(latestLiveTime)}，不是今日 ${today}` });
  }
  if (latestLiveTime && isAShareTradingTime()) {
    const quoteAge = minutesSince(latestLiveTime);
    if (quoteAge > MAX_INTRADAY_QUOTE_AGE_MINUTES) {
      issues.push({
        level: "BLOCK",
        message: `盘中行情已 ${quoteAge.toFixed(1)} 分钟未更新，超过 ${MAX_INTRADAY_QUOTE_AGE_MINUTES} 分钟上限`,
      });
    }
  }
  if (!liveQuotesMatchLatestPool) issues.push({ level: "BLOCK", message: "实时行情代码与最新候选池不匹配，已禁止覆盖雷达" });
  if (providerMode === "LOCAL_FALLBACK") issues.push({ level: "WARN", message: "全市场选股使用本地兜底，不是实时全市场重算" });
  if (priceDivergences.length) {
    const worst = priceDivergences.sort((a, b) => b.divergencePct - a.divergencePct)[0];
    issues.push({
      level: "BLOCK",
      message: `${worst.name} 实时价与候选价偏差 ${worst.divergencePct.toFixed(2)}%，超过 ${MAX_PRICE_DIVERGENCE_PCT}%`,
    });
  }
  const missedFlagged = Number(userWatchlist.summary?.missedFlagged || 0);
  if (missedFlagged > 0) {
    issues.push({ level: "WARN", message: `用户票池仍有 ${missedFlagged} 只强势/涨停票未进入主分析池，已进入上涨潜力雷达优先复核` });
  }
  const watchlistQuoteDate = String(userWatchlist.dataQuality?.latestQuoteDate || "");
  if (watchlistQuoteDate && watchlistQuoteDate !== today) {
    issues.push({ level: "BLOCK", message: `用户票池行情日期为 ${watchlistQuoteDate}，不是今日 ${today}` });
  }
  if (refreshReport.status === "RUNNING") issues.push({ level: "WARN", message: "数据刷新正在后台执行，页面暂时展示上一版完整结果" });
  if (refreshReport.ok === false) issues.push({ level: "BLOCK", message: `最近一次刷新失败：${refreshReport.detail || "未知错误"}` });
  if (Array.isArray(refreshReport.criticalFailures)) {
    for (const item of refreshReport.criticalFailures) issues.push({ level: "BLOCK", message: item });
  }
  if (refreshReport.warning) issues.push({ level: "WARN", message: "最近一次刷新存在数据源警告，详见步骤日志" });

  const recommendedRows = Array.isArray(referenceRows) ? referenceRows.filter((row) => String(row.action || "").toUpperCase() === "TRADE") : [];
  const dirtyRecommended = badPrimaryRows(recommendedRows);
  if (dirtyRecommended.length) {
    issues.push({ level: "BLOCK", message: `推荐池存在不合规候选：${dirtyRecommended.join("、")}` });
  }
  if (!issues.length) issues.push({ level: "OK", message: "候选池、实时行情与页面展示已对齐" });

  const status = issues.some((item) => item.level === "BLOCK") ? "BLOCK" : issues.some((item) => item.level === "WARN") ? "WARN" : "OK";
  const fileRows = [
    ["候选池", files.backendPool],
    ["腾讯实时行情", files.liveQuotes],
    ["交易信号", files.signals],
    ["推荐雷达", files.recommendation],
    ["推荐收益追踪", files.recommendationPerformance],
    ["投资委员会", files.committee],
    ["连续复核", files.continuity],
    ["刷新报告", files.refreshReport],
  ].map(([label, file]) => ({ label, ...(file || {}) }));

  return {
    status,
    tradeDate: today,
    providerMode,
    poolRunAt,
    poolTradeDate,
    poolInput: backendPool.input || "",
    poolSize: latestPoolCodes.size,
    liveSource: liveQuotes.source || "",
    liveGeneratedAt,
    latestLiveTime,
    liveRows: liveRadar.length,
    liveQuoteCodes: liveQuoteCodes.size,
    overlap: livePoolOverlap,
    overlapPct: latestPoolCodes.size ? Number(((livePoolOverlap / latestPoolCodes.size) * 100).toFixed(1)) : 100,
    liveQuotesMatchLatestPool,
    maxQuoteAgeMinutes: MAX_INTRADAY_QUOTE_AGE_MINUTES,
    maxPriceDivergencePct: MAX_PRICE_DIVERGENCE_PCT,
    priceDivergences: priceDivergences.slice(0, 12),
    issues,
    files: fileRows,
    refreshReport: {
      ok: refreshReport.ok,
      status: refreshReport.status,
      startedAt: refreshReport.startedAt,
      finishedAt: refreshReport.finishedAt,
      warning: refreshReport.warning,
      detail: refreshReport.detail,
      criticalFailures: refreshReport.criticalFailures,
      steps: Array.isArray(refreshReport.steps) ? refreshReport.steps.slice(0, 8) : [],
    },
  };
}

function liveRadarRows(liveQuotes: Record<string, any>) {
  return liveQuoteRows(liveQuotes).map((row) => {
    const pct = Number(row.pct || 0);
    const turnover = Number(row.turnover || 0);
    const momentum = Math.min(100, Math.max(0, 50 + pct * 7));
    const liquidity = Math.min(100, Math.max(0, 45 + turnover * 4));
    const score = Math.min(100, Math.max(0, momentum * 0.45 + liquidity * 0.25 + 25));
    return {
      code: String(row.code || "").padStart(6, "0"),
      name: row.name,
      current_price: Number(row.price || 0),
      price: Number(row.price || 0),
      pct_chg: pct,
      pct,
      turnover,
      volume_ratio: 1,
      mainNet: 0,
      market_cap: Number(row.totalMvYi || 0) * 100000000,
      score: Number(score.toFixed(2)),
      momentum_score: Number(momentum.toFixed(1)),
      volume_score: 50,
      liquidity_score: Number(liquidity.toFixed(1)),
      fund_score: 50,
      penalty_score: pct >= 9.8 ? 2 : 0,
      risk_level: pct >= 9.8 || turnover >= 12 ? "高" : "中",
      tier: score >= 75 ? "B" : "C",
      action: "WATCH",
      buy_zone: `${(Number(row.price || 0) * 0.98).toFixed(2)}-${(Number(row.price || 0) * 0.995).toFixed(2)}`,
      stop_loss: Number((Number(row.price || 0) * 0.94).toFixed(2)),
      target_price: Number((Number(row.price || 0) * 1.06).toFixed(2)),
      position_hint: "腾讯实时行情同步，仍需结合盘口承接确认",
      ai_comment: `${row.name} 腾讯行情 ${tencentTime(row.time)}：最新价 ${row.price}，涨跌幅 ${pct.toFixed(2)}%，换手 ${turnover.toFixed(2)}%。`,
      reasons: ["腾讯实时行情源", `更新时间 ${tencentTime(row.time)}`, `涨跌幅 ${pct.toFixed(2)}%`, `换手率 ${turnover.toFixed(2)}%`],
    };
  }).filter(isStrategyRadarCandidate);
}

function readJsonlTail(relativePath: string, limit = 40) {
  try {
    return fs
      .readFileSync(path.join(repoRoot, relativePath), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function defaultTradeState(): Record<string, any> {
  return {
    mode: "PAPER",
    generatedAt: reportStatus("reports/data/trade-ops-state.json").updatedAtIso || shanghaiDate(),
    cash: 100000,
    initialCash: 100000,
    positions: [],
    orders: [],
    trades: [],
  };
}

function latestRows() {
  const scan = readJson<Record<string, any>>("reports/data/latest-free-a-share-scan.brief.json", {});
  const openWatch = readJson<Record<string, any>>("reports/data/latest-open-limit-watch.json", {});
  const rows: any[] = [];
  for (const key of ["newLimitUps", "strongToLimit", "newStrong"]) {
    if (Array.isArray(openWatch[key])) rows.push(...openWatch[key]);
  }
  for (const key of ["limitUpPool", "strongNotLimit", "fundTop", "attack", "watch", "avoid", "selected"]) {
    if (Array.isArray(scan[key])) rows.push(...scan[key]);
  }
  const seen = new Set<string>();
  return rows.filter((row) => {
    const code = String(row.code || "").padStart(6, "0");
    if (!code || seen.has(code)) return false;
    seen.add(code);
    return true;
  });
}

function latestQuote(code: string) {
  const normalized = code.padStart(6, "0");
  const liveQuotes = readJson<Record<string, any>>("reports/data/live-tencent-candidate-quotes.json", {});
  const live = liveQuoteRows(liveQuotes).find((row) => String(row.code || "").padStart(6, "0") === normalized);
  if (live) return live;
  return latestRows().find((row) => String(row.code || "").padStart(6, "0") === normalized);
}

function tradeState() {
  return { ...defaultTradeState(), ...readJson<Record<string, any>>("reports/data/trade-ops-state.json", {}) };
}

function normalizePosition(position: any) {
  const quote = latestQuote(position.code);
  const lastPrice = Number(quote?.price || position.lastPrice || position.avgPrice || 0);
  const quantity = Number(position.quantity || 0);
  const avgPrice = Number(position.avgPrice || 0);
  const marketValue = lastPrice * quantity;
  const cost = avgPrice * quantity;
  return {
    ...position,
    lastPrice: Number(lastPrice.toFixed(3)),
    marketValue: Number(marketValue.toFixed(2)),
    unrealizedPct: cost > 0 ? Number(((marketValue / cost - 1) * 100).toFixed(2)) : 0,
  };
}

function equityOf(state: Record<string, any>) {
  const positions = (state.positions || []).map(normalizePosition);
  return Number((Number(state.cash || 0) + positions.reduce((sum: number, item: any) => sum + Number(item.marketValue || 0), 0)).toFixed(2));
}

function portfolioSnapshot(state: Record<string, any>, positions: any[]) {
  const policy = {
    maxPositionPct: 18,
    maxTotalExposurePct: 65,
    maxPositions: 6,
    maxOrderPct: 12,
    maxPriceDeviationPct: 4,
    stopLossPct: -8,
  };
  const equity = Number(state.cash || 0) + positions.reduce((sum, item) => sum + Number(item.marketValue || 0), 0);
  const exposure = positions.reduce((sum, item) => sum + Number(item.marketValue || 0), 0);
  const largest = positions.reduce((best, item) => (Number(item.marketValue || 0) > Number(best?.marketValue || 0) ? item : best), null);
  const exposurePct = equity > 0 ? (exposure / equity) * 100 : 0;
  const largestPositionPct = equity > 0 && largest ? (Number(largest.marketValue || 0) / equity) * 100 : 0;
  const warnings: Array<{ severity: string; message: string }> = [];
  if (exposurePct > policy.maxTotalExposurePct) warnings.push({ severity: "BLOCK", message: `总仓位 ${exposurePct.toFixed(2)}% 超过上限 65%` });
  if (largestPositionPct > policy.maxPositionPct) warnings.push({ severity: "BLOCK", message: `单票仓位 ${largestPositionPct.toFixed(2)}% 超过上限 18%` });
  if (positions.length > policy.maxPositions) warnings.push({ severity: "WARN", message: `持仓数量 ${positions.length} 只，超过建议上限 6 只` });
  for (const row of positions) {
    if (Number(row.unrealizedPct || 0) <= policy.stopLossPct) warnings.push({ severity: "WARN", message: `${row.name || row.code} 浮亏 ${row.unrealizedPct}%` });
  }
  return {
    policy,
    exposurePct: Number(exposurePct.toFixed(2)),
    largestPositionPct: Number(largestPositionPct.toFixed(2)),
    positionCount: positions.length,
    cashPct: equity > 0 ? Number(((Number(state.cash || 0) / equity) * 100).toFixed(2)) : 0,
    positions,
    warnings,
    status: warnings.some((item) => item.severity === "BLOCK") ? "BLOCK" : warnings.length ? "WARN" : "OK",
  };
}

export function getTradingState() {
  const state = tradeState();
  const positions = (state.positions || []).map(normalizePosition);
  return {
    ...state,
    positions,
    risk: portfolioSnapshot(state, positions),
    equity: equityOf(state),
    cash: Number(Number(state.cash || 0).toFixed(2)),
    orders: [...(state.orders || [])].reverse().slice(0, 50),
    trades: [...(state.trades || [])].reverse().slice(0, 50),
  };
}

function tradeGateCheck(order: OrderRequest, state: Record<string, any>, recommendation: Record<string, any>) {
  const reasons: string[] = [];
  const kbWarnings: string[] = [];
  const code = order.code.padStart(6, "0");
  const quote = latestQuote(code) || {};
  const quotePrice = Number(quote.price || 0);
  const price = Number(order.price || quotePrice || 0);
  const executionKb = buildExecutionKnowledge();
  const kbReferences = executionKb.references;
  const refreshReport = readJson<Record<string, any>>("reports/data/latest-refresh-report.json", {});
  const liveQuotes = readJson<Record<string, any>>("reports/data/live-tencent-candidate-quotes.json", {});
  const liveRows = liveQuoteRows(liveQuotes);
  const latestLiveTime = liveRows.map((row) => tencentTime(row.time)).sort().at(-1);
  const liveRow = liveRows.find((row) => String(row.code || "").padStart(6, "0") === code);

  if (!executionKb.ready) kbWarnings.push("知识库未达到 L2+，执行只能使用硬编码风控兜底");
  if (order.quantity % 100 !== 0) reasons.push("A股委托数量必须为100股整数倍");
  if (order.side === "BUY") {
    if (refreshReport.warning) reasons.push("最近一次刷新存在数据源警告，禁止新增买入");
    if (refreshReport.ok === false || Array.isArray(refreshReport.criticalFailures) && refreshReport.criticalFailures.length) {
      reasons.push("最近一次刷新存在关键失败，禁止新增买入");
    }
    if (!liveRow) reasons.push("缺少该标的今日实时行情，禁止新增买入");
    if (latestLiveTime && isAShareTradingTime()) {
      const quoteAge = minutesSince(latestLiveTime);
      if (quoteAge > MAX_INTRADAY_QUOTE_AGE_MINUTES) {
        reasons.push(`盘中行情已 ${quoteAge.toFixed(1)} 分钟未更新，禁止新增买入`);
      }
    }
    if (!recommendation.liveBuyAllowed) reasons.push("推荐闸门未打开，禁止新增买入");
    const tradeCodes = new Set((recommendation.recommendedBuys || []).map((item: any) => String(item.code || "").padStart(6, "0")));
    if (tradeCodes.size && !tradeCodes.has(code)) reasons.push("标的不在可买清单");
    if (!price) reasons.push("缺少可用价格");
    if (price && liveRow?.price) {
      const divergence = Math.abs(price / Number(liveRow.price) - 1) * 100;
      if (divergence > MAX_PRICE_DIVERGENCE_PCT) {
        reasons.push(`委托价与实时价偏差 ${divergence.toFixed(2)}%，超过 ${MAX_PRICE_DIVERGENCE_PCT}%`);
      }
    }
    if (price * order.quantity > Number(state.cash || 0)) reasons.push("现金不足");
    kbWarnings.push("已参考 Risk-KB：买入必须通过数据审计、推荐闸门、组合风控和 A 股 100 股整数倍规则");
    kbWarnings.push("已参考 Strategy-KB：短线龙头/趋势策略不得在闸门关闭时追价开新仓");
  } else {
    const position = (state.positions || []).find((item: any) => item.code === code);
    if (!position) reasons.push("没有可卖持仓");
    else if (order.quantity > Number(position.quantity || 0)) reasons.push("卖出数量超过持仓");
    kbWarnings.push("已参考 Risk-KB：卖出必须校验持仓数量，禁止超卖");
  }
  return { reasons, kbWarnings, kbReferences };
}

export function placeOrder(order: OrderRequest) {
  const state = tradeState();
  const recommendation = readJson<Record<string, any>>("reports/data/latest-quant-recommendation.json", {});
  const codeDigits = String(order.code || "").replace(/\D/g, "").slice(0, 6);
  const code = codeDigits ? codeDigits.padStart(6, "0") : "";
  const quote = latestQuote(code) || {};
  const price = Number(order.price || quote.price || 0);
  const name = order.name || quote.name || code;
  const normalizedOrder = { ...order, code };
  const gate = tradeGateCheck(normalizedOrder, state, recommendation);
  const reasons = gate.reasons;
  if (!/^\d{6}$/.test(code)) reasons.unshift("股票代码必须为6位数字");
  if (!Number.isFinite(order.quantity) || order.quantity <= 0) reasons.unshift("委托数量必须大于0");
  const orderRecord = {
    id: (state.orders || []).length + 1,
    createdAt: new Date().toISOString(),
    side: order.side,
    code,
    name,
    quantity: order.quantity,
    price: price ? Number(price.toFixed(3)) : null,
    status: order.dryRun && !reasons.length ? "CHECKED" : reasons.length ? "REJECTED" : "FILLED",
    dryRun: Boolean(order.dryRun),
    reasons,
    kbWarnings: gate.kbWarnings,
    kbReferences: gate.kbReferences,
  };
  if (isPublicReadOnly()) {
    return {
      order: {
        ...orderRecord,
        status: "REJECTED",
        reasons: ["公开部署为只读模式，禁止写入委托和模拟交易状态", ...reasons],
      },
      state: getTradingState(),
    };
  }
  state.orders = [...(state.orders || []), orderRecord];
  if (!order.dryRun && !reasons.length) {
    const gross = price * order.quantity;
    if (order.side === "BUY") {
      state.cash = Number((Number(state.cash || 0) - gross).toFixed(2));
      const existing = (state.positions || []).find((item: any) => item.code === code);
      if (existing) {
        const totalQty = Number(existing.quantity || 0) + order.quantity;
        existing.avgPrice = Number(((Number(existing.avgPrice || 0) * Number(existing.quantity || 0) + gross) / totalQty).toFixed(3));
        existing.quantity = totalQty;
      } else {
        state.positions = [...(state.positions || []), { code, name, quantity: order.quantity, avgPrice: Number(price.toFixed(3)), lastPrice: Number(price.toFixed(3)) }];
      }
    } else {
      state.cash = Number((Number(state.cash || 0) + gross).toFixed(2));
      state.positions = (state.positions || [])
        .map((item: any) => (item.code === code ? { ...item, quantity: Number(item.quantity || 0) - order.quantity, lastPrice: Number(price.toFixed(3)) } : item))
        .filter((item: any) => Number(item.quantity || 0) > 0);
    }
    state.trades = [...(state.trades || []), { ...orderRecord, gross: Number(gross.toFixed(2)) }];
  }
  writeJson("reports/data/trade-ops-state.json", state);
  appendJsonl("reports/data/execution-audit.jsonl", {
    ts: new Date().toISOString(),
    source: "web.paper_order",
    request: { ...normalizedOrder, price: order.price, dryRun: Boolean(order.dryRun) },
    order: orderRecord,
  });
  return { order: orderRecord, state: getTradingState() };
}

function defaultAutopilotState(): Record<string, any> {
  return {
    enabled: false,
    mode: "PAPER_ONLY",
    lastRunAt: null,
    policy: {
      minDecision: "BUY_CANDIDATE",
      minConfidence: 72,
      maxQuoteAgeMinutes: 8,
      maxOrdersPerRun: 3,
      maxOrdersPerDay: 5,
      orderCashPct: 8,
      requireDataAuditOk: true,
      blockOnRefreshWarning: true,
      blockIfKlineWarning: true,
      allowWatchOnly: false,
    },
    runs: [],
  };
}

function autopilotState() {
  return { ...defaultAutopilotState(), ...readJson<Record<string, any>>("reports/data/autopilot-state.json", {}) };
}

function normalizeLiveQuote(row: Record<string, any>) {
  return {
    code: String(row.code || "").padStart(6, "0"),
    name: row.name || "",
    price: Number(row.price || 0),
    pct: Number(row.pct || 0),
    turnover: Number(row.turnover || 0),
    volumeRatio: Number(row.volumeRatio || 0),
    time: row.time || "",
  };
}

function roundLot(quantity: number) {
  return Math.max(0, Math.floor(quantity / 100) * 100);
}

function todayOrderCount(state: Record<string, any>) {
  const today = shanghaiDate();
  return (state.orders || []).filter((item: Record<string, any>) => datePart(item.createdAt || item.runAt || item.time) === today).length;
}

function buildAutopilotCycle(options: AutopilotRunOptions = {}) {
  const settings = autopilotState();
  const workbench = getWorkbenchSnapshot();
  const trading = getTradingState();
  const liveQuotes = readJson<Record<string, any>>("reports/data/live-tencent-candidate-quotes.json", {});
  const committee = readJson<Record<string, any>>("reports/data/latest-investment-committee.json", {});
  const pool = readJson<Record<string, any>>("quant-system/backend/data/stock_pool_latest.json", {});
  const refreshReport = readJson<Record<string, any>>("reports/data/latest-refresh-report.json", {});
  const quoteMap = new Map(liveQuoteRows(liveQuotes).map((row) => [String(row.code || "").padStart(6, "0"), normalizeLiveQuote(row)]));
  const signalMap = new Map((Array.isArray(pool.signals) ? pool.signals : []).map((row: Record<string, any>) => [String(row.code || "").padStart(6, "0"), row]));
  const policy = { ...defaultAutopilotState().policy, ...(settings.policy || {}) };
  const executionKb = buildExecutionKnowledge();
  const blockers: string[] = [];

  const audit = workbench.system?.dataAudit || {};
  if (!executionKb.ready) blockers.push("知识库未达到 L2+，自动交易禁止执行");
  if (!settings.enabled) blockers.push("自动交易总开关未开启");
  if (settings.mode !== "PAPER_AUTO") blockers.push("当前仅允许 PAPER_AUTO 模式自动执行");
  if (policy.requireDataAuditOk && audit.status !== "OK") blockers.push(`数据审计状态 ${audit.status || "UNKNOWN"}，未达到 OK`);
  if (policy.blockOnRefreshWarning && refreshReport.warning) blockers.push("最近一次刷新存在数据源警告");
  if (policy.blockIfKlineWarning && (refreshReport.steps || []).some((step: Record<string, any>) => String(step.script || "").includes("kline") && step.stderr)) {
    blockers.push("K线缓存刷新存在告警，禁止自动开仓");
  }
  if (trading.risk?.status === "BLOCK") blockers.push("组合风控为 BLOCK");
  if (todayOrderCount(trading) >= policy.maxOrdersPerDay) blockers.push(`今日委托次数达到上限 ${policy.maxOrdersPerDay}`);

  const decisions = Array.isArray(committee.decisions) ? committee.decisions : [];
  const candidates = decisions
    .map((decision: Record<string, any>) => {
      const code = String(decision.code || "").padStart(6, "0");
      const quote = quoteMap.get(code);
      const signal = signalMap.get(code) || {};
      const reasons: string[] = [];
      const confidence = Number(decision.confidence || 0);
      const decisionText = String(decision.decision || "");
      const quoteAge = minutesSince(quote?.time);
      if (!quote || !quote.price) reasons.push("缺少今日实时价格");
      if (quoteAge > policy.maxQuoteAgeMinutes) reasons.push(`报价超过 ${policy.maxQuoteAgeMinutes} 分钟`);
      if (confidence < policy.minConfidence) reasons.push(`投委会置信度 ${confidence.toFixed(1)} 低于 ${policy.minConfidence}`);
      if (!policy.allowWatchOnly && ["WATCH_ONLY", "WATCH_NO_CHASE"].includes(decisionText)) reasons.push(`投委会结论为 ${decisionText}`);
      if (decisionText === "REJECT") reasons.push("投委会拒绝");
      if (Number(decision.max_position_pct || 0) <= 0) reasons.push("投委会最大仓位为 0%");
      if (String(signal.action || "") !== "TRADE") reasons.push("趋势模型未给出 TRADE");
      if (!executionKb.ready) reasons.push("执行知识库未达到 L2+");
      const cashBudget = Number(trading.equity || trading.cash || 0) * (policy.orderCashPct / 100);
      const quantity = quote?.price ? roundLot(cashBudget / quote.price) : 0;
      if (quantity <= 0) reasons.push("按当前预算不足 100 股");
      return {
        code,
        name: decision.name || quote?.name || signal.name || code,
        decision: decisionText,
        confidence,
        score: Number(signal.score || 0),
        price: quote?.price || 0,
        pct: quote?.pct || signal.pct_chg || 0,
        turnover: quote?.turnover || signal.turnover || 0,
        volumeRatio: quote?.volumeRatio || signal.volume_ratio || 0,
        buyZone: signal.buy_zone || "",
        stopLoss: signal.stop_loss || null,
        targetPrice: signal.target_price || null,
        quantity,
        cashBudget: Number(cashBudget.toFixed(2)),
        quoteTime: quote?.time || "",
        eligible: reasons.length === 0,
        reasons,
        kbReferences: executionKb.references,
      };
    })
    .sort((a: Record<string, any>, b: Record<string, any>) => Number(b.eligible) - Number(a.eligible) || b.confidence - a.confidence || b.score - a.score);

  const plannedOrders = candidates.filter((item: Record<string, any>) => item.eligible).slice(0, policy.maxOrdersPerRun);
  const runBlockers = [...blockers];
  if (!plannedOrders.length) runBlockers.push("没有通过全部闸门的自动买入标的");

  const executedOrders: any[] = [];
  if (options.execute && !runBlockers.length) {
    for (const item of plannedOrders) {
      executedOrders.push(placeOrder({ side: "BUY", code: item.code, name: item.name, quantity: item.quantity, price: item.price, dryRun: false }).order);
    }
  }

  const run = {
    runAt: new Date().toISOString(),
    mode: settings.mode,
    executeRequested: Boolean(options.execute),
    canExecute: runBlockers.length === 0,
    status: runBlockers.length ? "BLOCKED" : options.execute ? "EXECUTED" : "READY",
    blockers: runBlockers,
    policy,
    plannedOrders,
    executedOrders,
    rejectedCandidates: candidates.filter((item: Record<string, any>) => !item.eligible).slice(0, 12),
    audit: {
      status: audit.status,
      latestLiveTime: audit.latestLiveTime,
      overlapPct: audit.overlapPct,
      issues: audit.issues || [],
    },
    knowledge: {
      ready: executionKb.ready,
      docs: executionKb.docs,
      references: executionKb.references,
    },
  };
  return { settings, run };
}

export function getAutopilotState() {
  const settings = autopilotState();
  const preview = buildAutopilotCycle({ execute: false }).run;
  return { ...settings, preview };
}

export function updateAutopilotSettings(update: AutopilotSettingsUpdate = {}) {
  const current = autopilotState();
  const next = {
    ...current,
    enabled: typeof update.enabled === "boolean" ? update.enabled : Boolean(current.enabled),
    mode: update.mode === "PAPER_AUTO" || update.mode === "PAPER_ONLY" ? update.mode : current.mode || "PAPER_ONLY",
    policy: {
      ...(defaultAutopilotState().policy || {}),
      ...(current.policy || {}),
      ...(update.policy || {}),
    },
    updatedAt: new Date().toISOString(),
  };
  writeJson("reports/data/autopilot-state.json", next);
  appendJsonl("reports/data/execution-audit.jsonl", {
    ts: next.updatedAt,
    source: "web.autopilot_settings",
    update,
    state: { enabled: next.enabled, mode: next.mode, policy: next.policy },
  });
  return getAutopilotState();
}

export function runAutopilotCycle(options: AutopilotRunOptions = {}) {
  const { settings, run } = buildAutopilotCycle(options);
  const nextState = {
    ...settings,
    lastRunAt: run.runAt,
    runs: [run, ...(settings.runs || [])].slice(0, 30),
  };
  writeJson("reports/data/autopilot-state.json", nextState);
  appendJsonl("reports/data/execution-audit.jsonl", {
    ts: run.runAt,
    source: "web.autopilot_run",
    executeRequested: Boolean(options.execute),
    status: run.status,
    blockers: run.blockers,
    plannedOrders: run.plannedOrders,
    executedOrders: run.executedOrders,
  });
  return { ...nextState, latestRun: run, trading: getTradingState() };
}

export function getWorkbenchSnapshot(): Record<string, any> {
  const refreshReport = readJson<Record<string, any>>("reports/data/latest-refresh-report.json", {});
  if (refreshReport.status === "RUNNING") {
    const stableSnapshot = stableWorkbenchWithRunningReport(refreshReport);
    if (stableSnapshot) return attachDataDates(stableSnapshot, stableSnapshot.updatedAt || refreshReport.startedAt);
  }

  const openWatch = readJson<Record<string, any>>("reports/data/latest-open-limit-watch.json", {});
  const signals = readJson<Record<string, any>>("reports/data/latest-trading-signals.json", {});
  const recommendation = readJson<Record<string, any>>("reports/data/latest-quant-recommendation.json", {});
  const recommendationPerformance = readJson<Record<string, any>>("reports/data/latest-recommendation-performance.json", {});
  const scan = readJson<Record<string, any>>("reports/data/latest-free-a-share-scan.brief.json", {});
  const liveQuotes = readJson<Record<string, any>>("reports/data/live-tencent-candidate-quotes.json", {});
  const backtest = readJson<Record<string, any>>("reports/data/backtest-result.json", {});
  const eventBacktest = readJson<Record<string, any>>("reports/data/event-backtest-result.json", {});
  const paper = readJson<Record<string, any>>("reports/data/paper-trading-state.json", {});
  const committee = readJson<Record<string, any>>("reports/data/latest-investment-committee.json", {});
  const research = readJson<Record<string, any>>("reports/data/latest-research-report.json", {});
  const strategyRegistry = readJson<Record<string, any>>("reports/data/strategy-registry.json", {});
  const continuity = readJson<Record<string, any>>("reports/data/latest-continuity-review.json", {});
  const userWatchlist = readJson<Record<string, any>>("reports/data/latest-user-watchlist-review.json", {});
  const tradeWorkbench = readJson<Record<string, any>>("reports/data/latest-trade-workbench.json", {});
  const backendPool = readJson<Record<string, any>>("quant-system/backend/data/stock_pool_latest.json", {});
  const latestPoolCodes = new Set(
    (Array.isArray(backendPool.signals) ? backendPool.signals : [])
      .map((row: Record<string, any>) => String(row.code || "").padStart(6, "0"))
      .filter(Boolean),
  );
  const todayLiveRows = liveQuoteRows(liveQuotes);
  const liveQuoteCodes = new Set(
    todayLiveRows
      .map((row: Record<string, any>) => String(row.code || "").padStart(6, "0"))
      .filter(Boolean),
  );
  const livePoolOverlap = [...liveQuoteCodes].filter((code) => latestPoolCodes.has(code)).length;
  const liveQuotesMatchLatestPool = latestPoolCodes.size === 0 || livePoolOverlap >= Math.min(5, Math.ceil(latestPoolCodes.size * 0.5));
  const liveRadar = liveRadarRows(liveQuotes);
  const latestLiveTime = todayLiveRows
    .map((row) => tencentTime(row.time))
    .sort()
    .at(-1);
  const hasLiveQuotes = liveRadar.length > 0 && liveQuotesMatchLatestPool;
  const fileRecommended = Array.isArray(recommendation.recommendedBuys) ? recommendation.recommendedBuys : [];
  const displayRecommended = fileRecommended.filter(isPrimaryTradeCandidate);
  const fileQualityRadar = Array.isArray(recommendation.qualityRadar) ? recommendation.qualityRadar.filter(isStrategyRadarCandidate) : [];
  const fileUpliftTop = Array.isArray(recommendation.upliftTop) ? recommendation.upliftTop.filter(isStrategyRadarCandidate) : [];
  const cleanNewStrong = Array.isArray(openWatch.newStrong) ? openWatch.newStrong.filter(isStrategyRadarCandidate) : [];
  const cleanAttackCandidates = Array.isArray(openWatch.attackCandidates)
    ? openWatch.attackCandidates.filter(isStrategyRadarCandidate)
    : [];
  const files = {
    backendPool: reportStatus("quant-system/backend/data/stock_pool_latest.json"),
    liveQuotes: reportStatus("reports/data/live-tencent-candidate-quotes.json"),
    openWatch: reportStatus("reports/data/latest-open-limit-watch.json"),
    signals: reportStatus("reports/data/latest-trading-signals.json"),
    recommendation: reportStatus("reports/data/latest-quant-recommendation.json"),
    recommendationPerformance: reportStatus("reports/data/latest-recommendation-performance.json"),
    backtest: reportStatus("reports/data/backtest-result.json"),
    eventBacktest: reportStatus("reports/data/event-backtest-result.json"),
    paper: reportStatus("reports/data/paper-trading-state.json"),
    scan: reportStatus("reports/data/latest-free-a-share-scan.brief.json"),
    committee: reportStatus("reports/data/latest-investment-committee.json"),
    research: reportStatus("reports/data/latest-research-report.json"),
    strategyRegistry: reportStatus("reports/data/strategy-registry.json"),
    continuity: reportStatus("reports/data/latest-continuity-review.json"),
    userWatchlist: reportStatus("reports/data/latest-user-watchlist-review.json"),
    tradeWorkbench: reportStatus("reports/data/latest-trade-workbench.json"),
    refreshReport: reportStatus("reports/data/latest-refresh-report.json"),
  };
  const dataAudit = buildDataAudit({
    files,
    backendPool,
    liveQuotes,
    liveRadar,
    latestLiveTime,
    latestPoolCodes,
    liveQuoteCodes,
    livePoolOverlap,
    liveQuotesMatchLatestPool,
    refreshReport,
    userWatchlist,
    reportDataQuality: recommendation.dataQuality || signals.dataQuality || scan.dataQuality || openWatch.dataQuality || {},
    referenceRows: [
      ...(Array.isArray(backendPool.signals) ? backendPool.signals : []),
      ...(Array.isArray(recommendation.recommendedBuys) ? recommendation.recommendedBuys : []),
    ],
  });
  const hardGateReasons = [
    ...(dataAudit.issues || []).filter((item: { level: string }) => item.level === "BLOCK").map((item: { message: string }) => item.message),
    ...(refreshReport.warning ? ["最近一次刷新存在数据源警告，候选仅供观察"] : []),
    ...(dataAudit.providerMode === "LOCAL_FALLBACK" ? ["当前使用本地兜底数据，候选仅供观察"] : []),
  ];
  const effectiveLiveBuyAllowed = Boolean(recommendation.liveBuyAllowed) && hardGateReasons.length === 0 && dataAudit.status === "OK";
  const effectiveStatus = effectiveLiveBuyAllowed
    ? recommendation.status || "BUY"
    : displayRecommended.length
      ? "WATCH_ONLY"
      : recommendation.status || "UNKNOWN";
  const knowledge = buildKnowledgeSnapshot();
  const strategyCenter = buildStrategyCenter(backtest, signals, recommendation, strategyRegistry);
  const backtestReview = buildBacktestReview(backtest, paper, eventBacktest);
  const coreModules = [
    {
      id: 1,
      name: "Policy-Monitor",
      cnName: "政策监控核心",
      status: files.committee.exists ? "OK" : "PLANNED",
      detail: "抓取监管政策、行业新闻，自动提炼要点并预警市场影响。",
      signal: files.committee.exists ? "投委会材料已接入" : "待接入政策源",
    },
    {
      id: 2,
      name: "Stock-Analyst",
      cnName: "股票分析核心",
      status: files.recommendation.exists && files.signals.exists ? "OK" : "MISSING",
      detail: "从基本面、技术面、资金流向多维度分析个股，给出简洁参考。",
      signal: files.recommendation.exists ? "推荐雷达已生成" : "缺少分析结果",
    },
    {
      id: 3,
      name: "Daily-Trade-Review",
      cnName: "每日复盘核心",
      status: files.paper.exists ? "OK" : "PLANNED",
      detail: "自动汇总当日行情、持仓盈亏、操作得失，输出结构化复盘报告。",
      signal: files.paper.exists ? "纸面交易记录已接入" : "待生成复盘",
    },
    {
      id: 4,
      name: "Quant-KB",
      cnName: "量化知识库核心",
      status: knowledge.docs ? "OK" : "PLANNED",
      detail: "内置量化策略、因子、风控、案例和研报框架，支持投委会检索与策略复盘。",
      signal: knowledge.docs ? `知识库已接入 ${knowledge.docs} 篇 Markdown` : "策略知识库待接入",
    },
    {
      id: 5,
      name: "Stock-Watcher",
      cnName: "自选监控核心",
      status: files.openWatch.exists ? "OK" : "MISSING",
      detail: "监控自选股涨跌幅、异动、突破，触发推送提醒。",
      signal: files.openWatch.exists ? "事件监控在线" : "缺少监控快照",
    },
    {
      id: 6,
      name: "A-Shares-Data A",
      cnName: "A股数据源核心",
      status: files.scan.exists ? "OK" : "MISSING",
      detail: "提供A股基本面、财务、资金、历史K线等专业数据，支撑分析回测。",
      signal: files.scan.exists ? "A股扫描数据已接入" : "缺少行情数据",
    },
    {
      id: 7,
      name: "Report-Extractor",
      cnName: "研报/财报提炼核心",
      status: files.committee.exists ? "OK" : "PLANNED",
      detail: "解析PDF研报与财报，提取核心数据、观点与风险，快速读懂公告。",
      signal: files.committee.exists ? "投委会证据表可用" : "待接入PDF解析",
    },
    {
      id: 8,
      name: "Risk-Alert-System",
      cnName: "风险预警核心",
      status: files.signals.exists && files.paper.exists ? "OK" : "MISSING",
      detail: "监控持仓回撤、个股利空、大盘异动，及时安全提醒。",
      signal: files.signals.exists ? "信号风控已接入" : "缺少风控信号",
    },
    {
      id: 9,
      name: "Backtest-Engine",
      cnName: "回测引擎核心",
      status: files.backtest.exists ? "OK" : "MISSING",
      detail: "用历史数据验证策略，计算收益、回撤、胜率，避免盲目交易。",
      signal: files.backtest.exists ? "回测结果已生成" : "缺少回测结果",
    },
    {
      id: 10,
      name: "Skill-Vetter",
      cnName: "安全审计核心",
      status: "PLANNED",
      detail: "审计技能权限、数据外发风险，防止金融信息泄露与恶意操作。",
      signal: "权限审计待接入",
    },
  ];
  const snapshot = {
    updatedAt: latestLiveTime || openWatch.generatedAt || recommendation.generatedAt || signals.generatedAt || scan.requestTime,
    snapshotMode: "LIVE_FILES",
    dataSource: hasLiveQuotes ? `${liveQuotes.source || "Tencent qt.gtimg.cn"}; rows=${liveRadar.length}` : backendPool.input || "reports/data",
    dataHealth: freshness(
      [
        { label: "开盘监控", generatedAt: openWatch.generatedAt },
        { label: "交易信号", generatedAt: signals.requestTime || signals.generatedAt },
        { label: "推荐雷达", generatedAt: hasLiveQuotes ? latestLiveTime : recommendation.generatedAt },
      ],
      backendPool.input,
      hasLiveQuotes,
    ),
    marketState: openWatch.marketState || signals.marketState || scan.marketState || {},
    openWatch: {
      counts: openWatch.counts || {},
      newLimitUps: openWatch.newLimitUps || [],
      strongToLimit: openWatch.strongToLimit || [],
      removedLimitUps: openWatch.removedLimitUps || [],
      newStrong: cleanNewStrong,
      attackThemes: openWatch.attackThemes || [],
      attackCandidates: cleanAttackCandidates,
      events: readJsonlTail("reports/data/open-limit-events.jsonl", 60).reverse(),
    },
    signals: {
      stats: signals.stats || {},
      trade: signals.trade || [],
      watch: signals.watch || [],
      avoid: signals.avoid || [],
      risk: signals.risk || {},
    },
    recommendation: {
      status: effectiveStatus,
      liveBuyAllowed: effectiveLiveBuyAllowed,
      style: recommendation.style || "SHORT_TERM",
      holdingPeriod: recommendation.holdingPeriod || "1-3个交易日",
      recommendedBuys: displayRecommended.map((row: Record<string, any>) =>
        effectiveLiveBuyAllowed
          ? row
          : {
              ...row,
              action: row.action === "TRADE" ? "WATCH" : row.action,
              blockedReasons: [...(row.blockedReasons || []), ...hardGateReasons].slice(0, 5),
            },
      ),
      reasons: [...hardGateReasons, ...(recommendation.reasons || [])],
      watchPlan: recommendation.watchPlan || [],
      qualityRadar: hasLiveQuotes ? liveRadar : fileQualityRadar,
      upliftTop: hasLiveQuotes ? liveRadar.slice(0, 5) : fileUpliftTop,
      performanceSummary: recommendationPerformance.summary || {},
      performance: Array.isArray(recommendationPerformance.rows) ? recommendationPerformance.rows : [],
    },
    verification: {
      backtest: backtest.metrics || {},
      paper: paper.metrics || {},
    },
    strategyCenter,
    backtestReview,
    research: {
      generatedAt: research.generatedAt,
      method: research.method,
      summary: research.summary,
      decisions: Array.isArray(research.decisions) ? research.decisions.slice(0, 12) : [],
      evidence: Array.isArray(research.evidence) ? research.evidence.slice(0, 30) : [],
      dataGaps: Array.isArray(research.dataGaps) ? research.dataGaps.slice(0, 12) : [],
      riskFlags: Array.isArray(research.riskFlags) ? research.riskFlags.slice(0, 12) : [],
      file: files.research,
    },
    trading: getTradingState(),
    continuity: {
      generatedAt: continuity.generatedAt,
      modelNote: continuity.modelNote,
      summary: continuity.summary || {},
      reviewRows: continuity.reviewRows || [],
      addedRows: continuity.addedRows || [],
      priorityRows: continuity.priorityRows || [],
    },
    userWatchlist: {
      generatedAt: userWatchlist.generatedAt,
      sourceWatchlist: userWatchlist.sourceWatchlist,
      expectedTradeDate: userWatchlist.expectedTradeDate,
      dataQuality: userWatchlist.dataQuality || {},
      summary: userWatchlist.summary || {},
      themeBreadth: userWatchlist.themeBreadth || [],
      rows: userWatchlist.rows || [],
    },
    tradeWorkbench: {
      generatedAt: tradeWorkbench.generatedAt,
      status: tradeWorkbench.status || "UNKNOWN",
      action: tradeWorkbench.action || "",
      dataQuality: tradeWorkbench.dataQuality || {},
      summary: tradeWorkbench.summary || {},
      marketGate: tradeWorkbench.marketGate || null,
      playbook: tradeWorkbench.playbook || [],
      fullPoolAnalysis: tradeWorkbench.fullPoolAnalysis || [],
      fullPoolCategorySummary: tradeWorkbench.fullPoolCategorySummary || {},
      upsideRadar: tradeWorkbench.upsideRadar || [],
      executionQueue: tradeWorkbench.executionQueue || {},
      emotionRadar: tradeWorkbench.emotionRadar || [],
      missedRadar: tradeWorkbench.missedRadar || [],
      historicalLimitProof: tradeWorkbench.historicalLimitProof || [],
      styleCalibration: tradeWorkbench.styleCalibration || {},
      themeLadder: tradeWorkbench.themeLadder || [],
      modelSeparation: tradeWorkbench.modelSeparation || {},
    },
    system: {
      files,
      dataAudit,
      knowledge,
      modules: coreModules,
      committee: {
        generatedAt: committee.generatedAt,
        decisions: (committee.decisions || []).slice(0, 10),
      },
    },
  };
  if (shouldPublishStableSnapshot(snapshot, refreshReport)) {
    writeJson(STABLE_WORKBENCH_SNAPSHOT, snapshot);
  }
  return attachDataDates(snapshot, snapshot.updatedAt);
}
