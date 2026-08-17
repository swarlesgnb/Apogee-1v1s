/**
 * Measure what a first attempt costs.
 *
 * A match counts only the earliest run on each of its three scenarios (PLAN.md §3), so
 * a player gets one cold attempt and no resets. Their baseline, though, is the median
 * of their last 50 runs, and most of those were played warm: third or fourth try, after
 * the hands were already going.
 *
 * If cold runs sit systematically below that baseline, then every delta in every match
 * is shifted negative, and matches stop asking "who played better today" and start
 * asking "whose cold run was least bad". That is the same failure the top-30% baseline
 * had, and it was only found by measuring rather than reasoning (PLAN.md §3), so the
 * cost of a first attempt is measured here before the rule that depends on it is built.
 *
 * What counts as cold: the first run of a scenario within a session, where a session is
 * a stretch of play with no gap longer than --gap minutes. That is the closest thing in
 * recorded history to walking into a match and playing a scenario once.
 *
 * Two methodology notes, because both would otherwise flatter the result:
 *
 *   NO LOOKAHEAD    each run is scored against a baseline built only from that
 *                   scenario's *preceding* runs. Including the run itself, or later
 *                   ones, would leak the answer into the question.
 *
 *   NO PB FLOOR     the verified-PB floor needs KovaaK's servers and is not available
 *                   offline. Its absence lowers some baselines slightly, which if
 *                   anything understates the cold penalty, so the bias is safe.
 *
 *   npx tsx src/core/history/coldStart.ts [statsFolder] [--gap 30]
 */

import { readFileSync } from "node:fs";

import { dataDir } from "../dataDir.ts";
import { join } from "node:path";
import { baselineFromScores, delta, MIN_RUNS_FOR_BASELINE } from "./baseline.ts";
import { scanStatsFolder } from "./history.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

/** Gaps at or below this many minutes keep you in the same session. */
const DEFAULT_GAP_MINUTES = 30;

/** Session gaps to re-run the headline number against, to show it is not an artefact. */
const SENSITIVITY_GAPS = [10, 20, 30, 45, 60, 120];

/**
 * Prior runs a scenario needs before its deltas are trusted here.
 *
 * MIN_RUNS_FOR_BASELINE is 5, which is enough for a baseline to exist but not enough
 * for a percentage to behave: five early runs on a freshly installed scenario give a
 * tiny baseline, and the next decent score then reads as +400%. A handful of those
 * dominate any mean. Reported at both cutoffs so the effect of the choice is visible
 * rather than assumed.
 */
const HISTORY_CUTOFFS = [MIN_RUNS_FOR_BASELINE, 25];

interface TimelineRun {
  scenario: string;
  score: number;
  at: number;
  /** Index of this run within its scenario's own history, oldest first. */
  indexInScenario: number;
}

interface Sample {
  scenario: string;
  aimType: string;
  delta: number;
  cold: boolean;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pct(x: number): string {
  const s = (x * 100).toFixed(2);
  return `${x >= 0 ? "+" : ""}${s}%`;
}

/** aimType per scenario name, from the committed taxonomy. */
function aimTypes(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw = readFileSync(join(dataDir(), "scenario_taxonomy.json"), "utf8");
    for (const s of JSON.parse(raw).scenarios as { name: string; aimType: string | null }[]) {
      if (s.aimType) out.set(s.name, s.aimType);
    }
  } catch {
    // Taxonomy is a nicety here; the overall number does not depend on it.
  }
  return out;
}

/**
 * Every run on one timeline, oldest first, tagged with its position inside its own
 * scenario's history so a causal baseline can be rebuilt for it.
 */
function timeline(history: Map<string, { runs: { score: number; playedAt: Date | null }[] }>): TimelineRun[] {
  const all: TimelineRun[] = [];

  for (const [scenario, entry] of history) {
    entry.runs.forEach((run, i) => {
      if (!run.playedAt) return;
      all.push({ scenario, score: run.score, at: run.playedAt.getTime(), indexInScenario: i });
    });
  }

  return all.sort((a, b) => a.at - b.at);
}

/**
 * Mark the first run of each scenario within each session.
 *
 * Sessions are cut on the *global* timeline rather than per scenario: standing up for
 * twenty minutes cools the hands for everything, not just the scenario last played.
 */
function markCold(runs: TimelineRun[], gapMinutes: number): boolean[] {
  const gapMs = gapMinutes * 60_000;
  const cold: boolean[] = new Array(runs.length).fill(false);
  let seenThisSession = new Set<string>();

  runs.forEach((run, i) => {
    if (i > 0 && run.at - runs[i - 1].at > gapMs) seenThisSession = new Set();
    if (!seenThisSession.has(run.scenario)) {
      cold[i] = true;
      seenThisSession.add(run.scenario);
    }
  });

  return cold;
}

