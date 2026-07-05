"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw } from "lucide-react";

type RefreshState = "idle" | "loading" | "done" | "warn" | "error";

function compactRefreshMessage(payload: any) {
  const report = payload?.report || payload || {};
  if (report.status === "RUNNING" || payload?.running) return "后台刷新中";
  if (report.ok === false || report.status === "FAILED") return "刷新失败，首页查看原因";
  if (report.warning || report.criticalFailures?.length) return "刷新完成，部分源有警告";
  return "刷新完成";
}

export function RefreshDataButton() {
  const router = useRouter();
  const [state, setState] = useState<RefreshState>("idle");
  const [message, setMessage] = useState("");

  async function readStatus() {
    const response = await fetch("/api/refresh-data", { method: "GET", cache: "no-store" });
    return response.json();
  }

  async function waitForRefresh() {
    for (let index = 0; index < 90; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const payload = await readStatus();
      const report = payload.report || {};
      if (payload.running || report.status === "RUNNING") {
        setMessage(`后台刷新中 ${report.startedAt ? new Date(report.startedAt).toLocaleTimeString("zh-CN", { hour12: false }) : ""}`);
        continue;
      }
      router.refresh();
      if (report.ok === false || report.status === "FAILED") {
        setState("error");
        setMessage(compactRefreshMessage(payload));
        return;
      }
      setState(report.warning || report.criticalFailures?.length ? "warn" : "done");
      setMessage(compactRefreshMessage(payload));
      return;
    }
    setState("warn");
    setMessage("刷新仍在后台执行，可稍后查看状态");
  }

  async function refreshData() {
    setState("loading");
    setMessage("启动后台刷新");
    try {
      const response = await fetch("/api/refresh-data", {
        method: "POST",
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok && response.status !== 202) throw new Error(payload.detail || "启动失败");
      setMessage(payload.queued ? "后台刷新已启动" : compactRefreshMessage(payload));
      await waitForRefresh();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "更新失败");
    }
  }

  return (
    <div className="refreshCluster">
      <button className="refresh" type="button" onClick={refreshData} disabled={state === "loading"}>
        <RefreshCw size={16} className={state === "loading" ? "spinIcon" : ""} />
        {state === "loading" ? "更新数据" : "刷新数据"}
      </button>
      {message && <span className={`refreshState ${state}`}>{message}</span>}
    </div>
  );
}
