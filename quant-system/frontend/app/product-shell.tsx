import { isValidElement, type ReactNode } from "react";
import { Activity, CalendarDays } from "lucide-react";
import { requireAllowedPage } from "../lib/access-control";
import { InteractiveDataTable, type InteractiveRow } from "./interactive-data-table";
import { ProductNav } from "./product-nav";

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export async function ProductShell({
  title,
  eyebrow,
  dataDate,
  children,
}: {
  title: string;
  eyebrow: string;
  dataDate?: ReactNode;
  children: ReactNode;
}) {
  const { user } = await requireAllowedPage();
  const userName = user?.primaryEmailAddress?.emailAddress || user?.username || user?.firstName || "已登录";

  return (
    <div className="productApp">
      <ProductNav userName={userName} />
      <main className="productMain">
        <header className="productHeader">
          <div>
            <p>{eyebrow}</p>
            <h1>{title}</h1>
          </div>
          <div className="productHeaderActions">
            {dataDate && (
              <div className="productHeaderBadge">
                <CalendarDays size={14} />
                数据日期 {dataDate}
              </div>
            )}
            <div className="productHeaderBadge">
              <Activity size={14} />
              模拟模式
            </div>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

function toneClass(tone?: string) {
  if (tone === "good" || tone === "green" || tone === "success") return "success";
  if (tone === "warn" || tone === "amber" || tone === "warning") return "warning";
  if (tone === "danger" || tone === "down") return "danger";
  if (tone === "blue" || tone === "info") return "info";
  return "neutral";
}

function columnClass(column: string) {
  const numeric = /(数量|现金|权益|仓位|成本|现价|价格|浮盈|胜率|收益|回撤|PnL|样本|证据数|原因数|文档|策略数|参数|分|通过组合|Agent 调用|执行审计)/.test(column);
  const status = /(状态|通过|风控|模式|结论|执行闸门|质量|晋级|方向)/.test(column);
  const code = /(代码|股票)/.test(column);
  const reason = /(原因|依据|说明|动作|文件|参数)/.test(column);
  return [
    numeric ? "numericCell" : "",
    status ? "statusCell" : "",
    code ? "codeCell" : "",
    reason ? "reasonCellCompact" : "",
  ].filter(Boolean).join(" ");
}

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`statusBadge ${tone}`}>{children}</span>;
}

export function RiskBadge({ children, tone = "warning" }: { children: ReactNode; tone?: Exclude<Tone, "neutral"> }) {
  return <span className={`riskBadge ${tone}`}>{children}</span>;
}

export function SectionPanel({ title, children, tools }: { title: string; children: ReactNode; tools?: ReactNode }) {
  return (
    <section className="productPanel sectionPanel">
      <div className="sectionPanelHead">
        <h2>{title}</h2>
        {tools && <div className="sectionPanelTools">{tools}</div>}
      </div>
      {children}
    </section>
  );
}

export function MetricCard({
  label,
  value,
  tone = "",
  date,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  date?: ReactNode;
}) {
  return (
    <div className={`metricCard kpiCard ${toneClass(tone)}`}>
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      {date && <small>日期 {date}</small>}
    </div>
  );
}

export function DataTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  const tableRows: InteractiveRow[] = rows.map((row, index) => {
    const cells = columns.map((column, cellIndex) => {
      const content = row[cellIndex] ?? "-";
      return {
        content,
        text: nodeText(content),
        className: columnClass(column),
      };
    });
    return {
      id: `row-${index}`,
      cells,
      searchText: cells.map((cell) => cell.text).join(" "),
    };
  });

  return <InteractiveDataTable columns={columns.map((label) => ({ label, className: columnClass(label) }))} rows={tableRows} />;
}

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(" ");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}
