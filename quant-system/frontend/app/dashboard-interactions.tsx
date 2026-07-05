"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CalendarDays,
  Clock3,
  Database,
  FlaskConical,
  LayoutDashboard,
  LineChart,
  Package,
  Search,
  Settings,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";

type AnyRow = Record<string, any>;

const fallbackRows: AnyRow[] = [
  { code: "600519", name: "贵州茅台", price: 1423.5, pct: 0.85, signal: "持有", risk: "低风险", position: "6.00%", pnl: 12.35, industry: "白酒" },
  { code: "300750", name: "宁德时代", price: 262.1, pct: 1.92, signal: "增持", risk: "低风险", position: "5.00%", pnl: 8.71, industry: "电池" },
  { code: "000858", name: "五 粮 液", price: 129.73, pct: -0.22, signal: "持有", risk: "中风险", position: "4.00%", pnl: 3.21, industry: "白酒" },
  { code: "600036", name: "招商银行", price: 42.18, pct: 0.67, signal: "增持", risk: "低风险", position: "4.00%", pnl: 6.45, industry: "银行" },
  { code: "002594", name: "比亚迪", price: 341.2, pct: -1.15, signal: "减持", risk: "中风险", position: "2.50%", pnl: -2.31, industry: "汽车" },
  { code: "688111", name: "金山办公", price: 268.88, pct: 0.31, signal: "持有", risk: "低风险", position: "2.50%", pnl: 1.02, industry: "软件" },
  { code: "300347", name: "泰格医药", price: 59.32, pct: -0.76, signal: "观察", risk: "高风险", position: "0.00%", pnl: -4.12, industry: "医药" },
  { code: "000333", name: "美的集团", price: 74.91, pct: -0.53, signal: "减持", risk: "中风险", position: "1.50%", pnl: -1.25, industry: "家电" },
  { code: "000900", name: "长江电力", price: 28.36, pct: 0.14, signal: "持有", risk: "低风险", position: "2.00%", pnl: 0.85, industry: "电力" },
  { code: "002475", name: "立讯精密", price: 32.76, pct: 2.45, signal: "增持", risk: "中风险", position: "2.50%", pnl: 3.62, industry: "消费电子" },
  { code: "688981", name: "中芯国际", price: 89.5, pct: -1.08, signal: "减持", risk: "高风险", position: "0.00%", pnl: -5.67, industry: "半导体" },
  { code: "300760", name: "迈瑞医疗", price: 316.45, pct: 0.28, signal: "持有", risk: "低风险", position: "2.00%", pnl: 2.18, industry: "医疗器械" },
];

const logSeed = [
  ["15:00:00", "INFO", "因子更新完成", "动量因子 (mom_20d) 已更新，IC: 0.087，较昨日 +0.012", "因子引擎"],
  ["14:59:58", "SIGNAL", "生成交易信号", "300750.SZ 宁德时代 生成 增持 信号，综合得分 0.82（阈值 0.70）", "信号引擎"],
  ["14:59:55", "TRADE", "虚拟调仓执行", "调仓完成：买入 300750.SZ 200 股，卖出 002594.SZ 150 股，预计滑点 0.03%", "交易引擎"],
  ["14:59:53", "RISK", "风险预警", "300347.SZ 泰格医药 波动率突破阈值（3.21% > 3.00%），已加入观察名单", "风控引擎"],
  ["14:59:50", "INFO", "市场情绪更新", "市场情绪：积极（62%）较昨日 +5%，主力净流入 312.45 亿元", "数据引擎"],
];

