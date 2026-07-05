import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const quantRoot = process.cwd();
const repoRoot = path.resolve(quantRoot, "..");
const historyPath = path.join(repoRoot, "reports/data/latest-system-actions.json");

const actions = [
  {
    id: "factor-lab",
    script: "run_factor_lab.py",
    args: ["--max-codes", "120", "--top", "80"],
    timeoutMs: 120000,
  },
  {
    id: "event-backtest",
    script: "run_event_backtest.py",
    args: ["--hold-days", "3", "--limit", "30"],
    timeoutMs: 90000,
  },
  {
    id: "parameter-backtest",
    script: "run_parameter_backtest.py",
    args: ["--limit", "30", "--window", "160"],
    timeoutMs: 120000,
  },
  {
    id: "committee",
    script: "run_committee.py",
    args: [],
    timeoutMs: 90000,
  },
  {
    id: "research-report",
    script: "run_research.py",
    args: [],
    timeoutMs: 120000,
  },
  {
    id: "strategy-review",
    script: "run_strategy_review.py",
    args: [],
    timeoutMs: 90000,
  },
  {
    id: "strategy-registry",
    script: "run_strategy_registry.py",
    args: [],
    timeoutMs: 60000,
  },
];

async function pythonPath() {
  const python311Path = path.join(quantRoot, ".venv311/bin/python");
  try {
    await fs.access(python311Path);
    return python311Path;
  } catch {
    return path.join(quantRoot, ".venv/bin/python");
  }
}

async function readHistory() {
  try {
    const payload = JSON.parse(await fs.readFile(historyPath, "utf8"));
    return Array.isArray(payload.runs) ? payload.runs : [];
  } catch {
    return [];
  }
}

async function writeHistory(runs) {
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  const tmpPath = path.join(path.dirname(historyPath), `.${path.basename(historyPath)}.${process.pid}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify({ generatedAt: new Date().toISOString(), runs: runs.slice(0, 30) }, null, 2), "utf8");
  await fs.rename(tmpPath, historyPath);
}

function summarizeOutput(stdout = "", stderr = "") {
  return [stdout, stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);
}

async function patchRun(runId, patch) {
  const runs = await readHistory();
  await writeHistory(runs.map((run) => (run.id === runId ? { ...run, ...patch } : run)));
}

async function main() {
  const actionId = process.env.SYSTEM_ACTION_ID || "";
  const runId = process.env.SYSTEM_ACTION_RUN_ID || "";
  const action = actions.find((item) => item.id === actionId);
  if (!action || !runId) throw new Error("missing system action worker context");

  const started = Date.parse(process.env.SYSTEM_ACTION_STARTED_AT || "") || Date.now();
  try {
    const result = await execFileAsync(await pythonPath(), [path.join(quantRoot, "backend", action.script), ...action.args], {
      cwd: quantRoot,
      timeout: action.timeoutMs,
      maxBuffer: 1024 * 1024 * 6,
    });
    await patchRun(runId, {
      ok: true,
      status: "SUCCESS",
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      summary: summarizeOutput(result.stdout, result.stderr),
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
    });
  } catch (error) {
    const stdout = String(error?.stdout || "");
    const stderr = String(error?.stderr || error?.message || "系统动作执行失败");
    await patchRun(runId, {
      ok: false,
      status: "FAILED",
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      summary: summarizeOutput(stdout, stderr),
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000),
    });
  }
}

main().catch(async (error) => {
  const runId = process.env.SYSTEM_ACTION_RUN_ID || "";
  if (runId) {
    await patchRun(runId, {
      ok: false,
      status: "FAILED",
      finishedAt: new Date().toISOString(),
      summary: [error instanceof Error ? error.message : "系统动作后台任务失败"],
    }).catch(() => undefined);
  }
  process.exit(1);
});

