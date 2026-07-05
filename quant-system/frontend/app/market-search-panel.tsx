"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ECharts, EChartsOption } from "echarts";
import { RotateCw, Search } from "lucide-react";

type QuoteRow = {
  code: string;
  name: string;
  price: number;
  pct: number;
  change: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  turnover: number;
  volumeRatio: number;
  amountYi: number;
  totalMvYi: number;
  time: string;
  tradeDate: string;
  dataTime: string;
  asOf: string;
  latestTradeDate: string;
  isLatest: boolean;
  source: string;
  kline?: {
    source?: string;
    generatedAt?: string | null;
    detail?: string;
    rows?: KlineRow[];
  };
  analysis?: {
    trend: string;
    action: string;
    positives: string[];
    risks: string[];
    metrics: {
      ma5?: number | null;
      ma10?: number | null;
      ma20?: number | null;
      high20?: number | null;
      low20?: number | null;
      position20?: number | null;
      volumeMultiple?: number | null;
      dayRangePct?: number | null;
      gapPct?: number | null;
      closeVsPrevPct?: number | null;
    };
  };
};

type KlineRow = {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount?: number | null;
  ma5?: number | null;
  ma10?: number | null;
  ma20?: number | null;
};

function n(value: unknown, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : "-";
}

function pct(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num >= 0 ? "+" : ""}${num.toFixed(2)}%` : "-";
}

function formatTick(value?: string) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}` : value || "-";
}

