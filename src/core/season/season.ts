/**
 * The season is what the app measures against.
 *
 * Everything that grades a score - energy, ranks, the weakness map, quests, the
 * consistency floor - used to read `data/benchmarks/voltaic-s5.json` directly, which
 * made Voltaic the source of truth for what a rank means. A season replaces that
 * (PLAN.md §14): same numbers to begin with, but ours, frozen when published, and
 * replaceable without anything downstream noticing.
 *
 * "Without anything downstream noticing" is the design. The engine already speaks
 * `DifficultyDef`, and it is a good shape - rank names, colours, categories, scenarios,
 * thresholds - so a season is adapted into one rather than the engine being rewritten
 * around a new type. That keeps this change small enough to reason about, and it means
 * the energy model that was validated to within 0.005 energy against real accounts
 * carries on being the same code.
 *
 * No network. The committed file is the source, exactly as the benchmark files were,
 * so the app still owes nothing to any service being reachable at runtime.
 */

import { existsSync, readFileSync } from "node:fs";

import { dataFile } from "../dataDir.ts";
import { ENERGY_PER_RANK } from "../benchmarks/energy.ts";
import type { DifficultyDef } from "../benchmarks/types.ts";

export interface SeasonCategory {
  name: string;
  /** Category-level energy thresholds, one per rank in this category's ladder. */
  rankMaxes: number[];
  /**
   * This category's own ranks (PLAN.md §14).
   *
   * Clicking, Tracking and Switching are three ladders, not three views of one, so each
   * names and colours its own. They are separate because the claims are separate: being
   * near the top of Tracking says nothing about Clicking, and a shared vocabulary would
   * quietly imply it did.
   */
  rankNames: string[];
  rankColors: Record<string, string>;
  /** True when the energy thresholds are what the model would derive. Informational. */
  derivable?: boolean;
}

export interface SeasonScenario {
  scenario: string;
  category: string;
  leaderboardId: number | null;
  /**
   * Score thresholds, ascending. One per rank on a flat season; one per rank in this
   * variant's window on a windowed one.
   */
  rankMaxes: number[];
  /**
   * The family this is a variant of - "Pasu" for all three difficulties of Pasu.
   *
   * Families are what a windowed season grades. A player only ever plays the six
   * scenarios their band uses, not all eighteen, which is the whole reason the ladder
   * can be twelve ranks deep without becoming three times the grind.
   */
  family?: string;
  /** 0-based window this variant grades. See `Season.windowSize`. */
  window?: number;
  /**
   * Where the machine that built the season already scores on this scenario.
   *
   * Written by buildSeason as the sanity check on a seed - a threshold nobody real can
   * approach is a threshold that is wrong - and kept in the file because the season editor
   * shows it next to the number being edited. A threshold is a judgement about scores, and
   * making one with no scores in front of you is guessing.
   */
  corpus?: { runs: number; best: number; median: number; reaches: string | null };
  /**
   * Short display name, e.g. "Pasu" for "VT Pasu Intermediate S5".
   *
   * Carried rather than derived. It used to be stripped out of the scenario name using
   * the difficulty as the thing to remove, which stopped working the moment a season
   * had no difficulty: labels came out as "Pasu Intermediate", and the sub-category map
   * is keyed on the short label, so every scenario silently lost its sub-category and
   * the weakness map with it. A label is display identity, which is the season owner's
   * to decide anyway.
   */
  label?: string;
}

/**
 * Which scenario pool ranked matches draw from.
 *
 * A season's ladder and a season's *match pool* are different questions. The ladder
 * spans the whole skill range, because that is what a rank is for; the match pool wants
 * everyone on the same three scenarios, because a match is only meaningful when both
 * sides played the same thing (PLAN.md §3). Splitting the pool by window would split an
 * already-small population three ways for no gain: settlement compares a player against
 * their own baseline, so a beginner and a Celestial already get a real contest on the
 * same scenario.
 *
 * So this names one window of the season's own pool, and stays a single field until the
 * population is large enough to justify banding it by rank.
 */
export interface MatchPool {
  /** Index into `Season.windows`. */
  window: number;
}

/**
 * Where matches draw from when a season does not say.
 *
 * The middle window: playable by a beginner and still worth a strong player's time, which
 * is the property that matters while everybody shares one pool.
 */
export const DEFAULT_MATCH_POOL: MatchPool = { window: 1 };

