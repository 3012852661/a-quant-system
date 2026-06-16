import {
  Activity,
  BadgeCheck,
  Bell,
  Circle,
  Clock3,
  Database,
  FileBarChart,
  Gauge,
  Layers3,
  LayoutDashboard,
  ListChecks,
  RadioTower,
  Settings,
  ShieldAlert,
  TrendingUp,
  Workflow,
} from "lucide-react";
import { getWorkbenchSnapshot } from "../lib/local-data";
import { RefreshDataButton } from "./refresh-data-button";
import { TradingDesk } from "./trading-desk";

export const dynamic = "force-dynamic";

type MarketState = {
  status?: string;
  score?: number;
  note?: string;
};

type StockRow = {
  code?: string;
  name?: string;
  industry?: string;
  pct?: number | string;
  amount?: number;
  mainNet?: number;
  streak?: number;
  openCount?: number;
};

type ThemeRow = {
  name: string;
  score: number;
  limitCount: number;
  strongCount: number;
  mainNet: number;
  leaders: string[];
  followers: string[];
};

type AttackCandidate = {
  grade?: string;
  code?: string;
  name?: string;
  theme?: string;
  pct?: number;
  trigger?: string;
  stop?: number;
  maxPosition?: string;
};

type SignalRow = {
  code?: string;
  name?: string;
  tier?: string;
  blockedReasons?: string[];
  reason?: string;
  entry?: { buyZone?: string };
  exit?: { target?: number; stop?: number };
  sizing?: { hint?: string };
};

type RadarRow = {
  code?: string;
  name?: string;
  current_price?: number;
  price?: number;
  pct_chg?: number;
  pct?: number;
  turnover?: number;
  volume_ratio?: number;
  mainNet?: number;
  market_cap?: number;
  score?: number;
  momentum_score?: number;
  volume_score?: number;
  liquidity_score?: number;
  fund_score?: number;
  penalty_score?: number;
  risk_level?: string;
  tier?: string;
  action?: string;
  buy_zone?: string;
  stop_loss?: number;
  target_price?: number;
  position_hint?: string;
  ai_comment?: string;
  reasons?: string[];
};

type ContinuityReviewRow = {
  code?: string;
  name?: string;
  previousRank?: number;
  previousScore?: number;
  previousPct?: number;
  todayPrice?: number;
  todayPct?: number;
  todayTurnover?: number;
  todayVolumeRatio?: number;
  todayTime?: string;
  status?: string;
  label?: string;
  action?: string;
  severity?: string;
  reason?: string;
};

type ContinuityAddedRow = {
  code?: string;
  name?: string;
  todayRank?: number;
  score?: number;
  pct?: number;
  turnover?: number;
  volumeRatio?: number;
  risk?: string;
  action?: string;
};

type Workbench = {
  updatedAt?: string;
  dataSource?: string;
  dataHealth?: {
    tradeDate: string;
    isStale: boolean;
    staleFiles: string[];
    message: string;
  };
  marketState: MarketState;
  openWatch: {
    counts: Record<string, number>;
    newLimitUps: StockRow[];
    strongToLimit: StockRow[];
    removedLimitUps: StockRow[];
    newStrong: StockRow[];
    attackThemes: ThemeRow[];
    attackCandidates: AttackCandidate[];
    events: EventRow[];
  };
  signals: {
    stats: Record<string, number>;
    trade: SignalRow[];
    watch: SignalRow[];
    avoid: SignalRow[];
    risk: Record<string, unknown>;
  };
  recommendation: {
    status: string;
    liveBuyAllowed: boolean;
    recommendedBuys: SignalRow[];
    reasons: string[];
    watchPlan: Array<Record<string, unknown>>;
    qualityRadar: RadarRow[];
    upliftTop: RadarRow[];
  };
  verification: {
    backtest: Record<string, number | null>;
    paper: Record<string, number | null>;
  };
  system: {
    modules: SystemModule[];
    files: Record<string, Record<string, unknown>>;
    dataAudit?: DataAudit;
  };
  continuity?: {
    generatedAt?: string;
    modelNote?: string;
    summary?: Record<string, number>;
    reviewRows?: ContinuityReviewRow[];
    addedRows?: ContinuityAddedRow[];
    priorityRows?: Array<ContinuityReviewRow | ContinuityAddedRow>;
  };
};

