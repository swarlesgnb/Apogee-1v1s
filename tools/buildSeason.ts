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
import { candidateStatsFolders, findStatsFolder } from "../src/app/watcher.ts";
import { renderRankSheet } from "../src/core/report/rankSheet.ts";
import { topFractionOfScore, type Distribution } from "../src/core/season/percentiles.ts";
import { validateSeason, type Season } from "../src/core/season/season.ts";
import { ENERGY_PER_RANK } from "../src/core/benchmarks/energy.ts";



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
    subCategory?: string;
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
  subCategory?: string;
  window: number;
  label: string;
  leaderboardId: number | null;
  rankMaxes: number[];
  /**
   * How the thresholds were derived, per scenario, so a number can be traced.
   *
   * `leaderboardEntries` is the leaderboard endpoint's own `total` - the number of rows
   * it will paginate - because that is the population the percentile is cut from and the
   * denominator every `page` index here is computed against.
   *
   * It is NOT `counts.entries` from the scenario API, which `scenario_taxonomy.json`
   * carries under the same word for the same scenario and which is roughly twice as
   * large: 104,417 against 210,497 on VT ww5t Novice S5, and the ratio is not constant.
   * Whatever that field counts, it is not the board being sampled, and swapping the two
   * would silently redefine every threshold in the season. The two numbers are both
   * KovaaK's own and they measure different things; this is the one the ladder means.
   */
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
 * Carry a category's existing ladder onto a new one.
 *
 * Growing, this aligns to the top, not the bottom. The ladder grew downwards: what used to
 * be rank 1 described a good player, so the names somebody chose keep describing the same
 * standing instead of sliding down and re-labelling a beginner with a name meant for
 * someone else.
 *
 * Shrinking is the mirror of that and must align to the bottom, which is not the same
 * rule and was the bug: `slice(-depth)` on a shorter ladder keeps the hardest names and
 * drops the easiest, so every survivor slides down. Cutting season 1 from sixteen ranks
 * to twelve moved Switching's Peregrine from the top of the ladder to rank 8 and left the
 * unnamed placeholders of the *removed* window sitting above it - precisely the
 * re-labelling the alignment above exists to prevent.
 *
 * Aligning a shrink to the bottom is correct rather than merely opposite: windows are
 * ordered easiest first, and the only shrink the pool can express is dropping trailing
 * ones. Removing window 0 would renumber every family's variants, which no longer round
 * trips through this function at all. So the ranks that disappear are always the hardest,
 * and their names are the ones to drop.
 */
