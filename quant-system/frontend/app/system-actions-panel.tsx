"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, Clock3, Database, FlaskConical, Play, RotateCw, ShieldAlert } from "lucide-react";

type SystemAction = {
  id: string;
  label: string;
  group: "research" | "backtest" | "strategy" | "data";
  description: string;
  outputFiles: string[];
};

type ActionRun = {
  id: string;
  actionId: string;
  label: string;
  group: string;
  ok: boolean;
  status: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string[];
  outputFiles?: string[];
};

type ActionPayload = {
  actions?: SystemAction[];
  runs?: ActionRun[];
  readOnly?: boolean;
};

const groupLabels = {
  data: "数据 / 因子",
  backtest: "回测",
  research: "研究",
  strategy: "策略",
};

function shortTime(value?: string) {
  if (!value) return "-";
  return value.replace("T", " ").slice(5, 19);
}

function duration(value?: number) {
  if (!Number.isFinite(Number(value))) return "-";
  const seconds = Math.max(0, Math.round(Number(value) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusClass(status?: string) {
  if (status === "SUCCESS") return "good";
  if (status === "FAILED") return "danger";
  return "warn";
}

function groupIcon(group: string) {
  if (group === "data") return <Database size={15} />;
  if (group === "backtest") return <Activity size={15} />;
  if (group === "strategy") return <ShieldAlert size={15} />;
  return <FlaskConical size={15} />;
}

export function SystemActionsPanel({ compact = false }: { compact?: boolean }) {
  const [payload, setPayload] = useState<ActionPayload>({});
  const [activeGroup, setActiveGroup] = useState<SystemAction["group"] | "all">(compact ? "data" : "all");
  const [runningId, setRunningId] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/system-actions", { cache: "no-store" });
    if (!response.ok) throw new Error("系统动作加载失败");
    setPayload(await response.json());
  }, []);

  async function run(actionId: string) {
    setRunningId(actionId);
    setMessage("");
    try {
      const response = await fetch("/api/system-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId }),
      });
      const next = await response.json();
      if (!response.ok) throw new Error(next.detail || "系统动作执行失败");
      await load();
      setMessage(next.queued === false ? `${next.run?.label || "动作"} 正在运行` : `${next.run?.label || "动作"} 已开始后台运行`);
    } catch (error) {
      await load().catch(() => undefined);
      setMessage(error instanceof Error ? error.message : "系统动作执行失败");
    } finally {
      setRunningId("");
    }
  }

  useEffect(() => {
    load().catch((error) => setMessage(error instanceof Error ? error.message : "系统动作加载失败"));
  }, [load]);

  const actions = payload.actions || [];
  const runs = payload.runs || [];
  const hasRunningRun = runs.some((item) => item.status === "RUNNING");
  const visibleActions = useMemo(() => actions.filter((item) => activeGroup === "all" || item.group === activeGroup), [actions, activeGroup]);
  const latestRunByAction = useMemo(() => new Map(runs.map((item) => [item.actionId, item])), [runs]);

  useEffect(() => {
    if (!hasRunningRun && !runningId) return;
    const timer = window.setInterval(() => {
      load().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasRunningRun, load, runningId]);

  return (
    <section className={`systemActionsPanel ${compact ? "compact" : ""}`}>
      <div className="systemActionsHead">
        <div>
          <span className="eyebrow">System Actions</span>
          <h2>系统动作台</h2>
        </div>
        <button type="button" onClick={() => load()} disabled={Boolean(runningId)}>
          <RotateCw size={15} />
          {hasRunningRun ? "轮询中" : "刷新"}
        </button>
      </div>

      <div className="systemActionTabs">
        {(["all", "data", "backtest", "research", "strategy"] as const).map((item) => (
          <button type="button" key={item} className={activeGroup === item ? "active" : ""} onClick={() => setActiveGroup(item)}>
            {item === "all" ? "全部" : groupLabels[item]}
          </button>
        ))}
      </div>

      <div className="systemActionGrid">
        {visibleActions.map((action) => {
          const runState = latestRunByAction.get(action.id);
          const isRunning = runningId === action.id || runState?.status === "RUNNING";
          return (
            <article className="systemActionCard" data-action-id={action.id} key={action.id}>
              <div className="systemActionTitle">
                <span>{groupIcon(action.group)}</span>
                <strong>{action.label}</strong>
                {runState && <em className={statusClass(runState.status)}>{runState.status}</em>}
              </div>
              <p>{action.description}</p>
              <small>{runState ? `${shortTime(runState.finishedAt || runState.startedAt)} · ${duration(runState.durationMs)}` : "尚未运行"}</small>
              <button type="button" onClick={() => run(action.id)} disabled={isRunning || Boolean(runningId) || payload.readOnly}>
                {isRunning ? <Clock3 size={15} /> : runState?.ok ? <CheckCircle2 size={15} /> : <Play size={15} />}
                {isRunning ? "运行中" : "运行"}
              </button>
            </article>
          );
        })}
      </div>

      {message && <div className={`systemActionMessage ${message.includes("失败") ? "danger" : "good"}`}>{message}</div>}

      <div className="systemRunList">
        <div className="systemRunHead">最近运行</div>
        {runs.slice(0, compact ? 4 : 8).map((run) => (
          <div className="systemRunRow" key={run.id}>
            <span className={statusClass(run.status)}>{run.status}</span>
            <strong>{run.label}</strong>
            <em>{shortTime(run.finishedAt || run.startedAt)} · {duration(run.durationMs)}</em>
            <p>{(run.summary || []).slice(0, 2).join("；") || "-"}</p>
          </div>
        ))}
        {!runs.length && <div className="systemRunEmpty">暂无运行记录</div>}
      </div>
    </section>
  );
}
