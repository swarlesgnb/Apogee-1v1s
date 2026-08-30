/**
 * Trace every threshold back to a benchmark that published it.
 *
 *   npx tsx tools/adoptThresholds.ts [--dry-run] [--only <family>]
 *
 * `extractThresholds` carried the percentile era's numbers into the pool so they would stop
 * being recomputed. They arrived labelled `seeded` - inherited, with no source - which is
 * honest and is not where they should stay. This is what pays that debt.
 *
 * HOW A PUBLISHED TIER IS MATCHED TO A WINDOW
 *
 * `pool.bands` already maps every (benchmark, difficulty) to a window: it is the table that
 * decides a scenario's band, and reusing it means the numbers and the placement cannot
 * disagree about what "Advanced" means. So the candidates for a variant at window W are the
 * tiers naming that scenario which `bands` puts at W. A tier for the same scenario at a
 * different band is not a candidate - Voltaic Intermediate's numbers are not Advanced's, and
 * silently borrowing across bands is how a rank ends up asking for the wrong thing.
 *
 * PICKING windowSize NUMBERS FROM A TIER THAT PUBLISHES MORE
 *
 * A window is four ranks; a tier is however many its author chose. Where there are more, the
 * picks are spread evenly with the first and last always included, so the four span the range
 * the author meant that tier to cover rather than clustering at one end. Every number is
 * still one they published - see `isSubsequenceOf`.
 *
 * WHERE SEVERAL AUTHORS RATE THE SAME BAND
 *
 * Take the median per rank. Measured across the corpus, authors disagree by about 5% at the
 * median, so this is a tie-break between close numbers rather than a fudge between distant
 * ones - and the median cannot be dragged by one outlier the way a mean can. The result is
 * labelled `reconciled` and carries every source, so a reader can see the spread it came from.
 *
 * WHAT IT WILL NOT DO
 *
 * Invent. A variant with no published tier at its band keeps whatever it has and is reported.
 * A number that would break the ascent is reported rather than nudged: nudging is what
 * produced the collapsed ranks in Smooth Switching, where rounding two thresholds onto one
 * difficulty made a rank nobody could hold.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ThresholdCitation, ThresholdSource } from "../src/core/season/thresholds.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const POOL = join(root, "data", "pool.json");
const BENCH = join(root, "data", "benchmarks");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const onlyAt = args.indexOf("--only");
const ONLY = onlyAt !== -1 ? args[onlyAt + 1] : null;

interface Variant {
  window: number;
  scenario: string;
  rankMaxes?: number[];
  source?: ThresholdSource;
}
interface Pool {
  windowSize: number;
  windows: string[];
  sources: string[];
  bands: Record<string, Record<string, number>>;
  families: { family: string; category: string; variants: Variant[] }[];
}

const pool = JSON.parse(readFileSync(POOL, "utf8")) as Pool;
const sources = new Set(pool.sources);

/** Every tier that publishes scores for a scenario, with the window the pool bands it into. */
const tiers = new Map<string, (ThresholdCitation & { window: number | undefined })[]>();
for (const file of readdirSync(BENCH).filter((f) => f.endsWith(".json"))) {
  const def = JSON.parse(readFileSync(join(BENCH, file), "utf8")) as {
    benchmarkName: string;
    difficulties?: { name: string; categories?: { scenarios?: { name: string; rankMaxes?: number[] }[] }[] }[];
  };
  if (!sources.has(def.benchmarkName)) continue;

  for (const diff of def.difficulties ?? []) {
    for (const cat of diff.categories ?? []) {
      for (const sc of cat.scenarios ?? []) {
        if (!sc.rankMaxes || sc.rankMaxes.length === 0) continue;
        const list = tiers.get(sc.name) ?? [];
        list.push({
          benchmark: def.benchmarkName,
          difficulty: diff.name,
          rankMaxes: sc.rankMaxes,
          window: pool.bands?.[def.benchmarkName]?.[diff.name],
        });
        tiers.set(sc.name, list);
      }
    }
  }
}

