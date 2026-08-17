"""Generate supabase/seed.sql: the scenarios reference table.

Joins three committed sources, none of them hand-typed:

  data/benchmarks/*.json       thresholds, leaderboard ids, per difficulty
  data/scenario_taxonomy.json  KovaaK's authoritative aim types
  data/subcategories.json      the nine sub-categories (provisional)

The seed is idempotent - re-running it updates rows rather than duplicating them - so
it is safe to apply on every deploy.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BENCH_DIR = ROOT / "data" / "benchmarks"
TAXONOMY = ROOT / "data" / "scenario_taxonomy.json"
SUBCATS = ROOT / "data" / "subcategories.json"
SCORE_MODELS = ROOT / "data" / "score_models.json"
OUT = ROOT / "supabase" / "seed.sql"


def sql_str(value: str | None) -> str:
    if value is None:
        return "null"
    return "'" + value.replace("'", "''") + "'"


#: The two sources disagree on wording - KovaaK's `scenario/popular` says
#: "Target Switching" while its benchmark API says "Switching". Normalise to one set
#: so match categories and the weakness map can key off aim_type directly.
SKILLS = {
    "clicking": "Clicking",
    "tracking": "Tracking",
    "switching": "Switching",
    "target switching": "Switching",
}


def normalise_skill(value: str | None) -> str | None:
    if not value:
        return None
    return SKILLS.get(value.strip().lower())


def sql_num_array(values: list) -> str:
    if not values:
        return "'{}'"
    inner = ",".join(str(v) for v in values)
    return f"'{{{inner}}}'"


def family_of(name: str, difficulty: str) -> str:
    """'VT Frogtagon Intermediate S5' -> 'Frogtagon'.

    The difficulty label in the benchmark definition is not always the token used in
    the scenario name: 'Elite (Unofficial)' appears in scenario names as just 'Elite'.
    Matching on the first word of the label handles both.
    """
    stem = re.sub(r"^VT\s+", "", name)
    stem = re.sub(r"\s*S5(\.5)?\s*$", "", stem, flags=re.I)

    token = difficulty.split()[0] if difficulty.strip() else ""
    if token:
        stem = re.sub(rf"\s*\b{re.escape(token)}\b\s*", " ", stem, flags=re.I)

    return stem.strip()


def main() -> int:
    taxonomy = {}
    if TAXONOMY.exists():
        data = json.loads(TAXONOMY.read_text(encoding="utf-8"))
        taxonomy = {s["name"]: s for s in data.get("scenarios", [])}

    subcats = json.loads(SUBCATS.read_text(encoding="utf-8"))["families"]

    # Verification data the Edge Functions read. Absent entries simply mean the
    # corresponding check is skipped server-side, never that a run is rejected.
    score_models = {}
    if SCORE_MODELS.exists():
        score_models = json.loads(SCORE_MODELS.read_text(encoding="utf-8")).get("models", {})

    world_records = {}
    if TAXONOMY.exists():
        for s in json.loads(TAXONOMY.read_text(encoding="utf-8")).get("scenarios", []):
            if s.get("topScore"):
                world_records[s["name"]] = s["topScore"]

    # scenario name -> its global identity. A scenario belongs to many benchmarks, so
    # identity is collected once and thresholds are collected per membership.
    identities: dict[str, dict] = {}
    memberships: list[tuple[str, str, str, str | None, list]] = []

    for path in sorted(BENCH_DIR.glob("*.json")):
        bench = json.loads(path.read_text(encoding="utf-8"))
        bench_name = bench["benchmarkName"]

        for diff in bench.get("difficulties", []):
            diff_name = diff["name"]

            for cat in diff.get("categories", []):
                for scen in cat.get("scenarios", []):
                    name = scen["name"]
                    fam = family_of(name, diff_name)
                    sub = subcats.get(fam, {})
                    tax = taxonomy.get(name, {})

                    # Preference order matters. KovaaK's per-scenario aimType is
                    # authoritative. Our own mapping is next. The benchmark's category
                    # name is the last resort, and is only a skill for some benchmarks
                    # - Voltaic's Elite tier names its categories by SUB-category, so
                    # trusting it blindly labels Pasu as "Dynamic" rather than
                    # "Clicking".
                    aim_type = (
                        normalise_skill(tax.get("aimType"))
                        or normalise_skill(sub.get("skill"))
                        or normalise_skill(cat.get("name"))
                    )

                    existing = identities.get(name)
                    if existing is None:
                        identities[name] = {
                            "leaderboardId": scen.get("leaderboardId"),
                            "aimType": aim_type,
                            "subCategory": sub.get("subCategory"),
                        }
                    else:
                        # Fill gaps from whichever benchmark knows more, but never
                        # overwrite a value we already trust.
                        existing["leaderboardId"] = existing["leaderboardId"] or scen.get("leaderboardId")
                        existing["aimType"] = existing["aimType"] or aim_type
                        existing["subCategory"] = existing["subCategory"] or sub.get("subCategory")

                    memberships.append(
                        (bench_name, diff_name, name, cat.get("name"), scen.get("rankMaxes") or [])
                    )

    if not identities:
        print("no scenarios found - run fetch_benchmark_defs.py first")
        return 1

    def scenario_row(name: str, ident: dict) -> str:
        model = score_models.get(name) or {}
        return (
            "  ("
            + ", ".join(
                [
                    sql_str(name),
                    str(ident["leaderboardId"] or "null"),
                    sql_str(ident["aimType"]),
                    sql_str(ident["subCategory"]),
                    sql_str(model.get("stat")),
                    str(model["k"]) if model.get("k") is not None else "null",
                    str(world_records[name]) if name in world_records else "null",
                ]
            )
            + ")"
        )

    scenario_rows = ",\n".join(
        scenario_row(name, ident) for name, ident in sorted(identities.items())
    )

    membership_rows = ",\n".join(
        "  ("
        + ", ".join(
            [
                sql_str(bench),
                sql_str(diff),
                f"(select id from scenarios where name = {sql_str(name)})",
                sql_str(cat),
                sql_num_array(maxes),
            ]
        )
        + ")"
        for bench, diff, name, cat, maxes in memberships
    )

    sql = f"""-- Generated by tools/generate_seed.py. Do not edit by hand.
