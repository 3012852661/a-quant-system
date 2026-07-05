from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.committee.roles import repo_root
from backend.strategy.registry import build_strategy_registry


def main() -> int:
    parser = argparse.ArgumentParser(description="Build strategy registry from built-ins and Strategy-KB.")
    parser.add_argument("--output", default=str(repo_root() / "reports/data/strategy-registry.json"))
    args = parser.parse_args()

    payload = build_strategy_registry()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"strategies: {payload['summary']['total']}")
    print(f"enabled: {payload['summary']['enabled']}")
    print(f"productionReady: {payload['summary']['productionReady']}")
    print(f"json: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
