/**
 * Build season 1's definition.
 *
 * A season owns its pool, its thresholds and its rank ladder (PLAN.md §14). Nothing here
 * reads another benchmark, and nothing a season contains was written by anybody else.
 *
 *   THE POOL         `data/pool.json`. Which scenarios, in which category, which family,
 *                    which window. Ours, hand-maintained, and the only place to change it.
 *
 *   THE THRESHOLDS   percentiles of each scenario's KovaaK's leaderboard, sampled into
 *                    `data/leaderboard_percentiles.json`. A rank means being better at a
 *                    scenario than a given share of the people who play it.
 *
 *   THE SANITY CHECK the local corpus. One player's history cannot set thresholds - it
 *                    describes that player - but it can say where a real person lands, and
 *                    a ladder that puts somebody off the end of its own scale is wrong.
 *
 * WHY PERCENTILES RATHER THAN A SEED
 *
 * The first two cuts of this took another ladder's published numbers as a starting point,
 * and each time the numbers turned out to carry decisions nobody here had made. One took a
 * single difficulty and stretched it, so the first rank was another ladder's *fifth* and
 * most players were unranked with no progress to see. The next took three difficulties
 * properly and inherited a category energy threshold asking 17,500 per rank where six
 * families can only ever produce 15,000 - a top rank unreachable at any score, in the
 * source as well as in the copy.
 *
 * Both are the same mistake: a borrowed threshold is a borrowed judgement, and it arrives
 * without the reasoning that would let anybody here check it. Percentiles do not have that
 * problem. "Why is rank 7 at 929" has an answer that is a fact about the game rather than
 * an appeal to authority, and the answer stays true when the pool changes.
 *
 * WHY THREE WINDOWS
 *
 * A ladder wide enough for both a first-week player and a good one cannot be one set of
 * scenarios: a perfect run on something easy has to stop proving anything at some point,
 * and past that point the ladder needs harder scenarios to keep measuring. So the ranks are
 * cut into windows, and each family carries one variant per window. A family is graded on
 * the best of its variants (see core/benchmarks/energy.ts), so the ladder is twelve ranks
 * deep without being three times the grind.
 *
 * Where one window hands over to the next is the one judgement left, and it is recorded as
 * one: percentiles are comparable within a scenario's own board and not across two, since
 * a harder scenario draws a smaller and stronger crowd. Season 2 measures the handover
 * against Apogee's own population instead.
 *
 * Rank names already in the season file are carried forward rather than overwritten - they
 * are somebody's work, and this tool is not entitled to throw it away because it ran again.
 *
 *   npx tsx tools/buildSeason.ts [--stats <folder>] [--fresh]
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { scanStatsFolder } from "../src/core/history/history.ts";
import { renderRankSheet } from "../src/core/report/rankSheet.ts";
import { thresholdsFrom, type Distribution } from "../src/core/season/percentiles.ts";
import { validateSeason, type Season } from "../src/core/season/season.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

/** Energy one rank of one family is worth. Mirrors ENERGY_PER_RANK. */
const ENERGY_PER_RANK = 2500;

/**
 * Placeholder names for ranks nobody has named yet, and a grey ramp to go with them.
 *
 * Deliberately drab. A placeholder that looks designed gets left in place; one that looks
 * unfinished gets named, which is the point.
 */
const PLACEHOLDER_COLORS = ["#3f4652", "#59606d", "#737b89", "#8d95a4"];

interface Pool {
  windowSize: number;
  windows: string[];
  ladder: { perWindow: number[][] };
  /**
   * Thresholds set by hand, keyed on scenario name.
   *
   * The season's numbers are derived, and derived numbers get overwritten every time this
   * runs - which would quietly undo an evening of tuning in the editor. An override says
   * "this one is a judgement, not a measurement", survives the rebuild, and is marked as
   * such wherever it is shown so nobody mistakes it for a percentile.
   */
  overrides?: Record<string, number[]>;
  matchWindow: number;
  categories: string[];
  families: {
    family: string;
    category: string;
    variants: {
      window: number;
      scenario: string;
      label: string;
      leaderboardId: number | null;
    }[];
  }[];
}

