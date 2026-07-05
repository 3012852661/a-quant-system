import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAllowedUserResponse } from "../../../../lib/access-control";
import { isPublicReadOnly } from "../../../../lib/local-data";

export const dynamic = "force-dynamic";

const repoRoot = path.resolve(process.cwd(), "../..");
const reportRoot = path.join(repoRoot, "quant-system/knowledge/Report-KB");

export async function POST(request: NextRequest) {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  if (isPublicReadOnly()) {
    return NextResponse.json({ ok: false, detail: "公开部署为只读模式，禁止写入 Report-KB" }, { status: 403 });
  }
  const payload = await request.json();
  const title = cleanText(payload.title);
  const institution = cleanText(payload.institution);
  const summary = cleanText(payload.summary);
  const risk = cleanText(payload.risk);
  if (!title || !institution || !summary || !risk) {
    return NextResponse.json({ ok: false, detail: "标题、机构、核心观点、风险提示为必填项" }, { status: 400 });
  }
  const publishedAt = normalizeDate(payload.publishedAt) || shanghaiDate();
  const symbols = normalizeSymbols(payload.symbols);
  const filePath = path.join(reportRoot, `${publishedAt}-${slug(title)}.md`);
  await fs.mkdir(reportRoot, { recursive: true });
  await fs.writeFile(
    filePath,
    renderReportCard({
      title,
      institution,
      author: cleanText(payload.author) || "未标注",
      publishedAt,
      url: cleanText(payload.url) || "无",
      symbols,
      rating: cleanText(payload.rating) || "未标注",
      targetPrice: cleanText(payload.targetPrice) || "未标注",
      summary,
      assumptions: cleanText(payload.assumptions) || "待补充",
      catalysts: cleanText(payload.catalysts) || "待补充",
      risk,
    }),
    "utf8",
  );
  return NextResponse.json({
    ok: true,
    file: path.relative(repoRoot, filePath),
    detail: "研报 Evidence 已写入 Report-KB，重新运行研究报告后会进入 Evidence 索引",
  });
}

function renderReportCard(input: {
  title: string;
  institution: string;
  author: string;
  publishedAt: string;
  url: string;
  symbols: string[];
  rating: string;
  targetPrice: string;
  summary: string;
  assumptions: string;
  catalysts: string;
  risk: string;
}) {
  return [
    `# ${input.title}`,
    "",
    "status: L1 note",
    "market: A 股",
    `source: ${input.institution}`,
    `institution: ${input.institution}`,
    `author: ${input.author}`,
    `published_at: ${input.publishedAt}`,
    `url: ${input.url}`,
    `symbols: ${input.symbols.length ? input.symbols.join(", ") : "无"}`,
    `rating: ${input.rating}`,
    `target_price: ${input.targetPrice}`,
    "",
    "## 核心观点",
    "",
    `- ${input.summary}`,
    "",
    "## 财务假设",
    "",
    `- ${input.assumptions}`,
    "",
    "## 催化因素",
    "",
    `- ${input.catalysts}`,
    "",
    "## 风险提示",
    "",
    `- ${input.risk}`,
    "",
    "## Agent 使用",
    "",
    "- 研报 Evidence 必须保留来源、日期和风险提示；过期研报只能作为历史观点。",
    "",
  ].join("\n");
}

function cleanText(value: unknown) {
  return String(value || "").replace(/\r/g, "").trim().slice(0, 2000);
}

function normalizeSymbols(value: unknown) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.padStart(6, "0"))
    .filter((item) => /^(00|30|60|68)\d{4}$/.test(item))
    .slice(0, 20);
}

function normalizeDate(value: unknown) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function slug(title: string) {
  return title.replace(/[^0-9A-Za-z\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "report";
}
