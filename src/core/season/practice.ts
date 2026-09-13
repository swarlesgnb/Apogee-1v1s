/**
 * The season as something you can sit down and grind.
 *
 * A match hands you three scenarios and writes them out as a playlist
 * (`src/core/match/playlist.ts`). Practice is the other half of the same problem, and it
 * was the half that was missing: the season screen could name all 88 scenarios and there
 * was no way to play any of them without queueing. `apogee:launchScenario` refused
 * anything that was not part of a live match, and the only playlists on disk came from a
 * dev script that dumped them in the repo for hand-copying.
 *
 * So the playlists are built here rather than in a tool, and both the tool and the app
 * call this. There are `windows × (categories + 1)` of them: one per category per
 * difficulty band - what a category queue at that band would draw from - and one per band
 * across all three, for a full session at one level.
 *
 * Two rules the naming has to keep:
 *
 *   - never the match prefix. The client deletes files beginning `Apogee Match` when it
 *     writes a new match playlist, and a practice playlist swept away mid-session looks
 *     exactly like the app losing the player's things.
 *   - stable per season, so re-installing overwrites rather than accumulating.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MIN_RUNS_FOR_BASELINE } from "../history/baseline.ts";
import { originsOf, type OriginRank } from "../benchmarks/origins.ts";
import {
  MATCH_PLAYLIST_PREFIX,
  serializePlaylist,
  type KovaaksPlaylist,
} from "../match/playlist.ts";

/** Matches what `buildMatchPlaylist` writes; KovaaK's rejects an unknown version. */
const PLAYLIST_FORMAT_VERSION = 31;

export interface PracticePlaylist {
  name: string;
  /** Scenario names, in the order KovaaK's will play them. */
  scenarios: string[];
  description: string;
  category: string | null;
  window: number;
}

interface SeasonLike {
  name: string;
  windows?: string[];
  scenarios: { scenario: string; label?: string; category: string; window?: number }[];
}

/** Where KovaaK's keeps playlists, given its stats folder. */
export function playlistsFolderFor(statsDir: string): string {
  return join(statsDir, "..", "Saved", "SaveGames", "Playlists");
}

/** Windows-illegal characters stripped, because the name is also the file name. */
function fileNameFor(name: string): string {
  // eslint-disable-next-line no-control-regex
  return `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim()}.json`;
}

/**
 * Every practice playlist this season implies.
 *
 * Pure, so the set can be shown in the UI before anything is written and the tool and the
 * app cannot drift into building different ones.
 */
export function practicePlaylists(season: SeasonLike): PracticePlaylist[] {
  const windows = season.windows ?? [];
  const categories = [...new Set(season.scenarios.map((s) => s.category))];
  const out: PracticePlaylist[] = [];

  const describe = (count: number) =>
    `${season.name} practice. ${count} scenarios, the ones this season ranks you on. ` +
    `Play them as often as you like - nothing here is a match, and none of it settles ` +
    `anything.`;

  // `scenario`, never `label`. A label is display identity and the two do differ - the
  // season shows "Aimerz+ 1w4ts HF Hard" for a scenario KovaaK's calls "... Hard S1" -
  // and a playlist entry that is not the exact name is a row the game cannot launch.
  for (const category of categories) {
    for (let w = 0; w < windows.length; w++) {
      const scenarios = season.scenarios
        .filter((s) => s.category === category && (s.window ?? 0) === w)
        .map((s) => s.scenario);
      if (scenarios.length === 0) continue;
      out.push({
        name: `Apogee ${category} ${windows[w]}`,
        scenarios,
        description: describe(scenarios.length),
        category,
        window: w,
      });
    }
  }

  for (let w = 0; w < windows.length; w++) {
    const scenarios = season.scenarios
      .filter((s) => (s.window ?? 0) === w)
      .sort((a, b) => a.category.localeCompare(b.category) || a.scenario.localeCompare(b.scenario))
      .map((s) => s.scenario);
    if (scenarios.length === 0) continue;
    out.push({
      name: `Apogee All ${windows[w]}`,
      scenarios,
      description: describe(scenarios.length),
      category: null,
      window: w,
    });
  }

  return out;
}

function toKovaaks(playlist: PracticePlaylist, now: Date): KovaaksPlaylist {
  if (playlist.scenarios.length === 0) throw new Error(`${playlist.name} has no scenarios`);
  if (playlist.name.startsWith(MATCH_PLAYLIST_PREFIX)) {
    throw new Error(`${playlist.name} would be deleted by the match sweep`);
  }
  return {
    playlistName: playlist.name,
    playlistId: 0,
    authorSteamId: "",
    authorName: "",
    scenarioList: playlist.scenarios.map((scenario_name) => ({ scenario_name, play_Count: 1 })),
    description: playlist.description,
    hasOfflineScenarios: false,
    hasEdited: true,
    shareCode: "",
    version: PLAYLIST_FORMAT_VERSION,
    updated: Math.floor(now.getTime() / 1000),
    isPrivate: false,
  };
}

