"""Pull scenario metadata for the Voltaic S5 benchmark set from the KovaaK's
public webapp backend.

We need three things per scenario that we cannot invent reliably:
  - leaderboardId : required to query the server-side score for verification
  - aimType       : KovaaK's own Clicking / Tracking / Switching classification
  - topScore      : a real ceiling, useful for sanity-checking parsed runs

Output is written to data/scenario_taxonomy.json and is checked in, so the app
does not depend on this API being reachable at runtime.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://kovaaks.com/webapp-backend/scenario/popular"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

# The 18 Voltaic S5 scenario families, in the in-game naming used by the stats
# files. Each family exists at Novice / Intermediate / Advanced.
FAMILIES = [
    "Aether",
    "Controlsphere",
    "ControlTS",
    "DotTS",
    "DriftTS",
    "EddieTS",
    "Floating Heads",
    "FlyTS",
    "Frogtagon",
    "Ground",
    "Pasu",
    "Penta Bounce",
    "PGT",
    "Popcorn",
    "Raw Control",
    "Snake Track",
    "ww5t",
]

# The one family whose name changes per difficulty rather than carrying a
# difficulty suffix on a stable stem.
IRREGULAR = {
    "Novice": "VT 1w4ts Novice S5",
    "Intermediate": "VT 1w3ts Intermediate S5",
    "Advanced": "VT 1w2ts Advanced S5",
}

DIFFICULTIES = ["Novice", "Intermediate", "Advanced"]


def expected_names() -> list[str]:
    names = []
    for diff in DIFFICULTIES:
        names.append(IRREGULAR[diff])
        for fam in FAMILIES:
            names.append(f"VT {fam} {diff} S5")
    return names


def fetch(name: str) -> dict | None:
    qs = urllib.parse.urlencode({"page": 0, "max": 20, "scenarioNameSearch": name})
    req = urllib.request.Request(f"{API}?{qs}", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.load(resp)

    # The search is fuzzy and returns variants ("... 2 Targets", "... Hard").
    # Only an exact name match is the benchmark scenario.
    for row in payload.get("data", []):
        if row.get("scenarioName") == name:
            return row
    return None


def main() -> int:
    out_path = Path(__file__).resolve().parents[1] / "data" / "scenario_taxonomy.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    scenarios: list[dict] = []
    missing: list[str] = []

    names = expected_names()
    for i, name in enumerate(names, 1):
        try:
            row = fetch(name)
        except Exception as exc:  # network hiccup should not lose prior work
            print(f"  !! {name}: {exc}", file=sys.stderr)
            missing.append(name)
            time.sleep(1.0)
            continue

        if row is None:
            print(f"  ?? no exact match: {name}", file=sys.stderr)
            missing.append(name)
            continue

        scen = row.get("scenario") or {}
        counts = row.get("counts") or {}
        scenarios.append(
            {
                "name": name,
                "difficulty": next(d for d in DIFFICULTIES if d in name),
                "leaderboardId": row.get("leaderboardId"),
                "aimType": scen.get("aimType"),
                "description": (scen.get("description") or "").strip(),
                "plays": counts.get("plays"),
                "entries": counts.get("entries"),
                "topScore": (row.get("topScore") or {}).get("score"),
            }
        )
        print(f"[{i:>2}/{len(names)}] {name} -> {scen.get('aimType')}")
        time.sleep(0.35)  # be polite to their API

    out_path.write_text(
        json.dumps(
            {
                "source": "kovaaks.com/webapp-backend/scenario/popular",
                "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "scenarios": scenarios,
                "missing": missing,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nwrote {len(scenarios)} scenarios -> {out_path}")
    if missing:
        print(f"MISSING ({len(missing)}): {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