interface SeasonScenarioOut {
  scenario: string;
  category: string;
  family: string;
  window: number;
  label: string;
  leaderboardId: number | null;
  rankMaxes: number[];
  /** How the thresholds were derived, per scenario, so a number can be traced. */
  derivedFrom?: { leaderboardEntries: number; topFractions: number[] };
  /** True when these thresholds were set by hand and are not what the percentiles give. */
  overridden?: boolean;
  /** What the percentiles would have given, kept alongside an override for comparison. */
  derivedRankMaxes?: number[];
  /** Where this machine's own history sits against this window. */
  corpus?: { runs: number; best: number; median: number; reaches: string | null };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Carry a category's existing ladder onto a longer one.
 *
 * Aligned to the top, not the bottom. The ladder grew downwards: what used to be rank 1
 * described a good player, so the names somebody chose keep describing the same standing
 * instead of sliding down and re-labelling a beginner with a name meant for someone else.
 */
function carryLadder(
  existing: { rankNames?: string[]; rankColors?: Record<string, string> } | undefined,
  depth: number,
): { rankNames: string[]; rankColors: Record<string, string> } {
  const kept = (existing?.rankNames ?? []).slice(-depth);
  const missing = depth - kept.length;

  const names: string[] = [];
  const colors: Record<string, string> = {};

  for (let i = 0; i < missing; i++) {
    let name = `Rank ${i + 1}`;
    while (kept.includes(name) || names.includes(name)) name += "*";
    names.push(name);
    colors[name] = PLACEHOLDER_COLORS[i % PLACEHOLDER_COLORS.length];
  }

  for (const name of kept) {
    names.push(name);
    colors[name] = existing?.rankColors?.[name] ?? "#8891a3";
  }

  return { rankNames: names, rankColors: colors };
}

function main(): void {
  const args = process.argv.slice(2);
  const statsAt = args.indexOf("--stats");
  const statsDir = statsAt !== -1 ? args[statsAt + 1] : DEFAULT_STATS_DIR;
  const fresh = args.includes("--fresh");

  const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as Pool;

  const percentileFile = dataFile("leaderboard_percentiles.json");
  if (!existsSync(percentileFile)) {
    console.error(
      "no data/leaderboard_percentiles.json - run npm run sample:leaderboards first.\n" +
        "Thresholds come from the leaderboards, so there is nothing to build without them.",
    );
    process.exit(1);
  }

  const cache = JSON.parse(readFileSync(percentileFile, "utf8")) as {
    source: string;
    sampledAt: string;
    distributions: Distribution[];
  };
  const distByScenario = new Map(cache.distributions.map((d) => [d.scenario, d]));

  const windowSize = pool.windowSize;
  const ranks = windowSize * pool.windows.length;
  const ladders = pool.ladder.perWindow;

  if (ladders.length !== pool.windows.length) {
    console.error(
      `the ladder covers ${ladders.length} windows but the pool has ${pool.windows.length}`,
    );
    process.exit(1);
  }

  for (const [w, ladder] of ladders.entries()) {
    if (ladder.length !== windowSize) {
      console.error(
        `${pool.windows[w]} has ${ladder.length} percentiles but a window is ` +
          `${windowSize} ranks`,
      );
      process.exit(1);
    }
    // Within a window the bar must rise, so the percentile must fall.
    const flat = ladder.findIndex((f, i) => i > 0 && f >= ladder[i - 1]);
    if (flat > 0) {
      console.error(
        `${pool.windows[w]}: rank ${flat + 1} asks for the top ${(ladder[flat] * 100).toFixed(1)}%, ` +
          `which is no harder than rank ${flat} at ${(ladder[flat - 1] * 100).toFixed(1)}%`,
      );
      process.exit(1);
    }
  }

  // Across a boundary a percentile is allowed to step back, and often has to: the first
  // rank of a window is measured on a different board from the last rank below it, and a
  // harder scenario draws a stronger crowd, so the same ability sits at a larger
  // percentage there.
  //
  // How large a step is correct depends on how much harder the new scenarios are, which
  // nothing here can know. Two windows a step apart chain within a percentage point, while
  // a window of genuinely harder scenarios can legitimately reopen at the top 8% above one
  // that closed at 0.1% - there is no room above one in a thousand, and the room is on the
  // next board along. So this warns rather than refuses.
  //
  // The check that actually decides whether a ladder rises is the distribution: it sweeps
  // the population through the real engine and reports ranks nobody holds. A handover that
  // is genuinely wrong shows up there as a skipped rank.
  const HANDOVER_TOLERANCE = 1.25;
  const wide: string[] = [];
  for (let w = 1; w < ladders.length; w++) {
    const below = ladders[w - 1][windowSize - 1];
    const here = ladders[w][0];
    if (here > below * HANDOVER_TOLERANCE) {
      wide.push(
        `${pool.windows[w]} opens at the top ${(here * 100).toFixed(1)}% where ` +
          `${pool.windows[w - 1]} closes at ${(below * 100).toFixed(1)}%`,
      );
    }
  }

  const seasonFile = join(dataFile("."), "seasons", "season-1.json");
  const existing: Season | null =
    !fresh && existsSync(seasonFile)
      ? (JSON.parse(readFileSync(seasonFile, "utf8")) as Season)
      : null;

  const history = scanStatsFolder(statsDir);

  const scenarios: SeasonScenarioOut[] = [];
  const missing: string[] = [];

  for (const family of pool.families) {
    for (const v of family.variants) {
      const dist = distByScenario.get(v.scenario);
      if (!dist) {
        missing.push(v.scenario);
        continue;
      }

      const derived = thresholdsFrom(dist, ladders[v.window]);
      if (!derived) {
        missing.push(v.scenario);
        continue;
      }

      // A hand-set threshold wins over the derivation, and says so. Without this the
      // rebuild silently reverts every deliberate adjustment somebody made.
      const override = pool.overrides?.[v.scenario];
      const overridden =
        Array.isArray(override) &&
        override.length === derived.length &&
        override.some((n, i) => n !== derived[i]);
      const rankMaxes = overridden ? override.slice() : derived;

      const entry: SeasonScenarioOut = {
        scenario: v.scenario,
        category: family.category,
        family: family.family,
        window: v.window,
        label: v.label,
        leaderboardId: v.leaderboardId,
        rankMaxes,
        derivedFrom: { leaderboardEntries: dist.total, topFractions: ladders[v.window] },
        ...(overridden ? { overridden: true, derivedRankMaxes: derived } : {}),
      };

      const local = history.get(v.scenario);
      if (local && local.runs.length > 0) {
        const scores = local.runs.map((r) => r.score);
        let reached: number | null = null;
        rankMaxes.forEach((threshold, i) => {
          if (local.best >= threshold) reached = v.window * windowSize + i;
        });
        entry.corpus = {
          runs: scores.length,
          best: Math.round(local.best),
          median: Math.round(median(scores)),
          reaches: reached === null ? null : `rank ${reached + 1}`,
        };
      }

      scenarios.push(entry);
    }
  }

  if (missing.length > 0) {
    console.error(
      `no sampled leaderboard for ${missing.length} scenario(s): ${missing.join(", ")}\n` +
        "run npm run sample:leaderboards to pick them up.",
    );
    process.exit(1);
  }

  // Category energy thresholds.
  //
  // A category's rank is the sum of its families', and a family caps at ENERGY_PER_RANK per
  // rank, so a category caps at families * ranks * ENERGY_PER_RANK and rank r costs
  // families * ENERGY_PER_RANK * r. Derived, not carried: a borrowed number here is how the
  // last cut ended up with two ranks nobody could reach. `validateSeason` refuses that
  // shape now, so it cannot come back quietly.
  const categories = pool.categories.map((name) => {
    const familyCount = pool.families.filter((f) => f.category === name).length;
    const perRank = familyCount * ENERGY_PER_RANK;

    return {
      name,
      rankMaxes: Array.from({ length: ranks }, (_, i) => perRank * (i + 1)),
      ...carryLadder(
        existing?.categories?.find((x) => x.name === name),
        ranks,
      ),
      derivable: true,
    };
  });

  const season = {
    name: existing?.name ?? "Season 1",
    status: existing?.status ?? "draft",
    // The overall ladder is a readout derived from the three categories (PLAN.md §14), not
    // a fourth thing to climb, so its depth is independent of theirs and whatever the
    // season already had is left alone.
    rankNames: existing?.rankNames ?? ["Tier I", "Tier II", "Tier III", "Tier IV"],
    rankColors:
      existing?.rankColors ?? {
        "Tier I": "#7C8AA5",
        "Tier II": "#4FA3C7",
        "Tier III": "#C79A4F",
        "Tier IV": "#C75FA8",
      },
    windowSize,
    windows: pool.windows,
    matchPool: { window: pool.matchWindow },
    categories,
    derivedFrom: {
      thresholds: cache.source,
      sampledAt: cache.sampledAt,
      perWindow: ladders,
      leaderboardEntries: scenarios.reduce(
        (n, s) => n + (s.derivedFrom?.leaderboardEntries ?? 0),
        0,
      ),
      note:
        "Every threshold is the score at a given percentile of that scenario's KovaaK's " +
        "leaderboard. The percentiles are ours; the scores are a fact about the game. No " +
        "other benchmark's numbers appear in this file - where one is consulted it is " +
        "converted to percentiles and discarded (tools/calibrateLadder.ts). Season 2 " +
        "re-cuts these against Apogee's own population, including where one window hands " +
        "over to the next.",
    },
    builtAt: new Date().toISOString(),
    scenarios,
  };

  // Refuse to write a season the app would then refuse to load.
  validateSeason(season as unknown as Season);

  mkdirSync(join(dataFile("."), "seasons"), { recursive: true });
  writeFileSync(seasonFile, JSON.stringify(season, null, 2) + "\n");

  // The rank sheet is written from the season, here, rather than left to be remembered. It
  // is the page that gets sent to people for feedback, and a stale one is worse than none.
  const docsDir = join(dataFile("."), "..", "docs");
  const sheet = join(docsDir, "season-1-ranks.html");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(sheet, renderRankSheet(season as unknown as Season), "utf8");

  // ---- report ----
  console.log(
    `season 1: ${ranks} ranks per category, ${windowSize} per window\n` +
      `windows: ${pool.windows.join(" / ")}   matches draw from ` +
      `${pool.windows[pool.matchWindow]}\n` +
      `thresholds, as a share of each scenario's own leaderboard:\n` +
      ladders
        .map(
          (l, w) =>
            `  ${pool.windows[w].padEnd(8)} top ` +
            l.map((f) => `${(f * 100).toFixed(1)}%`).join(" / "),
        )
        .join("\n") +
      `\n` +
      `${scenarios.length} scenarios in ${pool.families.length} families, behind ` +
      `${season.derivedFrom.leaderboardEntries.toLocaleString()} leaderboard entries\n`,
  );

  for (const category of categories) {
    console.log(`${category.name}\n  ${category.rankNames.join(" · ")}`);
  }

  console.log("\nwhere this machine's history lands:");
  let unplayed = 0;
  for (const family of pool.families) {
    const variants = scenarios.filter(
      (s) => s.family === family.family && s.category === family.category,
    );
    const reached = variants
      .map((v) => v.corpus?.reaches)
      .filter((r): r is string => !!r)
      .map((r) => Number(r.replace("rank ", "")));
    const best = reached.length > 0 ? Math.max(...reached) : null;
    if (best === null) unplayed++;
    console.log(
      `  ${`${family.category}/${family.family}`.padEnd(26)}` +
        `${best === null ? "unranked".padEnd(14) : `rank ${best} of ${ranks}`.padEnd(14)}` +
        ` played ${variants.filter((v) => v.corpus).length}/${variants.length} windows`,
    );
  }

  if (unplayed > 0) console.log(`\n${unplayed} families have no local history at all.`);

  console.log(`\nwritten to ${seasonFile}`);
  console.log(`rank sheet  ${sheet}`);
  console.log(
    "the new bottom ranks are placeholders - the season editor is where they get named.",
  );
}

main();
