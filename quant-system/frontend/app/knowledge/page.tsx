import { ProductShell, MetricCard, DataTable } from "../product-shell";
import { dataDate, productData } from "../../lib/product-data";

export const dynamic = "force-dynamic";

export default function KnowledgePage() {
  const { knowledgeDocs, workbench, dataDates } = productData();
  const kb = workbench.system?.knowledge || {};
  const pageDate = dataDates.workbench;
  return (
    <ProductShell title="知识库管理" eyebrow="分层状态 / 文档覆盖" dataDate={pageDate}>
      <section className="metricGrid">
        <MetricCard label="Markdown" value={knowledgeDocs.length} date={pageDate} />
        <MetricCard label="Strategy-KB" value={knowledgeDocs.filter((f) => f.includes("/Strategy-KB/")).length} date={pageDate} />
        <MetricCard label="Case-KB" value={knowledgeDocs.filter((f) => f.includes("/Case-KB/")).length} date={pageDate} />
        <MetricCard label="Risk-KB" value={knowledgeDocs.filter((f) => f.includes("/Risk-KB/")).length} date={pageDate} />
      </section>
      <section className="productPanel">
        <h2>知识库分层</h2>
        <DataTable columns={["日期", "层", "名称", "文档", "状态", "示例"]} rows={(kb.layers || []).map((row: any) => [dataDate(row) === "-" ? pageDate : dataDate(row), row.key, row.cnName, `${row.docs}/${row.target}`, row.status, (row.examples || []).join("；")])} />
      </section>
    </ProductShell>
  );
}
