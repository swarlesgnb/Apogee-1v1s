/**
 * Move the season's thresholds into the pool, unchanged, so they can stop being derived.
 *
 *   npx tsx tools/extractThresholds.ts [--dry-run]
 *
 * One-shot, and worth keeping afterwards as the thing that documents what happened.
 *
 * Until now `data/pool.json` named the scenarios and `tools/buildSeason.ts` computed their
 * thresholds from percentiles at build time. The pool is becoming the place the numbers
 * live, which means the numbers have to get there - and the only honest way to start is to
 * carry across exactly what is already published, digit for digit, changing nothing.
 *
 * That is deliberate. Reversing the pipeline and re-authoring 352 numbers in one change
 * would produce a diff nobody could review: every number different, for two unrelated
 * reasons, with no way to tell a deliberate re-cut from a bug in the new reader. So this
 * step moves them and *only* moves them. `npm run build:season` afterwards should produce a
 * season whose thresholds are identical to the one in git.
 *
 * Every number lands with `source.kind: "seeded"` - the honest label. It says the number is
 * inherited from the percentile era and has not yet been given a real source, and
 * `validate:thresholds` counts them on every run so the debt is visible until it is paid.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSeason } from "../src/core/season/season.ts";
import type { ThresholdSource } from "../src/core/season/thresholds.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const POOL = join(root, "data", "pool.json");

const DRY = process.argv.includes("--dry-run");

interface Variant {
  window: number;
  scenario: string;
  label?: string;
  leaderboardId?: number | null;
  rankMaxes?: number[];
  source?: ThresholdSource;
}

interface Pool {
  families: { family: string; category: string; variants: Variant[] }[];
  [key: string]: unknown;
}

const pool = JSON.parse(readFileSync(POOL, "utf8")) as Pool;
const season = loadSeason();

const bySeasonScenario = new Map(season.scenarios.map((s) => [s.scenario, s]));

let carried = 0;
let already = 0;
const missing: string[] = [];

for (const family of pool.families) {
  for (const v of family.variants) {
    if (Array.isArray(v.rankMaxes) && v.rankMaxes.length > 0) {
      already++;
      continue;
    }

    const from = bySeasonScenario.get(v.scenario);
    if (!from || !Array.isArray(from.rankMaxes) || from.rankMaxes.length === 0) {
      missing.push(v.scenario);
      continue;
    }

    v.rankMaxes = [...from.rankMaxes];
    v.source = {
      kind: "seeded",
      note:
        "Carried from the percentile-derived season unchanged by tools/extractThresholds.ts. " +
        "Not yet traced to a published benchmark or deliberately authored.",
    };
    carried++;
  }
}

console.log(`\nthresholds into the pool`);
console.log(`  carried across : ${carried}`);
if (already > 0) console.log(`  already present: ${already}`);
if (missing.length > 0) {
  console.log(`  NOT IN SEASON  : ${missing.length} - ${missing.slice(0, 5).join(", ")}`);
}

if (DRY) {
  console.log("\n--dry-run, nothing written\n");
} else {
  writeFileSync(POOL, JSON.stringify(pool, null, 2) + "\n");
  console.log(`\nwrote ${POOL}\n`);
}

process.exitCode = missing.length > 0 ? 1 : 0;