function KlineChart({ rows, code }: { rows: KlineRow[]; code: string }) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ECharts | null>(null);
  const data = useMemo(() => rows.slice(-90), [rows]);

  useEffect(() => {
    let disposed = false;
    let resize: (() => void) | null = null;

    async function renderChart() {
      if (!chartRef.current || data.length < 2) return;
      const echarts = await import("echarts");
      if (disposed || !chartRef.current) return;
      const chart = instanceRef.current || echarts.init(chartRef.current, "dark", { renderer: "canvas" });
      instanceRef.current = chart;

      const dates = data.map((row) => row.date);
      const candleData = data.map((row) => [row.open, row.close, row.low, row.high]);
      const volumeData = data.map((row) => ({
        value: row.volume || 0,
        itemStyle: { color: row.close >= row.open ? "#ef4444" : "#10b981" },
      }));
      const ma = (key: "ma5" | "ma10" | "ma20") => data.map((row) => {
        const value = Number(row[key]);
        return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
      });

      const option: EChartsOption = {
        animation: false,
        backgroundColor: "transparent",
        color: ["#facc15", "#38bdf8", "#a78bfa"],
        axisPointer: { link: [{ xAxisIndex: "all" }] },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "cross" },
          backgroundColor: "rgba(15, 23, 42, 0.96)",
          borderColor: "rgba(148, 163, 184, 0.35)",
          textStyle: { color: "#e5e7eb", fontSize: 12 },
          formatter: (params: any) => {
            const items = Array.isArray(params) ? params : [params];
            const index = Number(items[0]?.dataIndex || 0);
            const row = data[index];
            if (!row) return "";
            const lines = [
              `<strong>${code} · ${row.date}</strong>`,
              `开盘：${n(row.open)}　收盘：${n(row.close)}`,
              `最高：${n(row.high)}　最低：${n(row.low)}`,
              `成交量：${n(row.volume, 0)}`,
              `MA5：${n(row.ma5)}　MA10：${n(row.ma10)}　MA20：${n(row.ma20)}`,
            ];
            return lines.join("<br/>");
          },
        },
        legend: {
          top: 0,
          right: 0,
          textStyle: { color: "#cbd5e1", fontSize: 11 },
          data: ["MA5", "MA10", "MA20"],
        },
        grid: [
          { left: 46, right: 18, top: 28, height: 250 },
          { left: 46, right: 18, top: 306, height: 72 },
        ],
        xAxis: [
          {
            type: "category",
            data: dates,
            boundaryGap: true,
            axisLine: { lineStyle: { color: "rgba(148, 163, 184, 0.35)" } },
            axisLabel: { color: "#64748b", fontSize: 10 },
            axisPointer: { z: 100 },
          },
          {
            type: "category",
            gridIndex: 1,
            data: dates,
            boundaryGap: true,
            axisLine: { lineStyle: { color: "rgba(148, 163, 184, 0.35)" } },
            axisLabel: { show: false },
          },
        ],
        yAxis: [
          {
            scale: true,
            splitLine: { lineStyle: { color: "rgba(148, 163, 184, 0.14)" } },
            axisLabel: { color: "#64748b", fontSize: 10 },
          },
          {
            scale: true,
            gridIndex: 1,
            splitNumber: 2,
            splitLine: { lineStyle: { color: "rgba(148, 163, 184, 0.10)" } },
            axisLabel: { color: "#64748b", fontSize: 10 },
          },
        ],
        dataZoom: [
          { type: "inside", xAxisIndex: [0, 1], start: 35, end: 100 },
          {
            type: "slider",
            xAxisIndex: [0, 1],
            bottom: 0,
            height: 18,
            borderColor: "rgba(148, 163, 184, 0.18)",
            fillerColor: "rgba(59, 130, 246, 0.16)",
            handleStyle: { color: "#64748b" },
            textStyle: { color: "#64748b" },
          },
        ],
        series: [
          {
            name: "K线",
            type: "candlestick",
            data: candleData,
            itemStyle: {
              color: "rgba(239, 68, 68, 0.72)",
              color0: "rgba(16, 185, 129, 0.72)",
              borderColor: "#ef4444",
              borderColor0: "#10b981",
            },
          },
          { name: "MA5", type: "line", data: ma("ma5"), smooth: true, showSymbol: false, lineStyle: { width: 1.4 } },
          { name: "MA10", type: "line", data: ma("ma10"), smooth: true, showSymbol: false, lineStyle: { width: 1.4 } },
          { name: "MA20", type: "line", data: ma("ma20"), smooth: true, showSymbol: false, lineStyle: { width: 1.4 } },
          {
            name: "成交量",
            type: "bar",
            xAxisIndex: 1,
            yAxisIndex: 1,
            data: volumeData,
            barWidth: "55%",
          },
        ],
      };

      chart.setOption(option, true);
      resize = () => chart.resize();
      window.addEventListener("resize", resize);
    }

    renderChart();

    return () => {
      disposed = true;
      if (resize) window.removeEventListener("resize", resize);
    };
  }, [code, data]);

  useEffect(() => () => {
    instanceRef.current?.dispose();
    instanceRef.current = null;
  }, []);

  if (data.length < 2) {
    return <div className="marketChartEmpty">暂无可用实时 K 线数据</div>;
  }

  return <div ref={chartRef} className="marketKlineChart" aria-label="ECharts 日K线图" />;
}

function AnalysisPanel({ row }: { row: QuoteRow }) {
  const analysis = row.analysis;
  if (!analysis) return null;
  const metrics = analysis.metrics || {};
  return (
    <div className="marketAnalysisPanel">
      <div className="marketAnalysisHead">
        <div>
          <span className="eyebrow">AI Snapshot</span>
          <h3>{row.code} {row.name || "-"} · {analysis.trend}</h3>
        </div>
        <strong className={row.pct >= 0 ? "up" : "down"}>{pct(row.pct)}</strong>
      </div>
      <div className="marketAnalysisMetrics">
        <span>MA5 <b>{n(metrics.ma5)}</b></span>
        <span>MA10 <b>{n(metrics.ma10)}</b></span>
        <span>MA20 <b>{n(metrics.ma20)}</b></span>
        <span>20日位置 <b>{metrics.position20 == null ? "-" : `${Number(metrics.position20).toFixed(0)}%`}</b></span>
        <span>量能 <b>{n(metrics.volumeMultiple)}x</b></span>
      </div>
      <div className="marketConclusion">
        <strong>操作结论</strong>
        <p>{analysis.action}</p>
      </div>
      <div className="marketAnalysisLists">
        <div>
          <strong>支持信号</strong>
          {(analysis.positives || []).length ? analysis.positives.map((item) => <p key={item}>{item}</p>) : <p>暂无明确支持信号</p>}
        </div>
        <div>
          <strong>风险提示</strong>
          {(analysis.risks || []).length ? analysis.risks.map((item) => <p key={item}>{item}</p>) : <p>暂无明显风险，但仍需结合盘中承接</p>}
        </div>
      </div>
    </div>
  );
}

