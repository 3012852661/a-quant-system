import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAllowedUserResponse } from "../../../lib/access-control";
import { isPublicReadOnly } from "../../../lib/local-data";

const repoRoot = path.resolve(process.cwd(), "../..");
const quantRoot = path.join(repoRoot, "quant-system");
const historyPath = path.join(repoRoot, "reports/data/latest-system-actions.json");

type ActionConfig = {
  id: string;
  label: string;
  group: "research" | "backtest" | "strategy" | "data";
  description: string;
  script: string;
  args: string[];
  timeoutMs: number;
  outputFiles: string[];
};

const actions: ActionConfig[] = [
  {
    id: "factor-lab",
    label: "重算因子实验",
    group: "data",
    description: "清洗因子、计算 IC/IR，并刷新因子分和因子注册表。",
    script: "run_factor_lab.py",
    args: ["--max-codes", "120", "--top", "80"],
    timeoutMs: 120000,
    outputFiles: ["reports/data/latest-factor-lab.json", "reports/data/latest-factor-scores.json", "reports/data/factor-registry.json"],
  },
  {
    id: "event-backtest",
    label: "运行事件回测",
    group: "backtest",
    description: "用最新候选池执行带交易约束的事件回测。",
    script: "run_event_backtest.py",
    args: ["--hold-days", "3", "--limit", "30"],
    timeoutMs: 90000,
    outputFiles: ["reports/data/event-backtest-result.json"],
  },
  {
    id: "parameter-backtest",
    label: "参数网格回测",
    group: "backtest",
    description: "生成策略变体并跑参数网格，刷新参数回测结果。",
    script: "run_parameter_backtest.py",
    args: ["--limit", "30", "--window", "160"],
    timeoutMs: 120000,
    outputFiles: ["reports/data/parameter-backtest-result.json"],
  },
  {
    id: "committee",
    label: "投委会复核",
    group: "research",
    description: "运行多角色投资委员会，刷新个股复核结论。",
    script: "run_committee.py",
    args: [],
    timeoutMs: 90000,
    outputFiles: ["reports/data/latest-investment-committee.json", "reports/data/latest-investment-committee.md"],
  },
  {
    id: "research-report",
    label: "生成研究报告",
    group: "research",
    description: "基于投委会与本地证据生成研究报告；默认不抓取外部实时源。",
    script: "run_research.py",
    args: [],
    timeoutMs: 120000,
    outputFiles: ["reports/data/latest-research-report.json", "reports/data/latest-research-report.md"],
  },
  {
    id: "strategy-review",
    label: "策略准入复盘",
    group: "strategy",
    description: "重算策略质量、晋级闸门、Paper 允许/阻塞状态。",
    script: "run_strategy_review.py",
    args: [],
    timeoutMs: 90000,
    outputFiles: ["reports/data/strategy-quality-review.json", "reports/data/strategy-quality-review.md"],
  },
  {
    id: "strategy-registry",
    label: "刷新策略注册表",
    group: "strategy",
    description: "从内置策略和知识库重建策略中心数据。",
    script: "run_strategy_registry.py",
    args: [],
    timeoutMs: 60000,
    outputFiles: ["reports/data/strategy-registry.json"],
  },
];

export const dynamic = "force-dynamic";

async function readHistory() {
  try {
    const payload = JSON.parse(await fs.readFile(historyPath, "utf8"));
    return Array.isArray(payload.runs) ? payload.runs : [];
  } catch {
    return [];
  }
}

async function writeHistory(runs: unknown[]) {
  if (isPublicReadOnly()) return;
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  const tmpPath = path.join(path.dirname(historyPath), `.${path.basename(historyPath)}.${process.pid}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify({ generatedAt: new Date().toISOString(), runs: runs.slice(0, 30) }, null, 2), "utf8");
  await fs.rename(tmpPath, historyPath);
}

function normalizeRuns(runs: any[]) {
  const timeoutById = new Map(actions.map((item) => [item.id, item.timeoutMs]));
  const now = Date.now();
  return runs.map((run) => {
    if (run.status !== "RUNNING") return run;
    const started = Date.parse(String(run.startedAt || ""));
    const timeoutMs = timeoutById.get(run.actionId) || 60000;
    if (Number.isFinite(started) && now - started > timeoutMs + 30000) {
      return {
        ...run,
        ok: false,
        status: "FAILED",
        finishedAt: new Date(started + timeoutMs).toISOString(),
        durationMs: timeoutMs,
        summary: ["后台任务超时或中断，请重新运行"],
      };
    }
    return run;
  });
}

function publicActions() {
  return actions.map(({ id, label, group, description, outputFiles }) => ({ id, label, group, description, outputFiles }));
}

export async function GET() {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  const runs = normalizeRuns(await readHistory());
  return NextResponse.json({
    ok: true,
    readOnly: isPublicReadOnly(),
    actions: publicActions(),
    runs: runs.slice(0, 12),
  });
}

export async function POST(request: NextRequest) {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  if (isPublicReadOnly()) {
    return NextResponse.json({ ok: false, detail: "公开部署为只读模式，禁止执行系统动作" }, { status: 403 });
  }

  const payload = await request.json().catch(() => ({}));
  const action = actions.find((item) => item.id === String(payload.actionId || ""));
  if (!action) {
    return NextResponse.json({ ok: false, detail: "未知系统动作" }, { status: 400 });
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const currentRuns = normalizeRuns(await readHistory());
  const existingRun = currentRuns.find((run) => run.actionId === action.id && run.status === "RUNNING");
  if (existingRun) {
    return NextResponse.json({ ok: true, queued: false, run: existingRun, detail: "该动作正在运行" }, { status: 202 });
  }

  const run = {
    id: `${action.id}-${started}`,
    actionId: action.id,
    label: action.label,
    group: action.group,
    ok: null,
    status: "RUNNING",
    startedAt,
    finishedAt: null,
    durationMs: null,
    summary: ["任务已排队，后台执行中"],
    outputFiles: action.outputFiles,
  };

  await writeHistory([run, ...currentRuns]);

  const workerPath = path.join(quantRoot, "scripts/system_action_worker.mjs");
  const child = spawn(process.execPath, [workerPath], {
    cwd: quantRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SYSTEM_ACTION_ID: action.id,
      SYSTEM_ACTION_RUN_ID: run.id,
      SYSTEM_ACTION_STARTED_AT: startedAt,
    },
  });
  child.unref();

  return NextResponse.json({ ok: true, queued: true, run }, { status: 202 });
}
