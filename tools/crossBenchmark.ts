/**
 * Where every benchmark we have a definition for places its ranks, in percentile terms.
 *
 * Setting thresholds by hand is a reasonable way to build a season - a number chosen with
 * judgement can beat a number chosen by formula - but only if the judgement has something
 * to sit on. "Is 930 about right for rank 7" is unanswerable; "rank 7 is the top 15% of
 * that board, and four published ladders put their comparable rank between 12% and 24%" is
 * a decision somebody can make.
 *
 * Scores cannot be compared across benchmarks: Aimerz+ pipeClick and VT Pasu are different
 * scenarios and 800 means nothing shared. Percentiles can, because every ladder is
 * ultimately a claim about how many players a rank sits above. So each threshold is
 * converted to a share of its own scenario's KovaaK's leaderboard, and only then compared.
 *
 * Nothing here is copied into a season. The numbers go in, the percentiles come out, and
 * the numbers are discarded - which is what makes another ladder a reference rather than a
 * source.
 *
 *   npx tsx tools/crossBenchmark.ts [--scenario <name>] [--csv]
 *
 * Needs the boards sampled first:  npx tsx tools/sampleLeaderboards.ts --benchmarks
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { topFractionOfScore, type Distribution } from "../src/core/season/percentiles.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const args = process.argv.slice(2);
const scenarioAt = args.indexOf("--scenario");
const onlyScenario = scenarioAt !== -1 ? args[scenarioAt + 1]?.toLowerCase() : null;
const asCsv = args.includes("--csv");

interface BenchmarkDef {
  benchmarkName: string;
  difficulties: {
    name: string;
    rankNames: string[];
    categories: { name: string; scenarios: { name: string; rankMaxes: number[] }[] }[];
  }[];
}

const cache = JSON.parse(
  readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"),
) as { distributions: Distribution[] };
const distOf = new Map(cache.distributions.map((d) => [d.scenario, d]));

const dir = join(dataFile("."), "benchmarks");
const definitions: BenchmarkDef[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as BenchmarkDef);

/** Median: one oddly-tuned scenario should not move the summary. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

interface Row {
  benchmark: string;
  difficulty: string;
  rank: string;
  /** Rank position within its own ladder, 1-based. */
  position: number;
  depth: number;
  median: number;
  min: number;
  max: number;
  scenarios: number;
}

const rows: Row[] = [];
const unsampled = new Set<string>();

for (const def of definitions) {
  for (const difficulty of def.difficulties ?? []) {
    const scenarios = (difficulty.categories ?? []).flatMap((c) => c.scenarios ?? []);
    const perRank: number[][] = difficulty.rankNames.map(() => []);

    for (const scenario of scenarios) {
      if (onlyScenario && !scenario.name.toLowerCase().includes(onlyScenario)) continue;

      const dist = distOf.get(scenario.name);
      if (!dist) {
        unsampled.add(scenario.name);
        continue;
      }

      scenario.rankMaxes.forEach((score, i) => {
        const f = topFractionOfScore(dist, score);
        if (f !== null && perRank[i]) perRank[i].push(f);
      });
    }

    difficulty.rankNames.forEach((rank, i) => {
      const fractions = perRank[i];
      if (fractions.length === 0) return;
      rows.push({
        benchmark: def.benchmarkName,
        difficulty: difficulty.name,
        rank,
        position: i + 1,
        depth: difficulty.rankNames.length,
        median: median(fractions),
        min: Math.min(...fractions),
        max: Math.max(...fractions),
        scenarios: fractions.length,
      });
    });
  }
}

if (asCsv) {
  console.log("benchmark,difficulty,rank,position,depth,median,min,max,scenarios");
  for (const r of rows) {
    console.log(
      [r.benchmark, r.difficulty, r.rank, r.position, r.depth,
        r.median.toFixed(4), r.min.toFixed(4), r.max.toFixed(4), r.scenarios]
        .map((v) => (typeof v === "string" && v.includes(",") ? `"${v}"` : v))
        .join(","),
    );
  }
  process.exit(0);
}

console.log(
  `\n${BOLD}Where published ladders put their ranks${RESET}\n` +
    `${DIM}each threshold as a share of its own scenario's KovaaK's leaderboard.\n` +
    `read, converted, and not adopted.${RESET}`,
);

let lastKey = "";
for (const r of rows) {
  const key = `${r.benchmark} ${r.difficulty}`;
  if (key !== lastKey) {
    console.log(
      `\n${BOLD}${key}${RESET}  ${DIM}${r.scenarios} scenarios sampled${RESET}\n` +
        `  ${"rank".padEnd(16)}${"median".padStart(8)}${"tightest".padStart(10)}` +
        `${"loosest".padStart(9)}   spread`,
    );
    lastKey = key;
  }
  console.log(
    `  ${`${r.position}. ${r.rank}`.padEnd(16)}${pct(r.median).padStart(8)}` +
      `${pct(r.min).padStart(10)}${pct(r.max).padStart(9)}   ` +
      `${DIM}${(r.max / Math.max(r.min, 0.0001)).toFixed(1)}x${RESET}`,
  );
}

// ---- the comparison that is actually the point ------------------------------------
//
// Ladders are different depths, so their ranks do not line up by number. What compares is
// where the *ends* sit: the bar to be ranked at all, and the bar for the top rank.
console.log(`\n${BOLD}Entry and summit, across every ladder${RESET}`);
console.log(
  `  ${"ladder".padEnd(34)}${"ranks".padStart(6)}${"first rank".padStart(12)}` +
    `${"top rank".padStart(10)}`,
);

const ladders = new Map<string, Row[]>();
for (const r of rows) {
  const key = `${r.benchmark} ${r.difficulty}`;
  ladders.set(key, (ladders.get(key) ?? []).concat(r));
}

for (const [key, rs] of [...ladders].sort(
  (a, b) => b[1][0].median - a[1][0].median,
)) {
  const first = rs[0];
  const top = rs[rs.length - 1];
  console.log(
    `  ${key.padEnd(34)}${String(first.depth).padStart(6)}` +
      `${pct(first.median).padStart(12)}${pct(top.median).padStart(10)}`,
  );
}

if (unsampled.size > 0) {
  console.log(
    `\n${DIM}${unsampled.size} scenario(s) have no sampled board and were skipped.\n` +
      `Run: npx tsx tools/sampleLeaderboards.ts --benchmarks${RESET}`,
  );
}

console.log();
