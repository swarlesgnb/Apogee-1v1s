"""Build complete benchmark definitions by joining evxl's registry to KovaaK's API.

evxl's registry gives us benchmarkName -> kovaaksBenchmarkId (+ rank colours).
KovaaK's own benchmark endpoint gives us, per difficulty:

    categories -> scenarios -> rank_maxes[]   the real score thresholds
                            -> leaderboard_id  for score verification
    ranks[]                                    rank names, icons, order

Together that is everything needed to rank a player in any of the benchmarks
evxl tracks, from official data, with no spreadsheet and no guessing.

Usage:
    python tools/fetch_benchmark_defs.py                 # every benchmark the pool names
    python tools/fetch_benchmark_defs.py "Voltaic S5"    # one benchmark
    python tools/fetch_benchmark_defs.py --all           # every benchmark (slow)

Output: data/benchmarks/<slug>.json
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "data" / "evxl_registry.json"
POOL = ROOT / "data" / "pool.json"
OUTDIR = ROOT / "data" / "benchmarks"

API = "https://kovaaks.com/webapp-backend/benchmarks/player-progress-rank-benchmark"
# A syntactically valid but unused SteamID: returns thresholds with zeroed scores.
ANON_STEAM_ID = "76561198000000000"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

# The pool names the benchmarks it draws from, and src/core/season/validatePool.ts rejects
# a scenario that comes from anywhere else. That check can only see benchmarks whose
# definitions are committed here, so the default set *is* pool.sources rather than a list
# that once matched it.
#
# It used to be "the top fifteen of the popularity measurement", which went wrong in the
# way a derived default does: the first version was five hand-named benchmarks, and by the
# time the pool grew to sixteen families only two of the top fifteen were committed, which
# read as nineteen scenarios "in no committed benchmark" when the real fault was here.
# Reading pool.sources removes the gap entirely - the list that decides what is allowed is
# the list that decides what is fetched.

# Kept only as the answer when there is no pool to read.
FALLBACK_SET = ["Voltaic S5", "Voltaic S5.5", "Voltaic S4", "Revosect S5", "Aimerz+ S1"]


def default_set() -> list[str]:
    if not POOL.exists():
        print("no data/pool.json - falling back to the named set")
        return FALLBACK_SET
    sources = json.loads(POOL.read_text(encoding="utf-8")).get("sources") or []
    if not sources:
        print("data/pool.json names no sources - falling back to the named set")
        return FALLBACK_SET
    return list(sources)


def slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", name).strip("-").lower()
    return s or "benchmark"


def fetch_progress(benchmark_id: int, steam_id: str = ANON_STEAM_ID) -> dict:
    url = f"{API}?benchmarkId={benchmark_id}&steamId={steam_id}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def build(entry: dict) -> dict:
    """Turn one registry entry into a full, self-contained benchmark definition."""
    difficulties = []

    for diff in entry.get("difficulties") or []:
        kid = diff.get("kovaaksBenchmarkId")
        # -1 / None mark benchmarks hosted elsewhere (Aimbeast) or not yet linked.
        if not isinstance(kid, int) or kid <= 0:
            print(f"    skip difficulty {diff.get('difficultyName')!r} (no KovaaK's id)")
            continue

        try:
            data = fetch_progress(kid)
        except Exception as exc:
            print(f"    !! {diff.get('difficultyName')}: {exc}")
            continue

        # ranks[] includes a leading "No Rank" sentinel; rank_maxes aligns with
        # the remaining entries, so drop it to keep thresholds and names parallel.
        rank_names = [r.get("name") for r in data.get("ranks") or []]
        if rank_names and rank_names[0] in ("No Rank", "Unranked"):
            rank_names = rank_names[1:]

        categories = []
        for cat_name, cat in (data.get("categories") or {}).items():
            scenarios = []
            for scen_name, scen in (cat.get("scenarios") or {}).items():
                scenarios.append(
                    {
                        "name": scen_name,
                        "leaderboardId": scen.get("leaderboard_id"),
                        "rankMaxes": scen.get("rank_maxes") or [],
                    }
                )
            categories.append(
                {
                    "name": cat_name,
                    "rankMaxes": cat.get("rank_maxes") or [],
                    "scenarios": scenarios,
                }
            )

        difficulties.append(
            {
                "name": diff.get("difficultyName"),
                "kovaaksBenchmarkId": kid,
                "rankNames": rank_names,
                # evxl's per-rank hex colours, keyed by rank name.
                "rankColors": diff.get("rankColors") or {},
                "categories": categories,
            }
        )
        n_scen = sum(len(c["scenarios"]) for c in categories)
        print(f"    {diff.get('difficultyName'):<16} {n_scen:>3} scenarios, ranks={rank_names}")
        time.sleep(0.3)

    return {
        "benchmarkName": entry["benchmarkName"],
        "abbreviation": entry.get("abbreviation"),
        "color": entry.get("color"),
        "spreadsheetURL": entry.get("spreadsheetURL"),
        "evxlUrl": f"https://evxl.app/benchmarks/{urllib.request.quote(entry['benchmarkName'])}",
        "source": "kovaaks.com benchmarks API + evxl registry",
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "difficulties": difficulties,
    }


def main(argv: list[str]) -> int:
    if not REGISTRY.exists():
        print("missing data/evxl_registry.json - run `npm run fetch:evxl` first")
        return 1

    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    by_name = {b["benchmarkName"]: b for b in registry["benchmarks"]}

    if "--all" in argv:
        wanted = list(by_name)
    elif len(argv) > 1:
        wanted = argv[1:]
    else:
        wanted = default_set()

    OUTDIR.mkdir(parents=True, exist_ok=True)
    ok = 0

    for name in wanted:
        entry = by_name.get(name)
        if entry is None:
            print(f"!! unknown benchmark: {name!r}")
            continue

        print(f"\n{name}")
        definition = build(entry)
        if not definition["difficulties"]:
            print("    (no usable difficulties, skipped)")
            continue

        path = OUTDIR / f"{slugify(name)}.json"
        path.write_text(json.dumps(definition, indent=2), encoding="utf-8")
        print(f"    -> {path.relative_to(ROOT)}")
        ok += 1

    print(f"\nwrote {ok} benchmark definitions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
