import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { requireAllowedUserResponse } from "../../../../lib/access-control";
import { isPublicReadOnly } from "../../../../lib/local-data";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd(), "../..");
const quantRoot = path.join(repoRoot, "quant-system");

export async function POST(request: NextRequest) {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  if (isPublicReadOnly()) {
    return NextResponse.json({ ok: false, detail: "公开部署为只读模式，禁止重新生成研究报告" }, { status: 403 });
  }
  const payload = await request.json();
  const codes = normalizeCodes(payload.codes);
  const args: string[] = [];
  if (codes.length) args.push("--codes", codes.join(","));
  if (Boolean(payload.liveSources)) args.push("--live-sources");
  const pageSize = Math.min(Math.max(Number(payload.sourcePageSize || 5), 1), 20);
  args.push("--source-page-size", String(pageSize));

  try {
    const pythonPath = await resolvePython();
    const result = await execFileAsync(pythonPath, [path.join(quantRoot, "backend/run_research.py"), ...args], {
      cwd: quantRoot,
      timeout: 180000,
      maxBuffer: 1024 * 1024 * 8,
    });
    return NextResponse.json({
      ok: true,
      detail: codes.length ? `已完成 ${codes.join(",")} 研究报告` : "已完成最新股票池研究报告",
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        detail: error instanceof Error ? error.message : "研究报告生成失败",
      },
      { status: 500 },
    );
  }
}

async function resolvePython() {
  const python311Path = path.join(quantRoot, ".venv311/bin/python");
  try {
    await fs.access(python311Path);
    return python311Path;
  } catch {
    return path.join(quantRoot, ".venv/bin/python");
  }
}

function normalizeCodes(value: unknown) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.padStart(6, "0"))
    .filter((item) => /^(00|30|60|68)\d{4}$/.test(item))
    .slice(0, 50);
}