function pct(value: unknown, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%` : "-";
}

function num(value: unknown, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
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

function MiniChart({ period, frequency }: { period: string; frequency: string }) {
  const variant = period.length + frequency.length;
  return (
    <div className="q-chart" aria-label="核心策略累计收益率曲线">
      <svg viewBox="0 0 920 250" role="img">
        <defs>
          <linearGradient id="alphaFillInteractive" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ddFillInteractive" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#EF4444" stopOpacity="0" />
            <stop offset="100%" stopColor="#EF4444" stopOpacity="0.18" />
          </linearGradient>
        </defs>
        {[40, 80, 120, 160, 200].map((y) => <line key={y} x1="0" x2="920" y1={y} y2={y} className="grid" />)}
        {[110, 220, 330, 440, 550, 660, 770, 880].map((x) => <line key={x} x1={x} x2={x} y1="24" y2="226" className="grid" />)}
        <path className="drawdown" d="M0 178 C110 196 160 156 240 176 S380 218 470 188 610 152 710 170 830 214 920 182 L920 226 L0 226 Z" fill="url(#ddFillInteractive)" />
        <path className="bench" d={variant % 2 ? "M0 150 C120 132 190 144 278 138 S430 158 530 148 710 138 920 154" : "M0 142 C120 154 190 132 278 146 S430 168 530 156 710 148 920 160"} />
        <path className="alpha-fill" d={variant % 2 ? "M0 174 C90 138 160 146 228 116 S356 70 455 94 610 56 710 70 812 46 920 34 L920 226 L0 226 Z" : "M0 162 C95 142 150 152 225 120 S356 86 455 98 610 62 710 76 812 52 920 38 L920 226 L0 226 Z"} fill="url(#alphaFillInteractive)" />
        <path className="alpha" d={variant % 2 ? "M0 174 C90 138 160 146 228 116 S356 70 455 94 610 56 710 70 812 46 920 34" : "M0 162 C95 142 150 152 225 120 S356 86 455 98 610 62 710 76 812 52 920 38"} />
      </svg>
    </div>
  );
}

function normalizeCode(value: unknown) {
  return String(value || "").replace(/\D/g, "").slice(0, 6).padStart(6, "0");
}

function riskTone(row: AnyRow, score: number) {
  const riskLabel = textValue(row.risk || row.risk_level, "");
  if (riskLabel.includes("高") || score >= 85) return "danger";
  if (riskLabel.includes("中") || score >= 75) return "warn";
  return "good";
}

const navItems = [
  { id: "dashboard", label: "首页总览", icon: LayoutDashboard },
  { id: "signals", label: "股票信号", icon: LineChart },
  { id: "factors", label: "因子实验", icon: FlaskConical },
  { id: "backtest", label: "回测中心", icon: Clock3 },
  { id: "risk", label: "风控中心", icon: ShieldCheck },
  { id: "agents", label: "AI 助手", icon: Bot },
  { id: "strategy-management", label: "策略管理", icon: Package },
  { id: "daily-review", label: "每日复盘", icon: CalendarDays },
  { id: "data-center", label: "数据中心", icon: Database },
  { id: "settings", label: "系统设置", icon: Settings, href: "/settings" },
];

export function InteractiveSideNav() {
  const [active, setActive] = useState("dashboard");
  return (
    <nav>
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <a key={item.id} href={item.href || `#${item.id}`} className={active === item.id ? "active" : ""} onClick={() => setActive(item.id)}>
            <Icon size={17} />
            <span>{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function InteractivePerformancePanel() {
  const [period, setPeriod] = useState("近3月");
  const [frequency, setFrequency] = useState("daily");
  const periods = ["近1月", "近3月", "近6月", "近1年", "今年以来", "全部"];
  const multiplier = Math.max(1, periods.indexOf(period) + 1);
  const strategyReturn = 18 + multiplier * 2.41;
  const benchReturn = 8 + multiplier * 1.02;
  return (
    <Panel title="策略表现" icon={TrendingUp} className="q-performance-panel">
      <div className="q-chart-head">
        <div className="q-segments">
          {periods.map((item) => (
            <button key={item} type="button" className={period === item ? "active" : ""} onClick={() => setPeriod(item)}>
              {item}
            </button>
          ))}
        </div>
        <select value={frequency} onChange={(event) => setFrequency(event.target.value)}>
          <option value="daily">日频</option>
          <option value="weekly">周频</option>
          <option value="monthly">月频</option>
        </select>
      </div>
      <div className="q-legend">
        <span className="alpha-dot" /> AI-Quant 策略 {(1 + strategyReturn / 100).toFixed(4)} ({pct(strategyReturn)})
        <span className="bench-dot" /> 中证500 {(1 + benchReturn / 100).toFixed(4)} ({pct(benchReturn)})
      </div>
      <MiniChart period={period} frequency={frequency} />
      <div className="q-range-chart"><Sparkline tone="blue" variant={multiplier} /></div>
      <p className="q-chart-note">当前视图：{period} / {frequency === "daily" ? "日频" : frequency === "weekly" ? "周频" : "月频"}，净值基期：1.0000（2026-04-03）</p>
    </Panel>
  );
}

export function InteractiveWatchlist({ rows }: { rows: AnyRow[] }) {
  const [query, setQuery] = useState("");
  const [industry, setIndustry] = useState("all");
  const [risk, setRisk] = useState("all");
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<"score" | "pct" | "pnl">("score");
  const source = useMemo(() => [...rows, ...fallbackRows].slice(0, 40), [rows]);
  const industries = useMemo(() => Array.from(new Set(source.map((row) => textValue(row.industry || row.theme, "")).filter(Boolean))).slice(0, 10), [source]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return source
      .filter((row, index) => {
        const code = normalizeCode(row.code || fallbackRows[index % fallbackRows.length].code);
        const name = textValue(row.name, fallbackRows[index % fallbackRows.length].name).toLowerCase();
        const rowIndustry = textValue(row.industry || row.theme, "");
        const score = Number(row.score ?? row.factorCompositeScore ?? row.emotionScore ?? 70);
        const rowRiskTone = riskTone(row, score);
        return (!term || code.includes(term) || name.includes(term)) && (industry === "all" || rowIndustry === industry) && (risk === "all" || rowRiskTone === risk);
      })
      .sort((a, b) => {
        const value = (row: AnyRow) => {
          if (sortKey === "pct") return Number(row.pct_chg ?? row.pct ?? 0);
          if (sortKey === "pnl") return Number(row.pnl ?? row.returnPct ?? 0);
          return Number(row.score ?? row.factorCompositeScore ?? row.emotionScore ?? 70);
        };
        return value(b) - value(a);
      });
  }, [industry, query, risk, sortKey, source]);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <Panel title="自选股票池" icon={Search} className="q-watch-panel">
      <div className="q-watch-toolbar">
        <label><Search size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="代码 / 名称" /></label>
        <select value={industry} onChange={(event) => { setIndustry(event.target.value); setPage(1); }}>
          <option value="all">全部行业</option>
          {industries.map((item) => <option value={item} key={item}>{item}</option>)}
        </select>
        <select value={risk} onChange={(event) => { setRisk(event.target.value); setPage(1); }}>
          <option value="all">风险状态</option>
          <option value="good">低风险</option>
          <option value="warn">中风险</option>
          <option value="danger">高风险</option>
        </select>
        <button type="button" onClick={() => setSortKey(sortKey === "score" ? "pct" : sortKey === "pct" ? "pnl" : "score")} title="切换排序">
          <Settings size={15} />
        </button>
      </div>
      <div className="q-table-wrap q-watch-table">
        <table className="q-table">
          <thead>
            <tr><th>代码</th><th>名称</th><th>最新价</th><th>涨跌幅</th><th>AI信号</th><th>风险状态</th><th>仓位建议</th><th>持仓盈亏</th></tr>
          </thead>
          <tbody>
            {pageRows.map((row, index) => {
              const realIndex = (currentPage - 1) * pageSize + index;
              const pctValue = Number(row.pct_chg ?? row.pct ?? (realIndex % 3 === 0 ? 0.85 : realIndex % 3 === 1 ? 1.92 : -0.22));
              const score = Number(row.score ?? row.factorCompositeScore ?? row.emotionScore ?? 70);
              const tone = riskTone(row, score);
              const signal = textValue(row.signal, realIndex % 4 === 1 ? "增持" : realIndex % 4 === 2 ? "减持" : realIndex % 4 === 3 ? "观察" : "持有");
              const pnl = Number(row.pnl ?? row.returnPct ?? (realIndex % 2 ? 8.71 - realIndex : 12.35 - realIndex * 0.9));
              return (
                <tr key={`watch-${row.code || realIndex}`}>
                  <td className="mono">{normalizeCode(row.code || fallbackRows[realIndex % fallbackRows.length].code)}.SH</td>
                  <td>{textValue(row.name, fallbackRows[realIndex % fallbackRows.length].name)}</td>
                  <td>{num(row.price ?? row.current_price ?? fallbackRows[realIndex % fallbackRows.length].price, 2)}</td>
                  <td className={pctValue >= 0 ? "up" : "down"}>{pct(pctValue)}</td>
                  <td><Badge tone={signal === "增持" ? "good" : signal === "减持" ? "warn" : signal === "观察" ? "neutral" : "lock"}>{signal}</Badge></td>
                  <td><Badge tone={tone}>{tone === "danger" ? "高风险" : tone === "warn" ? "中风险" : "低风险"}</Badge></td>
                  <td>{textValue(row.position, realIndex % 3 === 0 ? "6.00%" : realIndex % 3 === 1 ? "5.00%" : "2.50%")}</td>
                  <td className={pnl >= 0 ? "up" : "down"}>{pct(pnl)}</td>
                </tr>
              );
            })}
            {!pageRows.length && <tr><td colSpan={8}>没有匹配的股票</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="q-watch-footer">
        <span>共 {filtered.length} 只 · 排序: {sortKey === "score" ? "评分" : sortKey === "pct" ? "涨跌幅" : "盈亏"}</span>
        <div>
          <button type="button" onClick={() => setPage(Math.max(1, currentPage - 1))}>‹</button>
          <strong>{currentPage}</strong>
          <button type="button" onClick={() => setPage(Math.min(totalPages, currentPage + 1))}>›</button>
          <span>{pageSize} / 页</span>
        </div>
      </div>
    </Panel>
  );
}

export function InteractiveAgentLogPanel() {
  const [level, setLevel] = useState("all");
  const [latestOnly, setLatestOnly] = useState(true);
  const [hidden, setHidden] = useState(false);
  const logs = hidden ? [] : logSeed.filter((item) => level === "all" || item[1] === level).slice(0, latestOnly ? 4 : logSeed.length);
  return (
    <Panel title="AI代理日志" icon={Bot} className="q-agent-log-panel">
      <div className="q-agent-log-head">
        <select value={level} onChange={(event) => setLevel(event.target.value)}>
          <option value="all">全部级别</option>
          <option value="INFO">INFO</option>
          <option value="SIGNAL">SIGNAL</option>
          <option value="TRADE">TRADE</option>
          <option value="RISK">RISK</option>
        </select>
        <label><input type="checkbox" checked={latestOnly} onChange={(event) => setLatestOnly(event.target.checked)} /> 仅显示最新</label>
        <button type="button" onClick={() => setHidden(!hidden)}>{hidden ? "恢复" : "清空"}</button>
      </div>
      <div className="q-agent-log-table">
        {logs.map(([time, rowLevel, title, detail, engine]) => (
          <div key={`${time}-${rowLevel}`} className="q-agent-log-row">
            <span className="mono">{time}</span>
            <Badge tone={rowLevel === "RISK" ? "danger" : rowLevel === "TRADE" ? "warn" : rowLevel === "SIGNAL" ? "good" : "lock"}>{rowLevel}</Badge>
            <strong>{title}</strong>
            <p>{detail}</p>
            <em>{engine}</em>
          </div>
        ))}
        {!logs.length && (
          <div className="q-agent-log-row">
            <span className="mono">--:--:--</span>
            <Badge>EMPTY</Badge>
            <strong>暂无日志</strong>
            <p>当前筛选条件下没有可展示的日志</p>
            <em>系统</em>
          </div>
        )}
      </div>
    </Panel>
  );
}