type DataAudit = {
  status?: string;
  tradeDate?: string;
  providerMode?: string;
  poolRunAt?: string;
  poolTradeDate?: string;
  poolInput?: string;
  poolSize?: number;
  liveSource?: string;
  liveGeneratedAt?: string;
  latestLiveTime?: string;
  liveRows?: number;
  liveQuoteCodes?: number;
  overlap?: number;
  overlapPct?: number;
  liveQuotesMatchLatestPool?: boolean;
  issues?: Array<{ level?: string; message?: string }>;
  files?: Array<{ label?: string; path?: string; exists?: boolean; size?: number; updatedAtIso?: string | null }>;
  refreshReport?: {
    ok?: boolean;
    startedAt?: string;
    finishedAt?: string;
    warning?: string;
    detail?: string;
    steps?: Array<{ script?: string; ok?: boolean; stdout?: string; stderr?: string }>;
  };
};

type EventRow = StockRow & {
  type?: string;
  generatedAt?: string;
  requestTime?: string;
  marketStatus?: string;
};

type SystemModule = {
  id?: number;
  name: string;
  cnName?: string;
  status: "OK" | "MISSING" | string;
  detail: string;
  signal?: string;
};

const emptyWorkbench: Workbench = {
  marketState: {},
  openWatch: {
    counts: {},
    newLimitUps: [],
    strongToLimit: [],
    removedLimitUps: [],
    newStrong: [],
    attackThemes: [],
    attackCandidates: [],
    events: [],
  },
  signals: { stats: {}, trade: [], watch: [], avoid: [], risk: {} },
  recommendation: {
    status: "UNKNOWN",
    liveBuyAllowed: false,
    recommendedBuys: [],
    reasons: [],
    watchPlan: [],
    qualityRadar: [],
    upliftTop: [],
  },
  verification: { backtest: {}, paper: {} },
  system: { modules: [], files: {} },
  continuity: { summary: {}, reviewRows: [], addedRows: [], priorityRows: [] },
};

async function getWorkbench(): Promise<Workbench> {
  return getWorkbenchSnapshot() as Workbench;
}

function n(value: unknown, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : "-";
}

function pct(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : "-";
}

function yi(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? `${(num / 100000000).toFixed(2)}亿` : "-";
}

function price(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(2) : "-";
}