export interface Season {
  name: string;
  status: "draft" | "published" | "archived";
  /**
   * The overall ladder, above the three categories.
   *
   * Kept because a player still wants one number that means *them*, and §14 makes it a
   * readout derived from the three rather than the thing that moves.
   */
  rankNames: string[];
  rankColors: Record<string, string>;
  categories: SeasonCategory[];
  scenarios: SeasonScenario[];
  /**
   * How many ranks one scenario window covers. Absent on a flat season.
   *
   * A ladder wide enough to hold both a first-week player and a top one cannot be a
   * single set of scenarios: a perfect run on something easy has to stop proving
   * anything at some point, and past that point the ladder needs harder scenarios to
   * keep measuring. So the ladder is cut into windows of `windowSize` ranks, and each
   * family carries one variant per window.
   */
  windowSize?: number;
  /** Display name per window, low to high, e.g. ["Novice", "Intermediate", "Advanced"]. */
  windows?: string[];
  /** Defaults to DEFAULT_MATCH_POOL when absent. */
  matchPool?: MatchPool;
  seededFrom?: { benchmark: string; difficulty: string; note?: string };
}

/** The pool matches draw from, for a season that may not name one. */
export function matchPoolFor(season: Season): MatchPool {
  return season.matchPool ?? DEFAULT_MATCH_POOL;
}

/** True when this season grades families across windows rather than flat scenarios. */
export function isWindowed(season: Season): boolean {
  return typeof season.windowSize === "number" && season.windowSize > 0;
}

/** Which window ranked matches are drawn from. */
export function matchPoolWindow(season: Season): number {
  return matchPoolFor(season).window;
}

/** Display name for the window matches are drawn from. */
export function matchPoolName(season: Season): string {
  return season.windows?.[matchPoolWindow(season)] ?? `window ${matchPoolWindow(season) + 1}`;
}

/** Where the committed season lives. */
export const SEASON_FILE = "seasons/season-1.json";

export function seasonPath(): string {
  return dataFile("seasons", "season-1.json");
}

export function hasSeason(): boolean {
  return existsSync(seasonPath());
}

/**
 * Load the season, and refuse to load a broken one.
 *
 * A season with the wrong number of thresholds would produce ranks nobody can reach,
 * silently, on every screen that grades a score. Better to fail here with the reason
 * than to let a bad definition become a confusing app.
 */
export function loadSeason(path?: string): Season {
  const file = path ?? seasonPath();
  const season = JSON.parse(readFileSync(file, "utf8")) as Season;
  validateSeason(season);
  return season;
}

/**
 * Refuse a season that would grade scores wrongly.
 *
 * Shared with the editor, which checks before writing rather than after: a bad season
 * breaks every screen that grades a score, so discovering it on the next render means
 * the app is already wrong by the time anyone is told.
 *
 * Thresholds must ascend. A ladder that goes backwards silently makes a rank
 * unreachable - the score that earns the higher one already earned the lower - and it
 * is the easiest thing in the world to do by hand while editing a row of numbers.
 */
