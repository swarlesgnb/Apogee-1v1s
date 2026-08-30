/**
 * Derive per-scenario scoring relations from a corpus of runs.
 *
 * Most KovaaK's scenarios score as a fixed multiple of a countable stat (kills, hits,
 * or damage) and that multiple is a property of the scenario, not the player. Learning
 * it lets us re-derive the score from the run's own counters, which is the only local
 * defence against the simplest attack there is: editing `Score:` and nothing else.
 *
 * The relation is a fact about the scenario, so the output is reference data and is
 * committed. Rebuild it as new scenarios appear:
 *
 *   npx tsx src/core/verify/buildScoreModels.ts [statsFolder]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseStatsFile, type ParsedRun } from "../stats/parseStatsFile.ts";
import type { ScoreModel, WeaponScoreModel } from "./consistency.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const OUT = new URL("../../../data/score_models.json", import.meta.url);

/** Runs needed before a relation is trusted. Higher is safer; 8 is already strong. */
const MIN_RUNS = 8;

/** Relative agreement required across every run for a relation to count as constant. */
const TOLERANCE = 0.001;

/**
 * How close a scenario's fastest run must sit to its median one before its shots count
 * as a tick rate rather than a person clicking. See `deriveShotRate`.
 */
const TICK_RATE_GATE = 1.02;

const STATS: { name: ScoreModel["stat"]; get: (r: ParsedRun) => number | null }[] = [
  { name: "kills", get: (r) => r.kills },
  { name: "hitCount", get: (r) => r.hitCount },
  { name: "damageDone", get: (r) => r.damageDone },
];

export function deriveModel(runs: ParsedRun[]): ScoreModel | null {
  for (const { name, get } of STATS) {
    const ratios: number[] = [];

    for (const run of runs) {
      const value = get(run);
      // A zero stat says nothing about the multiplier either way.
      if (value == null || value === 0) continue;
      ratios.push(run.score / value);
    }

    if (ratios.length < MIN_RUNS) continue;

    const first = ratios[0];
    if (!Number.isFinite(first) || first === 0) continue;

    const constant = ratios.every(
      (r) => Math.abs(r - first) / Math.abs(first) <= TOLERANCE,
    );
    if (!constant) continue;

    return { stat: name, k: snap(first) };
  }
  return null;
}

/**
 * Snap a learned ratio to a clean value where the relation is obviously an integer or a
 * simple fraction; float noise in damage-based scoring otherwise leaves 9.999999994.
 *
 * Three decimal places is the wrong resolution below 0.001, and weapon damage rates do
 * get that small (`Aethercontrol Easy` records 0.001 damage per shot), so anything
 * under that keeps full precision rather than being rounded to zero.
 */
function snap(value: number): number {
  if (Math.abs(value) < 0.001) return value;
  const rounded = Math.round(value * 1000) / 1000;
  return Math.abs(rounded - Math.round(rounded)) < 1e-6 ? Math.round(rounded) : rounded;
}

/** Sum one column of the weapon block across every weapon a run used. */
function weaponTotal(run: ParsedRun, field: "shots" | "damageDone" | "damagePossible"): number {
  return run.weapons.reduce((sum, w) => (w[field] != null ? sum + w[field]! : sum), 0);
}

/**
 * The constant ratio `num/den` across a scenario's runs, or null if it is not constant.
 *
 * A run where the denominator is zero carries no information about the ratio, so it is
 * skipped rather than allowed to disqualify the relation.
 */
function constantRatio(
  runs: ParsedRun[],
  num: (r: ParsedRun) => number,
  den: (r: ParsedRun) => number,
): number | null {
  const ratios: number[] = [];
  for (const run of runs) {
    const d = den(run);
    if (d === 0) continue;
    const ratio = num(run) / d;
    if (!Number.isFinite(ratio)) continue;
    ratios.push(ratio);
  }
  if (ratios.length < MIN_RUNS) return null;

  const first = ratios[0];
  if (first === 0) return null;
  const constant = ratios.every((r) => Math.abs(r - first) / Math.abs(first) <= TOLERANCE);
  return constant ? snap(first) : null;
}

/**
 * The scenario's firing rate, where its shots are engine ticks rather than human clicks.
 *
 * The gate is what makes this safe. A scenario qualifies only where the fastest run
 * fires within 2% of the median one, which is true of a weapon that ticks continuously
 * and false of anything a person clicks. Without it the "rate" would be one player's
 * clicking speed, and a faster player would fail a check they never had a way to pass.
 *
 * The median sets the rate, not the maximum: one corrupt or mis-timed training run
 * should not raise the bar for everyone else.
 */
export function deriveShotRate(runs: ParsedRun[], seconds: number): number | null {
  const rates = runs
    .map((r) => weaponTotal(r, "shots") / seconds)
    .filter((rate) => rate > 0)
    .sort((a, b) => a - b);
  if (rates.length < MIN_RUNS) return null;

  const median = rates[Math.floor(rates.length / 2)];
  const fastest = rates[rates.length - 1];
  if (median <= 0 || fastest / median > TICK_RATE_GATE) return null;
  return median;
}

/**
 * Learn the weapon block's own relations, which is what verification falls back to when
 * a run has no kill rows to reconstruct from (PLAN.md §5).
 *
 * Both relations are required. `Damage Possible = Shots * damagePerShot` is the one
 * that does the real work — it pins the only column with no copy in the summary tail —
 * and it is worthless without a score relation to pin the shot count to in the first
 * place, so a scenario that yields only one of the two is left unmodelled.
 *
 * `Damage Done` rather than `Hits` as the score's source: measured across the runs that
 * have no kill rows, the damage relation holds for all 85 scenarios with enough
 * history, where the hits relation loses one to a varying rate.
 */