function rawNumber(value: unknown, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function compactNames(items: string[] = []) {
  return items.length ? items.slice(0, 4).join("、") : "-";
}

function statusClass(status: string) {
  if (status === "BUY" || status === "TRADE") return "good";
  if (status === "NO_BUY" || status === "极弱") return "danger";
  return "warn";
}

function netClass(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return num >= 0 ? "up" : "down";
}

function trendSeries(row: RadarRow) {
  const pctChange = rawNumber(row.pct_chg ?? row.pct);
  const momentum = rawNumber(row.momentum_score, rawNumber(row.score) * 0.28);
  const volume = rawNumber(row.volume_score);
  const liquidity = rawNumber(row.liquidity_score);
  const fund = rawNumber(row.fund_score);
  const penalty = rawNumber(row.penalty_score);
  const points = [
    42,
    46 + pctChange * 1.8,
    48 + momentum * 1.1,
    50 + volume * 0.9,
    48 + liquidity * 0.7,
    50 + fund * 1.1 - penalty * 0.7,
    52 + rawNumber(row.score) * 0.42 + pctChange * 1.2,
  ];
  return points.map((item) => clamp(item, 18, 88));
}

function Sparkline({ row }: { row: RadarRow }) {
  const values = trendSeries(row);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(max - min, 1);
  const points = values
    .map((value, index) => {
      const x = 8 + index * 29;
      const y = 82 - ((value - min) / span) * 58;
      return `${x},${y.toFixed(1)}`;
    })
    .join(" ");
  const fillPoints = `8,88 ${points} 182,88`;
  const upTrend = values[values.length - 1] >= values[0];
  return (
    <svg className={`sparkline ${upTrend ? "sparklineUp" : "sparklineDown"}`} viewBox="0 0 190 96" role="img" aria-label="趋势线">
      <defs>
        <linearGradient id={`sparkFill-${row.code}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={upTrend ? "#c83232" : "#0a7a53"} stopOpacity="0.22" />
          <stop offset="100%" stopColor={upTrend ? "#c83232" : "#0a7a53"} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M8 74H182" className="sparkBase" />
      <polygon points={fillPoints} fill={`url(#sparkFill-${row.code})`} />
      <polyline points={points} className={upTrend ? "sparkUp" : "sparkDown"} />
      {values.map((_, index) => {
        const [cx, cy] = points.split(" ")[index].split(",");
        return <circle key={`${row.code}-${index}`} cx={cx} cy={cy} r={index === values.length - 1 ? 3.2 : 2.1} />;
      })}
    </svg>
  );
}

function ScoreBar({ label, value, max = 20 }: { label: string; value: unknown; max?: number }) {
  const num = rawNumber(value);
  const width = clamp((num / max) * 100, 0, 100);
  return (
    <div className="scoreBar">
      <span>{label}</span>
      <div>
        <i style={{ width: `${width}%` }} />
      </div>
      <b>{n(num, 1)}</b>
    </div>
  );
}

function trendRadar(rows: RadarRow[]) {
  if (!rows.length) return <div className="emptyBlock">暂无趋势雷达数据</div>;
  return (
    <div className="trendGrid">
      {rows.slice(0, 6).map((row) => {
        const currentPrice = row.current_price ?? row.price;
        const change = row.pct_chg ?? row.pct;
        return (
          <article className="trendCard" key={`${row.code}-${row.name}`}>
            <div className="trendTopline">
              <div>
                <strong>{row.name || "-"}</strong>
                <span className="mono">{row.code || "-"}</span>
              </div>
              <span className={`riskBadge ${row.risk_level === "高" ? "danger" : row.risk_level === "低" ? "good" : "warn"}`}>
                {row.risk_level || row.tier || "-"}
              </span>
            </div>
            <div className="trendPriceRow">
              <div>
                <span>现价</span>
                <strong>{price(currentPrice)}</strong>
              </div>
              <div>
                <span>涨跌</span>
                <strong className={rawNumber(change) >= 0 ? "up" : "down"}>{pct(change)}</strong>
              </div>
              <div>
                <span>评分</span>
                <strong>{n(row.score, 1)}</strong>
              </div>
            </div>
            <Sparkline row={row} />
            <div className="priceBand">
              <span>止损 {price(row.stop_loss)}</span>
              <i />
              <span>目标 {price(row.target_price)}</span>
            </div>
            <div className="scoreStack">
              <ScoreBar label="动量" value={row.momentum_score} />
              <ScoreBar label="量能" value={row.volume_score} />
              <ScoreBar label="资金" value={row.fund_score} />
            </div>
            <p className="trendNote">{row.ai_comment || row.reasons?.slice(0, 2).join("；") || row.action || "等待更多盘中确认。"}</p>
            <div className="trendMeta">
              <span>量比 {n(row.volume_ratio, 2)}</span>
              <span>换手 {pct(row.turnover)}</span>
              <span>{row.position_hint || row.buy_zone || "-"}</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function stockTable(rows: StockRow[], mode: "limit" | "strong") {
  if (!rows.length) return <div className="emptyBlock">当前轮次暂无事件</div>;
  return (
    <table className="denseTable">
      <thead>
        <tr>
          <th>代码</th>
          <th>名称</th>
          <th>行业</th>
          <th>涨跌</th>
          <th>成交额</th>
          <th>主力净流入</th>
          {mode === "limit" && <th>连板/开板</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.code}-${row.name}`}>
            <td className="mono">{row.code}</td>
            <td className="nameCell">{row.name}</td>
            <td>{row.industry || "-"}</td>
            <td className="up">{pct(row.pct)}</td>
            <td>{yi(row.amount)}</td>
            <td className={netClass(row.mainNet)}>{yi(row.mainNet)}</td>
            {mode === "limit" && (
              <td>
                {row.streak ?? "-"} / {row.openCount ?? "-"}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function eventLabel(type?: string) {
  return {
    NEW_LIMIT_UP: "新增封板",
    STRONG_TO_LIMIT: "强势转板",
    REMOVED_LIMIT_UP: "开板移出",
    NEW_STRONG_NOT_LIMIT: "新增强势",
  }[type || ""] || type || "-";
}

function eventClass(type?: string) {
  if (type === "REMOVED_LIMIT_UP") return "eventWarn";
  if (type === "NEW_STRONG_NOT_LIMIT") return "eventInfo";
  return "eventHot";
}

function signalTable(rows: SignalRow[], emptyText: string) {
  if (!rows.length) return <div className="emptyBlock">{emptyText}</div>;
  return (
    <table className="denseTable">
      <thead>
        <tr>
          <th>层</th>
          <th>代码</th>
          <th>名称</th>
          <th>买区</th>
          <th>目标/风险线</th>
          <th>仓位</th>
          <th>理由</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.tier}-${row.code}-${row.name}`}>
            <td>{row.tier || "-"}</td>
            <td className="mono">{row.code}</td>
            <td className="nameCell">{row.name}</td>
            <td>{row.entry?.buyZone || "-"}</td>
            <td>
              {n(row.exit?.target)} / {n(row.exit?.stop)}
            </td>
            <td>{row.sizing?.hint || "-"}</td>
            <td className="reasonCell">
              {row.blockedReasons?.length ? row.blockedReasons.join("；") : row.reason || "-"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function continuityBadge(row: ContinuityReviewRow) {
  const cls = row.severity === "danger" ? "danger" : row.severity === "good" ? "good" : "warn";
  return <span className={`miniBadge ${cls}`}>{row.label || row.status || "-"}</span>;
}

function continuityTable(rows: ContinuityReviewRow[]) {
  if (!rows.length) return <div className="emptyBlock">暂无昨日复核数据</div>;
  return (
    <table className="denseTable continuityTable">
      <thead>
        <tr>
          <th>昨排</th>
          <th>代码</th>
          <th>名称</th>
          <th>昨分</th>
          <th>今日涨跌</th>
          <th>量比/换手</th>
          <th>状态</th>
          <th>处理</th>
          <th>原因</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.previousRank}-${row.code}`}>
            <td>{row.previousRank ?? "-"}</td>
            <td className="mono">{row.code}</td>
            <td className="nameCell">{row.name}</td>
            <td>{n(row.previousScore, 1)}</td>
            <td className={rawNumber(row.todayPct) >= 0 ? "up" : "down"}>{pct(row.todayPct)}</td>
            <td>
              {n(row.todayVolumeRatio, 2)} / {pct(row.todayTurnover)}
            </td>
            <td>{continuityBadge(row)}</td>
            <td>{row.action || "-"}</td>
            <td className="reasonCell">{row.reason || "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function addedTable(rows: ContinuityAddedRow[]) {
  if (!rows.length) return <div className="emptyBlock">暂无今日新增候选</div>;
  return (
    <table className="denseTable continuityTable">
      <thead>
        <tr>
          <th>新排</th>
          <th>代码</th>
          <th>名称</th>
          <th>分数</th>
          <th>涨跌</th>
          <th>量比/换手</th>
          <th>风险</th>
          <th>动作</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 12).map((row) => (
          <tr key={`${row.todayRank}-${row.code}`}>
            <td>{row.todayRank ?? "-"}</td>
            <td className="mono">{row.code}</td>
            <td className="nameCell">{row.name}</td>
            <td>{n(row.score, 1)}</td>
            <td className={rawNumber(row.pct) >= 0 ? "up" : "down"}>{pct(row.pct)}</td>
            <td>
              {n(row.volumeRatio, 2)} / {pct(row.turnover)}
            </td>
            <td>{row.risk || "-"}</td>
            <td>{row.action || "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SectionTitle({
  title,
  meta,
  icon,
}: {
  title: string;
  meta: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="sectionTitle">
      <span className="sectionIcon">{icon}</span>
      <div>
        <h2>{title}</h2>
        <p>{meta}</p>
      </div>
    </div>
  );
}

function systemMatrix(modules: SystemModule[]) {
  if (!modules.length) return <div className="emptyBlock">暂无核心模块状态</div>;
  return (
    <div className="coreGrid">
      {modules.map((item) => (
        <article className="coreItem" key={`${item.id}-${item.name}`}>
          <div className="coreHead">
            <span className="coreIndex">{String(item.id ?? "-").padStart(2, "0")}</span>
            <span className={`coreStatus ${item.status === "OK" ? "good" : item.status === "MISSING" ? "danger" : "warn"}`}>
              {item.status === "OK" ? "在线" : item.status === "MISSING" ? "缺失" : "规划"}
            </span>
          </div>
          <strong>{item.name}</strong>
          <small>{item.cnName || "-"}</small>
          <p>{item.detail}</p>
          <div className="coreSignal">
            <span className={`healthDot ${item.status === "OK" ? "ok" : "missing"}`} />
            {item.signal || item.detail}
          </div>
        </article>
      ))}
    </div>
  );
}

function providerName(mode?: string) {
  return {
    LIVE_EASTMONEY: "东方财富实时",
    LIVE_TENCENT: "腾讯实时",
    LIVE_AKSHARE: "AkShare实时",
    LOCAL_FALLBACK: "本地兜底",
    FILE_INPUT: "文件输入",
    UNKNOWN: "未知",
  }[mode || "UNKNOWN"] || mode || "未知";
}

function auditClass(level?: string) {
  if (level === "OK") return "good";
  if (level === "BLOCK") return "danger";
  return "warn";
}

function shortPath(value?: string) {
  if (!value) return "-";
  return value.replace(/^.*?(reports\/data|quant-system\/backend|quant-system\/data)/, "$1");
}

function dataAuditPanel(audit?: DataAudit) {
  if (!audit) return <div className="emptyBlock">暂无数据审计</div>;
  const steps = audit.refreshReport?.steps || [];
  return (
    <div className="auditPanel">
      <div className="auditSummary">
        <div className={`auditStatus ${auditClass(audit.status)}`}>
          <span>状态</span>
          <strong>{audit.status || "UNKNOWN"}</strong>
        </div>
        <div>
          <span>数据源</span>
          <strong>{providerName(audit.providerMode)}</strong>
          <small>{shortPath(audit.poolInput)}</small>
        </div>
        <div>
          <span>候选池</span>
          <strong>{audit.poolSize ?? 0} 只</strong>
          <small>{audit.poolRunAt || "-"}</small>
        </div>
        <div>
          <span>实时行情</span>
          <strong>{audit.liveRows ?? 0} 行</strong>
          <small>{audit.latestLiveTime || audit.liveGeneratedAt || "-"}</small>
        </div>
        <div>
          <span>代码重合</span>
          <strong>{audit.overlap ?? 0} / {audit.poolSize ?? 0}</strong>
          <small>{n(audit.overlapPct, 1)}%</small>
        </div>
      </div>

      <div className="auditIssues">
        {(audit.issues || []).map((item, index) => (
          <div className="auditIssue" key={`${item.level}-${index}`}>
            <span className={`miniBadge ${auditClass(item.level)}`}>{item.level || "WARN"}</span>
            <p>{item.message || "-"}</p>
          </div>
        ))}
      </div>

      <div className="auditColumns">
        <table className="denseTable auditTable">
          <thead>
            <tr>
              <th>文件</th>
              <th>状态</th>
              <th>更新时间</th>
              <th>大小</th>
            </tr>
          </thead>
          <tbody>
            {(audit.files || []).map((file) => (
              <tr key={`${file.label}-${file.path}`}>
                <td>{file.label || "-"}</td>
                <td>{file.exists ? <span className="miniBadge good">存在</span> : <span className="miniBadge danger">缺失</span>}</td>
                <td className="mono">{file.updatedAtIso || "-"}</td>
                <td>{file.size ? `${Math.round(file.size / 1024)} KB` : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <table className="denseTable auditTable">
          <thead>
            <tr>
              <th>刷新步骤</th>
              <th>结果</th>
              <th>摘要</th>
            </tr>
          </thead>
          <tbody>
            {steps.length ? (
              steps.map((step) => (
                <tr key={`${step.script}-${step.ok}`}>
                  <td>{step.script || "-"}</td>
                  <td>{step.ok ? <span className="miniBadge good">OK</span> : <span className="miniBadge warn">警告</span>}</td>
                  <td className="reasonCell">{step.stderr || step.stdout || "-"}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={3}>暂无刷新记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sourceLabel(source?: string) {
  if (!source) return "-";
  if (source.includes("fallback:")) return "本地兜底";
  if (source.includes("eastmoney")) return "东方财富实时";
  if (source.includes("akshare")) return "AkShare实时";
  return source;
}

export default async function Page() {
  const data = await getWorkbench();
  const counts = data.openWatch.counts || {};
  const status = data.recommendation.status || "UNKNOWN";
  const marketStatus = data.marketState.status || "-";
  const backtest = data.verification.backtest || {};
  const paper = data.verification.paper || {};
  const tradeReady = data.signals.stats.tradeReady ?? data.signals.trade.length;
  const closedTrades = Number(backtest.closedTrades || 0);
  const buyCount = Number(backtest.buyCount || 0);
  const radarRows = data.recommendation.qualityRadar.length
    ? data.recommendation.qualityRadar
    : data.recommendation.upliftTop;

  return (
    <main className="appShell">
      <aside className="rail" aria-label="系统导航">
        <div className="brand">
          <div className="brandMark">Q</div>
          <div>
            <strong>QuantOS</strong>
            <span>A股事件驱动</span>
          </div>
        </div>
        <nav className="navList">
          <a className="navItem active" href="#workspace-top">
            <LayoutDashboard size={17} />
            盘中工作台
          </a>
          <a className="navItem" href="#radar">
            <TrendingUp size={17} />
            趋势雷达
          </a>
          <a className="navItem" href="#continuity">
            <BadgeCheck size={17} />
            连续复核
          </a>
          <a className="navItem" href="#trading">
            <ShieldAlert size={17} />
            模拟交易
          </a>
          <a className="navItem" href="#events">
            <RadioTower size={17} />
            事件监控
          </a>
          <a className="navItem" href="#themes">
            <Layers3 size={17} />
            主线强度
          </a>
          <a className="navItem" href="#signals">
            <ListChecks size={17} />
            标准信号
          </a>
          <a className="navItem" href="#watch">
            <Bell size={17} />
            WATCH 阻塞
          </a>
          <a className="navItem" href="#system">
            <FileBarChart size={17} />
            系统核心
          </a>
          <a className="navItem" href="#data-audit">
            <Database size={17} />
            数据审计
          </a>
        </nav>
        <div className="railFooter">
          <Settings size={16} />
          <span>研究模式</span>
        </div>
      </aside>

      <div className="workspace" id="workspace-top">
        <header className="commandBar">
          <div>
            <p className="eyebrow">Trading Command Center</p>
            <h1>A股盘中量化工作台</h1>
          </div>
          <div className="commandActions">
            <span className="timestamp">
              <Circle size={8} fill="currentColor" />
              {data.updatedAt || "-"}
            </span>
            {data.dataHealth?.isStale && <span className="timestamp staleState">数据过期</span>}
            <span className="timestamp dataSource" title={data.dataSource || ""}>
              源 {sourceLabel(data.dataSource)}
            </span>
            <RefreshDataButton />
          </div>
        </header>

        <section className="decisionDeck" aria-label="当前决策">
          {data.dataHealth?.isStale && (
            <div className="dataAlert">
              <Database size={16} />
              <span>{data.dataHealth.message}</span>
            </div>
          )}
          <div className="decisionPanel">
            <span className={`statusPill ${statusClass(status)}`}>{status}</span>
            <div>
              <strong>{data.recommendation.liveBuyAllowed ? "允许进入可买区" : "当前不允许开新仓"}</strong>
              <p>{data.marketState.note || "等待事件、信号、风控和验证共同确认。"}</p>
            </div>
          </div>
          <div className="reasonStack">
            {(data.recommendation.reasons || []).slice(0, 5).map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </section>

        <section className="statStrip" aria-label="关键状态">
          <div className="statCell">
            <Gauge size={18} />
            <span>市场</span>
            <strong className={statusClass(marketStatus)}>{marketStatus}</strong>
            <small>{data.marketState.score ?? "-"} / 8</small>
          </div>
          <div className="statCell accentRed">
            <Bell size={18} />
            <span>新增封板</span>
            <strong>{counts.newLimitUp ?? 0}</strong>
            <small>涨停池 {counts.limitUp ?? 0}</small>
          </div>
          <div className="statCell">
            <TrendingUp size={18} />
            <span>转封板</span>
            <strong>{counts.strongToLimit ?? 0}</strong>
            <small>强势未封 {counts.strongNotLimit ?? 0}</small>
          </div>
          <div className="statCell">
            <ShieldAlert size={18} />
            <span>TRADE</span>
            <strong>{tradeReady}</strong>
            <small>WATCH {data.signals.stats.watch ?? data.signals.watch.length}</small>
          </div>
          <div className="statCell">
            <BadgeCheck size={18} />
            <span>昨日保留</span>
            <strong>{data.continuity?.summary?.kept ?? "-"}</strong>
            <small>仍强 {data.continuity?.summary?.stillStrong ?? 0} / 新增 {data.continuity?.summary?.added ?? 0}</small>
          </div>
          <div className="statCell">
            <Activity size={18} />
            <span>纸面敞口</span>
            <strong>{pct(paper.openExposurePct)}</strong>
            <small>收益 {pct(paper.totalReturnPct)}</small>
          </div>
        </section>

        <section className="terminalGrid">
          <div className="surface spanFull" id="radar">
            <div className="surfaceHeader">
              <SectionTitle title="趋势雷达" meta="候选股走势、目标区间、评分拆解" icon={<TrendingUp size={18} />} />
              <span className="countBadge">{radarRows.length}</span>
            </div>
            {trendRadar(radarRows)}
          </div>

          <div className="surface spanFull" id="continuity">
            <div className="surfaceHeader">
              <SectionTitle title="昨日推荐复核" meta="连续跟踪去留原因与今日新增" icon={<BadgeCheck size={18} />} />
              <span className="countBadge">{data.continuity?.summary?.previousTotal ?? 0}</span>
            </div>
            <div className="continuitySummary">
              <div>
                <span>保留</span>
                <strong className="good">{data.continuity?.summary?.kept ?? 0}</strong>
              </div>
              <div>
                <span>仍强观察</span>
                <strong className="good">{data.continuity?.summary?.stillStrong ?? 0}</strong>
              </div>
              <div>
                <span>降温</span>
                <strong className="warn">{data.continuity?.summary?.cooled ?? 0}</strong>
              </div>
              <div>
                <span>过热</span>
                <strong className="warn">{data.continuity?.summary?.overheated ?? 0}</strong>
              </div>
              <div>
                <span>剔除</span>
                <strong className="danger">{data.continuity?.summary?.dropped ?? 0}</strong>
              </div>
              <div>
                <span>今日新增</span>
                <strong>{data.continuity?.summary?.added ?? 0}</strong>
              </div>
            </div>
            {data.continuity?.modelNote && <div className="continuityNote">{data.continuity.modelNote}</div>}
            {continuityTable((data.continuity?.reviewRows || []).slice(0, 30))}
          </div>

          <div className="surface spanFull" id="new-picks">
            <div className="surfaceHeader">
              <SectionTitle title="今日新增候选" meta="剔除昨日 Top30 后的新强势票" icon={<TrendingUp size={18} />} />
              <span className="countBadge">{data.continuity?.summary?.added ?? 0}</span>
            </div>
            {addedTable(data.continuity?.addedRows || [])}
          </div>

          <div className="surface spanFull" id="system">
            <div className="surfaceHeader">
              <SectionTitle title="系统核心矩阵" meta="10 个核心能力状态与作用" icon={<Workflow size={18} />} />
              <span className="countBadge">{data.system.modules.length}</span>
            </div>
            {systemMatrix(data.system.modules || [])}
            <div className="gateGrid">
              <div className="gateItem">
                <Database size={16} />
                <span>样本约束</span>
                <strong>{buyCount} / 20</strong>
                <small>回测买入次数</small>
              </div>
              <div className="gateItem">
                <FileBarChart size={16} />
                <span>闭环交易</span>
                <strong>{closedTrades} / 20</strong>
                <small>已平仓样本</small>
              </div>
              <div className="gateItem">
                <ShieldAlert size={16} />
                <span>风控闸门</span>
                <strong className={statusClass(status)}>{status}</strong>
                <small>{data.recommendation.liveBuyAllowed ? "允许" : "禁止"}新仓</small>
              </div>
            </div>
          </div>

          <div className="surface spanFull" id="data-audit">
            <div className="surfaceHeader">
              <SectionTitle title="数据源审计" meta="刷新链路、文件时间、行情与候选池一致性" icon={<Database size={18} />} />
              <span className={`countBadge ${auditClass(data.system.dataAudit?.status)}`}>{data.system.dataAudit?.status || "UNKNOWN"}</span>
            </div>
            {dataAuditPanel(data.system.dataAudit)}
          </div>

          <div className="surface spanFull" id="trading">
            <div className="surfaceHeader">
              <SectionTitle title="模拟交易台" meta="风控预检、纸面委托、持仓" icon={<ShieldAlert size={18} />} />
            </div>
            <TradingDesk />
          </div>

          <div className="surface spanWide" id="events">
            <div className="surfaceHeader">
              <SectionTitle title="新增封板" meta="开盘事件流" icon={<RadioTower size={18} />} />
              <span className="countBadge">{data.openWatch.newLimitUps.length}</span>
            </div>
            {stockTable(data.openWatch.newLimitUps.slice(0, 12), "limit")}
          </div>

          <div className="surface" id="timeline">
            <div className="surfaceHeader">
              <SectionTitle title="事件时间线" meta="最近事件" icon={<Clock3 size={18} />} />
              <span className="countBadge">{data.openWatch.events?.length || 0}</span>
            </div>
            <div className="eventList">
              {(data.openWatch.events || []).slice(0, 12).map((event, index) => (
                <div className="eventItem" key={`${event.type}-${event.code}-${event.generatedAt}-${index}`}>
                  <span className={`eventType ${eventClass(event.type)}`}>{eventLabel(event.type)}</span>
                  <div>
                    <strong>
                      {event.name} <span className="mono">{event.code}</span>
                    </strong>
                    <p>
                      {event.industry || "-"} · {pct(event.pct)} · {yi(event.mainNet)}
                    </p>
                  </div>
                  <time>{event.requestTime || event.generatedAt || "-"}</time>
                </div>
              ))}
              {!(data.openWatch.events || []).length && <div className="emptyBlock">暂无事件日志</div>}
            </div>
          </div>

          <div className="surface" id="themes">
            <div className="surfaceHeader">
              <SectionTitle title="主线扩散" meta="攻击分排序" icon={<Layers3 size={18} />} />
            </div>
            <table className="denseTable themesTable">
              <thead>
                <tr>
                  <th>主线</th>
                  <th>分</th>
                  <th>板</th>
                  <th>强</th>
                  <th>资金</th>
                </tr>
              </thead>
              <tbody>
                {data.openWatch.attackThemes.slice(0, 8).map((theme) => (
                  <tr key={theme.name}>
                    <td>
                      <div className="themeName">{theme.name}</div>
                      <small>{compactNames(theme.leaders)}</small>
                    </td>
                    <td className="scoreCell">{theme.score}</td>
                    <td>{theme.limitCount}</td>
                    <td>{theme.strongCount}</td>
                    <td className={netClass(theme.mainNet)}>{yi(theme.mainNet)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="surface" id="attack">
            <div className="surfaceHeader">
              <SectionTitle title="主攻观察" meta="非买入信号" icon={<TrendingUp size={18} />} />
            </div>
            {data.openWatch.attackCandidates.length ? (
              <table className="denseTable">
                <thead>
                  <tr>
                    <th>档</th>
                    <th>代码</th>
                    <th>名称</th>
                    <th>主线</th>
                    <th>触发</th>
                  </tr>
                </thead>
                <tbody>
                  {data.openWatch.attackCandidates.map((row) => (
                    <tr key={`${row.grade}-${row.code}`}>
                      <td><span className="gradeBadge">{row.grade || "-"}</span></td>
                      <td className="mono">{row.code}</td>
                      <td className="nameCell">{row.name}</td>
                      <td>{row.theme || "-"}</td>
                      <td className="reasonCell">{row.trigger || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="emptyBlock">暂无主攻观察</div>
            )}
          </div>

          <div className="surface" id="signals">
            <div className="surfaceHeader">
              <SectionTitle title="标准 TRADE" meta="唯一可买来源" icon={<ListChecks size={18} />} />
            </div>
            {signalTable(data.signals.trade, "暂无 TRADE")}
          </div>

          <div className="surface" id="watch">
            <div className="surfaceHeader">
              <SectionTitle title="WATCH 阻塞" meta="等待确认" icon={<ShieldAlert size={18} />} />
            </div>
            {signalTable(data.signals.watch.slice(0, 8), "暂无 WATCH")}
          </div>

          <div className="surface spanFull" id="strong">
            <div className="surfaceHeader">
              <SectionTitle title="新增强势未封板" meta="候选雷达" icon={<Bell size={18} />} />
              <span className="countBadge">{data.openWatch.newStrong.length}</span>
            </div>
            {stockTable(data.openWatch.newStrong.slice(0, 12), "strong")}
          </div>
        </section>
      </div>
    </main>
  );
}