/** Delta of every run against a baseline built only from what came before it. */
function samples(
  history: Map<string, { runs: { score: number; playedAt: Date | null }[] }>,
  runs: TimelineRun[],
  cold: boolean[],
  types: Map<string, string>,
  minPrior: number = MIN_RUNS_FOR_BASELINE,
): Sample[] {
  const scores = new Map<string, number[]>();
  for (const [scenario, entry] of history) {
    scores.set(scenario, entry.runs.map((r) => r.score));
  }

  const out: Sample[] = [];

  runs.forEach((run, i) => {
    const all = scores.get(run.scenario);
    if (!all) return;

    // Only the runs strictly before this one, which is what the server would have had.
    const prior = all.slice(0, run.indexInScenario);
    if (prior.length < minPrior) return;

    const base = baselineFromScores(run.scenario, prior);
    const d = delta(run.score, base.value);
    if (d === null) return;

    out.push({
      scenario: run.scenario,
      aimType: types.get(run.scenario) ?? "Unknown",
      delta: d,
      cold: cold[i],
    });
  });

  return out;
}

function describe(label: string, values: number[]): string {
  const above = values.filter((d) => d > 0).length;
  const share = values.length === 0 ? 0 : above / values.length;
  return (
    `  ${label.padEnd(12)}` +
    `${String(values.length).padStart(7)}` +
    `${pct(mean(values)).padStart(11)}` +
    `${pct(median(values)).padStart(11)}` +
    `${(share * 100).toFixed(1).padStart(9)}%`
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const gapArg = args.indexOf("--gap");
  const gapMinutes = gapArg >= 0 ? Number(args[gapArg + 1]) : DEFAULT_GAP_MINUTES;
  const dir = args.find((a) => !a.startsWith("--") && a !== String(gapMinutes)) ?? DEFAULT_STATS_DIR;

  console.log(`stats folder: ${dir}`);
  console.log(`session gap : ${gapMinutes} min\n`);

  const history = scanStatsFolder(dir);
  if (history.size === 0) {
    console.error("no runs found; pass the stats folder as the first argument");
    process.exit(1);
  }

  const runs = timeline(history);
  const cold = markCold(runs, gapMinutes);
  const types = aimTypes();
  const all = samples(history, runs, cold, types);

  const coldSamples = all.filter((s) => s.cold);
  const warmSamples = all.filter((s) => !s.cold);

  console.log(
    `${history.size} scenarios, ${runs.length} timed runs, ` +
      `${all.length} with enough prior history to score\n`,
  );

  // The question a match asks is "is this run above the player's baseline", never "is
  // it above a warmed-up run". So the decisive number is where cold sits against zero,
  // and warm is shown only to size the warm-up effect itself.
  console.log("── where a first attempt lands, against its own baseline ──");
  console.log("  history  group          runs  mean delta  median     above base");
  for (const cutoff of HISTORY_CUTOFFS) {
    const s = cutoff === MIN_RUNS_FOR_BASELINE ? all : samples(history, runs, cold, types, cutoff);
    const c = s.filter((x) => x.cold).map((x) => x.delta);
    const w = s.filter((x) => !x.cold).map((x) => x.delta);
    console.log(`  >=${String(cutoff).padEnd(6)}${describe("cold", c).slice(2)}`);
    console.log(`  ${" ".repeat(7)}${describe("warm", w).slice(2)}`);
  }

  const coldMean = mean(coldSamples.map((s) => s.delta));
  const warmMean = mean(warmSamples.map((s) => s.delta));
  const coldMed = median(coldSamples.map((s) => s.delta));
  const warmMed = median(warmSamples.map((s) => s.delta));

  console.log(`\n  cold vs its own baseline : ${pct(coldMean)} mean, ${pct(coldMed)} median`);
  console.log(`  warm-up is worth         : ${pct(warmMean - coldMean)} mean, ` +
    `${pct(warmMed - coldMed)} median`);

  console.log("\n── by aim type, cold runs only ──────────────────");
  console.log("  type           runs  mean delta  median     above base");
  for (const type of ["Clicking", "Tracking", "Target Switching", "Unknown"]) {
    const group = coldSamples.filter((s) => s.aimType === type);
    if (group.length > 0) console.log(describe(type, group.map((s) => s.delta)));
  }

  console.log("\n── is the session gap doing the work? ───────────");
  console.log("  gap (min)      cold runs   mean delta   penalty");
  for (const g of SENSITIVITY_GAPS) {
    const marks = markCold(runs, g);
    const s = samples(history, runs, marks, types);
    const c = s.filter((x) => x.cold).map((x) => x.delta);
    const w = s.filter((x) => !x.cold).map((x) => x.delta);
    console.log(
      `  ${String(g).padEnd(12)}${String(c.length).padStart(8)}` +
        `${pct(mean(c)).padStart(13)}${pct(mean(c) - mean(w)).padStart(11)}`,
    );
  }

  // A match is three cold runs averaged, so the noise that matters is the noise of the
  // mean of three, not of one.
  const sd = Math.sqrt(
    mean(coldSamples.map((s) => (s.delta - mean(coldSamples.map((x) => x.delta))) ** 2)),
  );
  const matchNoise = sd / Math.sqrt(3);
  console.log("\n── what this means for a match ──────────────────");
  console.log(`  spread of a single cold run : ${pct(sd)} (1 sd)`);
  console.log(`  spread of a 3-scenario mean : ${pct(matchNoise)} (1 sd)`);
  console.log(
    `  offset of a cold match      : ${pct(coldMed)} (median)  ` +
      `${Math.abs(coldMed) > matchNoise ? "NEEDS CORRECTION" : "within noise, leave it"}`,
  );

  console.log("\nOK: cold-start cost measured");
}

main();
