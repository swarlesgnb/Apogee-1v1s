/**
 * Learn how long each scenario is meant to last, from a corpus of runs.
 *
 * A scenario's length is a property of the scenario, so it is learned once and
 * committed as reference data, exactly like the scoring relations in score_models.json.
 * Learning it rather than hardcoding 60 seconds is what keeps the check honest across
 * benchmarks: the 54 Voltaic S5 scenarios are all 60s, but pressure and "nevermiss"
 * scenarios end the moment you miss, and a global constant would call every one of
 * those an abandonment.
 *
 * The statistic is the mode, not the mean. Scenario length is a fixed value that a few
 * runs overshoot, because the file is written when the player leaves the screen rather
 * than when the timer ends: one PGT run in this corpus reads 434 seconds. A mean is
 * dragged by those; the mode is the value the scenario actually is.
 *
 *   npx tsx src/core/verify/buildDurations.ts [statsFolder]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseStatsFile } from "../stats/parseStatsFile.ts";
import { runDurationSeconds } from "../stats/duration.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const OUT = new URL("../../../data/scenario_durations.json", import.meta.url);

/** Runs needed before a scenario's length is trusted. */
const MIN_RUNS = 5;

/**
 * Share of a scenario's runs that must agree on the modal length.
 *
 * A scenario whose runs scatter has no fixed length to learn, and guessing one would
 * put legitimate runs at risk. Those are written out with a null duration, which
 * isAbandonedRun treats as "do not check".
 */
const MIN_AGREEMENT = 0.6;

export interface ScenarioDuration {
  scenario: string;
  /** Modal length in whole seconds, or null when the scenario has no fixed length. */
  seconds: number | null;
  runs: number;
  /** Share of runs landing on the modal value. */
  agreement: number;
}

export function deriveDuration(scenario: string, durations: number[]): ScenarioDuration {
  const usable = durations.filter((d) => d > 0);

  if (usable.length < MIN_RUNS) {
    return { scenario, seconds: null, runs: usable.length, agreement: 0 };
  }

  const counts = new Map<number, number>();
  for (const d of usable) {
    const whole = Math.round(d);
    counts.set(whole, (counts.get(whole) ?? 0) + 1);
  }

  // Runs land on the modal second or the one either side of it, since start and end are
  // recorded at different resolutions. Count that whole band as agreement.
  let best = 0;
  let bestCount = 0;
  for (const [value, count] of counts) {
    const band = (counts.get(value - 1) ?? 0) + count + (counts.get(value + 1) ?? 0);
    if (band > bestCount) {
      bestCount = band;
      best = value;
    }
  }

  const agreement = bestCount / usable.length;

  return {
    scenario,
    seconds: agreement >= MIN_AGREEMENT ? best : null,
    runs: usable.length,
    agreement,
  };
}

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;
  const byScenario = new Map<string, number[]>();

  let parsed = 0;
  let skipped = 0;

  for (const file of readdirSync(dir).filter((f) => f.endsWith("Stats.csv"))) {
    try {
      const result = parseStatsFile(file, readFileSync(join(dir, file), "utf8"));
      if (!result.ok) {
        skipped++;
        continue;
      }

      const seconds = runDurationSeconds(result.run.challengeStart, result.run.playedAt);
      if (seconds === null) {
        skipped++;
        continue;
      }

      parsed++;
      const list = byScenario.get(result.run.scenario);
      if (list) list.push(seconds);
      else byScenario.set(result.run.scenario, [seconds]);
    } catch {
      skipped++;
    }
  }

  const models = [...byScenario.entries()]
    .map(([scenario, durations]) => deriveDuration(scenario, durations))
    .sort((a, b) => a.scenario.localeCompare(b.scenario));

  const learned = models.filter((m) => m.seconds !== null);

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        source: "learned from local run history",
        builtAt: new Date().toISOString(),
        runs: parsed,
        note:
          "Modal run length per scenario, in seconds. null means the scenario has no " +
          "fixed length (pressure and nevermiss scenarios end early by design), and " +
          "abandonment is not checked for those.",
        durations: models,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`parsed ${parsed} runs, skipped ${skipped}`);
  console.log(`scenarios seen      : ${models.length}`);
  console.log(`with a fixed length : ${learned.length} (${((learned.length / models.length) * 100).toFixed(1)}%)`);

  const lengths = new Map<number, number>();
  for (const m of learned) lengths.set(m.seconds!, (lengths.get(m.seconds!) ?? 0) + 1);
  const common = [...lengths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`common lengths      : ${common.map(([s, n]) => `${s}s x${n}`).join(", ")}`);

  const unfixed = models.filter((m) => m.seconds === null && m.runs >= MIN_RUNS);
  console.log(`no fixed length     : ${unfixed.length} scenarios, not checked for abandonment`);
  for (const m of unfixed.slice(0, 5)) {
    console.log(`  ${m.scenario.slice(0, 44).padEnd(46)}${m.runs} runs, ${(m.agreement * 100).toFixed(0)}% agreement`);
  }

  console.log(`\nwrote ${OUT.pathname.split("/").pop()}`);
}

main();