export function validateSeason(season: Season): void {
  if (!season || typeof season !== "object") throw new Error("not a season");

  if (!Array.isArray(season.rankNames) || season.rankNames.length === 0) {
    throw new Error(`season "${season.name}" has no ranks`);
  }

  const ranks = season.rankNames.length;

  const blank = season.rankNames.find((n) => !n || !n.trim());
  if (blank !== undefined) throw new Error("a rank has no name");

  const duplicate = season.rankNames.find(
    (n, i) => season.rankNames.indexOf(n) !== i,
  );
  if (duplicate) throw new Error(`two ranks are both called "${duplicate}"`);

  if (!Array.isArray(season.scenarios) || season.scenarios.length === 0) {
    throw new Error("a season needs at least one scenario");
  }

  const ranksByCategory = new Map(
    season.categories.map((c) => [c.name, (c.rankNames ?? season.rankNames).length]),
  );

  const windowed = isWindowed(season);
  const windowSize = season.windowSize ?? 0;

  if (windowed) {
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new Error(`windowSize must be a whole number of ranks, not ${season.windowSize}`);
    }
    for (const [name, depth] of ranksByCategory) {
      if (depth % windowSize !== 0) {
        throw new Error(
          `${name} has ${depth} ranks, which is not a whole number of ` +
            `${windowSize}-rank windows`,
        );
      }
    }
    // Enough names to cover the deepest category. A shallower one uses a prefix of the
    // list rather than needing its own, because categories are allowed to differ in
    // depth and the windows are the same three ranges whichever ladder is asking.
    if (season.windows) {
      for (const [name, depth] of ranksByCategory) {
        if (season.windows.length < depth / windowSize) {
          throw new Error(
            `the season names ${season.windows.length} windows but ${name} has ` +
              `${depth / windowSize}`,
          );
        }
      }
    }
  }

  for (const s of season.scenarios) {
    // Against its own category's ladder, not the season's: with three ladders those
    // can differ, and checking the wrong one would pass a scenario that grades to a
    // rank its category has never heard of.
    const depth = ranksByCategory.get(s.category) ?? ranks;
    // A windowed variant carries its window's thresholds, not the whole ladder's.
    const expected = windowed ? windowSize : depth;
    if (windowed) {
      if (!s.family || !s.family.trim()) {
        throw new Error(`${s.label ?? s.scenario} has no family, which a windowed season needs`);
      }
      if (!Number.isInteger(s.window) || s.window! < 0 || s.window! >= depth / windowSize) {
        throw new Error(
          `${s.label ?? s.scenario} is in window ${s.window}, and ${s.category} has ` +
            `${depth / windowSize}`,
        );
      }
    }
    if (s.rankMaxes.length !== expected) {
      throw new Error(
        `${s.label ?? s.scenario} has ${s.rankMaxes.length} thresholds ` +
          `but ${s.category} defines ${expected} ranks` +
          (windowed ? ` per window` : ``),
      );
    }
    if (s.rankMaxes.some((v) => !Number.isFinite(v))) {
      throw new Error(`${s.label ?? s.scenario} has a threshold that is not a number`);
    }
    const descends = s.rankMaxes.findIndex((v, i) => i > 0 && v <= s.rankMaxes[i - 1]);
    if (descends > 0) {
      // Named from the category's own ladder. Reaching for the season's would print a
      // rank this scenario is not graded against, which is a confusing way to be told
      // about a real mistake. On a windowed season the row's thresholds start partway
      // up that ladder, so the window's offset has to be added back.
      const ladder =
        season.categories.find((c) => c.name === s.category)?.rankNames ?? season.rankNames;
      const at = descends + (windowed ? s.window! * windowSize : 0);
      throw new Error(
        `${s.label ?? s.scenario}: ${ladder[at]} (${s.rankMaxes[descends]}) ` +
          `is not above ${ladder[at - 1]} (${s.rankMaxes[descends - 1]})`,
      );
    }
  }

  // Every family must cover every window.
  //
  // A missing window makes the ranks it covers unreachable for that family, which shows up
  // as a ladder nobody can finish and no error to say why. Covering a window more than
  // once is fine - the family takes the best of its variants, so two scenarios in one
  // window is an honest "either of these proves it".
  if (windowed) {
    const byFamily = new Map<string, SeasonScenario[]>();
    for (const s of season.scenarios) {
      const list = byFamily.get(s.family!) ?? [];
      list.push(s);
      byFamily.set(s.family!, list);
    }

    for (const [family, variants] of byFamily) {
      const categories = new Set(variants.map((v) => v.category));
      if (categories.size > 1) {
        throw new Error(
          `family ${family} is split across ${[...categories].join(" and ")}`,
        );
      }
      const depth = ranksByCategory.get(variants[0].category) ?? ranks;
      const wanted = depth / windowSize;
      const seen = new Set(variants.map((v) => v.window!));
      for (let w = 0; w < wanted; w++) {
        if (!seen.has(w)) {
          throw new Error(
            `family ${family} has no scenario for window ${w}, so ranks ` +
              `${w * windowSize + 1}-${w * windowSize + windowSize} cannot be reached`,
          );
        }
      }
      // More than one scenario in a window is allowed, and useful: a family is graded on
      // the best of its variants, so two scenarios sharing a window means "prove this rank
      // on either of these". What is not allowed is a window with none, which is the case
      // above - that leaves the ranks it covers unreachable.
      //
      // Duplicates of the *same* scenario are refused, though: the same name twice adds
      // nothing, and it is what a mis-click produces.
      const names = variants.map((v) => v.scenario);
      const twice = names.find((n, i) => names.indexOf(n) !== i);
      if (twice) {
        throw new Error(`family ${family} lists ${twice} twice`);
      }
    }
  }

  for (const c of season.categories) {
    if (!Array.isArray(c.rankNames) || c.rankNames.length === 0) {
      throw new Error(`category ${c.name} has no ranks`);
    }
    if (c.rankNames.some((n) => !n || !n.trim())) {
      throw new Error(`category ${c.name} has a rank with no name`);
    }
    if (c.rankMaxes.length !== c.rankNames.length) {
      throw new Error(
        `category ${c.name} has ${c.rankMaxes.length} energy thresholds ` +
          `but ${c.rankNames.length} ranks`,
      );
    }
    const descends = c.rankMaxes.findIndex((v, i) => i > 0 && v <= c.rankMaxes[i - 1]);
    if (descends > 0) {
      throw new Error(`category ${c.name}: energy thresholds must ascend`);
    }

    // A rank nobody can reach.
    //
    // A family caps at ENERGY_PER_RANK per rank and a category is the sum of its
    // families, so there is a hard ceiling on category energy - and a threshold above it
    // is a rank that exists on every screen and cannot be earned by anyone, at any score,
    // ever. Nothing else catches it: the ladder ascends, the counts line up, and the only
    // symptom is a top rank that stays empty forever while people try for it.
    //
    // Voltaic's published Switching thresholds have exactly this shape, which is how this
    // check came to be written.
    const familyCount = new Set(
      season.scenarios.filter((s) => s.category === c.name).map((s) => s.family ?? s.scenario),
    ).size;
    const ceiling = familyCount * c.rankNames.length * ENERGY_PER_RANK;
    const top = c.rankMaxes[c.rankMaxes.length - 1];

    if (familyCount > 0 && top > ceiling) {
      const unreachable = c.rankMaxes.filter((v) => v > ceiling).length;
      throw new Error(
        `category ${c.name}: ${unreachable} rank(s) cannot be reached - ` +
          `${c.rankNames[c.rankNames.length - unreachable]} needs ` +
          `${c.rankMaxes[c.rankMaxes.length - unreachable]} energy and ${familyCount} ` +
          `families over ${c.rankNames.length} ranks cap at ${ceiling}`,
      );
    }
  }

  // A scenario in no category is graded by nothing and would vanish from every screen
  // without any error to explain where it went.
  const known = new Set(season.categories.map((c) => c.name));
  const orphan = season.scenarios.find((s) => !known.has(s.category));
  if (orphan) {
    throw new Error(
      `${orphan.label ?? orphan.scenario} is in category "${orphan.category}", ` +
        `which the season does not define`,
    );
  }
}

