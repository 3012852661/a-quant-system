"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type RunState = "idle" | "loading" | "done" | "error";

export function ResearchRunForm() {
  const router = useRouter();
  const [state, setState] = useState<RunState>("idle");
  const [message, setMessage] = useState("");

  async function runResearch(formData: FormData) {
    setState("loading");
    setMessage("运行多 Agent 研究链");
    try {
      const response = await fetch("/api/research/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codes: formData.get("codes") || "",
          liveSources: formData.get("liveSources") === "on",
          sourcePageSize: formData.get("sourcePageSize") || "5",
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "研究生成失败");
      setState("done");
      setMessage(payload.detail || "研究报告已生成");
      router.refresh();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "研究生成失败");
    }
  }

  return (
    <form className="evidenceForm compact" action={runResearch}>
      <div>
        <label>
          研究代码
          <input name="codes" placeholder="留空=最新股票池；或 000001,600519" />
        </label>
        <label>
          公告条数
          <input name="sourcePageSize" type="number" min="1" max="20" defaultValue="5" />
        </label>
        <label className="checkboxLine">
          <input name="liveSources" type="checkbox" />
          <span>启用 live sources</span>
        </label>
      </div>
      <div className="formActionLine">
        <button type="submit" disabled={state === "loading"}>{state === "loading" ? "研究中" : "生成研究报告"}</button>
        {message && <span className={`refreshState ${state}`}>{message}</span>}
      </div>
    </form>
  );
}