function carryLadder(
  existing: { rankNames?: string[]; rankColors?: Record<string, string> } | undefined,
  depth: number,
): { rankNames: string[]; rankColors: Record<string, string> } {
  const all = existing?.rankNames ?? [];
  const kept = depth < all.length ? all.slice(0, depth) : all;
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
  // Detected rather than hardcoded. This was one developer's absolute path, which works
  // on exactly one machine and tells everybody else the tool is not meant for them.
  const statsDir = statsAt !== -1 ? args[statsAt + 1] : findStatsFolder();
  if (!statsDir) {
    console.error(
      "no KovaaK's stats folder found. Searched:\n" +
        candidateStatsFolders()
          .map((c) => `  ${c}`)
          .join("\n") +
        "\nPass one with --stats <folder>.",
    );
    process.exit(1);
  }
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
  // `pool.ladder.perWindow` used to be checked here for shape, because it was the
  // source of every threshold. It is not a source any more; what is checked instead is
  // that every variant carries as many scores as a window has ranks, which is the same
  // guarantee moved to where the numbers now live.
  const wrongWidth = pool.families.flatMap((f) =>
    f.variants
      .filter((v) => !Array.isArray(v.rankMaxes) || v.rankMaxes.length !== windowSize)
      .map((v) => `${v.scenario} has ${v.rankMaxes?.length ?? 0}`),
  );
  if (wrongWidth.length > 0) {
    console.error(
      `a window is ${windowSize} ranks, so every variant needs ${windowSize} scores:\n  ` +
        wrongWidth.join("\n  "),
    );
    process.exit(1);
  }

  // What kind of provenance the pool's numbers carry, summarised into the season so the
  // debt is visible in the artefact and not only in a validator nobody ran.
  const sourceCounts: Record<string, number> = {};
  for (const family of pool.families) {
    for (const v of family.variants) {
      const kind = v.source?.kind ?? "none";
      sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1;
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

      // The pool owns the numbers now. This used to call thresholdsFrom(dist, ladder)
      // and cut every rank from a percentile of the board; a benchmark for improvement
      // wants a target that sits still, so the number is read rather than computed.
      //
      // `overrides` went with the derivation. It existed so a hand-set number could
      // survive a rebuild that would otherwise recompute over it - and with nothing
      // being computed there is nothing to override.
      const rankMaxes = v.rankMaxes;
      if (!Array.isArray(rankMaxes) || rankMaxes.length === 0) {
        missing.push(v.scenario);
        continue;
      }

      // What the board says about the numbers, rather than what it dictated to them.
      // `clears[i]` is the share of that leaderboard meeting rank i - the readout that
      // catches a threshold nobody can reach or everybody clears, which is the job the
      // percentile ladder used to do by construction and now has to do by inspection.
      const clears = rankMaxes.map((score) => {
        const f = topFractionOfScore(dist, score);
        return f === null ? null : Number(f.toFixed(5));
      });

      const entry: SeasonScenarioOut = {
        scenario: v.scenario,
        category: family.category,
        family: family.family,
        ...(family.subCategory ? { subCategory: family.subCategory } : {}),
        window: v.window,
        label: v.label,
        leaderboardId: v.leaderboardId,
        rankMaxes,
        source: v.source ?? { kind: "seeded", note: "no source recorded in the pool" },
        sanity: {
          leaderboardEntries: dist.total,
          clears,
          sampledAt: cache.sampledAt,
        },
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

  // The whole ladder must still fall, handovers included - now measured, not decreed.
  //
  // This used to compare the percentile ladder against itself, which was possible because
  // every family was cut from one shared sequence. With authored scores there is no shared
  // sequence, and two scenarios' scores are not comparable at all: 900 on one board and 120
  // on another say nothing about each other. What IS comparable is how much of each board
  // clears each threshold, so the check runs on that.
  //
  // Why it has to exist: a family is graded on the BEST of its variants, so a player holds
  // the highest rank any window gives them. If Expert's first rank is easier to clear than
  // Advanced's last, everybody reaching Advanced's last reaches Expert's first at the same
  // moment and the ranks between are held by nobody. Season 1 shipped that shape twice, and
  // the version of this check that only warned collected its findings into an array nothing
  // ever printed.
  const notFalling: string[] = [];

  for (const family of pool.families) {
    const ordered = scenarios
      .filter((sc) => sc.family === family.family)
      .sort((a, b) => (a.window ?? 0) - (b.window ?? 0));

    const seq: { clear: number; scenario: string; rank: number }[] = [];
    for (const sc of ordered) {
      const clears = sc.sanity?.clears ?? [];
      clears.forEach((c, i) => {
        if (typeof c === "number") {
          seq.push({
            clear: c,
            scenario: sc.label ?? sc.scenario,
            rank: (sc.window ?? 0) * windowSize + i + 1,
          });
        }
      });
    }

    for (let i = 1; i < seq.length; i++) {
      if (seq[i].clear >= seq[i - 1].clear) {
        notFalling.push(
          `${family.family}: rank ${seq[i].rank} on ${seq[i].scenario} is cleared by ` +
            `${(seq[i].clear * 100).toFixed(2)}% of its board, no fewer than rank ` +
            `${seq[i - 1].rank} on ${seq[i - 1].scenario} at ` +
            `${(seq[i - 1].clear * 100).toFixed(2)}%`,
        );
      }
    }
  }

  if (notFalling.length > 0) {
    console.error(
      `\n${notFalling.length} rank(s) nobody can hold - a family is graded on its best ` +
        `variant, so reaching the rank below reaches these at the same moment:\n  ` +
        notFalling.slice(0, 12).join("\n  "),
    );
    process.exit(1);
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
    thresholds: {
      owner: "data/pool.json",
      sourced: sourceCounts,
      note:
        "Every threshold in this file is an authored score read from data/pool.json, not a " +
        "percentile of anybody's population. A percentile moves when the population moves, " +
        "so the target slides while somebody is chasing it, and a benchmark for improvement " +
        "wants a number that sits still. Each one carries a `source` saying whether it was " +
        "adopted verbatim from a published benchmark, reconciled between several, authored " +
        "outright with a reason, or is still seeded - inherited from the percentile era and " +
        "not yet given a source. npm run validate:thresholds re-derives the first two and " +
        "counts the last.",
    },
    boards: {
      source: cache.source,
      sampledAt: cache.sampledAt,
      leaderboardEntries: scenarios.reduce(
        (n, s) => n + (s.sanity?.leaderboardEntries ?? 0),
        0,
      ),
      note:
        "The boards no longer set the thresholds; they audit them. Each scenario carries " +
        "`sanity.clears` - what share of that leaderboard meets each rank - which is how a " +
        "threshold nobody can reach, or one everybody clears, gets caught now that no " +
        "percentile guarantees it by construction.",
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
  // The percentile ladder used to be printed here, because it was the thing that decided
  // every number. What matters now is where the numbers came from, and what the boards say
  // about them - so the report shows the median clear-rate per window instead. It is the
  // same shape of readout, measured from the authored numbers rather than dictating them.
  const medianClear = (w: number): string => {
    const all = scenarios
      .filter((sc) => (sc.window ?? 0) === w)
      .flatMap((sc) => sc.sanity?.clears ?? [])
      .filter((c): c is number => typeof c === "number")
      .sort((a, b) => a - b);
    if (all.length === 0) return "unsampled";
    const lo = all[0];
    const hi = all[all.length - 1];
    return `${(hi * 100).toFixed(1)}% down to ${(lo * 100).toFixed(2)}%`;
  };

  console.log(
    `season 1: ${ranks} ranks per category, ${windowSize} per window\n` +
      `windows: ${pool.windows.join(" / ")}   matches draw from ` +
      `${pool.windows[pool.matchWindow]}\n` +
      `thresholds are authored; what each window's share of its boards looks like:\n` +
      pool.windows
        .map((name, w) => `  ${name.padEnd(12)} ${medianClear(w)}`)
        .join("\n") +
      `\n` +
      `provenance: ` +
      Object.entries(sourceCounts)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ") +
      `\n` +
      `${scenarios.length} scenarios in ${pool.families.length} families, behind ` +
      `${season.boards.leaderboardEntries.toLocaleString()} leaderboard entries\n`,
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
