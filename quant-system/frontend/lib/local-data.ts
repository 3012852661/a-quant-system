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

const repoRoot = path.resolve(process.cwd(), "../..");

function readJson<T>(relativePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(relativePath: string, payload: unknown) {
  const filePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function reportStatus(relativePath: string) {
  const filePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(filePath)) return { path: relativePath, exists: false, size: 0, updatedAt: null };
  const stat = fs.statSync(filePath);
  return { path: relativePath, exists: true, size: stat.size, updatedAt: stat.mtimeMs / 1000, updatedAtIso: stat.mtime.toISOString() };
}

function shanghaiDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function datePart(value: unknown) {
  const text = String(value || "");
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
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
  const today = shanghaiDate();
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

function sourceMode(source?: unknown) {
  const text = String(source || "");
  if (!text) return "UNKNOWN";
  if (text.includes("fallback:")) return "LOCAL_FALLBACK";
  if (text.includes("eastmoney-live") || text.includes("eastmoney") || text.includes("EastMoney")) return "LIVE_EASTMONEY";
  if (text.includes("Tencent")) return "LIVE_TENCENT";
  if (text.includes("akshare")) return "LIVE_AKSHARE";
  return "FILE_INPUT";
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
}) {
  const today = shanghaiDate();
  const poolRunAt = backendPool.run_at || backendPool.generatedAt || "";
  const poolTradeDate = backendPool.trade_date || datePart(poolRunAt);
  const liveGeneratedAt = liveQuotes.generatedAt || "";
  const providerMode = sourceMode(backendPool.input || liveQuotes.source);
  const issues: Array<{ level: "OK" | "WARN" | "BLOCK"; message: string }> = [];

  if (poolTradeDate !== today) issues.push({ level: "BLOCK", message: `候选池交易日为 ${poolTradeDate || "未知"}，不是今日 ${today}` });
  if (!latestLiveTime) issues.push({ level: "WARN", message: "缺少今日腾讯实时行情时间" });
  if (latestLiveTime && datePart(latestLiveTime) !== today) issues.push({ level: "BLOCK", message: `实时行情时间为 ${datePart(latestLiveTime)}，不是今日 ${today}` });
  if (!liveQuotesMatchLatestPool) issues.push({ level: "BLOCK", message: "实时行情代码与最新候选池不匹配，已禁止覆盖雷达" });
  if (providerMode === "LOCAL_FALLBACK") issues.push({ level: "WARN", message: "全市场选股使用本地兜底，不是实时全市场重算" });
  if (refreshReport.ok === false) issues.push({ level: "BLOCK", message: `最近一次刷新失败：${refreshReport.detail || "未知错误"}` });
  if (refreshReport.warning) issues.push({ level: "WARN", message: "最近一次刷新存在数据源警告，详见步骤日志" });
  if (!issues.length) issues.push({ level: "OK", message: "候选池、实时行情与页面展示已对齐" });

  const status = issues.some((item) => item.level === "BLOCK") ? "BLOCK" : issues.some((item) => item.level === "WARN") ? "WARN" : "OK";
  const fileRows = [
    ["候选池", files.backendPool],
    ["腾讯实时行情", files.liveQuotes],
    ["交易信号", files.signals],
    ["推荐雷达", files.recommendation],
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
    issues,
    files: fileRows,
    refreshReport: {
      ok: refreshReport.ok,
      startedAt: refreshReport.startedAt,
      finishedAt: refreshReport.finishedAt,
      warning: refreshReport.warning,
      detail: refreshReport.detail,
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
  });
}

function readJsonlTail(relativePath: string, limit = 40) {
  try {
    return fs
      .readFileSync(path.join(repoRoot, relativePath), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function defaultTradeState(): Record<string, any> {
  return {
    mode: "PAPER",
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

function tradeGateReasons(order: OrderRequest, state: Record<string, any>, recommendation: Record<string, any>) {
  const reasons: string[] = [];
  const code = order.code.padStart(6, "0");
  const quote = latestQuote(code) || {};
  const quotePrice = Number(quote.price || 0);
  const price = Number(order.price || quotePrice || 0);
  if (order.quantity % 100 !== 0) reasons.push("A股委托数量必须为100股整数倍");
  if (order.side === "BUY") {
    if (!recommendation.liveBuyAllowed) reasons.push("推荐闸门未打开，禁止新增买入");
    const tradeCodes = new Set((recommendation.recommendedBuys || []).map((item: any) => String(item.code || "").padStart(6, "0")));
    if (tradeCodes.size && !tradeCodes.has(code)) reasons.push("标的不在可买清单");
    if (!price) reasons.push("缺少可用价格");
    if (price * order.quantity > Number(state.cash || 0)) reasons.push("现金不足");
  } else {
    const position = (state.positions || []).find((item: any) => item.code === code);
    if (!position) reasons.push("没有可卖持仓");
    else if (order.quantity > Number(position.quantity || 0)) reasons.push("卖出数量超过持仓");
  }
  return reasons;
}

export function placeOrder(order: OrderRequest) {
  const state = tradeState();
  const recommendation = readJson<Record<string, any>>("reports/data/latest-quant-recommendation.json", {});
  const code = order.code.padStart(6, "0");
  const quote = latestQuote(code) || {};
  const price = Number(order.price || quote.price || 0);
  const name = order.name || quote.name || code;
  const reasons = tradeGateReasons(order, state, recommendation);
  const orderRecord = {
    id: (state.orders || []).length + 1,
    side: order.side,
    code,
    name,
    quantity: order.quantity,
    price: price ? Number(price.toFixed(3)) : null,
    status: order.dryRun && !reasons.length ? "CHECKED" : reasons.length ? "REJECTED" : "FILLED",
    dryRun: Boolean(order.dryRun),
    reasons,
  };
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
  return { order: orderRecord, state: getTradingState() };
}

export function getWorkbenchSnapshot() {
  const openWatch = readJson<Record<string, any>>("reports/data/latest-open-limit-watch.json", {});
  const signals = readJson<Record<string, any>>("reports/data/latest-trading-signals.json", {});
  const recommendation = readJson<Record<string, any>>("reports/data/latest-quant-recommendation.json", {});
  const scan = readJson<Record<string, any>>("reports/data/latest-free-a-share-scan.brief.json", {});
  const liveQuotes = readJson<Record<string, any>>("reports/data/live-tencent-candidate-quotes.json", {});
  const backtest = readJson<Record<string, any>>("reports/data/backtest-result.json", {});
  const paper = readJson<Record<string, any>>("reports/data/paper-trading-state.json", {});
  const committee = readJson<Record<string, any>>("reports/data/latest-investment-committee.json", {});
  const continuity = readJson<Record<string, any>>("reports/data/latest-continuity-review.json", {});
  const refreshReport = readJson<Record<string, any>>("reports/data/latest-refresh-report.json", {});
  const backendPool = readJson<Record<string, any>>("quant-system/backend/data/stock_pool_latest.json", {});
  const latestPoolCodes = new Set(
    (Array.isArray(backendPool.signals) ? backendPool.signals : [])
      .map((row: Record<string, any>) => String(row.code || "").padStart(6, "0"))
      .filter(Boolean),
  );
  const liveQuoteCodes = new Set(
    (Array.isArray(liveQuotes.rows) ? liveQuotes.rows : [])
      .map((row: Record<string, any>) => String(row.code || "").padStart(6, "0"))
      .filter(Boolean),
  );
  const livePoolOverlap = [...liveQuoteCodes].filter((code) => latestPoolCodes.has(code)).length;
  const liveQuotesMatchLatestPool = latestPoolCodes.size === 0 || livePoolOverlap >= Math.min(5, Math.ceil(latestPoolCodes.size * 0.5));
  const liveRadar = liveRadarRows(liveQuotes);
  const latestLiveTime = liveQuoteRows(liveQuotes)
    .map((row) => tencentTime(row.time))
    .sort()
    .at(-1);
  const hasLiveQuotes = liveRadar.length > 0 && liveQuotesMatchLatestPool;
  const files = {
    backendPool: reportStatus("quant-system/backend/data/stock_pool_latest.json"),
    liveQuotes: reportStatus("reports/data/live-tencent-candidate-quotes.json"),
    openWatch: reportStatus("reports/data/latest-open-limit-watch.json"),
    signals: reportStatus("reports/data/latest-trading-signals.json"),
    recommendation: reportStatus("reports/data/latest-quant-recommendation.json"),
    backtest: reportStatus("reports/data/backtest-result.json"),
    paper: reportStatus("reports/data/paper-trading-state.json"),
    scan: reportStatus("reports/data/latest-free-a-share-scan.brief.json"),
    committee: reportStatus("reports/data/latest-investment-committee.json"),
    continuity: reportStatus("reports/data/latest-continuity-review.json"),
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
  });
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
      status: "PLANNED",
      detail: "内置量化策略、指标用法、经典模型，支持快速查询与思路参考。",
      signal: "策略知识库待接入",
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
  return {
    updatedAt: latestLiveTime || openWatch.generatedAt || recommendation.generatedAt || signals.generatedAt || scan.requestTime,
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
      newStrong: openWatch.newStrong || [],
      attackThemes: openWatch.attackThemes || [],
      attackCandidates: openWatch.attackCandidates || [],
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
      status: recommendation.status || "UNKNOWN",
      liveBuyAllowed: recommendation.liveBuyAllowed || false,
      recommendedBuys: recommendation.recommendedBuys || [],
      reasons: recommendation.reasons || [],
      watchPlan: recommendation.watchPlan || [],
      qualityRadar: hasLiveQuotes ? liveRadar : recommendation.qualityRadar || [],
      upliftTop: hasLiveQuotes ? liveRadar.slice(0, 5) : recommendation.upliftTop || [],
    },
    verification: {
      backtest: backtest.metrics || {},
      paper: paper.metrics || {},
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
    system: {
      files,
      dataAudit,
      modules: coreModules,
      committee: {
        generatedAt: committee.generatedAt,
        decisions: (committee.decisions || []).slice(0, 10),
      },
    },
  };
}