--
-- Reference data sourced from KovaaK's own benchmark API, so the thresholds here are
-- official rather than transcribed.
--
-- Two tables, because a scenario belongs to many benchmarks with different
-- thresholds: Voltaic S5.5 reuses S5's Advanced scenario names but re-tunes the ranks.
-- Identity lives in `scenarios`; thresholds live in `benchmark_scenarios`.
--
-- Idempotent: re-running updates existing rows.

insert into scenarios
  (name, leaderboard_id, aim_type, sub_category, score_model_stat, score_model_k, world_record)
values
{scenario_rows}
on conflict (name) do update set
  leaderboard_id   = coalesce(excluded.leaderboard_id, scenarios.leaderboard_id),
  aim_type         = coalesce(excluded.aim_type, scenarios.aim_type),
  sub_category     = coalesce(excluded.sub_category, scenarios.sub_category),
  score_model_stat = coalesce(excluded.score_model_stat, scenarios.score_model_stat),
  score_model_k    = coalesce(excluded.score_model_k, scenarios.score_model_k),
  world_record     = coalesce(excluded.world_record, scenarios.world_record);

insert into benchmark_scenarios (benchmark_name, difficulty, scenario_id, category, rank_maxes)
values
{membership_rows}
on conflict (benchmark_name, difficulty, scenario_id) do update set
  category   = excluded.category,
  rank_maxes = excluded.rank_maxes;
"""

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(sql, encoding="utf-8")

    no_sub = sum(1 for i in identities.values() if not i["subCategory"])

    print(f"wrote {len(identities)} scenarios, {len(memberships)} memberships")
    print(f"  -> {OUT.relative_to(ROOT)}")
    if no_sub:
        print(f"\n{no_sub} scenarios have no sub-category mapping")
        print("(expected for non-Voltaic benchmarks; they seed with a null sub_category)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
