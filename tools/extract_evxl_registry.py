"""Extract the benchmark registry that evxl.app ships inside its JS bundle.

evxl embeds the full list of tracked benchmarks as a JSON literal in a chunk. Each
entry carries the pieces we cannot derive ourselves:

  benchmarkName       display name, and what a user's evxl URL refers to
  kovaaksBenchmarkId  the key into KovaaK's own benchmark API, where the real
                      score thresholds (rank_maxes) live
  rankColors          hex colour per rank, per difficulty
  categories          category / subcategory structure with colours

Run tools/scrape_evxl_bundle.py first to populate tools/_bundle/.
Output: data/evxl_registry.json
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "tools" / "_bundle"
OUT = ROOT / "data" / "evxl_registry.json"

# The registry is emitted as JSON.parse('[...]') or JSON.parse(`[...]`).
PARSE_RE = re.compile(r"JSON\.parse\((['\"`])(\[\{.*?\}\])\1\)", re.DOTALL)


def unescape(raw: str, quote: str) -> str:
    """Undo the JS string escaping applied to the embedded JSON literal."""
    if quote == "`":
        # Template literal: only backslash-escapes and escaped backticks.
        return raw.replace("\\`", "`").replace("\\\\", "\\")
    out = raw.replace(f"\\{quote}", quote)
    # A literal backslash in the JSON (rare here) survives as-is; JSON's own
    # escapes must be preserved for json.loads to handle.
    return out


def main() -> int:
    if not BUNDLE.exists():
        print(f"missing {BUNDLE} - run scrape_evxl_bundle.py first")
        return 1

    benchmarks: dict[str, dict] = {}

    for path in sorted(BUNDLE.glob("*.js")):
        text = path.read_text(encoding="utf-8", errors="replace")
        for quote, body in PARSE_RE.findall(text):
            candidate = unescape(body, quote)
            try:
                data = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if not isinstance(data, list):
                continue
            for entry in data:
                if isinstance(entry, dict) and "benchmarkName" in entry:
                    # Later chunks may repeat entries; first definition wins.
                    benchmarks.setdefault(entry["benchmarkName"], entry)

    if not benchmarks:
        print("no benchmark registry found in bundle")
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "source": "evxl.app client bundle",
                "count": len(benchmarks),
                "benchmarks": sorted(benchmarks.values(), key=lambda b: b["benchmarkName"]),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"extracted {len(benchmarks)} benchmarks -> {OUT}")
    for name in sorted(benchmarks):
        diffs = benchmarks[name].get("difficulties") or []
        ids = [d.get("kovaaksBenchmarkId") for d in diffs]
        print(f"  {name:38} difficulties={len(diffs):>2}  kovaaksIds={ids}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