export function MarketSearchPanel() {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [selectedCode, setSelectedCode] = useState("");
  const [message, setMessage] = useState("输入代码或名称查询公开实时行情");
  const [busy, setBusy] = useState(false);

  async function runSearch(nextQuery = query) {
    const term = nextQuery.trim();
    if (!term) {
      setMessage("请输入股票代码或名称");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/market-search?q=${encodeURIComponent(term)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "查询失败");
      setRows(payload.rows || []);
      setSelectedCode(payload.rows?.[0]?.code || "");
      setMessage(`${payload.detail || "查询完成"} · 最近交易日 ${payload.latestTradeDate || "-"} · 查询时间 ${payload.dataTime || "-"}`);
    } catch (error) {
      setRows([]);
      setMessage(error instanceof Error ? error.message : "查询失败");
    } finally {
      setBusy(false);
    }
  }

  const selectedRow = rows.find((row) => row.code === selectedCode) || rows[0];

  return (
    <section className="marketSearchPanel">
      <div className="marketSearchHead">
        <div>
          <span className="eyebrow">Realtime Search</span>
          <h2>实时行情查询</h2>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            runSearch();
          }}
        >
          <label>
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入代码 / 名称，如 002475 或 立讯精密" />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? <RotateCw size={15} className="spinIcon" /> : <Search size={15} />}
            查询
          </button>
        </form>
      </div>
      <div className="marketSearchMessage">{message}</div>
      {selectedRow && (
        <div className="marketSearchDetail">
          <div className="marketChartPanel">
            <div className="marketChartHead">
              <div>
                <span className="eyebrow">Daily Kline</span>
                <h3>{selectedRow.code} {selectedRow.name || "-"} K线图</h3>
                <p className="marketChartSource">{selectedRow.kline?.source || "-"}{selectedRow.kline?.detail ? ` · ${selectedRow.kline.detail}` : ""}</p>
              </div>
              <div className="marketLegend">
                <span className="ma5-dot">MA5</span>
                <span className="ma10-dot">MA10</span>
                <span className="ma20-dot">MA20</span>
              </div>
            </div>
            <KlineChart code={selectedRow.code} rows={selectedRow.kline?.rows || []} />
          </div>
          <AnalysisPanel row={selectedRow} />
        </div>
      )}

      <div className="q-table-wrap marketSearchTable">
        <table className="q-table">
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>最新价</th>
              <th>涨跌幅</th>
              <th>涨跌额</th>
              <th>开/高/低</th>
              <th>换手</th>
              <th>量比</th>
              <th>成交额</th>
              <th>数据时间</th>
              <th>最新状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code} className={row.code === selectedCode ? "selectedRow" : ""} onClick={() => setSelectedCode(row.code)}>
                <td className="mono">{row.code}</td>
                <td>{row.name || "-"}</td>
                <td>{n(row.price)}</td>
                <td className={row.pct >= 0 ? "up" : "down"}>{pct(row.pct)}</td>
                <td className={row.change >= 0 ? "up" : "down"}>{n(row.change)}</td>
                <td>{n(row.open)} / {n(row.high)} / {n(row.low)}</td>
                <td>{pct(row.turnover)}</td>
                <td>{n(row.volumeRatio)}</td>
                <td>{n(row.amountYi)} 亿</td>
                <td>{row.dataTime || formatTick(row.time)}</td>
                <td><span className={`pill ${row.isLatest ? "good" : "warn"}`}>{row.isLatest ? "最新" : `非最新 ${row.latestTradeDate || ""}`}</span></td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={11} className="centerCell">暂无实时查询结果</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
