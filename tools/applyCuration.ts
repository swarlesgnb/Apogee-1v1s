/**
 * Write the hand-picked families in `data/pool_curation.json` into `data/pool.json`.
 *
 *   npx tsx tools/applyCuration.ts [--dry-run]
 *
 * WHY THE CHOICES LIVE IN A SEPARATE FILE
 *
 * `pool.json` carries thresholds, provenance and sanity readouts alongside the choices, and
 * the choices are four scenario names per family. Editing 264 names inside a file where
 * each one sits under a hundred lines of derived numbers is how a name gets mistyped into a
 * scenario that does not exist - which then samples as an empty board and grades nobody.
 * So the choices are authored on their own, and this joins them to the corpus.
 *
 * WHAT IT REFUSES
 *
 * A scenario KovaaK's does not publish, a family without exactly one rung per window, and a
 * scenario used twice in one category. Each is reported with the family it came from rather
 * than as a count, because the fix is always to change one name.
 *
 * WHAT IT PRESERVES
 *
 * Any category the curation does not mention. Static Clicking was built by hand in the
 * season editor and is not in the curation file, so it passes through exactly as it is -
 * including its thresholds, which is the point of writing only what changed.
 *
 * Thresholds are NOT written here. A rung that moved comes out with no numbers at all, so
 * `npm run sample:leaderboards` and then `adopt:thresholds` / `cut:thresholds` are what fill
 * them, and a variant that was silently left un-thresholded fails `build:season` rather than
 * inheriting the numbers of whatever used to sit in that slot.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { dataFile } from "../src/core/dataDir.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const dryRun = process.argv.slice(2).includes("--dry-run");

interface Curated {
  family: string;
  why: string;
  rungs: string[];
}

interface Curation {
  /** Categories kept whole, under a new name. */
  rename?: Record<string, string>;
  /** Categories whose families are replaced wholesale and should not be carried. */
  retire?: string[];
  categories: Record<string, { $why?: string; families: Curated[] }>;
}

interface Variant {
  window: number;
  scenario: string;
  label?: string;
  leaderboardId: number | null;
  rankMaxes?: number[];
  source?: unknown;
}

interface Family {
  family: string;
  $why?: string;
  category: string;
  subCategory?: string;
  mechanic?: string;
  variants: Variant[];
}

interface Pool {
  windows: string[];
  categories: string[];
  subCategories?: Record<string, string[]>;
  families: Family[];
  [key: string]: unknown;
}

const POOL = dataFile("pool.json");
const pool = JSON.parse(readFileSync(POOL, "utf8")) as Pool;
const curation = JSON.parse(readFileSync(dataFile("pool_curation.json"), "utf8")) as Curation;
const taxonomy = new Map(
  (
    JSON.parse(readFileSync(dataFile("scenario_taxonomy.json"), "utf8")) as {
      scenarios: { name: string; leaderboardId: number | null }[];
    }
  ).scenarios.map((s) => [s.name, s.leaderboardId]),
);

const problems: string[] = [];
const built: Family[] = [];

for (const [category, spec] of Object.entries(curation.categories)) {
  const seen = new Map<string, string>();

  for (const c of spec.families) {
    if (c.rungs.length !== pool.windows.length) {
      problems.push(
        `${category}/${c.family} names ${c.rungs.length} rungs, and there are ` +
          `${pool.windows.length} windows`,
      );
      continue;
    }

    const variants: Variant[] = [];
    let ok = true;

    c.rungs.forEach((scenario, window) => {
      if (!taxonomy.has(scenario)) {
        problems.push(
          `${category}/${c.family} ${pool.windows[window]}: KovaaK's publishes no ` +
            `scenario called "${scenario}"`,
        );
        ok = false;
        return;
      }
      const already = seen.get(scenario);
      if (already) {
        problems.push(
          `${category}/${c.family} ${pool.windows[window]}: "${scenario}" is already ` +
            `${already}`,
        );
        ok = false;
        return;
      }
      seen.set(scenario, `${c.family}'s ${pool.windows[window]} rung`);
      variants.push({
        window,
        scenario,
        label: scenario,
        leaderboardId: taxonomy.get(scenario) ?? null,
      });
    });

    if (ok) {
      built.push({
        family: c.family,
        $why: c.why,
        category,
        subCategory: category,
        variants,
      });
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${BOLD}${problems.length} problem(s), nothing written${RESET}`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const curated = new Set(Object.keys(curation.categories));
const retired = new Set(curation.retire ?? []);
const renames = curation.rename ?? {};

// Renamed before anything is dropped, so a category can be renamed INTO one the curation
// also names without its families being mistaken for stale ones.
for (const f of pool.families) {
  const to = renames[f.category];
  if (to) {
    f.category = to;
    if (f.subCategory === undefined) f.subCategory = to;
  }
}

const dropped = pool.families.filter((f) => retired.has(f.category));
const kept = pool.families.filter(
  (f) => !curated.has(f.category) && !retired.has(f.category),
);
pool.families = [...kept, ...built];

// The pool's category list is what the season is built from, so a curated category that is
// not in it produces families nothing grades. Kept in the order the curation names them,
// after whatever was already there.
const categories = [
  ...pool.categories
    .map((c) => renames[c] ?? c)
    .filter((c) => !curated.has(c) && !retired.has(c)),
  ...curated,
];
pool.categories = categories;

// The sub-skill map is one entry per category now that a category IS a sub-skill. Keeping
// the old four-per-category map would leave validate:pool checking families against
// sub-skills nothing in the season grades.
pool.subCategories = Object.fromEntries(categories.map((c) => [c, [c]]));

console.log(`\n${BOLD}curation${RESET}`);
for (const [category, spec] of Object.entries(curation.categories)) {
  console.log(`  ${category.padEnd(20)}${spec.families.length} families`);
}
for (const [from, to] of Object.entries(renames)) {
  console.log(`  ${DIM}renamed${RESET} ${from} -> ${to}`);
}
if (dropped.length > 0) {
  console.log(
    `  ${DIM}retired${RESET} ${[...retired].join(", ")} ` +
      `${DIM}(${dropped.length} family/families dropped)${RESET}`,
  );
}
console.log(
  `${DIM}  ${kept.length} family/families in categories the curation does not name, ` +
    `carried through untouched${RESET}`,
);
console.log(`  categories now: ${categories.join(", ")}`);

const unsampled = built.flatMap((f) => f.variants.map((v) => v.scenario));
console.log(
  `\n${built.length} curated family/families, ${unsampled.length} variants, all without ` +
    `thresholds until sample:leaderboards and adopt/cut:thresholds have run.`,
);

if (dryRun) {
  console.log(`\n${DIM}dry run, nothing written${RESET}\n`);
} else {
  writeFileSync(POOL, JSON.stringify(pool, null, 2) + "\n");
  console.log(`\nwrote ${POOL}\n`);
}
