/**
 * Prove the tuning sheet's formulas agree with the builder.
 *
 *   npx tsx tools/validateTuningSheet.ts
 *
 * `buildTuningSheet.ts` exports thresholds as spreadsheet formulas rather than numbers,
 * which is only useful if those formulas produce what `build:season` produced. A tuning
 * tool that quietly disagrees with the builder is worse than none: it would send somebody
 * back to `pool.json` with a number that then comes out different.
 *
 * So this re-implements the arithmetic *as the exported formula writes it* - clamp to the
 * first and last sampled point, bracket with a MATCH-style search, interpolate linearly,
 * round - deliberately without calling `scoreAtTopFraction`. Calling the function the
 * formula is supposed to match would make the check vacuous, which is the failure mode
 * PLAN.md §5 already caught once with a `players.length === 0` assertion.
 *
 * It then compares all 54 x 4 against the thresholds committed in the season file.
 */

import { readFileSync } from "node:fs";

import { dataFile } from "../src/core/dataDir.ts";
import type { Distribution } from "../src/core/season/percentiles.ts";

const season = JSON.parse(readFileSync(dataFile("seasons/season-1.json"), "utf8")) as {
  windowSize: number;
  scenarios: {
    scenario: string;
    window: number;
    rankMaxes: number[];
    derivedFrom: { topFractions: number[] };
  }[];
};
const cache = JSON.parse(
  readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"),
) as { samplePoints: number[]; distributions: Distribution[] };

const dists = new Map(cache.distributions.map((d) => [d.scenario, d]));

/** What the exported LET(...) formula computes, transcribed rather than imported. */
function asTheFormulaComputesIt(fractions: number[], scores: number[], p: number): number {
  const n = fractions.length;
  if (p <= fractions[0]) return scores[0];
  if (p >= fractions[n - 1]) return scores[n - 1];

  // MATCH(p, f, 1): the largest index whose fraction is <= p, 1-based.
  let i = 1;
  for (let k = 0; k < n; k++) if (fractions[k] <= p) i = k + 1;

  const a = fractions[i - 1];
  const b = fractions[i];
  const c = scores[i - 1];
  const d = scores[i];
  return Math.round(c + ((p - a) / (b - a)) * (d - c));
}

let checked = 0;
const wrong: string[] = [];

for (const s of season.scenarios) {
  const dist = dists.get(s.scenario);
  if (!dist) {
    wrong.push(`${s.scenario}: no sampled distribution`);
    continue;
  }
  const fractions = dist.points.map((p) => p.topFraction);
  const scores = dist.points.map((p) => p.score);

  // The sheet nudges a tied threshold past the one below it with MAX(raw, left + 1),
  // which is a chain across the window rather than a per-cell sum, so walk it the same
  // way here. Without this the comparison passes only while no board is dense enough to
  // tie two adjacent percentiles, and quietly starts failing when one is.
  let previous: number | null = null;

  s.derivedFrom.topFractions.forEach((p, j) => {
    const raw = asTheFormulaComputesIt(fractions, scores, p);
    const fromFormula = previous === null ? raw : Math.max(raw, previous + 1);
    previous = fromFormula;
    const committed = s.rankMaxes[j];
    checked++;
    if (fromFormula !== committed) {
      wrong.push(
        `${s.scenario} rank ${s.window * season.windowSize + j + 1}: ` +
          `sheet ${fromFormula}, season ${committed}`,
      );
    }
  });
}

// A check that cannot fail is not a check. If the sample points ever stop being ascending
// the MATCH-style search above silently returns the wrong bracket, so assert the shape.
const ascending = cache.samplePoints.every((p, i, a) => i === 0 || p > a[i - 1]);

console.log(`\ntuning sheet`);
console.log(`  ${checked === 0 ? "FAIL" : "ok  "} thresholds compared: ${checked}`);
console.log(`  ${ascending ? "ok  " : "FAIL"} sample points ascend, so the bracket search is well-defined`);
console.log(
  `  ${wrong.length === 0 ? "ok  " : "FAIL"} every exported formula reproduces the committed threshold` +
    (wrong.length > 0 ? `: ${wrong.slice(0, 8).join("; ")}${wrong.length > 8 ? ", ..." : ""}` : ""),
);

const failed = wrong.length > 0 || checked === 0 || !ascending;
console.log(failed ? "\nFAILED" : `\nOK: ${checked} formulas match the season exactly`);
process.exit(failed ? 1 : 0);
