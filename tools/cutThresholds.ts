/**
 * Cut every variant's thresholds from its own leaderboard, at the pool's ladder.
 *
 *   npx tsx tools/cutThresholds.ts [--dry-run] [--only <family>] [--window <n>]
 *
 * WHAT THIS IS FOR, GIVEN THE POOL OWNS ITS NUMBERS
 *
 * It does not take the numbers back. `buildSeason` stopped deriving thresholds on purpose:
 * a percentile moves when the population moves, so a target derived at read time slides
 * while somebody is chasing it. The numbers still live in `data/pool.json` and are still
 * what the season is built from. This writes them *once*, into that file, where they then
 * sit still and can be edited by hand or traced to a benchmark by `adoptThresholds`.
 *
 * So it is the answer to two questions the pool cannot otherwise answer:
 *
 *   a new family     264 scenarios chosen by hand need 264 sets of numbers, and there is no
 *                    published tier for most of them - they are community variants nobody
 *                    graded, which is exactly why they are in the pool
 *   a new ladder     changing what a rank is worth means re-cutting every threshold, and
 *                    doing that by hand across the pool is not a thing anybody does twice
 *
 * WHERE THE PERCENTILES COME FROM
 *
 * `pool.ladder.ranks`, sliced per window by `windowRankCount` - so a window takes the
 * percentiles of the ranks it grades, overlap included, and two neighbouring windows cut
 * their shared ranks from their own different boards. That is the point: the same rank
 * asks a different score depending on which scenario proves it, and the harder board is
 * the harder ask.
 *
 * WHAT IT REFUSES
 *
 * A board it cannot measure at. `scoreAtTopFraction` clamps outside the sampled range
 * rather than extrapolating, so a percentile past the ends of the curve would come back as
 * whatever the last sample was and two ranks would collide on one score. Those are
 * reported and the variant is left alone, because a threshold nobody measured is worse
 * than the one already there.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { dataFile } from "../src/core/dataDir.ts";
import { thresholdsFrom, type Distribution } from "../src/core/season/percentiles.ts";
import type { ThresholdSource } from "../src/core/season/thresholds.ts";
import { windowRankIndices } from "../src/core/season/windows.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyAt = args.indexOf("--only");
const only = onlyAt === -1 ? null : args[onlyAt + 1] ?? null;
/** Re-cut even the variants a benchmark publishes, discarding what was adopted from them. */
const overAdopted = args.includes("--over-adopted");
/**
 * Only this window, which is how the two rules about thresholds are kept apart.
 *
 * Above the Novice window a published tier is the better statement of what a rank is worth
 * and this tool fills in behind it. The Novice window is the one place this season
 * deliberately overrules that: its scenarios are entry cuts chosen so a beginner can load
 * them, and an entry benchmark's own tiers are pitched for a beginner too - adopt both and
 * the bottom band asks nothing. So `--over-adopted --window 0` re-cuts Novice from this
 * season's ladder and leaves every harder band on its author's numbers.
 */
const windowAt = args.indexOf("--window");
const onlyWindow = windowAt === -1 ? null : Number(args[windowAt + 1]);

interface Variant {
  window: number;
  scenario: string;
  label?: string;
  leaderboardId?: number;
  rankMaxes?: number[];
  source?: ThresholdSource;
}

interface Pool {
  windowSize: number;
  windows: string[];
  ladder: { ranks: number[]; overlap: number };
  families: { family: string; category: string; variants: Variant[] }[];
}

const POOL = dataFile("pool.json");
const pool = JSON.parse(readFileSync(POOL, "utf8")) as Pool;
const cache = JSON.parse(
  readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"),
) as { distributions: Distribution[] };
const byScenario = new Map(cache.distributions.map((d) => [d.scenario, d]));

const totalRanks = pool.windowSize * pool.windows.length;
const overlap = pool.ladder.overlap ?? 0;

const written: string[] = [];
const unchanged: string[] = [];
const unsampled: string[] = [];
const unmeasurable: string[] = [];

const published: string[] = [];

