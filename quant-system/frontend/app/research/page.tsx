import { ProductShell, MetricCard, DataTable } from "../product-shell";
import { dataDate, productData, num, pct } from "../../lib/product-data";
import { ResearchRunForm } from "./research-run-form";

export const dynamic = "force-dynamic";

export default function ResearchPage() {
  const { research, dataDates } = productData();
  const decisions = Array.isArray(research.decisions) ? research.decisions : [];
  const evidence = Array.isArray(research.evidence) ? research.evidence : [];
  const dataGaps = Array.isArray(research.dataGaps) ? research.dataGaps : [];
  const sourceMeta = research.sources?.researchEvidenceSources || {};
  const sourceRows = Object.entries(sourceMeta.sources || {}) as Array<[string, any]>;
  const evidenceCounts = evidence.reduce((acc: Record<string, number>, row: any) => {
    const type = String(row.type || "unknown");
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const primarySourceStatus = sourceMeta.liveSourcesEnabled ? "LIVE" : "OFFLINE";
  const rejected = decisions.filter((item: any) => item.decision === "REJECT").length;
  return (
    <ProductShell title="研究中心" eyebrow="结论 / 证据 / 数据源" dataDate={dataDates.research}>
      <section className="metricGrid">
        <MetricCard label="研究标的" value={decisions.length} date={dataDates.research} />
        <MetricCard label="证据条目" value={evidence.length} date={dataDates.research} />
        <MetricCard label="风险否决" value={rejected} tone={rejected ? "danger" : "good"} date={dataDates.research} />
        <MetricCard label="数据源模式" value={primarySourceStatus} tone={sourceMeta.liveSourcesEnabled ? "good" : "warn"} date={dataDates.research} />
        <MetricCard label="数据缺口" value={dataGaps.length || 0} tone="warn" date={dataDates.research} />
      </section>
      <section className="productPanel">
        <h2>生成研究报告</h2>
        <ResearchRunForm />
      </section>
      <section className="productPanel">
        <h2>多 Agent 结论</h2>
        <DataTable
          columns={["日期", "代码", "名称", "结论", "置信度", "仓位", "依据/否决"]}
          rows={decisions.slice(0, 30).map((row: any) => [
            dataDate(row) === "-" ? dataDates.research : dataDate(row),
            <span className="mono">{row.code}</span>,
            row.name || "-",
            <span className={`pill ${row.decision === "REJECT" ? "danger" : "warn"}`}>{row.decision}</span>,
            num(row.confidence, 1),
            pct(row.max_position_pct),
            [...(row.vetoes || []), ...(row.rationale || [])].slice(0, 2).join("；") || "-",
          ])}
        />
      </section>
      <section className="productPanel">
        <h2>Evidence 数据源</h2>
        <DataTable
          columns={["日期", "来源", "状态", "证据数", "说明"]}
          rows={sourceRows.map(([name, row]) => [
            dataDate(row) === "-" ? dataDates.research : dataDate(row),
            name,
            <span className={`pill ${row.status === "ok" ? "good" : row.status === "disabled" ? "warn" : ""}`}>{row.status || "-"}</span>,
            evidenceCountLabel(row),
            row.reason || row.error || (Array.isArray(row.paths) ? row.paths.join("；") : row.provider || "-"),
          ])}
        />
      </section>
      <section className="productPanel">
        <h2>Evidence 类型</h2>
        <div className="tagStack">
          {Object.entries(evidenceCounts).map(([type, count]) => (
            <span key={type}>{type}: {count}</span>
          ))}
          {!Object.keys(evidenceCounts).length && <span>暂无 Evidence</span>}
        </div>
      </section>
    </ProductShell>
  );
}

function evidenceCountLabel(row: any) {
  if (row.evidenceByType) return JSON.stringify(row.evidenceByType);
  if (row.evidenceCount !== undefined) return String(row.evidenceCount);
  return "-";
}
