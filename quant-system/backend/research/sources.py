from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.data.providers import (
    CninfoAnnouncementProvider,
    ConfigurableNewsProvider,
    EastMoneyMoneyFlowProvider,
    ProviderUnavailable,
    TushareProvider,
)
from backend.research.models import Evidence, EvidenceType


@dataclass
class SourceCollection:
    evidence: list[Evidence] = field(default_factory=list)
    data_gaps: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


def collect_research_source_evidence(
    committee_payload: dict[str, Any],
    codes: list[str] | None = None,
    *,
    enable_live_sources: bool = False,
    source_page_size: int = 5,
    now: str | None = None,
) -> SourceCollection:
    collected_at = now or committee_payload.get("generatedAt") or datetime.now().isoformat(timespec="seconds")
    target_codes = _target_codes(committee_payload, codes)
    collection = SourceCollection(
        metadata={
            "collectedAt": collected_at,
            "liveSourcesEnabled": enable_live_sources,
            "targetCodes": target_codes,
            "sourcePageSize": source_page_size,
            "sources": {},
        }
    )

    kb_evidence = _collect_knowledge_base_evidence(collected_at, target_codes)
    collection.evidence.extend(kb_evidence)
    kb_counts = _count_by_type(kb_evidence)
    collection.metadata["sources"]["knowledgeBase"] = {
        "status": "ok",
        "evidenceCount": len(kb_evidence),
        "evidenceByType": kb_counts,
        "paths": ["knowledge/Report-KB", "knowledge/Policy-KB", "knowledge/News-KB", "knowledge/Case-KB"],
    }

    if not target_codes:
        collection.data_gaps.append("公告/财务/资金流 Evidence 未拉取：本次研究没有可识别股票代码")
        collection.metadata["sources"]["liveAdapters"] = {"status": "skipped", "reason": "no target codes"}
        return collection

    if not enable_live_sources:
        collection.data_gaps.extend(
            [
                "公告 Evidence 未接入实时抓取：运行 backend/run_research.py --live-sources 可尝试巨潮资讯",
                "财务快照 Evidence 未接入实时抓取：运行 backend/run_research.py --live-sources 并配置 TUSHARE_TOKEN",
                _news_gap_message(kb_counts),
                "资金流 Evidence 未接入实时抓取：运行 backend/run_research.py --live-sources 可尝试东方财富资金流",
            ]
        )
        collection.metadata["sources"]["liveAdapters"] = {"status": "disabled"}
        return collection

    live_sources = {
        "announcements": _collect_announcements(target_codes, source_page_size, collected_at),
        "financials": _collect_financials(target_codes, collected_at),
        "news": _collect_live_news(target_codes, source_page_size, collected_at),
        "moneyflow": _collect_moneyflow(target_codes, collected_at),
    }
    for name, result in live_sources.items():
        collection.evidence.extend(result.evidence)
        collection.data_gaps.extend(result.data_gaps)
        collection.metadata["sources"][name] = result.metadata

    return collection


def _collect_knowledge_base_evidence(collected_at: str, target_codes: list[str]) -> list[Evidence]:
    specs: list[tuple[str, EvidenceType, str, float]] = [
        ("knowledge/Report-KB", "report", "research-report-kb", 0.7),
        ("knowledge/Policy-KB", "policy", "policy-kb", 0.75),
        ("knowledge/News-KB", "news", "manual-news-kb", 0.68),
        ("knowledge/Case-KB", "risk", "case-kb", 0.65),
    ]
    rows: list[Evidence] = []
    for relative_path, evidence_type, source, confidence in specs:
        root = _repo_root() / relative_path
        markdown_files = sorted(root.glob("*.md")) if root.exists() else []
        for path in markdown_files:
            if path.name.lower() == "readme.md":
                continue
            text = path.read_text(encoding="utf-8")
            title = _markdown_title(text) or path.stem
            summary = _markdown_summary(text)
            declared_source = _frontmatter_value(text, "source")
            declared_url = _frontmatter_value(text, "url")
            declared_symbols = _frontmatter_symbols(text)
            rows.append(
                Evidence(
                    id=_evidence_id(source, path.relative_to(_repo_root()), collected_at),
                    type=evidence_type,
                    title=title,
                    summary=summary,
                    source=declared_source or source,
                    symbols=declared_symbols or _symbols_in_text(text, target_codes),
                    source_url=declared_url or str(path.relative_to(_repo_root())),
                    published_at=_frontmatter_value(text, "published_at"),
                    collected_at=collected_at,
                    confidence=confidence,
                    metadata={
                        "path": str(path.relative_to(_repo_root())),
                        "status": _frontmatter_value(text, "status"),
                        "market": _frontmatter_value(text, "market"),
                        "declaredSource": declared_source,
                        "author": _frontmatter_value(text, "author"),
                        "institution": _frontmatter_value(text, "institution"),
                        "rating": _frontmatter_value(text, "rating"),
                    },
                )
            )
    return rows


