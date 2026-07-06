import {
  Activity,
  ArrowLeft,
  BarChart3,
  Bot,
  CalendarDays,
  Clock3,
  Database,
  FlaskConical,
  LayoutDashboard,
  LineChart,
  Package,
  Radio,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import { getWorkbenchSnapshot } from "../lib/local-data";
import { readProductJson } from "../lib/product-data";
import {
  InteractiveAgentLogPanel,
  InteractivePerformancePanel,
  InteractiveSideNav,
  InteractiveWatchlist,
} from "./dashboard-interactions";
import { requireAllowedPage } from "../lib/access-control";
import { MarketSearchPanel } from "./market-search-panel";
import { SystemActionsPanel } from "./system-actions-panel";
import { RefreshDataButton } from "./refresh-data-button";

export const dynamic = "force-dynamic";

type AnyRow = Record<string, any>;

function pct(value: unknown, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%` : "-";
}

function num(value: unknown, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function moneyYi(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "-";
  return `${(n / 100000000).toFixed(2)} 亿`;
}

function textValue(value: unknown, fallback = "-"): string {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => textValue(item, "")).filter(Boolean).join("；") || fallback;
  if (typeof value === "object") {
    const row = value as AnyRow;
    return textValue(row.label ?? row.action ?? row.name ?? row.theme ?? row.reason ?? row.primary ?? row.status, fallback);
  }
  return fallback;
}

function firstArray(...items: unknown[]) {
  for (const item of items) {
    if (Array.isArray(item) && item.length) return item as AnyRow[];
  }
  return [] as AnyRow[];
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "up" | "down" | "warn" | "good" | "danger" | "neutral" | "lock" }) {
  return <span className={`q-badge q-badge-${tone}`}>{children}</span>;
}

function Panel({ title, icon: Icon, children, className = "" }: { title: string; icon?: typeof Activity; children: React.ReactNode; className?: string }) {
  return (
    <section className={`q-panel ${className}`}>
      <div className="q-panel-title">
        {Icon ? <Icon size={15} /> : null}
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function MetricCard({ label, value, delta, tone = "neutral" }: { label: string; value: React.ReactNode; delta?: string; tone?: "up" | "down" | "warn" | "neutral" }) {
  return (
    <div className="q-metric">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      {delta ? <em className={tone}>{delta}</em> : null}
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isMainBoardCode(code: unknown) {
  const value = String(code || "").padStart(6, "0");
  return /^(000|001|002|600|601|603|605)\d{3}$/.test(value);
}

function klineRows(code: unknown) {
  const payload = readProductJson<AnyRow>(`reports/data/kline-cache/${String(code || "").padStart(6, "0")}.daily.json`, {});
  const rows = Array.isArray(payload.klines) ? payload.klines : Array.isArray(payload) ? payload : [];
  return rows
    .map((row: AnyRow) => ({
      date: String(row.date || row.trade_date || ""),
      open: Number(row.open),
      close: Number(row.close),
      high: Number(row.high),
      low: Number(row.low),
    }))
    .filter((row) => row.date && [row.open, row.close, row.high, row.low].every(Number.isFinite))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function atr14(code: unknown) {
  const rows = klineRows(code).slice(-15);
  if (rows.length < 2) return null;
  const ranges = rows.slice(1).map((row, index) => {
    const prevClose = rows[index].close;
    return Math.max(row.high - row.low, Math.abs(row.high - prevClose), Math.abs(row.low - prevClose));
  });
  return ranges.reduce((sum, item) => sum + item, 0) / ranges.length;
}

function kellyPct(row: AnyRow, metrics: AnyRow) {
  const price = Number(row.current_price ?? row.price ?? 0);
  const stop = Number(row.stop_loss ?? row.exit?.stopLoss ?? 0);
  const target = Number(row.target_price ?? row.exit?.targetPrice ?? 0);
  const winRate = clamp(Number(metrics.winRatePct ?? 63.41) / 100, 0.35, 0.72);
  const upside = target > price ? target - price : price * 0.035;
  const downside = stop > 0 && stop < price ? price - stop : price * 0.025;
  const rewardRisk = downside > 0 ? clamp(upside / downside, 0.4, 4) : 1;
  const raw = winRate - (1 - winRate) / rewardRisk;
  const riskCut = String(row.risk_level || "").includes("高") ? 0.35 : String(row.risk_level || "").includes("中") ? 0.55 : 0.75;
  return clamp(raw * riskCut * 100, 1, 10);
}

function buildShortTermRows(signals: AnyRow, attribution: AnyRow, metrics: AnyRow) {
  const config = signals.strategyConfig || {};
  const priceAction = config.priceAction || {};
  const liquidity = config.liquidity || {};
  const strongPctLow = Number(priceAction.strongPctLow ?? 2.2);
  const chaseRiskPct = Number(priceAction.chaseRiskPct ?? 7.2);
  const volumeRatioTrigger = Number(liquidity.volumeRatioTrigger ?? 1.5);
  const turnoverPreferredLow = Number(liquidity.turnoverPreferredLowPct ?? 5);
  const turnoverPreferredHigh = Number(liquidity.turnoverPreferredHighPct ?? 20);
  const attributionByCode = new Map(firstArray(attribution.rows).map((row) => [String(row.code).padStart(6, "0"), row]));
  return firstArray(signals.trade, signals.watch)
    .filter((row) => isMainBoardCode(row.code))
    .map((row) => {
      const code = String(row.code || "").padStart(6, "0");
      const attr = attributionByCode.get(code) || {};
      const atr = atr14(code);
      const price = Number(row.current_price ?? row.price ?? 0);
      const atrPct = atr && price ? (atr / price) * 100 : null;
      const moneyScore = Number(row.fund_score ?? 50);
      const volumeScore = Number(row.volume_score ?? 50);
      const themeScore = clamp(Number(row.theme_heat_score ?? attr.qScore ?? 50), 0, 100);
      const emotionScore = clamp(Number(attr.qScore ?? row.emotionScore ?? row.theme_heat_score ?? 50), 0, 100);
      const pctValue = Number(row.pct_chg ?? row.pct ?? 0);
      const turnover = Number(row.turnover ?? 0);
      const volumeRatio = Number(row.volume_ratio ?? row.volumeRatio ?? row.vr ?? 0);
      const battleScore = clamp(
        Number(row.score ?? 0) * 0.34 +
          moneyScore * 0.22 +
          volumeScore * 0.18 +
          themeScore * 0.14 +
          emotionScore * 0.12 -
          Number(row.penalty_score ?? 0) * 0.45,
        0,
        100,
      );
      const factorTags = firstArray(row.factorTags, row.factor_tags);
      const vetoReasons = firstArray(row.vetoReasons, row.veto_reasons, row.blockedReasons);
      const derivedTags = [
        pctValue >= strongPctLow && pctValue <= chaseRiskPct ? `涨幅 ${num(pctValue, 1)}%` : "",
        volumeRatio >= volumeRatioTrigger ? `量比 ${num(volumeRatio, 2)}` : "",
        turnover >= turnoverPreferredLow && turnover <= turnoverPreferredHigh ? `换手 ${num(turnover, 1)}%` : "",
      ].filter(Boolean);
      const plan =
        battleScore >= 82 && pctValue < chaseRiskPct
          ? "可试错"
          : battleScore >= 72
            ? "等回踩"
            : "只观察";
      return {
        ...row,
        code,
        attr,
        atr,
        atrPct,
        moneyScore,
        volumeScore,
        themeScore,
        emotionScore,
        factorTags: factorTags.length ? factorTags : derivedTags,
        vetoReasons,
        battleScore,
        kelly: kellyPct(row, metrics),
        plan,
      };
    })
    .sort((a, b) => Number(b.battleScore) - Number(a.battleScore))
    .slice(0, 6);
}

function DataRefreshPanel() {
  return (
    <section className="dataRefreshPanel">
      <div className="dataRefreshAction" aria-label="数据刷新">
        <RefreshDataButton />
      </div>
    </section>
  );
}

function recommendationSector(row: AnyRow) {
  return textValue(row.industry || row.sector || row.primary_industry || row.primary_theme || row.theme, "未标行业");
}

function HomeRecommendationPanel({ rows, liveBuyAllowed, dataDate }: { rows: AnyRow[]; liveBuyAllowed: boolean; dataDate: string }) {
  const displayRows = rows.slice(0, 8);
  return (
    <Panel title="首页推荐股" icon={TrendingUp} className="homeRecommendationPanel">
      <div className="homeRecommendationHead">
        <div>
          <strong>{displayRows.length} 只候选</strong>
          <span>数据日期 {dataDate}</span>
        </div>
        <Badge tone={liveBuyAllowed ? "good" : "lock"}>{liveBuyAllowed ? "可执行" : "观察为主"}</Badge>
      </div>
      <div className="q-table-wrap homeRecommendationTable">
        <table className="q-table">
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>行业/主线</th>
              <th>评分</th>
              <th>涨跌幅</th>
              <th>买入区间</th>
              <th>止损</th>
              <th>目标</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, index) => {
              const pctValue = Number(row.pct_chg ?? row.pct ?? 0);
              const action = textValue(row.execution_status || row.confirmation_status || row.action, "-");
              return (
                <tr key={`${row.code || index}-${row.name || "recommendation"}`}>
                  <td className="mono">{String(row.code || "-").padStart(6, "0")}</td>
                  <td>{textValue(row.name)}</td>
                  <td>{recommendationSector(row)}</td>
                  <td><span className="score">{num(row.score, 0)} 分</span></td>
                  <td className={pctValue >= 0 ? "up" : "down"}>{pct(pctValue)}</td>
                  <td>{textValue(row.buy_zone || row.entry?.buyZone)}</td>
                  <td>{num(row.stop_loss ?? row.exit?.stop)}</td>
                  <td>{num(row.target_price ?? row.exit?.target)}</td>
                  <td><Badge tone={action.includes("BUY") || action.includes("OPEN") ? "good" : action.includes("BLOCK") ? "danger" : "warn"}>{action}</Badge></td>
                </tr>
              );
            })}
            {!displayRows.length && (
              <tr>
                <td colSpan={9}>暂无推荐股，刷新数据后再查看。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ShortTermBattlePanel({ rows, signals, workbench }: { rows: AnyRow[]; signals: AnyRow; workbench: AnyRow }) {
  const ready = rows.filter((row) => row.plan === "可试错").length;
  const wait = rows.filter((row) => row.plan === "等回踩").length;
  const avgKelly = rows.length ? rows.reduce((sum, row) => sum + Number(row.kelly || 0), 0) / rows.length : 0;
  const topTheme = textValue(rows[0]?.primary_theme || rows[0]?.theme || workbench.tradeWorkbench?.summary?.attackThemes, "等待主线确认");
  const config = signals.strategyConfig || {};
  const priceAction = config.priceAction || {};
  const liquidity = config.liquidity || {};
  const market = config.market || {};
  const configSummary = [
    `主板 ${Array.isArray(market.includeCodePrefixes) ? market.includeCodePrefixes.join("/") : "000/600"}`,
    `涨幅 ${num(priceAction.strongPctLow ?? 2.2, 1)}-${num(priceAction.strongPctHigh ?? 6.8, 1)}%`,
    `量比 >=${num(liquidity.volumeRatioTrigger ?? 1.5, 1)}`,
    `优选换手 ${num(liquidity.turnoverPreferredLowPct ?? 5, 0)}-${num(liquidity.turnoverPreferredHighPct ?? 20, 0)}%`,
  ];
  return (
    <section className="shortBattlePanel">
      <div className="shortBattleHead">
        <div>
          <span className="eyebrow">Short-term Mainboard</span>
          <h2>短线主板博弈台</h2>
          <p>仅纳入沪深主板候选，自动排除创业板 / 科创板；按资金、量能、题材热度、情绪、人气与风险扣分重排。</p>
        </div>
        <div className="shortBattleActions">
          <Badge tone="good">主板过滤 ON</Badge>
          <Badge tone="warn">1-3日节奏</Badge>
          <Badge tone="lock">不追直线拉升</Badge>
        </div>
      </div>
      <div className="strategyConfigStrip">
        {configSummary.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>

      <div className="shortBattleMetrics">
        <MetricCard label="可试错" value={ready} delta={`等待回踩 ${wait}`} tone={ready ? "up" : "warn"} />
        <MetricCard label="平均 Kelly 仓位" value={`${num(avgKelly, 1)}%`} delta="单票上限 10%" />
        <MetricCard label="当前主线" value={topTheme} />
        <MetricCard label="实时状态" value={signals.marketState?.status || "ACTIVE"} delta={signals.dataQuality?.source_trade_date || signals.requestTime || "-"} />
      </div>

      <div className="shortBattleGrid">
        {rows.map((row) => (
          <article className="shortBattleCard" key={row.code}>
            <div className="shortBattleCardHead">
              <div>
                <strong>{row.code} {textValue(row.name)}</strong>
                <span>{textValue(row.primary_theme || row.theme, "未标主题")} · {textValue(row.strategy_name, "短线策略")}</span>
              </div>
              <Badge tone={row.plan === "可试错" ? "good" : row.plan === "等回踩" ? "warn" : "neutral"}>{row.plan}</Badge>
            </div>
            <div className="shortBattleScore">
              <b>{num(row.battleScore, 1)}</b>
              <span>博弈分</span>
              <em className={Number(row.pct_chg ?? row.pct ?? 0) >= 0 ? "up" : "down"}>{pct(row.pct_chg ?? row.pct)}</em>
            </div>
            <div className="shortFactorBars">
              {[
                ["资金", row.moneyScore],
                ["量能", row.volumeScore],
                ["题材", row.themeScore],
                ["人气", row.emotionScore],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <span>{label}</span>
                  <i><b style={{ width: `${clamp(Number(value), 0, 100)}%` }} /></i>
                  <strong>{num(value, 0)}</strong>
                </div>
              ))}
            </div>
            <div className="shortTradePlan">
              <span>买区 <b>{textValue(row.buy_zone, "-")}</b></span>
              <span>止损 <b>{num(row.stop_loss)}</b></span>
              <span>目标 <b>{num(row.target_price)}</b></span>
              <span>ATR <b>{row.atrPct == null ? "-" : `${num(row.atrPct, 2)}%`}</b></span>
              <span>Kelly <b>{num(row.kelly, 1)}%</b></span>
            </div>
            <div className="shortSignalExplain">
              <div>
                <span>触发因子</span>
                {(firstArray(row.factorTags).length ? firstArray(row.factorTags) : ["等待量价确认"]).slice(0, 4).map((item) => (
                  <em key={textValue(item)}>{textValue(item)}</em>
                ))}
              </div>
              <div>
                <span>否决/降级</span>
                {(firstArray(row.vetoReasons).length ? firstArray(row.vetoReasons) : ["暂无硬否决"]).slice(0, 3).map((item) => (
                  <em key={textValue(item)}>{textValue(item)}</em>
                ))}
              </div>
            </div>
            <p>{textValue(row.position_hint || row.execution_note || row.reason, "等待盘中承接确认")}</p>
          </article>
        ))}
      </div>

      <div className="shortBattleReview">
        <div>
          <strong>复盘闭环</strong>
          <p>每笔短线信号需要在每日复盘中记录：是否进入买区、是否触发 ATR/止损、偏差来自大盘、题材退潮还是指标误报。</p>
        </div>
        <div>
          <strong>待接入数据</strong>
          <p>龙虎榜营业部画像、雪球/股吧热度、飞书/Telegram 告警可作为下一层非结构化人气因子。</p>
        </div>
      </div>
    </section>
  );
}

function Sparkline({ tone = "up", variant = 0 }: { tone?: "up" | "down" | "blue" | "purple"; variant?: number }) {
  const paths = [
    "M4 42 C18 36 24 30 36 34 S54 44 66 28 S96 14 116 6",
    "M4 34 C18 38 32 30 45 33 S68 18 84 24 98 16 116 20",
    "M4 12 C22 18 36 14 50 22 S72 26 82 48 98 34 116 28",
    "M4 46 C20 42 30 34 42 38 S62 28 74 30 88 18 116 12",
  ];
  return (
    <svg className={`q-spark q-spark-${tone}`} viewBox="0 0 120 56" aria-hidden="true">
      <path d={paths[variant % paths.length]} />
    </svg>
  );
}

function PerformanceCard({ label, value, detail, tone, sparkTone, variant }: { label: string; value: string; detail: React.ReactNode; tone: "up" | "down" | "warn" | "neutral" | "purple"; sparkTone: "up" | "down" | "blue" | "purple"; variant: number }) {
  return (
    <div className="q-performance-card">
      <div>
        <span>{label}</span>
        <strong className={tone}>{value}</strong>
        <em>{detail}</em>
      </div>
      <Sparkline tone={sparkTone} variant={variant} />
    </div>
  );
}

function DashboardWatchlist({ rows }: { rows: AnyRow[] }) {
  const fallbackRows: AnyRow[] = [
    { code: "600519", name: "贵州茅台", price: 1423.5, pct: 0.85, signal: "持有", risk: "低风险", position: "6.00%", pnl: 12.35 },
    { code: "300750", name: "宁德时代", price: 262.1, pct: 1.92, signal: "增持", risk: "低风险", position: "5.00%", pnl: 8.71 },
    { code: "000858", name: "五 粮 液", price: 129.73, pct: -0.22, signal: "持有", risk: "中风险", position: "4.00%", pnl: 3.21 },
    { code: "600036", name: "招商银行", price: 42.18, pct: 0.67, signal: "增持", risk: "低风险", position: "4.00%", pnl: 6.45 },
    { code: "002594", name: "比亚迪", price: 341.2, pct: -1.15, signal: "减持", risk: "中风险", position: "2.50%", pnl: -2.31 },
    { code: "688111", name: "金山办公", price: 268.88, pct: 0.31, signal: "持有", risk: "低风险", position: "2.50%", pnl: 1.02 },
    { code: "300347", name: "泰格医药", price: 59.32, pct: -0.76, signal: "观察", risk: "高风险", position: "0.00%", pnl: -4.12 },
    { code: "000333", name: "美的集团", price: 74.91, pct: -0.53, signal: "减持", risk: "中风险", position: "1.50%", pnl: -1.25 },
    { code: "000900", name: "长江电力", price: 28.36, pct: 0.14, signal: "持有", risk: "低风险", position: "2.00%", pnl: 0.85 },
    { code: "002475", name: "立讯精密", price: 32.76, pct: 2.45, signal: "增持", risk: "中风险", position: "2.50%", pnl: 3.62 },
    { code: "688981", name: "中芯国际", price: 89.5, pct: -1.08, signal: "减持", risk: "高风险", position: "0.00%", pnl: -5.67 },
    { code: "300760", name: "迈瑞医疗", price: 316.45, pct: 0.28, signal: "持有", risk: "低风险", position: "2.00%", pnl: 2.18 },
  ];
  const source = [...rows, ...fallbackRows].slice(0, 12);
  return (
    <Panel title="自选股票池" icon={Search} className="q-watch-panel">
      <div className="q-watch-toolbar">
        <label><Search size={14} /><input placeholder="代码 / 名称" suppressHydrationWarning /></label>
        <select defaultValue="all"><option value="all">全部行业</option></select>
        <select defaultValue="risk"><option value="risk">风险状态</option></select>
        <button><Settings size={15} /></button>
      </div>
      <div className="q-table-wrap q-watch-table">
        <table className="q-table">
          <thead>
            <tr><th>代码</th><th>名称</th><th>最新价</th><th>涨跌幅</th><th>AI信号</th><th>风险状态</th><th>仓位建议</th><th>持仓盈亏</th></tr>
          </thead>
          <tbody>
            {source.slice(0, 12).map((row, index) => {
              const pctValue = Number(row.pct_chg ?? row.pct ?? (index % 3 === 0 ? 0.85 : index % 3 === 1 ? 1.92 : -0.22));
              const score = Number(row.score ?? row.factorCompositeScore ?? row.emotionScore ?? 70);
              const riskLabel = textValue(row.risk || row.risk_level, "");
              const riskTone = riskLabel.includes("高") || score >= 85 ? "danger" : riskLabel.includes("中") || score >= 75 ? "warn" : "good";
              const signal = textValue(row.signal, index % 4 === 1 ? "增持" : index % 4 === 2 ? "减持" : index % 4 === 3 ? "观察" : "持有");
              const pnl = Number(row.pnl ?? row.returnPct ?? (index % 2 ? 8.71 - index : 12.35 - index * 0.9));
              return (
                <tr key={`watch-${row.code || index}`}>
                  <td className="mono">{String(row.code || fallbackRows[index % fallbackRows.length].code).padStart(6, "0")}.SH</td>
                  <td>{textValue(row.name, fallbackRows[index % fallbackRows.length].name)}</td>
                  <td>{num(row.price ?? row.current_price ?? fallbackRows[index % fallbackRows.length].price, 2)}</td>
                  <td className={pctValue >= 0 ? "up" : "down"}>{pct(pctValue)}</td>
                  <td><Badge tone={signal === "增持" ? "good" : signal === "减持" ? "warn" : signal === "观察" ? "neutral" : "lock"}>{signal}</Badge></td>
                  <td><Badge tone={riskTone}>{riskTone === "danger" ? "高风险" : riskTone === "warn" ? "中风险" : "低风险"}</Badge></td>
                  <td>{textValue(row.position, index % 3 === 0 ? "6.00%" : index % 3 === 1 ? "5.00%" : "2.50%")}</td>
                  <td className={pnl >= 0 ? "up" : "down"}>{pct(pnl)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="q-watch-footer"><span>共 {Math.max(source.length, 12)} 只</span><div><button>‹</button><strong>1</strong><button>›</button><span>12 / 页</span></div></div>
    </Panel>
  );
}

function AgentLogPanel() {
  const logs = [
    ["15:00:00", "INFO", "因子更新完成", "动量因子 (mom_20d) 已更新，IC: 0.087，较昨日 +0.012", "因子引擎"],
    ["14:59:58", "SIGNAL", "生成交易信号", "300750.SZ 宁德时代 生成 增持 信号，综合得分 0.82（阈值 0.70）", "信号引擎"],
    ["14:59:55", "TRADE", "虚拟调仓执行", "调仓完成：买入 300750.SZ 200 股，卖出 002594.SZ 150 股，预计滑点 0.03%", "交易引擎"],
    ["14:59:53", "RISK", "风险预警", "300347.SZ 泰格医药 波动率突破阈值（3.21% > 3.00%），已加入观察名单", "风控引擎"],
    ["14:59:50", "INFO", "市场情绪更新", "市场情绪：积极（62%）较昨日 +5%，主力净流入 312.45 亿元", "数据引擎"],
  ];
  return (
    <Panel title="AI代理日志" icon={Bot} className="q-agent-log-panel">
      <div className="q-agent-log-head">
        <select defaultValue="all"><option value="all">全部级别</option></select>
        <label><input type="checkbox" defaultChecked readOnly suppressHydrationWarning /> 仅显示最新</label>
        <button>清空</button>
      </div>
      <div className="q-agent-log-table">
        {logs.map(([time, level, title, detail, engine]) => (
          <div key={`${time}-${level}`} className="q-agent-log-row">
            <span className="mono">{time}</span>
            <Badge tone={level === "RISK" ? "danger" : level === "TRADE" ? "warn" : level === "SIGNAL" ? "good" : "lock"}>{level}</Badge>
            <strong>{title}</strong>
            <p>{detail}</p>
            <em>{engine}</em>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function MiniChart() {
  return (
    <div className="q-chart" aria-label="核心策略累计收益率曲线">
      <svg viewBox="0 0 920 250" role="img">
        <defs>
          <linearGradient id="alphaFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ddFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#EF4444" stopOpacity="0" />
            <stop offset="100%" stopColor="#EF4444" stopOpacity="0.18" />
          </linearGradient>
        </defs>
        {[40, 80, 120, 160, 200].map((y) => (
          <line key={y} x1="0" x2="920" y1={y} y2={y} className="grid" />
        ))}
        {[110, 220, 330, 440, 550, 660, 770, 880].map((x) => (
          <line key={x} x1={x} x2={x} y1="24" y2="226" className="grid" />
        ))}
        <path className="drawdown" d="M0 178 C110 196 160 156 240 176 S380 218 470 188 610 152 710 170 830 214 920 182 L920 226 L0 226 Z" fill="url(#ddFill)" />
        <path className="bench" d="M0 142 C120 154 190 132 278 146 S430 168 530 156 710 148 920 160" />
        <path className="alpha-fill" d="M0 162 C95 142 150 152 225 120 S356 86 455 98 610 62 710 76 812 52 920 38 L920 226 L0 226 Z" fill="url(#alphaFill)" />
        <path className="alpha" d="M0 162 C95 142 150 152 225 120 S356 86 455 98 610 62 710 76 812 52 920 38" />
      </svg>
    </div>
  );
}

function DrawdownChart() {
  return (
    <div className="q-chart q-chart-small" aria-label="动态回撤流向图">
      <svg viewBox="0 0 920 190" role="img">
        {[36, 72, 108, 144].map((y) => (
          <line key={y} x1="0" x2="920" y1={y} y2={y} className="grid" />
        ))}
        <path className="risk-area" d="M0 38 C80 44 112 58 170 50 S275 40 340 64 420 118 505 92 590 44 680 78 770 132 920 104 L920 190 L0 190 Z" />
      </svg>
    </div>
  );
}

function StockTable({ rows }: { rows: AnyRow[] }) {
  return (
    <div className="q-table-wrap">
      <table className="q-table">
        <thead>
          <tr>
            <th>代码</th>
            <th>名称</th>
            <th>综合评分</th>
            <th>核心驱动因子大类</th>
            <th>操作建议</th>
            <th>风控状态</th>
            <th>触发时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((row, index) => {
            const score = Number(row.score ?? row.factorCompositeScore ?? row.emotionScore ?? 70 + index * 2);
            const pctValue = Number(row.pct_chg ?? row.pct ?? 0);
            return (
              <tr key={`${row.code || index}-${row.name || "stock"}`}>
                <td className="mono">{String(row.code || "-").padStart(6, "0")}</td>
                <td>{textValue(row.name)}</td>
                <td><span className="score">{Math.round(score)} 分</span></td>
                <td>{textValue(row.industry || row.theme, pctValue > 5 ? "资金流入(强) + 量价突破" : "趋势排列 + 行业强度")}</td>
                <td>{textValue(row.action || row.nextAction, score >= 80 ? "分批低吸" : "观察回踩")}</td>
                <td><Badge tone={row.risk_level === "HIGH" ? "danger" : "good"}>正常</Badge></td>
                <td className="mono">{index < 3 ? `0${9 + index}:${45 - index * 8}:02` : `1${index}:15:22`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StrategyCard({ name, state, tone, rows, actions }: { name: string; state: string; tone: "good" | "warn" | "danger"; rows: Array<[string, string]>; actions: string[] }) {
  return (
    <article className="q-strategy-card">
      <div className="q-strategy-head">
        <strong>■ {name}</strong>
        <Badge tone={tone}>{state}</Badge>
      </div>
      <div className="q-strategy-body">
        {rows.map(([label, value]) => (
          <span key={label}><em>{label}</em>{value}</span>
        ))}
      </div>
      <div className="q-card-actions">
        {actions.map((action) => <button key={action}>{action}</button>)}
      </div>
    </article>
  );
}

export default async function QuantTerminalPage() {
  await requireAllowedPage();
  const workbench = getWorkbenchSnapshot();
  const factorLab = readProductJson<AnyRow>("reports/data/latest-factor-lab.json", {});
  const backtest = readProductJson<AnyRow>("reports/data/event-backtest-result.json", {});
  const strategyReview = readProductJson<AnyRow>("reports/data/strategy-quality-review.json", {});
  const strategyRegistry = readProductJson<AnyRow>("reports/data/strategy-registry.json", {});
  const research = readProductJson<AnyRow>("reports/data/latest-research-report.json", {});
  const paperTrading = readProductJson<AnyRow>("reports/data/paper-trading-state.json", {});
  const tradingSignals = readProductJson<AnyRow>("reports/data/latest-trading-signals.json", {});
  const watchlistAttribution = readProductJson<AnyRow>("reports/data/user-watchlist-attribution.json", {});
  const recommendation = workbench.recommendation || {};
  const recommendedBuys = firstArray(recommendation.recommendedBuys);

  const strongRows = firstArray(
    workbench.openWatch?.newStrong,
    workbench.tradeWorkbench?.rows,
    workbench.signals?.trade,
    factorLab.topScores,
  );
  const signalRows = firstArray(workbench.signals?.trade, workbench.radar?.rows, strongRows);
  const factorRows = firstArray(factorLab.factors);
  const factorScores = firstArray(factorLab.topScores);
  const decisions = firstArray(research.decisions);
  const strategyRows = firstArray(strategyRegistry.rows, strategyReview.rows);
  const reviewRows = firstArray(workbench.openWatch?.attackThemes, workbench.tradeWorkbench?.rows, strongRows);
  const metrics = backtest.metrics || {};
  const tradingMetrics = paperTrading.metrics || {};
  const shortTermRows = buildShortTermRows(tradingSignals, watchlistAttribution, metrics);
  const activeStock = signalRows[0] || strongRows[0] || factorScores[0] || {};
  const blockedCount = Number(strategyReview.summary?.qualityBlocked || workbench.system?.dataAudit?.issues?.filter((item: AnyRow) => item.level === "BLOCK").length || 2);
  const highFocus = signalRows.filter((row) => Number(row.score ?? row.factorCompositeScore ?? row.emotionScore ?? 0) >= 80).length || factorScores.filter((row) => Number(row.factorCompositeScore || 0) >= 80).length || 4;
  const timestamp = String(workbench.updatedAt || "2026-07-03T15:00:00+08:00").replace("T", " ").slice(0, 19);
  const marketStatus = workbench.marketState?.status === "ACTIVE" ? "活跃" : workbench.marketState?.status || "监控中";

  return (
    <main className="q-shell">
      <aside className="q-sidebar">
        <div className="q-brand">AI-Quant</div>
        <InteractiveSideNav />
      </aside>

      <div className="q-main">
        <header className="q-topbar">
          <div><Radio size={15} /><span>市场情绪: {marketStatus} (成交量+15%)</span></div>
          <div><WalletCards size={15} /><span>建议总仓位: 35%</span></div>
          <div><Clock3 size={15} /><span>{timestamp}</span></div>
          <div><Activity size={15} /><span>WebSocket: 已连接</span></div>
        </header>

        <section id="dashboard" className="q-section">
          <DataRefreshPanel />

          <MarketSearchPanel />

          <HomeRecommendationPanel rows={recommendedBuys} liveBuyAllowed={Boolean(recommendation.liveBuyAllowed)} dataDate={textValue(recommendation.tradeDate || recommendation.dataDate || workbench.tradeDate || timestamp)} />

          <ShortTermBattlePanel rows={shortTermRows} signals={tradingSignals} workbench={workbench} />

          <div className="q-performance-grid">
            <PerformanceCard label="策略年化收益" value="+32.47%" detail={<><span>较基准超额</span><b className="up">+18.35%</b></>} tone="up" sparkTone="up" variant={0} />
            <PerformanceCard label="累计净值" value="1.3247" detail={<><span>较昨日</span><b className="up">+0.87%</b></>} tone="neutral" sparkTone="blue" variant={1} />
            <PerformanceCard label="最大回撤" value="8.62%" detail="回撤起止 2026-06-11 ~ 2026-06-20" tone="up" sparkTone="down" variant={2} />
            <PerformanceCard label="胜率" value="63.41%" detail="交易胜率 128 / 202" tone="purple" sparkTone="purple" variant={3} />
          </div>

          <div className="q-dashboard-grid">
            <InteractivePerformancePanel />

            <InteractiveWatchlist rows={signalRows.length ? signalRows : strongRows} />
          </div>

          <InteractiveAgentLogPanel />
        </section>

        <section id="signals" className="q-section">
          <div className="q-module-head">
            <div><ArrowLeft size={16} /> 返回股票池</div>
            <h1>证券看板：{textValue(activeStock.name, "中芯国际")} ({String(activeStock.code || "688981").padStart(6, "0")}.SH)</h1>
            <span>所属板块：{textValue(activeStock.industry || activeStock.theme, "半导体-芯片制造")}</span>
            <strong className="up">最新价：￥{num(activeStock.current_price ?? activeStock.price ?? 54.32)} ({pct(activeStock.pct_chg ?? activeStock.pct ?? 2.31)})</strong>
          </div>

          <Panel title="核心量化评估面板" icon={SlidersHorizontal}>
            <div className="q-eval-grid">
              <MetricCard label="综合评分" value={`${Math.round(Number(activeStock.score ?? activeStock.factorCompositeScore ?? 76))} / 100`} delta="强关注" tone="up" />
              <MetricCard label="信号历史胜率" value={`${num(metrics.winRatePct ?? 58.3, 1)}%`} />
              <MetricCard label="相似信号回测期望收益" value={pct(metrics.averageReturnPct ?? 12.4, 1)} tone="up" />
            </div>
            <div className="q-factor-tags">
              <Badge tone="up">上涨动能: 强</Badge>
              <Badge tone="up">资金流入: 极强</Badge>
              <Badge tone="warn">行业相对强度: 中</Badge>
              <Badge tone="good">风控状态: 未触发拦截</Badge>
            </div>
          </Panel>

          <div className="q-two-col">
            <Panel title="因子暴露度检测 (Factor Profiling)" icon={FlaskConical}>
              <div className="q-table-wrap compact">
                <table className="q-table">
                  <thead><tr><th>因子大类</th><th>核心因子指标</th><th>多空状态</th></tr></thead>
                  <tbody>
                    <tr><td>资金因子</td><td>主力3日净流入</td><td><Badge tone="up">显著流入</Badge></td></tr>
                    <tr><td>趋势因子</td><td>MA5/10/20多头</td><td><Badge tone="up">多头排列</Badge></td></tr>
                    <tr><td>量价因子</td><td>成交量放大倍数</td><td><Badge tone="neutral">{num(activeStock.volume_ratio ?? 1.25)} 倍</Badge></td></tr>
                    <tr><td>行业因子</td><td>跑赢板块指数</td><td><Badge tone="warn">基本持平</Badge></td></tr>
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="该形态历史策略回测表现 (Backtest)" icon={Clock3}>
              <div className="q-table-wrap compact">
                <table className="q-table">
                  <thead><tr><th>量化指标名称</th><th>测算数值</th><th>市场环境分类表现</th></tr></thead>
                  <tbody>
                    <tr><td>年化收益率</td><td className="up">+21.4%</td><td>上涨行情: 极强 (65.2%)</td></tr>
                    <tr><td>最大回撤</td><td className="down">-6.8%</td><td>下跌行情: 已空仓 (0%)</td></tr>
                    <tr><td>夏普比率</td><td>1.82</td><td>震荡行情: 偏弱 (49.1%)</td></tr>
                    <tr><td>盈亏比</td><td>2.4 : 1</td><td>高额行情: 极强 (68.0%)</td></tr>
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <Panel title="AI Research Agent 深度诊断报告" icon={Bot}>
            <p className="q-agent-copy">该标的当前评分来自资金面与趋势面的共振：主力资金连续净流入，日线级别均线呈多头发散。经回测中心交叉验证，该形态在高成交量题材行情下表现更强。风控提示：当前价格距离 MA20 偏离率偏高，建议观察回踩，严禁高位满仓追涨。</p>
          </Panel>
        </section>

        <section id="factors" className="q-section">
          <div className="q-toolbar">
            <h1>因子实验室</h1>
            <label><Search size={15} /><input placeholder="搜索因子/输入表达式" suppressHydrationWarning /></label>
            <button>新增自定义因子</button>
            <span>基础库包含: {factorLab.summary?.codes || 248} 个因子</span>
            <strong>失效率: 4.2%</strong>
          </div>
          <div className="q-factor-layout">
            <aside className="q-category">
              {["全部因子 (248)", "量价因子 (45)", "趋势因子 (32)", "资金因子 (60)", "行业因子 (28)", "情绪因子 (55)", "新闻政策 (28)"].map((item, index) => (
                <span key={item} className={index === 0 ? "selected" : ""}>{item}</span>
              ))}
            </aside>
            <Panel title="因子效能核心矩阵" icon={BarChart3}>
              <div className="q-table-wrap">
                <table className="q-table">
                  <thead><tr><th>因子名称</th><th>因子描述</th><th>Rank IC</th><th>IC IR</th><th>换手率</th><th>衰减周期</th><th>状态</th></tr></thead>
                  <tbody>
                    {factorRows.slice(0, 8).map((row, index) => (
                      <tr key={row.key || index}>
                        <td className="mono">{row.key}</td>
                        <td>{textValue(row.name || row.description)}</td>
                        <td className={Math.abs(Number(row.meanRankIc)) >= 0.03 ? "up" : "warn"}>{num(row.meanRankIc, 4)}</td>
                        <td>{num(row.rankIcIr, 2)}</td>
                        <td>{index % 2 ? "28.5%" : "14.2%"}</td>
                        <td>{index + 1} Days</td>
                        <td><Badge tone={row.passesResearchGate ? "good" : "warn"}>{row.passesResearchGate ? "强效" : "衰退"}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
          <Panel title="Factor Agent 优化建议" icon={Bot}>
            <p className="q-agent-copy">检测到部分趋势类因子在当前震荡市环境下 Rank IC 持续下滑，建议联动量价确认因子进行正交化复合修正，以剔除无量假突破噪音。<button className="q-inline-action">一键生成复合因子表达式</button></p>
          </Panel>
        </section>

        <section id="backtest" className="q-section">
          <div className="q-toolbar">
            <h1>策略回测中心</h1>
            <select defaultValue="multi"><option value="multi">多因子机器学习选股策略_V2.1</option></select>
            <select defaultValue="zz500"><option value="zz500">中证500成份股</option></select>
            <select defaultValue="2024-2026"><option value="2024-2026">2024-2026</option></select>
          </div>
          <Panel title="核心回测绩效指标 (KPI)" icon={BarChart3}>
            <div className="q-metric-grid five">
              <MetricCard label="累计总收益率" value={pct(metrics.totalReturnPct ?? 68.42)} tone="up" />
              <MetricCard label="年化收益率" value="+24.15%" tone="up" />
              <MetricCard label="最大回撤 (MaxDD)" value={pct(-(metrics.maxDrawdownPct ?? 8.21))} tone="down" />
              <MetricCard label="夏普比率 (Sharpe)" value="2.14" />
              <MetricCard label="盈亏比 / 胜率" value={`2.3 : 1 / ${num(metrics.winRatePct ?? 56.4, 1)}%`} />
            </div>
          </Panel>
          <Panel title="动态回撤流向图" icon={LineChart}><DrawdownChart /></Panel>
          <Panel title="Backtest Agent 归因分析" icon={Bot}>
            <p className="q-agent-copy">本策略主要收益超额来自半导体与电力设备行业风格暴露。最大回撤发生在系统性缩量阶段，建议允许 AI 自动注入风控规则，在下一次迭代中过滤大盘缩量期。</p>
          </Panel>
        </section>

        <section id="risk" className="q-section">
          <div className="q-toolbar">
            <h1>风控总控制台</h1>
            <Badge tone="good">当前安全状态：风险极低</Badge>
            <span>全局止损线：-5.0%</span>
            <span>单票最大持仓上限：30%</span>
            <Badge tone="lock">自动熔断: ON</Badge>
          </div>
          <div className="q-two-col">
            <Panel title="标的池黑名单硬过滤 (Hard Rules)" icon={ShieldCheck}>
              <div className="q-table-wrap compact">
                <table className="q-table"><thead><tr><th>过滤大类</th><th>触发规则</th><th>隔离状态</th></tr></thead><tbody>
                  <tr><td>财务暴雷</td><td>扣非净利润 &lt; 0</td><td><Badge tone="lock">开启</Badge></td></tr>
                  <tr><td>垃圾股</td><td>ST / *ST / 退市</td><td><Badge tone="lock">开启</Badge></td></tr>
                  <tr><td>流动性</td><td>日成交额 &lt; 3000万</td><td><Badge tone="lock">开启</Badge></td></tr>
                  <tr><td>技术破位</td><td>跌破MA20关键均线</td><td><Badge tone="lock">开启</Badge></td></tr>
                </tbody></table>
              </div>
            </Panel>
            <Panel title="动态仓位管理逻辑 (Dynamic Positioning)" icon={WalletCards}>
              <div className="q-table-wrap compact">
                <table className="q-table"><thead><tr><th>市场情绪环境</th><th>建议基准仓位</th><th>当前执行状态</th></tr></thead><tbody>
                  <tr><td>极强/牛市</td><td>60% - 80%</td><td><Badge>未达到</Badge></td></tr>
                  <tr><td>震荡/题材</td><td>20% - 40%</td><td><Badge tone="warn">激活中 (当前 35%)</Badge></td></tr>
                  <tr><td>极弱/熊市</td><td>0% - 10%</td><td><Badge>未达到</Badge></td></tr>
                </tbody></table>
              </div>
            </Panel>
          </div>
          <Panel title="Risk Agent 实时拦截日志" icon={Bot}>
            <div className="q-log-list">
              <span>13:45:02 [拦截成功] 股票 000xxx 触发 ST/退市风险过滤，已移出策略待选池。</span>
              <span>14:22:11 [拦截成功] 股票 603xxx 综合评分达 84 分，但日内换手率超 45% 且放量长上影，触发拦截。</span>
              {strategyRows.slice(0, 2).map((row, index) => <span key={index}>14:{30 + index}:00 [策略闸门] {textValue(row.name || row.key)}：{textValue((row.gate_reasons || row.quality?.blockers || ["已完成准入检查"])[0])}</span>)}
            </div>
          </Panel>
        </section>

        <section id="agents" className="q-section">
          <div className="q-toolbar">
            <h1>AI Research Agent 工作台</h1>
            <label className="wide"><Bot size={15} /><input defaultValue="请帮我写一份今天半导体板块异动股票的复盘和策略相关度报告" suppressHydrationWarning /></label>
          </div>
          <Panel title="Agent 矩阵节点状态" icon={Bot}>
            <div className="q-agent-grid">
              {[
                ["Factor Agent", "空闲", "负责挖掘清洗因子特征，寻找 Alpha 信号来源。"],
                ["Backtest Agent", "运行", "自动化执行策略多轮历史测算与情景归因分析。"],
                ["Risk Agent", "监听", "全局扫描风控合规、黑天鹅舆情并实时进行交易拦截。"],
                ["News Agent", "空闲", "实时抓取政策公告及新闻情绪，输出量化评分。"],
                ["Report Agent", "空闲", "自动聚合各模块量化输出，生成深度复盘与分析报告。"],
              ].map(([name, state, desc]) => (
                <div key={name}><Badge tone={state === "运行" ? "warn" : "good"}>{state}</Badge><strong>{name}</strong><span>{desc}</span></div>
              ))}
            </div>
          </Panel>
          <Panel title="交互式 Agent 输出沙盒 (Sandbox Output)" icon={Bot}>
            <div className="q-sandbox">
              <strong>Report Agent :</strong>
              <p>根据最新指令，我联合 Factor Agent 与 News Agent 为您复盘：芯片相关股票池 Rank 评分中位数显著抬升；半导体/PCB/通信算力在当前快照中热度领先；Backtest Agent 正在计算相似政策利好发布后 5 日内胜率，当前进度 80%。</p>
              {decisions.slice(0, 3).map((row, index) => <p key={index}>{index + 1}. {row.code} {textValue(row.name)}: {textValue(row.decision, "WATCH")}，置信度 {num(row.confidence, 1)}。</p>)}
            </div>
          </Panel>
        </section>

        <section id="strategy-management" className="q-section">
          <div className="q-toolbar">
            <h1>策略管理中心</h1>
            <Badge tone="good">生产环境运行中: {strategyRegistry.summary?.enabled || 3} 个</Badge>
            <Badge tone="warn">沙盒测试中: 2 个</Badge>
            <Badge tone="danger">已停用: {strategyRegistry.summary?.paperBlocked || 1} 个</Badge>
            <span>全局最大杠杆率: 1.0x</span>
          </div>
          <Panel title="策略卡片式矩阵 (Strategy Matrix)" icon={Package}>
            <div className="q-strategy-grid">
              <StrategyCard
                name="Alpha-MultiModel_V2.1"
                state="运行中"
                tone="good"
                rows={[
                  ["状态：", "正常运作"],
                  ["实时仓位：", `${num(tradingMetrics.openExposurePct ?? 20, 0)}% / 30%`],
                  ["今日收益：", "+1.42%"],
                  ["夏普比率：", "2.14"],
                  ["核心标的：", textValue(activeStock.industry || activeStock.theme, "半导体/科创板")],
                ]}
                actions={["查看运行图表", "调整参数", "停用"]}
              />
              <StrategyCard
                name="High-Turnover-Trend"
                state="运行中"
                tone="good"
                rows={[
                  ["状态：", "正常运作"],
                  ["实时仓位：", "15% / 15%"],
                  ["今日收益：", "-0.35%"],
                  ["夏普比率：", "1.82"],
                  ["核心标的：", "全市场高动能个股"],
                ]}
                actions={["查看运行图表", "调整参数", "停用"]}
              />
              <StrategyCard
                name="Machine-Learning-LGBM"
                state="沙盒中"
                tone="warn"
                rows={[
                  ["状态：", "虚拟资金跑测"],
                  ["胜率：", `${num(metrics.winRatePct ?? 54.2, 1)}%`],
                  ["累计收益：", "+3.12%"],
                  ["测算天数：", "14 天"],
                  ["样本数量：", `${metrics.tradeCount || metrics.closedTrades || 32} 笔`],
                ]}
                actions={["一键切到生产环境", "清除缓存"]}
              />
              <StrategyCard
                name="News-Sentiment-Arbitrage"
                state="已停用"
                tone="danger"
                rows={[
                  ["状态：", "信号钝化引发超额回撤"],
                  ["停用时间：", "2026-06-15"],
                  ["历史总绩效：", "+8.4%"],
                  ["重启闸门：", "需重新完成 20 日沙盒验证"],
                ]}
                actions={["导出历史日志", "重新初始化"]}
              />
            </div>
          </Panel>
          <Panel title="Strategy Agent 动态调配建议" icon={Bot}>
            <p className="q-agent-copy">过去一周 High-Turnover-Trend 的胜率从 58% 下滑至 49%，归因分析显示当前市场缩量，高频追涨信号更容易触发风控长上影拦截。建议将该策略资金权重上限临时由 15% 下调至 5%。<button className="q-inline-action">允许 AI 自动下调仓位权重</button></p>
          </Panel>
        </section>

        <section id="daily-review" className="q-section">
          <div className="q-toolbar">
            <h1>每日复盘画布</h1>
            <select defaultValue="2026-07-03"><option value="2026-07-03">2026-07-03</option></select>
            <strong className="up">今日损益：￥+14,205.00 (+1.42%)</strong>
            <span>胜率：4 战 3 胜 (75%)</span>
          </div>
          <div className="q-two-col">
            <Panel title="全市场热力图一瞥 (Market Heatmap)" icon={BarChart3}>
              <div className="q-table-wrap compact">
                <table className="q-table">
                  <thead><tr><th>板块</th><th>核心领涨股</th><th>行业涨跌</th><th>热度</th></tr></thead>
                  <tbody>
                    {(reviewRows.length ? reviewRows : [{ theme: "半导体", leaders: [{ name: "中芯国际" }], pct: 3.42 }]).slice(0, 6).map((row, index) => {
                      const leader = Array.isArray(row.leaders) ? row.leaders[0] : row;
                      const change = Number(row.pct ?? row.heatScore ?? (index === 2 ? -1.2 : 3.42 - index * 0.4));
                      return (
                        <tr key={`${textValue(row.theme || row.name, "theme")}-${index}`}>
                          <td>{textValue(row.theme || row.industry || row.name, index === 1 ? "机器人" : "半导体")}</td>
                          <td>{textValue(leader?.name || row.name, "中芯国际")}</td>
                          <td className={change >= 0 ? "up" : "down"}>{pct(change, 2)}</td>
                          <td><Badge tone={index < 2 ? "up" : "neutral"}>{index < 2 ? "强" : "中"}</Badge></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
            <Panel title="今日交易流水与资金流向" icon={WalletCards}>
              <div className="q-table-wrap compact">
                <table className="q-table">
                  <thead><tr><th>时间</th><th>股票名称</th><th>操作</th><th>数量</th><th>成交价</th><th>状态</th></tr></thead>
                  <tbody>
                    {signalRows.slice(0, 5).map((row, index) => (
                      <tr key={`flow-${row.code || index}`}>
                        <td className="mono">{index === 0 ? "09:45:02" : index === 1 ? "10:15:22" : `14:${42 + index}:10`}</td>
                        <td>{textValue(row.name, "X科技")}</td>
                        <td><Badge tone={index === 4 ? "down" : "up"}>{index === 4 ? "卖出" : "买入"}</Badge></td>
                        <td>{(index + 1) * 1000}</td>
                        <td>￥{num(row.price ?? row.current_price ?? 42.1, 2)}</td>
                        <td><Badge tone="good">完全</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
          <Panel title="Report Agent 收盘全局复盘报告" icon={Bot}>
            <p className="q-agent-copy">今日市场呈现缩量弱反弹格局，系统多因子模型抓住半导体板块主力资金突袭，强关注池中多只标的保持高评分。潜在隐患：尾盘部分高换手个股出现冲高回落，系统已通过风控引擎将明日追涨阈值调高 5%。<button className="q-inline-action">导出 PDF 格式深度复盘报告</button><button className="q-inline-action">推送到 Feishu / 钉钉机器人</button></p>
          </Panel>
        </section>

        <section id="data-center" className="q-section">
          <div className="q-toolbar">
            <h1>数据中心控制台</h1>
            <span>行情源：{workbench.dataSource || "腾讯云/聚宽复合流"}</span>
            <Badge tone="good">实时延迟：12ms</Badge>
            <span>行情/因子库：ClickHouse</span>
            <span>信号缓存：Redis</span>
            <span>占用空间：42.1GB</span>
          </div>
          <Panel title="数据质量上限闸门 (Data Quality Ceiling)" icon={ShieldCheck}>
            <div className="q-data-quality-grid">
              <div>
                <span>因子去相关</span>
                <strong>Orthogonalization</strong>
                <p>近3日涨幅、近5日涨幅、MACD 金叉等同源跟涨因子进入施密特正交化，避免模型把单一趋势风险重复计权。</p>
                <Badge tone="good">上线闸门: 相关系数 &lt; 0.72</Badge>
              </div>
              <div>
                <span>Label 行业中性化</span>
                <strong>Alpha Label</strong>
                <p>预测目标统一为个股未来3日涨幅 - 所属行业指数未来3日涨幅，逼迫模型学习独立牛股特征。</p>
                <Badge tone="lock">Label = Stock R3D - Industry R3D</Badge>
              </div>
              <div>
                <span>极值截断</span>
                <strong>Winsorize</strong>
                <p>连续一字板、妖股拉升等极端样本先做 3σ 或 1%/99% 分位截断，再进入 LightGBM 训练集。</p>
                <Badge tone="warn">训练前强制执行</Badge>
              </div>
              <div>
                <span>未来数据隔离</span>
                <strong>No Leakage</strong>
                <p>盘前信号只允许读取信号时间戳之前的数据，严禁把当日成交额、开盘价或未发布公告混入因子。</p>
                <Badge tone="danger">硬拦截未来函数</Badge>
              </div>
            </div>
          </Panel>
          <Panel title="数据管道实时监控 (Data Pipelines)" icon={Database}>
            <div className="q-table-wrap">
              <table className="q-table">
                <thead><tr><th>数据流名称</th><th>刷新频率</th><th>最近同步时间</th><th>运行状态</th></tr></thead>
                <tbody>
                  <tr><td>A股日线/分钟K线</td><td>实时流 (WebSocket)</td><td>{timestamp}</td><td><Badge tone="good">连通中 (已接收 2.4M 帧)</Badge></td></tr>
                  <tr><td>盘口五档/L2逐笔</td><td>3秒滚动批处理</td><td>{timestamp}</td><td><Badge tone="good">正常</Badge></td></tr>
                  <tr><td>财务报表/公告文本</td><td>每日凌晨 02:00 自动</td><td>2026-07-03 02:05:11</td><td><Badge tone="good">正常 (无漏报)</Badge></td></tr>
                  <tr><td>舆情新闻/政策抓取</td><td>每 5 分钟增量爬取</td><td>2026-07-03 14:55:00</td><td><Badge tone="good">正常 (今日抓取 1,420 条)</Badge></td></tr>
                  <tr><td>市场宽度/赚钱效应</td><td>15秒实时聚合</td><td>{timestamp}</td><td><Badge tone="good">正常 (涨跌比/炸板率已广播)</Badge></td></tr>
                  <tr><td>新闻实体图谱映射</td><td>秒级实体抽取</td><td>2026-07-03 14:59:40</td><td><Badge tone="lock">概念标签已映射到板块/个股</Badge></td></tr>
                </tbody>
              </table>
            </div>
          </Panel>
          <div className="q-two-col">
            <Panel title="短线微观结构数据 (Order Book / Breadth)" icon={BarChart3}>
              <div className="q-table-wrap compact">
                <table className="q-table">
                  <thead><tr><th>数据项</th><th>短线用途</th><th>当前状态</th></tr></thead>
                  <tbody>
                    <tr><td>大单挂撤比</td><td>识别压盘测试、瞬时撤单与主动吃单</td><td><Badge tone="good">买一至卖五监控中</Badge></td></tr>
                    <tr><td>成交笔均金额</td><td>区分散户放量与机构大单进场</td><td><Badge tone="good">逐笔聚合中</Badge></td></tr>
                    <tr><td>全市场涨跌比曲线</td><td>衡量赚钱效应扩散或退潮</td><td><Badge tone="lock">15秒刷新</Badge></td></tr>
                    <tr><td>昨日涨停开盘溢价</td><td>游资接力情绪温度计</td><td><Badge tone="warn">明日盘前必检</Badge></td></tr>
                    <tr><td>炸板率趋势</td><td>两点后陡增则调低买入评分</td><td><Badge tone="danger">接入风控广播</Badge></td></tr>
                  </tbody>
                </table>
              </div>
            </Panel>
            <Panel title="新闻政策知识图谱化 (Entity Extraction)" icon={Bot}>
              <div className="q-knowledge-flow">
                <div><span>原始文本</span><strong>高端芯片 / 光刻胶 / 国产替代</strong></div>
                <div><span>实体抽取</span><strong>标准概念标签</strong></div>
                <div><span>图谱映射</span><strong>板块 → 个股 → 因子分</strong></div>
                <div><span>落库广播</span><strong>News Policy Factor 秒级更新</strong></div>
              </div>
              <p className="q-agent-copy">大模型不直接猜涨跌，只负责结构化抽取实体与政策方向；交易系统只消费标准化标签、映射关系和可回测的新闻/政策因子分。</p>
            </Panel>
          </div>
          <div className="q-two-col">
            <Panel title="存储与计算架构" icon={Database}>
              <div className="q-arch-grid">
                <div><span>行情与因子库</span><strong>ClickHouse / DolphinDB</strong><p>列式计算分钟 K 线、Tick、因子矩阵；500 支股票 20 日均线斜率毫秒级扫描。</p></div>
                <div><span>最终信号缓存</span><strong>Redis</strong><p>Factor Engine 输出综合评分、风控状态、交易建议，供 Dashboard 和交易接口秒级读取。</p></div>
                <div><span>关系型库角色</span><strong>PostgreSQL Meta</strong><p>只存策略配置、审计、账户和权限，不承载海量行情计算。</p></div>
              </div>
            </Panel>
            <Panel title="防偷看回测机制 (Purged Walk-Forward)" icon={Clock3}>
              <div className="q-leakage-list">
                <div><Badge tone="danger">T-Only</Badge><span>7月3日开盘前因子不得包含 7月3日成交额、开盘价、未发布公告。</span></div>
                <div><Badge tone="lock">Rolling Train</Badge><span>过去 3 个月训练，预测未来 1 周，每周自动重新训练并更新特征权重。</span></div>
                <div><Badge tone="warn">Purge Gap</Badge><span>训练/验证窗口之间强制留隔离带，防止事件标签重叠造成收益虚高。</span></div>
              </div>
            </Panel>
          </div>
          <Panel title="核心数据操作维护" icon={Settings}>
            <SystemActionsPanel compact />
          </Panel>
        </section>

        <section id="settings" className="q-section q-bottom-spacer">
          <div className="q-toolbar">
            <h1>系统全局设置</h1>
            <span>当前版本：v2.5.0-Stable</span>
            <Badge tone="lock">本地沙盒环境</Badge>
            <Badge>远程托管云端</Badge>
          </div>
          <div className="q-two-col">
            <Panel title="API 密钥与凭证管理 (Credentials)" icon={Settings}>
              <div className="q-table-wrap compact">
                <table className="q-table"><thead><tr><th>平台名称</th><th>配置状态</th><th>操作</th></tr></thead><tbody>
                  <tr><td>OpenAI API</td><td><Badge tone="good">已配置 (sk-..)</Badge></td><td><button className="q-link-button">修改</button></td></tr>
                  <tr><td>DeepSeek</td><td><Badge tone="good">已配置 (sk-..)</Badge></td><td><button className="q-link-button">修改</button></td></tr>
                  <tr><td>聚宽数据源</td><td><Badge tone="good">已绑定 (138..)</Badge></td><td><button className="q-link-button">解绑</button></td></tr>
                </tbody></table>
              </div>
            </Panel>
            <Panel title="交易接口合规配置 (Execution API)" icon={ShieldCheck}>
              <div className="q-table-wrap compact">
                <table className="q-table"><thead><tr><th>配置项名称</th><th>当前参数值</th><th>状态</th></tr></thead><tbody>
                  <tr><td>券商柜台接口</td><td>模拟交易柜台 (Sim)</td><td><Badge tone="good">生产联通</Badge></td></tr>
                  <tr><td>单笔滑点容忍</td><td>0.05 %</td><td><Badge tone="warn">极低滑点</Badge></td></tr>
                  <tr><td>默认手续费率</td><td>0.03 % (包含印花税)</td><td><Badge tone="good">已校准</Badge></td></tr>
                </tbody></table>
              </div>
            </Panel>
          </div>
          <Panel title="开发者调试工具 (Developer Flags)" icon={Settings}>
            <div className="q-flag-row">
              <label><input type="checkbox" defaultChecked readOnly suppressHydrationWarning /> 开启 Agent 原始 Prompt 日志归档</label>
              <label><input type="checkbox" defaultChecked readOnly suppressHydrationWarning /> 模拟大盘暴跌 5% 压力测试</label>
              <label><input type="checkbox" readOnly suppressHydrationWarning /> 切换至美股红绿配色体系(绿涨红跌)</label>
            </div>
          </Panel>
        </section>
      </div>

      <footer className="q-logbar">
        <strong>Agent日志</strong>
        <span>[15:00:00] FactorEngine 因子批处理完成</span>
        <span>[15:00:02] BacktestEngine 滚动回测样本更新完毕</span>
        <span>[15:00:05] RiskAgent 当前硬过滤规则全部启用</span>
      </footer>
    </main>
  );
}
