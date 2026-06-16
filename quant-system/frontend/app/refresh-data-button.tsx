"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw } from "lucide-react";

type RefreshState = "idle" | "loading" | "done" | "warn" | "error";

export function RefreshDataButton() {
  const router = useRouter();
  const [state, setState] = useState<RefreshState>("idle");
  const [message, setMessage] = useState("");

  async function refreshData() {
    setState("loading");
    setMessage("更新中");
    try {
      const response = await fetch("/api/refresh-data", {
        method: "POST",
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.detail || "更新失败");
      const updatedAt = payload.snapshot?.updatedAt;
      setState(payload.warning ? "warn" : "done");
      setMessage(payload.warning ? `已更新 ${updatedAt || ""}，部分源有警告` : `已获取最新 ${updatedAt || ""}`);
      router.refresh();
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
