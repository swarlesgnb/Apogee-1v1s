/**
 * Where do other people's thresholds actually sit on the leaderboard?
 *
 * Apogee's thresholds are percentiles of the KovaaK's board for each scenario, which
 * leaves one thing to decide: *which* percentiles. That is a judgement, and the honest way
 * to make it is to look at where established ladders put theirs and then choose knowingly.
 *
 * This is what "a reference point" means, concretely. Nothing from another benchmark is
 * copied into a season: the numbers are read, converted into percentiles, and thrown away.
 * What survives is a percentile ladder Apogee owns, which can then be defended without
 * appealing to anyone else's authority - and which would have caught the thing that made
 * this necessary, a first rank set at another ladder's *fifth*.
 *
 *   npx tsx tools/calibrateLadder.ts [--reference voltaic-s5.json]
 */

import { readFileSync } from "node:fs";

import { dataFile } from "../src/core/dataDir.ts";
import { topFractionOfScore, type Distribution } from "../src/core/season/percentiles.ts";

const args = process.argv.slice(2);
const refAt = args.indexOf("--reference");
const referenceFile = refAt !== -1 ? args[refAt + 1] : "voltaic-s5.json";

const cache = JSON.parse(
  readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"),
) as { distributions: Distribution[] };

const byScenario = new Map(cache.distributions.map((d) => [d.scenario, d]));

const reference = JSON.parse(
  readFileSync(dataFile("benchmarks", referenceFile), "utf8"),
) as {
  benchmarkName: string;
  difficulties: {
    name: string;
    rankNames: string[];
    categories: { name: string; scenarios: { name: string; rankMaxes: number[] }[] }[];
  }[];
};

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

console.log(
  `\n${BOLD}${reference.benchmarkName} as a reference${RESET}\n` +
    `${DIM}where each of its thresholds sits on the KovaaK's board for that scenario,\n` +
    `as a fraction from the top. Read, converted, and not adopted.${RESET}`,
);

/** Median, which is the right summary here: one odd scenario should not move it. */
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

for (const difficulty of reference.difficulties) {
  const scenarios = difficulty.categories.flatMap((c) => c.scenarios);
  const perRank: number[][] = difficulty.rankNames.map(() => []);
  let covered = 0;

  for (const s of scenarios) {
    const dist = byScenario.get(s.name);
    if (!dist) continue;
    covered++;
    s.rankMaxes.forEach((score, i) => {
      const f = topFractionOfScore(dist, score);
      if (f !== null && perRank[i]) perRank[i].push(f);
    });
  }

  if (covered === 0) continue;

  console.log(
    `\n${BOLD}${difficulty.name}${RESET}  ${DIM}${covered}/${scenarios.length} scenarios sampled${RESET}`,
  );
  console.log(
    `  ${"rank".padEnd(14)}${"median".padStart(9)}${"tightest".padStart(10)}` +
      `${"loosest".padStart(9)}   spread`,
  );

  difficulty.rankNames.forEach((name, i) => {
    const fractions = perRank[i];
    if (fractions.length === 0) return;
    const med = median(fractions);
    const min = Math.min(...fractions);
    const max = Math.max(...fractions);
    console.log(
      `  ${name.padEnd(14)}${pct(med).padStart(9)}${pct(min).padStart(10)}` +
        `${pct(max).padStart(9)}   ${DIM}${(max / min).toFixed(1)}x${RESET}`,
    );
  });
}

console.log(
  `\n${DIM}A tight spread across scenarios means the reference ladder really is a\n` +
    `percentile ladder in disguise, and its percentiles are worth knowing.\n` +
    `A loose one means its thresholds are per-scenario judgements, and there is\n` +
    `nothing there to borrow even in percentile form.${RESET}\n`,
);
