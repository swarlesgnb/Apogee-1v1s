"""Generate supabase/seed.sql: the scenarios reference table.

Joins four committed sources, none of them hand-typed:

  data/benchmarks/*.json       thresholds, leaderboard ids, per difficulty
  data/scenario_taxonomy.json  KovaaK's authoritative aim types
  data/pool.json               the season pool's own family -> sub-skill decisions
  data/subskills.json          every corpus scenario's sub-skill, derived from what the
                               benchmarks publishing it call it
  data/subcategories.json      Voltaic's published mapping, for the families that are theirs

The pool is consulted by scenario name rather than by a family stem parsed out of one.
It has to be: a season family can span benchmarks - the same sub-skill measured by a
Community scenario at one window and a Voltaic one at the next - and no amount of
string-stripping recovers a family name that was never in the scenario name to begin
with. Without it every scenario outside Voltaic reaches the `scenarios` table with a null
sub_category, and a null sub_category is a scenario no sub-category queue can ever draw.

Outside the pool the sub-skill comes from `subskills.json`, which classifies 1,007 of the
corpus rather than Voltaic's eighteen. Same reason: a scenario in `scenarios` with a null
sub_category is invisible to every sub-skill surface, and before that file the null was
most of the table.

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
SUBSKILLS = ROOT / "data" / "subskills.json"
POOL = ROOT / "data" / "pool.json"
SCORE_MODELS = ROOT / "data" / "score_models.json"
OUT = ROOT / "supabase" / "seed.sql"
IDENTITY = ROOT / "data" / "scenario_identity.json"
CORRECTIONS = ROOT / "data" / "aim_type_corrections.json"


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


def load_aim_type_corrections(taxonomy: dict) -> dict[str, dict]:
    """Scenarios where KovaaK's aim type is wrong, and has been measured to be wrong.

    KovaaK's per-scenario aimType is preferred over everything else below, and that
    preference is right: a benchmark author's category name is a sub-category as often as
    a category. It is not infallible, and the failure is not cosmetic - aim_type is the
    column find-match partitions the queue on, so a scenario mislabelled here is graded by
    the season as one skill and matched as another.

    Corrections are therefore allowed, and fenced. Each one carries a measurement rather
    than an opinion (shots per kill, which separates the corpus by two orders of magnitude),
    and `npm run validate:aimtypes` re-derives every figure from the stats folder.

    Refused here: a correction that agrees with KovaaK's, which has stopped doing anything,
    and one naming a scenario the taxonomy has never heard of, which would silently never
    apply. Both are how a wrong label becomes permanent.
    """
    if not CORRECTIONS.exists():
        return {}

    doc = json.loads(CORRECTIONS.read_text(encoding="utf-8"))
    out: dict[str, dict] = {}

    for name, entry in (doc.get("corrections") or {}).items():
        known = normalise_skill((taxonomy.get(name) or {}).get("aimType"))
        want = normalise_skill(entry.get("aimType"))

        if want is None:
            raise SystemExit(f"aim_type_corrections: {name} names no usable aim type")
        if name not in taxonomy:
            raise SystemExit(
                f"aim_type_corrections: {name} is not a scenario KovaaK's publishes"
            )
        if known is not None and known == want:
            raise SystemExit(
                f"aim_type_corrections: {name} corrects to {want}, which is already "
                f"what KovaaK's says - remove it"
            )
        out[name] = entry

    return out


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

    corrections = load_aim_type_corrections(taxonomy)

    subcats = json.loads(SUBCATS.read_text(encoding="utf-8"))["families"]

    # Every corpus scenario the derivation could classify, keyed by scenario name rather
    # than by a family stem - most of the corpus has no stem Voltaic would recognise.
    derived_of: dict[str, dict] = {}
    if SUBSKILLS.exists():
        for entry in json.loads(SUBSKILLS.read_text(encoding="utf-8")).get("scenarios", []):
            if entry.get("subSkill"):
                derived_of[entry["scenario"]] = {
                    "skill": entry.get("category"),
                    "subCategory": entry["subSkill"],
                }

    # The season pool's own decisions, keyed by scenario name. Apogee owns its families,
    # so where the pool names one its sub-category is the answer, not a fallback.
    pool_of: dict[str, dict] = {}
    pool_variants: dict[str, dict] = {}
    if POOL.exists():
        for fam in json.loads(POOL.read_text(encoding="utf-8")).get("families", []):
            mapping = {
                "skill": fam.get("category"),
                "subCategory": fam.get("subCategory")
                or subcats.get(fam.get("family"), {}).get("subCategory"),
            }
            for variant in fam.get("variants", []):
                pool_of[variant["scenario"]] = mapping
                pool_variants[variant["scenario"]] = {
                    "leaderboardId": variant.get("leaderboardId"),
                    "subCategory": mapping["subCategory"],
                }

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
                    # The pool's own decision wins, then the corpus-wide derivation,
                    # then Voltaic's sheet for a family stem it recognises.
                    sub = pool_of.get(name) or derived_of.get(name) or subcats.get(fam, {})
                    tax = taxonomy.get(name, {})

                    # Preference order matters. KovaaK's per-scenario aimType is
                    # authoritative. Our own mapping is next. The benchmark's category
                    # name is the last resort, and is only a skill for some benchmarks
                    # - Voltaic's Elite tier names its categories by SUB-category, so
                    # trusting it blindly labels Pasu as "Dynamic" rather than
                    # "Clicking".
                    # A measured correction outranks KovaaK's; everything else does not.
                    corrected = corrections.get(name)
                    aim_type = (
                        (normalise_skill(corrected["aimType"]) if corrected else None)
                        or normalise_skill(tax.get("aimType"))
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

    # The pool's own scenarios, for the families nobody published.
    #
    # A season family can be sampled straight off KovaaK's leaderboards instead of taken
    # from a benchmark - `Speed` is four scenarios of exactly that - and those names are
    # in no benchmark file, so the loop above never reaches them. Eleven pool scenarios
    # were therefore missing from `scenarios`, which is the table find-match resolves a
    # pool against, and pushing the season failed outright on the list of them. Every one
    # was sitting in data/pool.json with a leaderboard id beside it.
    #
    # aim_type stays null. The pool decided the sub-category so it is the authority on
    # that, but the aim type is KovaaK's and the taxonomy has never heard of these
    # scenarios. The column is nullable for exactly this case; deriving one from the
    # sub-category would dress a guess as the authority the column is named for.
    pool_only = 0
    for name, variant in pool_variants.items():
        if name in identities:
            continue
        corrected = corrections.get(name)
        identities[name] = {
            "leaderboardId": variant["leaderboardId"],
            "aimType": (normalise_skill(corrected["aimType"]) if corrected else None)
            or normalise_skill(taxonomy.get(name, {}).get("aimType")),
            "subCategory": variant["subCategory"],
        }
        pool_only += 1

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

    # The same identities, as JSON, for the deploy path.
    #
    # seed.sql only reaches a live project through `db push --include-seed`, which
    # silently skips a seed whose hash it has already recorded - so on every deploy after
    # the first, a corrected sub-category never arrives. `sync:reference` exists for
    # exactly that and could not fix it either: it had no source for aim type or
    # sub-category and sent neither, despite its own header offering "a corrected
    # sub-category" as the reason it exists.
    #
    # This is that source. Written here rather than derived a second time in TypeScript,
    # because two derivations of the same three fields is how the seed and the live
    # project come to disagree about what a scenario is.
    IDENTITY.write_text(
        json.dumps(
            {
                "$comment": (
                    "Scenario identity: leaderboard id, KovaaK's aim type, and the "
                    "sub-category the season pool assigns. Generated by "
                    "tools/generate_seed.py alongside supabase/seed.sql, from the same "
                    "sources and the same preference order. Read by "
                    "tools/syncReferenceData.ts, which is how these reach a live project "
                    "after the first deploy. Do not hand-edit - change data/pool.json and "
                    "regenerate."
                ),
                "generatedFrom": [
                    "data/benchmarks/*.json",
                    "data/scenario_taxonomy.json",
                    "data/pool.json",
                    "data/subcategories.json",
                ],
                "scenarios": dict(sorted(identities.items())),
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    no_sub = sum(1 for i in identities.values() if not i["subCategory"])

    print(
        f"wrote {len(identities)} scenarios, {len(memberships)} memberships"
        + (f" ({pool_only} named by the pool alone)" if pool_only else "")
    )
    print(f"  -> {OUT.relative_to(ROOT)}")
    print(f"  -> {IDENTITY.relative_to(ROOT)}")
    if no_sub:
        total = len(identities)
        print(f"\n{total - no_sub} of {total} scenarios carry a sub-skill")
        print(
            f"({no_sub} do not: their benchmarks file them by target geometry or body "
            "part rather than by skill, so there is nothing to read. They seed with a "
            "null sub_category, which no sub-skill queue can draw.)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