/** `count` values spread across `from`, first and last always included. */
function spread(from: number[], count: number): number[] {
  if (from.length === count) return [...from];
  if (from.length < count) return [];
  if (count === 1) return [from[from.length - 1]];

  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(from[Math.round((i * (from.length - 1)) / (count - 1))]);
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const size = pool.windowSize;

let adopted = 0;
let reconciled = 0;
const unsourced: string[] = [];
const refused: string[] = [];
const changed: string[] = [];

for (const family of pool.families) {
  if (ONLY && family.family !== ONLY) continue;

  for (const v of family.variants) {
    // Never overwrite a number somebody wrote down a reason for.
    if (v.source?.kind === "authored") continue;

    const candidates = (tiers.get(v.scenario) ?? []).filter(
      (t) => t.window === v.window && t.rankMaxes.length >= size,
    );

    if (candidates.length === 0) {
      unsourced.push(`${v.scenario} (${pool.windows[v.window]})`);
      continue;
    }

    const picks = candidates.map((c) => spread(c.rankMaxes, size));
    const proposed =
      picks.length === 1
        ? picks[0]
        : Array.from({ length: size }, (_, i) => median(picks.map((p) => p[i])));

    // Ascent is the one property a rank ladder cannot do without, and a reconciliation that
    // breaks it is reported rather than repaired - a nudged number is neither the author's
    // nor explained, which is exactly the state this file exists to eliminate.
    if (proposed.some((n, i) => i > 0 && n <= proposed[i - 1])) {
      refused.push(
        `${v.scenario} (${pool.windows[v.window]}) would be [${proposed.join(", ")}], which does not ascend`,
      );
      continue;
    }

    const before = v.rankMaxes ? [...v.rankMaxes] : null;
    v.rankMaxes = proposed;

    const citations: ThresholdCitation[] = candidates.map((c, i) => ({
      benchmark: c.benchmark,
      difficulty: c.difficulty,
      rankMaxes: c.rankMaxes,
      // Which of them this used, when the tier publishes more ranks than a window holds.
      // Without it a checker has no way to line up window rank 2 with the picks it came
      // from, and will read a correct reconciliation as out of range.
      ...(c.rankMaxes.length === size ? {} : { used: picks[i] }),
    }));

    if (candidates.length === 1) {
      v.source = { kind: "adopted", from: citations };
      adopted++;
    } else {
      v.source = {
        kind: "reconciled",
        rule:
          `median per rank of ${candidates.length} tiers this pool bands at ` +
          `${pool.windows[v.window]}, each first reduced to ${size} evenly spread picks`,
        from: citations,
      };
      reconciled++;
    }

    if (before && before.join(",") !== proposed.join(",")) {
      changed.push(`${v.scenario}: [${before.join(", ")}] -> [${proposed.join(", ")}]`);
    }
  }
}

console.log(`\nadopting thresholds`);
console.log(`  adopted from one tier : ${adopted}`);
console.log(`  reconciled between    : ${reconciled}`);
console.log(`  no tier at their band : ${unsourced.length}`);
console.log(`  numbers that moved    : ${changed.length}`);

if (refused.length > 0) {
  console.log(`\n  refused (would not ascend):`);
  for (const r of refused) console.log(`    ${r}`);
}
if (unsourced.length > 0) {
  console.log(`\n  left as they were, no published tier at that band:`);
  for (const u of unsourced.slice(0, 12)) console.log(`    ${u}`);
  if (unsourced.length > 12) console.log(`    ...and ${unsourced.length - 12} more`);
}
if (changed.length > 0) {
  console.log(`\n  moved:`);
  for (const c of changed.slice(0, 20)) console.log(`    ${c}`);
  if (changed.length > 20) console.log(`    ...and ${changed.length - 20} more`);
}

if (DRY) {
  console.log(`\n--dry-run, nothing written\n`);
} else {
  writeFileSync(POOL, JSON.stringify(pool, null, 2) + "\n");
  console.log(`\nwrote ${POOL}\n`);
}
