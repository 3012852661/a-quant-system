from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.committee.roles import repo_root, run_committee
from backend.research.report import build_research_report, write_research_outputs


def main() -> int:
    parser = argparse.ArgumentParser(description="Run AI research layer report over the six-role committee.")
    parser.add_argument("--codes", default="", help="Comma-separated stock codes. Defaults to latest pool.")
    parser.add_argument("--output", default=str(repo_root() / "reports/data/latest-research-report.json"))
    parser.add_argument("--markdown", default=str(repo_root() / "reports/data/latest-research-report.md"))
    parser.add_argument("--evidence-dir", default=str(repo_root() / "reports/data/research-evidence"))
    parser.add_argument(
        "--live-sources",
        action="store_true",
        help="Fetch live announcement/financial/money-flow evidence from configured providers.",
    )
    parser.add_argument(
        "--source-page-size",
        type=int,
        default=5,
        help="Rows per symbol for live announcement evidence.",
    )
    args = parser.parse_args()

    codes = [item.strip().zfill(6) for item in args.codes.split(",") if item.strip()] or None
    committee_payload = run_committee(codes)
    report = build_research_report(
        committee_payload,
        codes=codes,
        enable_live_sources=args.live_sources,
        source_page_size=args.source_page_size,
    )
    write_research_outputs(report, Path(args.output), Path(args.markdown), Path(args.evidence_dir))

    payload = report.to_dict()
    print(f"research decisions: {len(payload.get('decisions', []))}")
    print(f"evidence rows: {len(payload.get('evidence', []))}")
    print(f"json: {args.output}")
    print(f"markdown: {args.markdown}")
    print(f"evidence: {args.evidence_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
