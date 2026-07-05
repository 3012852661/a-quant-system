import { ProductShell, MetricCard, DataTable } from "../product-shell";
import { dataDate, productData } from "../../lib/product-data";

export const dynamic = "force-dynamic";

export default function AgentGatewayPage() {
  const { agentAudit, executionAudit, dataDates } = productData();
  const auditDate = dataDate(agentAudit.at(-1) || executionAudit.at(-1)) === "-" ? dataDates.workbench : dataDate(agentAudit.at(-1) || executionAudit.at(-1));
  return (
    <ProductShell title="Agent Gateway / 审计" eyebrow="外部 Agent 接入审计" dataDate={auditDate}>
      <section className="metricGrid">
        <MetricCard label="Agent 调用" value={agentAudit.length} date={auditDate} />
        <MetricCard label="执行审计" value={executionAudit.length} date={auditDate} />
        <MetricCard label="模式" value="模拟模式" tone="warn" date={auditDate} />
        <MetricCard label="实盘 Broker" value="未启用" tone="danger" date={auditDate} />
      </section>
      <section className="productPanel">
        <h2>Agent Gateway Audit</h2>
        <DataTable columns={["日期", "时间", "动作", "模式", "状态", "原因数"]} rows={agentAudit.slice().reverse().slice(0, 60).map((row: any) => [dataDate(row), row.time, row.action, row.mode, row.result?.status, row.result?.reasonCount ?? 0])} />
      </section>
      <section className="productPanel">
        <h2>Execution Audit</h2>
        <DataTable columns={["日期", "时间", "动作", "模式", "代码", "状态"]} rows={executionAudit.slice().reverse().slice(0, 60).map((row: any) => [dataDate(row), row.time, row.action, row.mode, row.result?.code || "-", row.result?.status])} />
      </section>
    </ProductShell>
  );
}
