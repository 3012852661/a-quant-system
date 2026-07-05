import { ProductShell, MetricCard, DataTable } from "../product-shell";
import { dataDate, productData } from "../../lib/product-data";

export const dynamic = "force-dynamic";

function titleOf(text: string, fallback: string) {
  return text.match(/^#\s+(.+)$/m)?.[1] || fallback;
}

export default function ReviewsPage() {
  const { cases, strategyReview, parameterBacktest, dataDates } = productData();
  const pageDate = dataDates.strategyReview === "-" ? dataDates.parameterBacktest : dataDates.strategyReview;
  const strategyRows = Array.isArray(strategyReview.rows) ? strategyReview.rows : [];
  const reviewRows = [
    ...strategyRows.map((row: any) => [
      dataDate(row) === "-" ? pageDate : dataDate(row),
      "策略",
      row.name || row.key || "-",
      row.execution_gate || row.status || "-",
      [...(row.gate_reasons || []), ...(row.next_actions || [])].slice(0, 2).join("；") || "-",
    ]),
    ...cases.map((row) => [
      dateFromCase(row) || pageDate,
      "案例",
      titleOf(row.text, row.file),
      row.text.match(/^status:\s*(.+)$/m)?.[1] || "-",
      row.file.replace("quant-system/knowledge/", ""),
    ]),
  ];
  return (
    <ProductShell title="复盘中心" eyebrow="策略问题 / 案例沉淀" dataDate={pageDate}>
      <section className="metricGrid">
        <MetricCard label="案例数" value={cases.length} date={pageDate} />
        <MetricCard label="策略数" value={strategyReview.summary?.total ?? 0} date={dataDates.strategyReview} />
        <MetricCard label="参数组合" value={parameterBacktest.summary?.runs ?? 0} date={dataDates.parameterBacktest} />
        <MetricCard label="通过组合" value={parameterBacktest.summary?.passed ?? 0} tone={parameterBacktest.summary?.passed ? "good" : "danger"} date={dataDates.parameterBacktest} />
      </section>
      <section className="productPanel">
        <h2>复盘事项</h2>
        <DataTable columns={["日期", "类型", "对象", "状态", "动作/文件"]} rows={reviewRows} />
      </section>
    </ProductShell>
  );
}

function dateFromCase(row: { text: string; file: string }) {
  const fromText = dataDate({ date: row.text.match(/\d{4}-\d{2}-\d{2}/)?.[0] });
  if (fromText !== "-") return fromText;
  return row.file.match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}
