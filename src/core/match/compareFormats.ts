/**
 * Does the stronger player win more often? Mean delta against best-of-3 rounds.
 *
 * The question that moved ranked off mean delta (PLAN.md §3). Every pairing here is two
 * real runs on the same scenario from the stats folder: the same player at two moments,
 * months apart, so one side is measurably stronger than the other. Strength at a moment
 * is the production baseline at that moment - the median of the previous 50 runs,
 * floored at 90% of the best so far (baseline.ts) - and the gap is the difference
 * between the two baselines.
 *
 * Each pair is scored both ways: by raw score, as a round is now, and by delta against
 * each side's own baseline, as it was. A match is three pairs from three different
 * scenarios in the same gap band, decided best-of-3 on raw score or by mean delta.
 *
 * What it cannot show: two different people. A player's past self differs from them by
 * practice alone, not by hand speed or setup, so the bands describe skill gaps of the size
 * one player crosses by improving. That is the gap the ladder has to resolve.
 *
 *   npx tsx src/core/match/compareFormats.ts [statsFolder]
 */

import { baselineFromScores } from "../history/baseline.ts";
import { scanStatsFolder } from "../history/history.ts";
import { seededRandom } from "./scenarioSelection.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

/** Runs of history before a run counts as a measured moment, as a ranked baseline needs. */
const MIN_PRIOR_RUNS = 10;
/** Scenarios with fewer runs than this cannot supply moments far enough apart. */
const MIN_SCENARIO_RUNS = 60;
const PAIRS_PER_SCENARIO = 400;
const MATCHES_PER_BAND = 4000;

interface Moment {
  score: number;
  baseline: number;
}

interface Pair {
  scenario: string;
  /** The side with the higher baseline. */
  strong: Moment;
  weak: Moment;
  gap: number;
}

const BANDS: { label: string; lo: number; hi: number }[] = [
  { label: "under 2%", lo: 0, hi: 0.02 },
  { label: "2-5%", lo: 0.02, hi: 0.05 },
  { label: "5-10%", lo: 0.05, hi: 0.1 },
  { label: "10-20%", lo: 0.1, hi: 0.2 },
  { label: "20% and over", lo: 0.2, hi: Infinity },
];

const delta = (m: Moment) => (m.score - m.baseline) / m.baseline;

/** 1 when the stronger side takes it, 0 when the weaker does, 0.5 level. */
const credit = (a: number, b: number) => (a > b ? 1 : a < b ? 0 : 0.5);

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;
  const history = scanStatsFolder(dir);
  const random = seededRandom("compare-formats");

  const pairs: Pair[] = [];
  let scenarios = 0;

  for (const h of history.values()) {
    if (h.runs.length < MIN_SCENARIO_RUNS) continue;
    scenarios++;

    const moments: Moment[] = [];
    let best = 0;
    for (const [i, run] of h.runs.entries()) {
      if (i >= MIN_PRIOR_RUNS) {
        const prior = h.runs.slice(0, i).map((r) => r.score);
        const baseline = baselineFromScores(h.scenario, prior, best).value;
        if (baseline > 0 && run.score > 0) moments.push({ score: run.score, baseline });
      }
      best = Math.max(best, run.score);
    }

    for (let n = 0; n < PAIRS_PER_SCENARIO; n++) {
      const a = moments[Math.floor(random() * moments.length)];
      const b = moments[Math.floor(random() * moments.length)];
      if (a === b || a.baseline === b.baseline) continue;
      const [strong, weak] = a.baseline > b.baseline ? [a, b] : [b, a];
      pairs.push({ scenario: h.scenario, strong, weak, gap: strong.baseline / weak.baseline - 1 });
    }
  }

  console.log(`${dir}\n${scenarios} scenarios with ${MIN_SCENARIO_RUNS}+ runs, ${pairs.length} pairings\n`);
  console.log("P(the stronger side wins), by skill gap:\n");
  console.log("  gap            pairs   round:raw  round:delta   match:best-of-3 raw  match:mean delta");

  for (const band of BANDS) {
    const inBand = pairs.filter((p) => p.gap >= band.lo && p.gap < band.hi);
    if (inBand.length < 30) {
      console.log(`  ${band.label.padEnd(13)} ${String(inBand.length).padStart(6)}   too few to say`);
      continue;
    }

    const roundRaw = inBand.reduce((s, p) => s + credit(p.strong.score, p.weak.score), 0) / inBand.length;
    const roundDelta = inBand.reduce((s, p) => s + credit(delta(p.strong), delta(p.weak)), 0) / inBand.length;

    // Three pairs from three different scenarios, the stronger side the same throughout.
    const byScenario = new Map<string, Pair[]>();
    for (const p of inBand) byScenario.set(p.scenario, [...(byScenario.get(p.scenario) ?? []), p]);
    const pools = [...byScenario.values()];

    let matches = 0;
    let rawWins = 0;
    let deltaWins = 0;
    if (pools.length >= 3) {
      for (let n = 0; n < MATCHES_PER_BAND; n++) {
        const picked = new Set<number>();
        while (picked.size < 3) picked.add(Math.floor(random() * pools.length));
        const three = [...picked].map((i) => pools[i][Math.floor(random() * pools[i].length)]);

        const roundsWon = three.filter((p) => p.strong.score > p.weak.score).length;
        const roundsLost = three.filter((p) => p.strong.score < p.weak.score).length;
        rawWins += roundsWon > roundsLost ? 1 : roundsWon < roundsLost ? 0 : 0.5;

        const mean = (f: (p: Pair) => Moment) => three.reduce((s, p) => s + delta(f(p)), 0) / 3;
        deltaWins += credit(mean((p) => p.strong), mean((p) => p.weak));
        matches++;
      }
    }

    const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padStart(9);
    console.log(
      `  ${band.label.padEnd(13)} ${String(inBand.length).padStart(6)}  ${pct(roundRaw)}   ${pct(roundDelta)}` +
        (matches > 0
          ? `            ${pct(rawWins / matches)}         ${pct(deltaWins / matches)}`
          : "            fewer than 3 scenarios in band"),
    );
  }

  // Printed as a reading of the table, not a claim about it: if a corpus ever disagrees,
  // the numbers above are what to believe.
  console.log(
    "\nUnder raw rounds the stronger side wins more as the gap widens, which is what lets a\n" +
      "rating learn who is better; Glicko matchmaking keeps the gap small, which keeps the\n" +
      "match even. Under mean delta it does not rise with the gap, and where it falls below\n" +
      "50% the weaker side is winning because it was still improving faster than its median.",
  );
}

main();
