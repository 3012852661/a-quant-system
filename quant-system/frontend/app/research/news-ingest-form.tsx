"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type FormState = "idle" | "loading" | "done" | "error";

export function NewsIngestForm() {
  const router = useRouter();
  const [state, setState] = useState<FormState>("idle");
  const [message, setMessage] = useState("");

  async function submitNews(formData: FormData) {
    setState("loading");
    setMessage("写入 News-KB");
    try {
      const response = await fetch("/api/research/news", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(formData.entries())),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "写入失败");
      setState("done");
      setMessage(payload.detail || "已写入");
      router.refresh();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "写入失败");
    }
  }

  return (
    <form className="evidenceForm" action={submitNews}>
      <div>
        <label>
          标题
          <input name="title" placeholder="公司或行业新闻标题" required />
        </label>
        <label>
          来源
          <input name="source" placeholder="媒体、公告源或人工记录" required />
        </label>
        <label>
          发布日期
          <input name="publishedAt" type="date" />
        </label>
        <label>
          关联代码
          <input name="symbols" placeholder="000001,600519" />
        </label>
      </div>
      <label>
        摘要
        <textarea name="summary" placeholder="只写事实，不写交易结论" required />
      </label>
      <label>
        影响路径
        <textarea name="impact" placeholder="订单、毛利率、估值、资金情绪或监管风险如何传导" />
      </label>
      <label>
        风险和不确定性
        <textarea name="risk" placeholder="真实性、落地周期、兑现压力、反向风险" />
      </label>
      <label>
        原文链接
        <input name="url" placeholder="https://..." />
      </label>
      <div className="formActionLine">
        <button type="submit" disabled={state === "loading"}>{state === "loading" ? "写入中" : "写入 News-KB"}</button>
        {message && <span className={`refreshState ${state}`}>{message}</span>}
      </div>
    </form>
  );
}
