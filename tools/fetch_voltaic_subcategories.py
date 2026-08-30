"""Derive the Voltaic sub-category mapping from Voltaic's own published spreadsheet.

The nine sub-categories drive the weakness map and decide which scenarios a
sub-category queue can draw from, so getting them wrong quietly corrupts both. An
earlier version of data/subcategories.json was derived by reading scenario descriptions
and was wrong on 6 of 18 scenarios, notably swapping Tracking's Precise and Reactive
groups entirely.

This reads the mapping from the source instead. evxl's registry records each benchmark's
`spreadsheetURL`; for Voltaic S5 that is Voltaic's own public sheet, exportable as CSV.
Its first three columns are skill / sub-category / scenario, using merged cells, so the
labels are forward-filled down each group.

Two sheets, not one. S5 is authoritative and always wins. S4 is read only to cover the
families S5 never had - Bounceshot, Multiclick 120, 1w5ts Rasp, Smoothbot, Air, skyTS -
which the season pool draws on and S5 cannot answer for. S4's own layout is identical,
but its scenario lists live on tabs named Novice / Intermediate / Advanced rather than on
the default one, which exports the instructions page instead. S4 also uses a "Strafe"
group that S5 replaced; anything landing there is dropped rather than mapped onto one of
the nine, because renaming somebody's taxonomy is the guessing this file exists to avoid.

The season's own family names are Apogee's, not Voltaic's: the pool groups scenarios into
"Wide Wall" and "Ground Plaza" where the sheets say "1w4ts" and "Ground". Those are joined
here rather than in each of the five modules that read this file, and only where every
member scenario that resolves agrees. A family whose members disagree is left out, so a
split family shows up as unmapped rather than as a coin flip.

    python tools/fetch_voltaic_subcategories.py

Output: data/subcategories.json
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "data" / "evxl_registry.json"
OUT = ROOT / "data" / "subcategories.json"

BENCHMARK = "Voltaic S5"
FALLBACK = "Voltaic S4"

# S4 keeps its scenario lists on these tabs. Its default tab is the instructions page.
FALLBACK_TABS = ("Novice", "Intermediate", "Advanced")

POOL = ROOT / "data" / "pool.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36"

SKILLS = {"Clicking", "Tracking", "Switching"}
SUBCATEGORIES = {
    "Dynamic", "Static", "Linear",
    "Precise", "Reactive", "Control",
    "Speed", "Evasive", "Stability",
}


def sheet_id(url: str) -> str | None:
    m = re.search(r"/spreadsheets/d/([A-Za-z0-9_-]+)", url or "")
    return m.group(1) if m else None


def fetch_csv(sheet: str) -> str:
    export = f"https://docs.google.com/spreadsheets/d/{sheet}/export?format=csv"
    req = urllib.request.Request(export, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


def fetch_tab_csv(sheet: str, tab: str) -> str:
    """One named tab. The plain /export endpoint only ever gives the first sheet."""
    url = (
        f"https://docs.google.com/spreadsheets/d/{sheet}/gviz/tq"
        f"?tqx=out:csv&sheet={urllib.parse.quote(tab)}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


def family_of(scenario: str) -> str:
    """'VT Pasu Novice' -> 'Pasu'. The sheet omits the ' S5' the game appends."""
    stem = re.sub(r"^VT\s+", "", scenario.strip())
    stem = re.sub(r"\s*S5(\.5)?\s*$", "", stem, flags=re.I)
    stem = re.sub(
        r"\s*\b(Novice|Intermediate|Advanced|Elite)\b\s*", " ", stem, flags=re.I
    )
    return stem.strip()


def parse(csv_text: str) -> list[tuple[str, str, str]]:
    """Forward-fill the merged skill / sub-category cells down each group."""
    rows = list(csv.reader(io.StringIO(csv_text)))
    skill: str | None = None
    sub: str | None = None
    out: list[tuple[str, str, str]] = []

    for row in rows:
        if len(row) < 3:
            continue
        a, b, c = row[0].strip(), row[1].strip(), row[2].strip()

        if a in SKILLS:
            skill = a
            # A new skill begins a new sub-category run.
            sub = None

        # Any label in this column starts a new group. One of the nine is the group;
        # anything else - S4's "Strafe", which S5 replaced - ends the previous one and
        # takes its scenarios with it. Testing only for the nine would leave `sub`
        # pointing at the group above, so Strafe's rows would be filed under it: on S4
        # that silently made AngleStrafe and ArcStrafe "Static", and AirStrafe and
        # PatStrafe "Reactive". Dropping them is right - a group Voltaic retired has no
        # honest home among the nine, and inventing one is the guess this file avoids.
        if b:
            sub = b if b in SUBCATEGORIES else None

        if c.startswith("VT ") and skill and sub:
            out.append((skill, sub, c))

    return out


def main() -> int:
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))["benchmarks"]
    entry = next((b for b in registry if b["benchmarkName"] == BENCHMARK), None)
    if entry is None:
        print(f"{BENCHMARK} not in the evxl registry", file=sys.stderr)
        return 1

    sheet = sheet_id(entry.get("spreadsheetURL") or "")
    if not sheet:
        print(f"no spreadsheet URL recorded for {BENCHMARK}", file=sys.stderr)
        return 1

    print(f"source: {entry['spreadsheetURL']}")
    triples = parse(fetch_csv(sheet))

    if not triples:
        print("no scenario rows found - the sheet layout may have changed", file=sys.stderr)
        return 1

    families: dict[str, dict[str, str]] = {}
    for skill, sub, scenario in triples:
        fam = family_of(scenario)
        if not fam:
            continue
        families[fam] = {"skill": skill, "subCategory": sub}

    # The 1wXts family is named per difficulty (1w4ts / 1w3ts / 1w2ts) and the sheet
    # only lists one. They are the same scenario at three difficulties, so the mapping
    # carries across.
    for variant in ("1w4ts", "1w3ts", "1w2ts"):
        known = next((families[k] for k in families if re.fullmatch(r"1w\dts", k)), None)
        if known:
            families[variant] = dict(known)

    # ---- S4, for the families S5 never had -------------------------------------
    origin: dict[str, str] = {fam: BENCHMARK for fam in families}
    fb = next((b for b in registry if b["benchmarkName"] == FALLBACK), None)
    fb_sheet = sheet_id(fb.get("spreadsheetURL") or "") if fb else None

    if fb_sheet:
        added = 0
        for tab in FALLBACK_TABS:
            try:
                rows = parse(fetch_tab_csv(fb_sheet, tab))
            except Exception as err:  # a missing tab must not lose the S5 mapping
                print(f"  {FALLBACK}/{tab}: {type(err).__name__}", file=sys.stderr)
                continue
            for skill, sub, scenario in rows:
                fam = family_of(scenario)
                if fam and fam not in families:
                    families[fam] = {"skill": skill, "subCategory": sub}
                    origin[fam] = FALLBACK
                    added += 1
        print(f"source: {fb['spreadsheetURL']}  (+{added} families S5 does not cover)")

    # ---- the pool's own family names, joined through the sheets ------------------
    joined = 0
    if POOL.exists():
        pool = json.loads(POOL.read_text(encoding="utf-8"))
        for entry_fam in pool.get("families", []):
            name = entry_fam.get("family")
            if not name or name in families:
                continue
            seen = {
                (families[k]["skill"], families[k]["subCategory"])
                for k in (family_of(v["scenario"]) for v in entry_fam.get("variants", []))
                if k in families
            }
            # Exactly one answer among the members that resolve, or nothing.
            if len(seen) == 1:
                skill, sub = seen.pop()
                families[name] = {"skill": skill, "subCategory": sub}
                origin[name] = "pool join"
                joined += 1
        print(f"joined {joined} pool family name(s) through the sheets")

    for fam, info in families.items():
        info["source"] = origin.get(fam, BENCHMARK)

    by_sub: dict[str, list[str]] = {}
    for fam, info in families.items():
        by_sub.setdefault(f"{info['skill']}/{info['subCategory']}", []).append(fam)

    OUT.write_text(
        json.dumps(
            {
                "$comment": [
                    "Sub-category mapping keyed by scenario family (the name with the",
                    "'VT ' prefix and ' <Difficulty> S5' suffix removed), plus the season",
                    "pool's own family names joined through those same sheets.",
                    "",
                    "Each entry records the sheet it came from in `source`: Voltaic S5 is",
                    "authoritative, Voltaic S4 covers only families S5 never had, and",
                    "'pool join' means every member scenario that resolved agreed.",
                    "",
                    "AUTHORITATIVE. Generated by tools/fetch_voltaic_subcategories.py from",
                    "Voltaic's own published spreadsheet, recorded in evxl's registry as",
                    f"{entry['spreadsheetURL']}",
                    "",
                    "Do not hand-edit. Regenerate instead, so the mapping stays traceable",
                    "to its source. An earlier hand-derived version - inferred from",
                    "scenario descriptions - was wrong on 6 of 18 scenarios: it swapped",
                    "Tracking's Precise and Reactive groups, and swapped DriftTS with",
                    "Penta Bounce between Evasive and Stability.",
                ],
                "benchmark": BENCHMARK,
                "provisional": False,
                "source": entry["spreadsheetURL"],
                "families": dict(sorted(families.items())),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"\nwrote {len(families)} families -> data/subcategories.json\n")
    for group in sorted(by_sub):
        print(f"  {group:22} {', '.join(sorted(by_sub[group]))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
