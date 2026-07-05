import { ProductShell, MetricCard, DataTable } from "../product-shell";
import { dataDate, productData, pct } from "../../lib/product-data";

export const dynamic = "force-dynamic";

export default function StrategiesPage() {
  const { strategies, dataDates } = productData();
  const rows = Array.isArray(strategies.rows) ? strategies.rows : [];
  const summary = strategies.summary || {};
  return (
    <ProductShell title="策略中心" eyebrow="策略准入 / 执行闸门" dataDate={dataDates.strategies}>
      <section className="metricGrid">
        <MetricCard label="策略总数" value={summary.total ?? rows.length} date={dataDates.strategies} />
        <MetricCard label="已启用" value={summary.enabled ?? 0} date={dataDates.strategies} />
        <MetricCard label="Paper 可跑" value={summary.paperAllowed ?? 0} tone={summary.paperAllowed ? "good" : "warn"} date={dataDates.strategies} />
        <MetricCard label="Paper 阻塞" value={summary.paperBlocked ?? 0} tone={summary.paperBlocked ? "danger" : ""} date={dataDates.strategies} />
        <MetricCard label="平均质量分" value={summary.averageQualityScore ?? "-"} tone={summary.qualityBlocked ? "danger" : "good"} date={dataDates.strategies} />
      </section>
      <section className="productPanel">
        <h2>策略准入</h2>
        <DataTable
          columns={["日期", "策略", "阶段", "执行闸门", "质量", "晋级", "回测", "阻塞原因"]}
          rows={rows.map((row: any) => [
            dataDate(row) === "-" ? dataDates.strategies : dataDate(row),
            row.name,
            row.stage,
            <span className={`pill ${row.execution_gate === "PAPER_BLOCKED" ? "danger" : row.execution_gate === "PAPER_ALLOWED" ? "good" : "warn"}`}>{row.execution_gate}</span>,
            row.quality ? (
              <span className={`pill ${row.quality.status === "BLOCK" ? "danger" : row.quality.status === "PASS" ? "good" : "warn"}`}>
                {row.quality.score} / {row.quality.status}
              </span>
            ) : "-",
            row.promotion?.target || "-",
            row.backtest?.tradeCount ? `样本 ${row.backtest.tradeCount} / 胜率 ${pct(row.backtest.winRatePct)} / 回撤 ${pct(row.backtest.maxDrawdownPct)}` : "无",
            (row.quality?.blockers || row.gate_reasons || []).slice(0, 2).join("；") || "-",
          ])}
        />
      </section>
    </ProductShell>
  );
}
