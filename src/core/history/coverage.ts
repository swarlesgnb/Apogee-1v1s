/**
 * Which difficulties a player is actually measured on.
 *
 * A match is decided on delta against your own baseline, which is what lets any two
 * players have a real contest on the same scenario (PLAN.md §3). The catch is that the
 * baseline has to exist. Below `MIN_RUNS_FOR_BASELINE` runs there is no usable median,
 * and the verified-PB floor that defends against sandbagging cannot help either: on a
 * scenario with two runs the median *is* those two runs and the floor is 0.9 x a PB set
 * on the same two. The anti-sandbag guarantee is a guarantee about scenarios you have
 * played, and says nothing about the rest.
 *
 * That makes coverage a first-class fact rather than an implementation detail:
 *
 *   FOR A PLAYER    it is the honest answer to "what can I queue for", and the reason a
 *                   difficulty is worth grinding beyond the rank it pays.
 *   FOR A MATCH     it decides which difficulties two people can fairly contest. A
 *                   difficulty one side has never played is not a hard scenario, it is an
 *                   unmeasured one, and a match there is decided by whose baseline is
 *                   worse rather than by who played better.
 *
 * Measured, not assumed: on the most-played account this app has, 11,138 runs across 803
 * scenarios, 36 of the season's 54 scenarios have no usable baseline. Coverage is thin
 * even for someone who has played a great deal, which is exactly why it has to be shown.
 */

import { MIN_RUNS_FOR_BASELINE } from "./baseline.ts";
import type { ScenarioHistory } from "./history.ts";
import type { Season } from "../season/season.ts";

/**
 * Scenarios in one match (PLAN.md §3).
 *
 * A window is contestable once this many of its scenarios are measured, because
 * selection can be held to the measured ones. Below it there is not enough to fill a
 * match without reaching for a scenario nobody has a baseline on.
 */
export const SCENARIOS_PER_MATCH = 3;

export interface ScenarioCoverage {
  scenario: string;
  label: string;
  family: string;
  runs: number;
  /** True once there are enough runs for a baseline that is not provisional. */
  measured: boolean;
  /** Runs still needed. Zero once measured. */
  needs: number;
}

export interface WindowCoverage {
  category: string;
  window: number;
  windowName: string;
  /** Scenarios in this category's window. */
  total: number;
  measured: number;
  runs: number;
  /**
   * Enough measured scenarios to fill a match from.
   *
   * The bar a difficulty has to clear to be worth offering as a choice: everything on
   * that list should be a difficulty where the player's own scores are the thing being
   * compared.
   */
  matchable: boolean;
  /** Every scenario in the window is measured. */
  complete: boolean;
  scenarios: ScenarioCoverage[];
}

/**
 * How well covered every category-and-window is.
 *
 * `history` is keyed on scenario name, as `scanStatsFolder` returns it. A season with no
 * windows is treated as one window, which is the honest reading: there is one set of
 * scenarios and either you have played them or you have not.
 */
export function windowCoverage(
  season: Season,
  history: Map<string, ScenarioHistory>,
): WindowCoverage[] {
  const size = season.windowSize ?? 0;
  const names = season.windows ?? [];

  const buckets = new Map<string, WindowCoverage>();

  for (const s of season.scenarios) {
    const window = size > 0 ? (s.window ?? 0) : 0;
    const key = `${s.category}/${window}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        category: s.category,
        window,
        windowName: names[window] ?? (size > 0 ? `window ${window + 1}` : season.name),
        total: 0,
        measured: 0,
        runs: 0,
        matchable: false,
        complete: false,
        scenarios: [],
      };
      buckets.set(key, bucket);
    }

    const runs = history.get(s.scenario)?.runs.length ?? 0;
    const measured = runs >= MIN_RUNS_FOR_BASELINE;

    bucket.total++;
    bucket.runs += runs;
    if (measured) bucket.measured++;
    bucket.scenarios.push({
      scenario: s.scenario,
      label: s.label ?? s.scenario,
      family: s.family ?? s.scenario,
      runs,
      measured,
      needs: measured ? 0 : MIN_RUNS_FOR_BASELINE - runs,
    });
  }

  const out = [...buckets.values()];
  for (const bucket of out) {
    bucket.matchable = bucket.measured >= Math.min(SCENARIOS_PER_MATCH, bucket.total);
    bucket.complete = bucket.measured === bucket.total;
    // Least-played first, so what is missing leads.
    bucket.scenarios.sort((a, b) => a.runs - b.runs);
  }

  return out.sort(
    (a, b) => a.category.localeCompare(b.category) || a.window - b.window,
  );
}

/**
 * The difficulties a player could fairly be offered, per category.
 *
 * This is the ballot, and the same list is the answer to "what can I queue for". A player
 * with nothing matchable in a category is not blocked - the caller falls back to the
 * season's own match pool - but it is worth knowing that is what happened.
 */
export function matchableWindows(coverage: WindowCoverage[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const c of coverage) {
    if (!c.matchable) continue;
    const list = out.get(c.category) ?? [];
    list.push(c.window);
    out.set(c.category, list);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

/**
 * Windows both players could contest, per category.
 *
 * The intersection, because a difficulty is only fair when both sides are measured on
 * it. Empty is a real answer and the caller has to have something to do with it.
 */
export function sharedWindows(
  a: WindowCoverage[],
  b: WindowCoverage[],
): Map<string, number[]> {
  const mine = matchableWindows(a);
  const theirs = matchableWindows(b);
  const out = new Map<string, number[]>();

  for (const [category, windows] of mine) {
    const other = theirs.get(category);
    if (!other) continue;
    const both = windows.filter((w) => other.includes(w));
    if (both.length > 0) out.set(category, both);
  }

  return out;
}