for (const family of pool.families) {
  if (only && family.family !== only) continue;

  for (const v of family.variants) {
    if (onlyWindow !== null && v.window !== onlyWindow) continue;

    // A published number beats a cut one, so this fills in behind `adoptThresholds` rather
    // than over it. Where a benchmark grades this scenario at this band, that author's own
    // ladder is the more accurate statement of what the rank is worth; a percentile is only
    // what to do when nobody has said.
    if (!overAdopted && (v.source?.kind === "adopted" || v.source?.kind === "reconciled")) {
      published.push(v.scenario);
      continue;
    }

    const dist = byScenario.get(v.scenario);
    if (!dist) {
      unsampled.push(v.scenario);
      continue;
    }

    const ranks = windowRankIndices(v.window, pool.windowSize, totalRanks, overlap);
    const ladder = ranks.map((r) => pool.ladder.ranks[r]);
    const cut = thresholdsFrom(dist, ladder);
    if (!cut) {
      unmeasurable.push(v.scenario);
      continue;
    }

    // Unchanged means the numbers *and* the record of how they were made. A variant whose
    // scores already match but whose source still describes an older cut is not finished:
    // validate:thresholds re-derives from what the source says, so a stale one is a check
    // that passes against the wrong question.
    const before = v.rankMaxes ?? [];
    const recorded =
      v.source?.kind === "percentile" &&
      v.source.cut?.ranks?.join(",") === ranks.join(",") &&
      v.source.cut.topFractions.join(",") === ladder.join(",") &&
      v.source.cut.total === dist.total;
    if (before.length === cut.length && before.every((n, i) => n === cut[i]) && recorded) {
      unchanged.push(v.scenario);
      continue;
    }

    const moved = !(before.length === cut.length && before.every((n, i) => n === cut[i]));
    written.push(
      moved
        ? `${family.family}/${pool.windows[v.window]}  ${v.scenario}\n` +
          `${DIM}      was ${before.join(", ") || "nothing"}\n` +
          `      now ${cut.join(", ")}${RESET}`
        : `${family.family}/${pool.windows[v.window]}  ${v.scenario}\n` +
          `${DIM}      same numbers, the record of the cut restated${RESET}`,
    );

    if (!dryRun) {
      v.rankMaxes = cut;
      // The provenance changes with the numbers. Saying they were adopted from a published
      // tier when they were cut from a board is the kind of untrue label that makes every
      // other label worth less - and the cut is recorded in full rather than described, so
      // validate:thresholds re-derives it instead of believing the sentence.
      v.source = {
        kind: "percentile",
        cut: {
          ranks,
          topFractions: ladder,
          leaderboardId: v.leaderboardId ?? dist.leaderboardId ?? null,
          total: dist.total,
          sampledAt: dist.sampledAt,
        },
        why:
          `Cut from this scenario's own KovaaK's board at the pool ladder's ranks ` +
          `${ranks.map((r) => r + 1).join(", ")} - the top ` +
          `${ladder.map((f) => `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`).join(", ")} of ` +
          `${dist.total.toLocaleString()} entries. No benchmark publishes a tier for this ` +
          `scenario at this window, so there is nothing to adopt. Re-cut with ` +
          `npm run cut:thresholds.`,
      };
    }
  }
}

console.log(
  `\n${BOLD}thresholds${RESET}  ${pool.windows.length} windows of ${pool.windowSize} ` +
    `overlapping by ${overlap}, from a ${pool.ladder.ranks.length}-rank ladder`,
);

if (written.length > 0) {
  console.log(`\n${BOLD}${dryRun ? "would write" : "written"}${RESET}  ${written.length}`);
  for (const line of written) console.log(`  ${line}`);
}
if (unchanged.length > 0) {
  console.log(`\n${DIM}${unchanged.length} already at the ladder${RESET}`);
}
if (published.length > 0) {
  console.log(
    `\n${DIM}${published.length} left to the benchmark that publishes them - ` +
      `--over-adopted to cut those too${RESET}`,
  );
}
if (unsampled.length > 0) {
  console.log(
    `\n${BOLD}not sampled${RESET}  ${unsampled.length} - run npm run sample:leaderboards\n  ` +
      unsampled.join("\n  "),
  );
}
if (unmeasurable.length > 0) {
  console.log(
    `\n${BOLD}off the measured curve${RESET}  ${unmeasurable.length}, left alone\n  ` +
      unmeasurable.join("\n  "),
  );
}

if (!dryRun && written.length > 0) {
  writeFileSync(POOL, JSON.stringify(pool, null, 2) + "\n");
  console.log(`\n${written.length} variant(s) rewritten in data/pool.json`);
} else if (dryRun) {
  console.log(`\n${DIM}dry run, nothing written${RESET}`);
}
