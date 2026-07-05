import { ProductShell, MetricCard, DataTable } from "../product-shell";
import { dataDate, productData, pct, money } from "../../lib/product-data";

export const dynamic = "force-dynamic";

export default function BacktestsPage() {
  const { eventBacktest, parameterBacktest, dataDates } = productData();
  const metrics = eventBacktest.metrics || {};
  const runs = Array.isArray(parameterBacktest.runs) ? parameterBacktest.runs : [];
  return (
    <ProductShell title="回测中心" eyebrow="参数回测 / 风控指标" dataDate={dataDates.parameterBacktest}>
      <section className="metricGrid">
        <MetricCard label="平仓样本" value={metrics.closedTrades ?? 0} date={dataDates.eventBacktest} />
        <MetricCard label="胜率" value={pct(metrics.winRatePct)} date={dataDates.eventBacktest} />
        <MetricCard label="平均收益" value={pct(metrics.averageReturnPct)} date={dataDates.eventBacktest} />
        <MetricCard label="最大回撤" value={pct(metrics.maxDrawdownPct)} tone={Number(metrics.maxDrawdownPct || 0) > 25 ? "danger" : "warn"} date={dataDates.eventBacktest} />
      </section>
      <section className="productPanel">
        <h2>参数回测 Top 20</h2>
        <DataTable
          columns={["日期", "变体", "参数", "胜率", "平均收益", "回撤", "PnL", "通过"]}
          rows={runs.slice(0, 20).map((row: any) => [
            dataDate(row) === "-" ? dataDates.parameterBacktest : dataDate(row),
            row.variantName,
            JSON.stringify(row.params),
            pct(row.metrics?.winRatePct),
            pct(row.metrics?.averageReturnPct),
            pct(row.metrics?.maxDrawdownPct),
            money(row.metrics?.totalPnl),
            row.passesGate ? <span className="pill good">YES</span> : <span className="pill danger">NO</span>,
          ])}
        />
      </section>
    </ProductShell>
  );
}
