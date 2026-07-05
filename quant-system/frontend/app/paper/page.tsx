import { ProductShell, MetricCard, DataTable } from "../product-shell";
import { dataDate, productData, money, pct } from "../../lib/product-data";
import { TradingDesk } from "../trading-desk";

export const dynamic = "force-dynamic";

export default function PaperPage() {
  const { trading, workbench, dataDates } = productData();
  const candidates = [
    ...((workbench.recommendation?.recommendedBuys || []) as any[]),
    ...((workbench.recommendation?.qualityRadar || []) as any[]),
  ];
  return (
    <ProductShell title="Paper Trading" eyebrow="Paper account, orders, positions and risk" dataDate={dataDates.trading}>
      <section className="metricGrid">
        <MetricCard label="现金" value={money(trading.cash)} date={dataDates.trading} />
        <MetricCard label="权益" value={money(trading.equity)} date={dataDates.trading} />
        <MetricCard label="仓位" value={pct(trading.risk?.exposurePct)} date={dataDates.trading} />
        <MetricCard label="风控" value={trading.risk?.status || "UNKNOWN"} tone={trading.risk?.status === "BLOCK" ? "danger" : "warn"} date={dataDates.trading} />
      </section>
      <section className="productPanel">
        <h2>交易操作台</h2>
        <TradingDesk candidates={candidates} />
      </section>
      <section className="productPanel">
        <h2>持仓</h2>
        <DataTable columns={["日期", "代码", "名称", "数量", "成本", "现价", "浮盈"]} rows={(trading.positions || []).map((row: any) => [dataDate(row) === "-" ? dataDates.trading : dataDate(row), row.code, row.name, row.quantity, row.avgPrice, row.lastPrice, pct(row.unrealizedPct)])} />
      </section>
      <section className="productPanel">
        <h2>订单</h2>
        <DataTable columns={["日期", "方向", "代码", "名称", "数量", "价格", "状态", "原因"]} rows={(trading.orders || []).slice(0, 40).map((row: any) => [dataDate(row) === "-" ? dataDates.trading : dataDate(row), row.side, row.code, row.name, row.quantity, row.price, row.status, (row.reasons || []).join("；") || "-"])} />
      </section>
    </ProductShell>
  );
}