def _count_by_type(evidence: list[Evidence]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in evidence:
        counts[item.type] = counts.get(item.type, 0) + 1
    return counts


def _news_gap_message(kb_counts: dict[str, int]) -> str:
    if kb_counts.get("news"):
        return "实时新闻 Evidence 未接入 licensed API：当前使用 knowledge/News-KB 人工新闻入库"
    return "新闻 Evidence 尚未入库：可用 backend/run_news_ingest.py 写入 knowledge/News-KB，实时源后续接 licensed API"


def _collect_announcements(codes: list[str], page_size: int, collected_at: str) -> SourceCollection:
    result = SourceCollection(metadata={"provider": "cninfo", "status": "ok", "evidenceCount": 0, "codes": {}})
    try:
        provider = CninfoAnnouncementProvider()
    except (ProviderUnavailable, RuntimeError, OSError) as exc:
        result.data_gaps.append(f"公告 Evidence 拉取失败：巨潮资讯 provider 不可用（{exc}）")
        result.metadata.update({"status": "unavailable", "error": str(exc)})
        return result
    for code in codes:
        try:
            rows = provider.get_announcements(code, page_size=page_size)
        except (ProviderUnavailable, RuntimeError, OSError, TimeoutError) as exc:
            result.data_gaps.append(f"{code} 公告 Evidence 拉取失败：{exc}")
            result.metadata["codes"][code] = {"status": "failed", "error": str(exc)}
            continue
        result.metadata["codes"][code] = {"status": "ok", "count": len(rows)}
        for item in rows:
            title = item.title or f"{code} 公告"
            result.evidence.append(
                Evidence(
                    id=_evidence_id("cninfo", code, title, item.announcement_date, item.url),
                    type="announcement",
                    title=f"{code} 公告 - {title}",
                    summary=_announcement_summary(item),
                    source=item.source,
                    symbols=[code],
                    source_url=item.url,
                    published_at=item.announcement_date.isoformat() if item.announcement_date else None,
                    collected_at=collected_at,
                    confidence=0.85,
                    metadata={"category": item.category},
                )
            )
    result.metadata["evidenceCount"] = len(result.evidence)
    return result


def _collect_financials(codes: list[str], collected_at: str) -> SourceCollection:
    result = SourceCollection(metadata={"provider": "tushare", "status": "ok", "evidenceCount": 0, "codes": {}})
    try:
        provider = TushareProvider()
    except (ProviderUnavailable, RuntimeError, OSError) as exc:
        result.data_gaps.append(f"财务快照 Evidence 拉取失败：Tushare provider 不可用（{exc}）")
        result.metadata.update({"status": "unavailable", "error": str(exc)})
        return result
    for code in codes:
        try:
            item = provider.get_financial_snapshot(code)
        except (ProviderUnavailable, RuntimeError, OSError, TimeoutError) as exc:
            result.data_gaps.append(f"{code} 财务快照 Evidence 拉取失败：{exc}")
            result.metadata["codes"][code] = {"status": "failed", "error": str(exc)}
            continue
        result.metadata["codes"][code] = {"status": "ok"}
        result.evidence.append(
            Evidence(
                id=_evidence_id("tushare-financial", code, item.report_date),
                type="financial",
                title=f"{code} 财务快照 - {item.report_date or 'latest'}",
                summary=_financial_summary(item.model_dump()),
                source=item.source,
                symbols=[code],
                published_at=item.report_date.isoformat() if item.report_date else None,
                collected_at=collected_at,
                confidence=0.8,
                metadata=item.model_dump(mode="json"),
            )
        )
    result.metadata["evidenceCount"] = len(result.evidence)
    return result


def _collect_moneyflow(codes: list[str], collected_at: str) -> SourceCollection:
    result = SourceCollection(metadata={"provider": "eastmoney_moneyflow", "status": "ok", "evidenceCount": 0, "codes": {}})
    try:
        provider = EastMoneyMoneyFlowProvider()
    except (ProviderUnavailable, RuntimeError, OSError) as exc:
        result.data_gaps.append(f"资金流 Evidence 拉取失败：东方财富 provider 不可用（{exc}）")
        result.metadata.update({"status": "unavailable", "error": str(exc)})
        return result
    for code in codes:
        try:
            rows = provider.get_money_flow(code, days=3)
        except (ProviderUnavailable, RuntimeError, OSError, TimeoutError) as exc:
            result.data_gaps.append(f"{code} 资金流 Evidence 拉取失败：{exc}")
            result.metadata["codes"][code] = {"status": "failed", "error": str(exc)}
            continue
        result.metadata["codes"][code] = {"status": "ok", "count": len(rows)}
        for item in rows:
            result.evidence.append(
                Evidence(
                    id=_evidence_id("eastmoney-moneyflow", code, item.trade_date, item.main_net, item.main_net_pct),
                    type="moneyflow",
                    title=f"{code} 资金流 - {item.trade_date or 'latest'}",
                    summary=_moneyflow_summary(item.model_dump()),
                    source=item.source,
                    symbols=[code],
                    published_at=item.trade_date.isoformat() if item.trade_date else None,
                    collected_at=collected_at,
                    confidence=0.75,
                    metadata=item.model_dump(mode="json"),
                )
            )
    result.metadata["evidenceCount"] = len(result.evidence)
    return result


def _collect_live_news(codes: list[str], limit: int, collected_at: str) -> SourceCollection:
    result = SourceCollection(metadata={"provider": "configured_news", "status": "ok", "evidenceCount": 0, "codes": {}})
    try:
        provider = ConfigurableNewsProvider()
        rows = provider.get_news(codes, limit=max(limit, 5))
    except (ProviderUnavailable, RuntimeError, OSError, TimeoutError) as exc:
        result.data_gaps.append(f"实时新闻 Evidence 拉取失败：{exc}")
        result.metadata.update({"status": "unavailable", "error": str(exc)})
        return result
    for item in rows:
        symbols = item.symbols or [code for code in codes if code in f"{item.title} {item.summary or ''}"]
        if codes and symbols and not set(symbols).intersection(codes):
            continue
        result.evidence.append(
            Evidence(
                id=_evidence_id("configured-news", item.source, item.title, item.published_at, item.url),
                type="news",
                title=item.title,
                summary=item.summary or item.title,
                source=item.source,
                symbols=symbols,
                source_url=item.url,
                published_at=item.published_at,
                collected_at=collected_at,
                confidence=0.72,
                metadata={"category": item.category, "adapter": "configured_news"},
            )
        )
    result.metadata["evidenceCount"] = len(result.evidence)
    result.metadata["codes"] = {code: {"matched": sum(1 for item in result.evidence if code in item.symbols)} for code in codes}
    if not result.evidence:
        result.data_gaps.append("实时新闻 Evidence 未匹配研究标的：请检查新闻源字段 symbols/codes 或标题正文是否包含股票代码")
        result.metadata["status"] = "empty"
    return result


def _target_codes(payload: dict[str, Any], codes: list[str] | None) -> list[str]:
    values = codes or [item.get("code") for item in payload.get("decisions", [])]
    normalized = [str(item).strip().zfill(6) for item in values if str(item or "").strip()]
    return sorted(set(normalized))


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _evidence_id(*parts: object) -> str:
    raw = "|".join(str(part) for part in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _markdown_title(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("# "):
            return line.removeprefix("# ").strip()
    return None


def _markdown_summary(text: str, limit: int = 260) -> str:
    content_lines = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.startswith("#") and not re.match(r"^[a-zA-Z_]+:\s*", line)
    ]
    summary = " ".join(content_lines[:8])
    return summary[:limit].rstrip() + ("..." if len(summary) > limit else "")


def _frontmatter_value(text: str, key: str) -> str | None:
    pattern = re.compile(rf"^{re.escape(key)}:\s*(.+)$", re.MULTILINE)
    match = pattern.search(text)
    return match.group(1).strip() if match else None


def _frontmatter_symbols(text: str) -> list[str]:
    raw = _frontmatter_value(text, "symbols")
    if not raw or raw == "无":
        return []
    return sorted(
        {
            item.strip().zfill(6)
            for item in raw.split(",")
            if re.match(r"^\s*(?:00|30|60|68)?\d{1,6}\s*$", item)
        }
    )


def _symbols_in_text(text: str, target_codes: list[str]) -> list[str]:
    found = {code for code in target_codes if code in text}
    found.update(re.findall(r"(?<!\d)(?:00|30|60|68)\d{4}(?!\d)", text))
    return sorted(found)


def _announcement_summary(item: Any) -> str:
    pieces = [str(item.title or "")]
    if item.category:
        pieces.append(f"分类：{item.category}")
    if item.announcement_date:
        pieces.append(f"发布日期：{item.announcement_date}")
    return "；".join(piece for piece in pieces if piece)


def _financial_summary(item: dict[str, Any]) -> str:
    keys = [
        ("report_date", "报告期"),
        ("revenue", "收入"),
        ("net_profit", "净利润"),
        ("gross_margin", "毛利率"),
        ("roe", "ROE"),
        ("debt_to_assets", "资产负债率"),
        ("eps", "EPS"),
    ]
    return "；".join(f"{label}：{item.get(key)}" for key, label in keys if item.get(key) is not None)


def _moneyflow_summary(item: dict[str, Any]) -> str:
    keys = [
        ("trade_date", "交易日"),
        ("main_net", "主力净流入"),
        ("main_net_pct", "主力净流入占比"),
        ("super_large_net", "超大单净流入"),
        ("large_net", "大单净流入"),
    ]
    return "；".join(f"{label}：{item.get(key)}" for key, label in keys if item.get(key) is not None)
