from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import BaseModel, Field

from backend.app import execute_order, read_json_report, trade_state, trading_state, write_json_report
from backend.committee.roles import repo_root
from backend.execution.audit import append_execution_audit


class CliOrder(BaseModel):
    side: str = Field(pattern="^(BUY|SELL)$")
    code: str
    name: str | None = None
    quantity: int = Field(gt=0)
    price: float | None = Field(default=None, gt=0)
    dryRun: bool = True


def main() -> int:
    parser = argparse.ArgumentParser(description="Submit or preflight a paper-trading order.")
    parser.add_argument("--side", choices=("BUY", "SELL"), required=True)
    parser.add_argument("--code", required=True)
    parser.add_argument("--name", default=None)
    parser.add_argument("--quantity", type=int, required=True)
    parser.add_argument("--price", type=float, default=None)
    parser.add_argument("--execute", action="store_true", help="Persist a paper order if all gates pass. Defaults to dry-run.")
    args = parser.parse_args()

    order = CliOrder(
        side=args.side,
        code=args.code,
        name=args.name,
        quantity=args.quantity,
        price=args.price,
        dryRun=not args.execute,
    )
    state = trade_state()
    recommendation = read_json_report("reports/data/latest-quant-recommendation.json", {})
    record = execute_order(order, state, recommendation)  # type: ignore[arg-type]
    if args.execute or record["status"] == "REJECTED":
        write_json_report("reports/data/trade-ops-state.json", state)
    append_execution_audit("cli.paper_order", order.model_dump(), record)

    payload = {"order": record, "state": trading_state()}
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"state: {repo_root() / 'reports/data/trade-ops-state.json'}")
    print(f"audit: {repo_root() / 'reports/data/execution-audit.jsonl'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