export function deriveWeaponModel(runs: ParsedRun[]): WeaponScoreModel | null {
  const scorePerDamage = constantRatio(
    runs,
    (r) => r.score,
    (r) => weaponTotal(r, "damageDone"),
  );
  if (scorePerDamage == null) return null;

  const damagePerShot = constantRatio(
    runs,
    (r) => weaponTotal(r, "damagePossible"),
    (r) => weaponTotal(r, "shots"),
  );
  if (damagePerShot == null) return null;

  return { scorePerDamage, damagePerShot };
}

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;

  // Scenario lengths are learned separately, by buildDurations.ts. A scenario with no
  // fixed length (pressure and nevermiss modes end early by design) carries null and
  // gets no firing rate, which is correct: there is no length to be a rate over.
  const durations = new Map<string, number>();
  const durationFile = JSON.parse(
    readFileSync(new URL("../../../data/scenario_durations.json", import.meta.url), "utf8"),
  ) as { durations: { scenario: string; seconds: number | null }[] };
  for (const d of durationFile.durations) {
    if (d.seconds != null) durations.set(d.scenario, d.seconds);
  }

  const byScenario = new Map<string, ParsedRun[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith("Stats.csv"))) {
    try {
      const result = parseStatsFile(file, readFileSync(join(dir, file), "utf8"));
      if (!result.ok) continue;
      const list = byScenario.get(result.run.scenario) ?? [];
      list.push(result.run);
      byScenario.set(result.run.scenario, list);
    } catch {
      /* parser is validated separately */
    }
  }

  const models: Record<string, ScoreModel> = {};
  const weaponModels: Record<string, WeaponScoreModel> = {};
  const shotRates: Record<string, number> = {};
  let considered = 0;
  let skippedThin = 0;

  for (const [scenario, runs] of [...byScenario].sort()) {
    if (runs.length < MIN_RUNS) {
      skippedThin++;
      continue;
    }
    considered++;
    const model = deriveModel(runs);
    if (model) models[scenario] = model;
    const weaponModel = deriveWeaponModel(runs);
    if (weaponModel) weaponModels[scenario] = weaponModel;

    const seconds = durations.get(scenario);
    if (seconds) {
      const rate = deriveShotRate(runs, seconds);
      if (rate) shotRates[scenario] = snap(rate);
    }
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        $comment: [
          "Learned scoring relations: score = <stat> * k, per scenario.",
          "Derived from observed runs, not from documentation. A scenario only appears",
          "here if the relation held across every observed run with no exceptions.",
          "Used by the score_matches_model integrity check; scenarios absent from this",
          "file simply skip that check rather than failing it.",
          "",
          "weaponModels holds the same idea for the weapon block: score = Damage Done *",
          "scorePerDamage, and Damage Possible = Shots * damagePerShot. Those are what",
          "verify a tracking run against an invincible target, which scores at a rate",
          "and so has no kill rows to reconstruct from.",
          "",
          "shotRates is the scenario's own firing rate, in shots per second, and only",
          "for scenarios whose shots are engine ticks rather than human clicks. It is",
          "the one bound that is not a ratio, so it is the only thing that sees a",
          "forgery that scales every counter in the file by the same factor.",
          "Rebuild with: npx tsx src/core/verify/buildScoreModels.ts",
        ],
        minRuns: MIN_RUNS,
        tolerance: TOLERANCE,
        derivedFrom: `${byScenario.size} scenarios`,
        models,
        weaponModels,
        shotRates,
      },
      null,
      2,
    ),
    "utf8",
  );

  const byStat = new Map<string, number>();
  for (const m of Object.values(models)) {
    byStat.set(m.stat, (byStat.get(m.stat) ?? 0) + 1);
  }

  console.log(`scenarios seen        : ${byScenario.size}`);
  console.log(`too few runs (<${MIN_RUNS})   : ${skippedThin}`);
  console.log(`considered            : ${considered}`);
  console.log(`models derived        : ${Object.keys(models).length}` +
    ` (${((Object.keys(models).length / considered) * 100).toFixed(1)}%)`);
  console.log(`  by stat             : ${[...byStat].map(([s, n]) => `${s}=${n}`).join("  ")}`);

  const weaponCount = Object.keys(weaponModels).length;
  console.log(`weapon models derived : ${weaponCount}` +
    ` (${((weaponCount / considered) * 100).toFixed(1)}%)`);
  // The point of the weapon models is the runs the kill-row checks cannot touch, so
  // that is the number worth printing.
  const noRowRuns = [...byScenario.values()].flat().filter((r) => r.killRows.length === 0);
  const noRowCovered = noRowRuns.filter((r) => weaponModels[r.scenario]).length;
  console.log(`  runs with no kill rows: ${noRowCovered} of ${noRowRuns.length} covered` +
    ` (${((noRowCovered / noRowRuns.length) * 100).toFixed(1)}%)`);

  const rateNames = Object.keys(shotRates);
  const rateNoRow = rateNames.filter((name) => {
    const runs = byScenario.get(name)!;
    return runs.filter((r) => r.killRows.length === 0).length > runs.length / 2;
  }).length;
  console.log(`firing rates derived  : ${rateNames.length}` +
    ` (${rateNoRow} of them kill-row-less)`);

  console.log(`\nwrote data/score_models.json`);
}

main();
