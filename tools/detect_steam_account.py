"""Work out which Steam account on this machine is the KovaaK's player.

A machine can have several Steam logins. Apogee needs the one whose server-side
KovaaK's scores actually correspond to the local stats folder, because that pairing is
what the whole verification model rests on (PLAN.md §5).

Rather than trusting "most recent login", we correlate: for each candidate SteamID, ask
KovaaK's for their benchmark progress and see how many scenario scores it reports, and
how well those line up with the local personal bests.

Usage: python tools/detect_steam_account.py [benchmarkId]
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Steam is wherever it was installed, which is very often not C:. Steam records its
# extra library folders in libraryfolders.vdf, so the install root is found rather than
# assumed - this was one developer's `E:\Steam` and worked on exactly one machine.
STATS_SUFFIX = Path("steamapps/common/FPSAimTrainer/FPSAimTrainer/stats")


def steam_roots() -> list[Path]:
    """Every Steam install root worth looking in, best guess first."""
    roots: list[Path] = []

    for env in ("ProgramFiles(x86)", "ProgramFiles"):
        base = os.environ.get(env)
        if base:
            roots.append(Path(base) / "Steam")

    for drive in "CDEFGH":
        roots.append(Path(f"{drive}:/Steam"))
        roots.append(Path(f"{drive}:/Program Files (x86)/Steam"))

    # Libraries declared by whichever root exists: the game is frequently on a different
    # drive from Steam itself.
    for root in list(roots):
        vdf = root / "steamapps" / "libraryfolders.vdf"
        try:
            text = vdf.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for match in re.finditer(r'"path"\s*"([^"]+)"', text):
            roots.append(Path(match.group(1).replace("\\\\", "\\")))

    seen: list[Path] = []
    for root in roots:
        if root not in seen:
            seen.append(root)
    return seen


def find_stats() -> Path | None:
    for root in steam_roots():
        candidate = root / STATS_SUFFIX
        if candidate.is_dir():
            return candidate
    return None


def find_loginusers() -> Path | None:
    for root in steam_roots():
        candidate = root / "config" / "loginusers.vdf"
        if candidate.is_file():
            return candidate
    return None


LOGINUSERS = find_loginusers()
STATS = find_stats()

API = "https://kovaaks.com/webapp-backend/benchmarks/player-progress-rank-benchmark"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36"

# Voltaic S5 Intermediate by default - the set most likely to be populated.
DEFAULT_BENCHMARK_ID = 458


def steam_accounts() -> list[tuple[str, str]]:
    if LOGINUSERS is None:
        searched = "\n".join(f"  {r / 'config' / 'loginusers.vdf'}" for r in steam_roots())
        sys.exit(f"no Steam loginusers.vdf found. Searched:\n{searched}")
    text = LOGINUSERS.read_text(encoding="utf-8", errors="replace")
    out = []
    for m in re.finditer(r'"(7656\d{13})"\s*\{(.*?)\n\t\}', text, re.DOTALL):
        block = m.group(2)
        persona = re.search(r'"PersonaName"\s*"([^"]*)"', block)
        out.append((m.group(1), persona.group(1) if persona else "?"))
    return out


def local_bests() -> dict[str, float]:
    """Highest local score per scenario, from the filenames + Score: field."""
    if STATS is None:
        searched = "\n".join(f"  {r / STATS_SUFFIX}" for r in steam_roots())
        sys.exit(f"no KovaaK's stats folder found. Searched:\n{searched}")
    bests: dict[str, float] = {}
    for path in STATS.glob("*Stats.csv"):
        name = path.name.split(" - Challenge - ")[0]
        if " S5" not in name:
            continue
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith("Score:,"):
                    score = float(line.split(",", 1)[1])
                    if score > bests.get(name, 0):
                        bests[name] = score
                    break
        except Exception:
            continue
    return bests


def fetch_progress(benchmark_id: int, steam_id: str) -> dict:
    url = f"{API}?benchmarkId={benchmark_id}&steamId={steam_id}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main() -> int:
    benchmark_id = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_BENCHMARK_ID

    local = local_bests()
    print(f"local S5 scenarios with scores: {len(local)}\n")

    accounts = steam_accounts()
    results = []

    for steam_id, persona in accounts:
        try:
            data = fetch_progress(benchmark_id, steam_id)
        except Exception as exc:
            print(f"{steam_id}  {persona:<32} ERROR {exc}")
            continue

        scored = 0
        matched = 0
        for cat in (data.get("categories") or {}).values():
            for name, scen in (cat.get("scenarios") or {}).items():
                # The API reports score fixed-point, scaled by 100, while rank_maxes
                # are in raw score units. Confirmed against real accounts.
                score = (scen.get("score") or 0) / 100.0
                if score > 0:
                    scored += 1
                    # Server PB should be present locally and no higher than the
                    # local best (local includes runs never submitted as a PB).
                    if name in local and abs(local[name] - score) < max(1.0, score * 0.02):
                        matched += 1

        overall = data.get("overall_rank")
        results.append((matched, scored, steam_id, persona, overall))
        print(
            f"{steam_id}  {persona:<32} scenarios_scored={scored:<3} "
            f"matches_local={matched:<3} overall_rank={overall}"
        )

    if not results:
        return 1

    results.sort(reverse=True)
    best = results[0]
    print()
    if best[0] == 0 and best[1] == 0:
        print("No account has server-side data for this benchmark.")
        return 0

    print(f"=> most likely account: {best[2]} ({best[3]})")
    print(f"   {best[0]} of {best[1]} scored scenarios corroborated by local stats")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
