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
import type { DifficultyDef } from "../benchmarks/types.ts";

export interface SeasonCategory {
  name: string;
  /** Category-level energy thresholds, one per rank. */
  rankMaxes: number[];
  /** True when these are exactly what the energy model would derive. Informational. */
  derivable?: boolean;
}

export interface SeasonScenario {
  scenario: string;
  category: string;
  leaderboardId: number | null;
  /** Score thresholds, ascending, one per rank. */
  rankMaxes: number[];
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

export interface Season {
  name: string;
  status: "draft" | "published" | "archived";
  rankNames: string[];
  rankColors: Record<string, string>;
  categories: SeasonCategory[];
  scenarios: SeasonScenario[];
  seededFrom?: { benchmark: string; difficulty: string; note?: string };
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

  if (!Array.isArray(season.rankNames) || season.rankNames.length === 0) {
    throw new Error(`season "${season.name}" has no ranks`);
  }

  const ranks = season.rankNames.length;

  const badScenario = season.scenarios.find((s) => s.rankMaxes.length !== ranks);
  if (badScenario) {
    throw new Error(
      `${badScenario.scenario} has ${badScenario.rankMaxes.length} thresholds ` +
        `but the season defines ${ranks} ranks`,
    );
  }

  const badCategory = season.categories.find((c) => c.rankMaxes.length !== ranks);
  if (badCategory) {
    throw new Error(
      `category ${badCategory.name} has ${badCategory.rankMaxes.length} thresholds ` +
        `but the season defines ${ranks} ranks`,
    );
  }

  return season;
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
      scenarios: (byCategory.get(c.name) ?? []).map((s) => ({
        name: s.scenario,
        leaderboardId: s.leaderboardId,
        rankMaxes: s.rankMaxes,
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