/**
 * Present a season in the shape the grading engine already reads.
 *
 * A season has no difficulties: that was Voltaic's way of splitting one benchmark into
 * four, and owning the pool means the split is now three categories instead. The
 * `name` here is the season's, so anything that prints a difficulty prints something
 * true rather than a borrowed label.
 */
export function seasonAsDifficulty(season: Season): DifficultyDef {
  const byCategory = new Map<string, SeasonScenario[]>();
  for (const s of season.scenarios) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }

  return {
    name: season.name,
    // No KovaaK's benchmark id: this season is not one of theirs, and pretending
    // otherwise would send anything that trusted the field to the wrong data.
    kovaaksBenchmarkId: 0,
    rankNames: season.rankNames,
    rankColors: season.rankColors,
    categories: season.categories.map((c) => ({
      name: c.name,
      rankMaxes: c.rankMaxes,
      rankNames: c.rankNames ?? season.rankNames,
      rankColors: c.rankColors ?? season.rankColors,
      windowSize: season.windowSize,
      scenarios: (byCategory.get(c.name) ?? []).map((s) => ({
        name: s.scenario,
        leaderboardId: s.leaderboardId,
        rankMaxes: s.rankMaxes,
        family: s.family,
        window: s.window,
      })),
    })),
  };
}

/**
 * Short display name per scenario, for anything that labels one.
 *
 * Falls back to stripping the "VT " prefix and the trailing season marker, which is
 * enough to be readable when a hand-edited season leaves a label out.
 */
export function seasonLabels(season: Season): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of season.scenarios) {
    out.set(
      s.scenario,
      s.label ?? s.scenario.replace(/^VT\s+/, "").replace(/\s*S\d(\.\d)?\s*$/i, "").trim(),
    );
  }
  return out;
}