export interface WriteResult {
  ok: boolean;
  dir?: string;
  written?: string[];
  error?: string;
}

/**
 * Write them all into a folder.
 *
 * `mkdir` is deliberate for a plain output directory and deliberate*ly not* for KovaaK's
 * own: a missing Playlists folder there means the path is wrong, and creating one would
 * hide that behind twenty files nothing will ever read.
 */
export function writePracticePlaylists(
  season: SeasonLike,
  dir: string,
  options: { create?: boolean; now?: Date; only?: Set<string> | null } = {},
): WriteResult {
  const all = practicePlaylists(season);
  const playlists = options.only ? all.filter((p) => options.only!.has(p.name)) : all;
  if (playlists.length === 0) {
    return {
      ok: false,
      error: options.only ? "none of those playlists are in this season" : "this season has no scenarios",
    };
  }

  if (!existsSync(dir)) {
    if (!options.create) return { ok: false, error: `no folder at ${dir}` };
    mkdirSync(dir, { recursive: true });
  }

  const now = options.now ?? new Date();
  const written: string[] = [];
  try {
    for (const playlist of playlists) {
      const file = fileNameFor(playlist.name);
      writeFileSync(join(dir, file), serializePlaylist(toKovaaks(playlist, now)), "utf8");
      written.push(playlist.name);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, dir, written };
}

/** How many Apogee playlists are sitting in a folder now, for a "20 installed" readout. */
export function installedPlaylistCount(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.startsWith("Apogee ") && f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Where a family stands, and which of its variants to play next
// ---------------------------------------------------------------------------

export interface VariantProgress {
  scenario: string;
  window: number;
  /** Ladder rank index this variant's own best reaches, or null for none. */
  rankIndex: number | null;
  /** Ladder rank index the next threshold on this variant would grant. */
  nextRankIndex: number;
  /** Score for that rank on this variant, or null when it is already maxed. */
  nextRankScore: number | null;
}

/**
 * The variant to play next, given every variant's standing.
 *
 * A family is graded on the *best* of its variants, so the next rank is the first one
 * above whatever that reaches - and it is often scored on a harder variant than the one
 * currently carrying the family. Picking it wrong is the single most confusing thing a
 * windowed ladder can do (PLAN.md §14), so it is decided here rather than in each of the
 * three places that show it.
 *
 * The rule that is easy to get wrong: a maxed variant is never the target. Its
 * `nextRankIndex` still reads as one past the rank it granted, so a family sitting at
 * rank 4 with a maxed Novice variant matches "the next rank" on the Novice row - and the
 * app tells the player to grind a scenario that cannot award them anything. Only a
 * variant with a threshold left can be the answer.
 */
export function nextVariant<T extends VariantProgress>(variants: T[]): T | null {
  const held = variants.reduce(
    (best, v) => (v.rankIndex !== null && v.rankIndex > best ? v.rankIndex : best),
    -1,
  );

  const reachable = variants.filter((v) => v.nextRankScore !== null);
  if (reachable.length === 0) return null;

  // The cheapest real step: the lowest next rank that is above what the family holds.
  // Falling back to the lowest of all is for a family whose windows are all behind the
  // player - which happens mid-season when a rank ladder is re-cut under them.
  const ahead = reachable.filter((v) => v.nextRankIndex > held);
  const pool = ahead.length > 0 ? ahead : reachable;
  return pool.reduce((a, b) => (b.nextRankIndex < a.nextRankIndex ? b : a));
}

/** Highest ladder rank index any variant of the family reaches, or null for none. */
export function familyRank(variants: VariantProgress[]): number | null {
  let held: number | null = null;
  for (const v of variants) {
    if (v.rankIndex !== null && (held === null || v.rankIndex > held)) held = v.rankIndex;
  }
  return held;
}

// ---------------------------------------------------------------------------
// The pool measured against a player's history
// ---------------------------------------------------------------------------

export interface PracticeRow extends VariantProgress {
  label: string;
  category: string;
  subCategory: string | null;
  /** Viscose's Arm/Wrist/Fingertip/Blending, where published. Null for most of the pool. */
  mechanic: string | null;
  /**
   * The published benchmarks that also name this scenario, and what `best` is worth in
   * each of them.
   *
   * 146 of the 156 in the pool carry at least one. Empty for the rest, which are the
   * hand-picked easier rungs no author has graded - and an empty list renders as nothing
   * rather than as "no benchmarks", because a scenario the community has not graded is
   * not a scenario that failed to be graded.
   */
  origins: OriginRank[];
  /**
   * Whether this scenario holds a baseline a match could be scored against.
   *
   * Not `runs > 0`. Below MIN_RUNS_FOR_BASELINE there is no usable median, so a screen
   * counting any run as a baseline disagrees with `windowCoverage` about the same pool -
   * which is exactly what the queue screen did, saying five where coverage said four.
   */
  measured: boolean;
  family: string;
  windowName: string;
  rankMaxes: number[];
  runs: number;
  /** Personal best, rounded, or null where the scenario has never been played. */
  best: number | null;
  /** Points from `best` to `nextRankScore`, or null when there is nothing to reach. */
  gap: number | null;
  /** Score of the rank already held on this variant - the floor of the current step. */
  heldRankScore: number | null;
  /**
   * How far through the current rank step this score is, 0..1, or null where there is no
   * step left to be through.
   *
   * Measured from the threshold already cleared rather than from zero, because from zero
   * every scenario a player has touched reads as nearly full and the bar says nothing.
   * The honest question is how much of *this* rank is done.
   */
  progress: number | null;
  /** The one variant of this family worth playing next. See `nextVariant`. */
  isNext: boolean;
}

export interface FamilyStanding {
  family: string;
  category: string;
  subCategory: string | null;
  /** Viscose's Arm/Wrist/Fingertip/Blending, where published. Null for most of the pool. */
  mechanic: string | null;
  /** Highest ladder rank any variant reaches, or null for none. */
  rankIndex: number | null;
  /** Scenario name of the variant to play next, or null when the family is maxed. */
  next: string | null;
}

interface HistoryEntry {
  runs: { score: number }[];
}

interface GradedSeason extends SeasonLike {
  windowSize?: number;
  scenarios: {
    scenario: string;
    label?: string;
    category: string;
    subCategory?: string;
    mechanic?: string;
    family?: string;
    window?: number;
    rankMaxes: number[];
  }[];
}

/**
 * Every scenario in the season, with what this player has done on it.
 *
 * One row per scenario rather than per family, which is the difference between a standing
 * and a practice list: the snapshot already answers "what rank am I", and it answers it
 * with the single variant that earned the rank. That cannot say what you have done on the
 * other three difficulties, so it cannot say which one to play next.
 *
 * Rank indices are the *ladder's*, not the scenario's - a variant's own thresholds are
 * offset by the ranks below its window - because the whole point of a windowed ladder is
 * that all sixteen ranks are one ladder. Printing a scenario-local "rank 2" beside a
 * category's "rank 10" is the confusion this offset exists to prevent.
 *
 * Pure, given a history map. Three callers share it - the app, `tools/checkPractice.ts`
 * and the UI preview - and the arithmetic being in one place is what stops them printing
 * three different personal bests for the same run.
 */
export function practiceRows(
  season: GradedSeason,
  history: Map<string, HistoryEntry>,
): { rows: PracticeRow[]; families: FamilyStanding[] } {
  const windows = season.windows ?? [];
  const windowSize = season.windowSize ?? 4;

  const rows: PracticeRow[] = season.scenarios.map((s) => {
    const window = s.window ?? 0;
    const local = history.get(s.scenario);
    const scores = local ? local.runs.map((r) => r.score) : [];
    const best = scores.length > 0 ? Math.max(...scores) : null;

    const base = window * windowSize;
    let rankIndex: number | null = null;
    s.rankMaxes.forEach((threshold, i) => {
      if (best !== null && best >= threshold) rankIndex = base + i;
    });

    const within = rankIndex === null ? 0 : rankIndex - base + 1;
    const nextRankScore = within < s.rankMaxes.length ? s.rankMaxes[within] : null;
    const heldRankScore = within > 0 ? s.rankMaxes[within - 1] : null;

    // From the rank already cleared to the one being chased. Below the first threshold the
    // floor is zero, which is right: there is no rank under it to have come from.
    const floor = heldRankScore ?? 0;
    const progress =
      nextRankScore === null || nextRankScore <= floor
        ? null
        : Math.max(0, Math.min(1, ((best ?? 0) - floor) / (nextRankScore - floor)));

    return {
      scenario: s.scenario,
      label: s.label ?? s.scenario,
      category: s.category,
      subCategory: s.subCategory ?? null,
      mechanic: s.mechanic ?? null,
      origins: originsOf(s.scenario, best),
      family: s.family ?? s.scenario,
      window,
      windowName: windows[window] ?? `window ${window + 1}`,
      rankMaxes: s.rankMaxes,
      runs: scores.length,
      measured: scores.length >= MIN_RUNS_FOR_BASELINE,
      best: best === null ? null : Math.round(best),
      rankIndex,
      nextRankIndex: rankIndex === null ? base : rankIndex + 1,
      nextRankScore,
      gap: nextRankScore === null || best === null ? null : Math.max(0, Math.round(nextRankScore - best)),
      heldRankScore,
      progress,
      isNext: false,
    };
  });

  const byFamily = new Map<string, PracticeRow[]>();
  for (const row of rows) {
    const key = `${row.category}/${row.family}`;
    byFamily.set(key, [...(byFamily.get(key) ?? []), row]);
  }

  const families: FamilyStanding[] = [...byFamily.values()].map((variants) => {
    const target = nextVariant(variants);
    for (const v of variants) v.isNext = target?.scenario === v.scenario;
    return {
      family: variants[0].family,
      category: variants[0].category,
      subCategory: variants[0].subCategory,
      mechanic: variants[0].mechanic,
      rankIndex: familyRank(variants),
      next: target?.scenario ?? null,
    };
  });

  return { rows, families };
}
