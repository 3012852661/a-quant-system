"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type FormState = "idle" | "loading" | "done" | "error";

export function ReportIngestForm() {
  const router = useRouter();
  const [state, setState] = useState<FormState>("idle");
  const [message, setMessage] = useState("");

  async function submitReport(formData: FormData) {
    setState("loading");
    setMessage("写入 Report-KB");
    try {
      const response = await fetch("/api/research/report", {
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
    <form className="evidenceForm" action={submitReport}>
      <div>
        <label>
          标题
          <input name="title" placeholder="研报标题" required />
        </label>
        <label>
          机构
          <input name="institution" placeholder="券商/研究机构/公司" required />
        </label>
        <label>
          作者
          <input name="author" placeholder="分析师或作者" />
        </label>
        <label>
          发布日期
          <input name="publishedAt" type="date" />
        </label>
      </div>
      <div>
        <label>
          关联代码
          <input name="symbols" placeholder="000001,600519" />
        </label>
        <label>
          评级
          <input name="rating" placeholder="买入/增持/中性" />
        </label>
        <label>
          目标价
          <input name="targetPrice" placeholder="目标价或估值区间" />
        </label>
        <label>
          原文/PDF
          <input name="url" placeholder="https://... 或本地 PDF 路径" />
        </label>
      </div>
      <label>
        核心观点
        <textarea name="summary" placeholder="收入、利润、行业位置、结论等事实摘要" required />
      </label>
      <label>
        财务假设
        <textarea name="assumptions" placeholder="收入、利润、毛利率、现金流、估值假设" />
      </label>
      <label>
        催化因素
        <textarea name="catalysts" placeholder="订单、政策、产品、产能、价格等催化" />
      </label>
      <label>
        风险提示
        <textarea name="risk" placeholder="必须完整摘录或总结风险提示" required />
      </label>
      <div className="formActionLine">
        <button type="submit" disabled={state === "loading"}>{state === "loading" ? "写入中" : "写入 Report-KB"}</button>
        {message && <span className={`refreshState ${state}`}>{message}</span>}
      </div>
    </form>
  );
}
