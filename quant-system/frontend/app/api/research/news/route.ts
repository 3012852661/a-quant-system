import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAllowedUserResponse } from "../../../../lib/access-control";
import { isPublicReadOnly } from "../../../../lib/local-data";

export const dynamic = "force-dynamic";

const repoRoot = path.resolve(process.cwd(), "../..");
const newsRoot = path.join(repoRoot, "quant-system/knowledge/News-KB");

export async function POST(request: NextRequest) {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  if (isPublicReadOnly()) {
    return NextResponse.json({ ok: false, detail: "公开部署为只读模式，禁止写入 News-KB" }, { status: 403 });
  }
  const payload = await request.json();
  const title = cleanText(payload.title);
  const source = cleanText(payload.source);
  const summary = cleanText(payload.summary);
  if (!title || !source || !summary) {
    return NextResponse.json({ ok: false, detail: "标题、来源、摘要为必填项" }, { status: 400 });
  }
  const publishedAt = normalizeDate(payload.publishedAt) || shanghaiDate();
  const symbols = normalizeSymbols(payload.symbols);
  const fileName = `${publishedAt}-${slug(title)}.md`;
  const filePath = path.join(newsRoot, fileName);
  await fs.mkdir(newsRoot, { recursive: true });
  await fs.writeFile(
    filePath,
    renderNewsCard({
      title,
      source,
      publishedAt,
      url: cleanText(payload.url) || "无",
      symbols,
      summary,
      impact: cleanText(payload.impact) || "待分析",
      risk: cleanText(payload.risk) || "待补充",
    }),
    "utf8",
  );
  return NextResponse.json({
    ok: true,
    file: path.relative(repoRoot, filePath),
    detail: "新闻 Evidence 已写入 News-KB，重新运行研究报告后会进入 Evidence 索引",
  });
}

function renderNewsCard(input: {
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  symbols: string[];
  summary: string;
  impact: string;
  risk: string;
}) {
  return [
    `# ${input.title}`,
    "",
    "status: L1 note",
    "market: A 股",
    `source: ${input.source}`,
    `published_at: ${input.publishedAt}`,
    `url: ${input.url}`,
    `symbols: ${input.symbols.length ? input.symbols.join(", ") : "无"}`,
    "",
    "## 摘要",
    "",
    `- ${input.summary}`,
    "",
    "## 影响路径",
    "",
    `- ${input.impact}`,
    "",
    "## 风险和不确定性",
    "",
    `- ${input.risk}`,
    "",
    "## Agent 使用",
    "",
    "- 新闻 Evidence 只作为研究层证据，不允许单独触发自动买入。",
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
  return title.replace(/[^0-9A-Za-z\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "news";
}
