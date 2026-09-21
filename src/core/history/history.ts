/**
 * Local run history and baseline computation.
 *
 * The baseline is the number every match is scored against (PLAN.md §3), which makes it
 * both the most attack-prone value in the system and the one that decides how matches
 * feel. Two properties are needed at once:
 *
 *   UNGAMEABLE  deliberately playing badly must not drag the baseline down, or
 *               sandbagging becomes the dominant strategy.
 *   CENTRED     a typical run should sit near 0%, so a good day reads as +x% and a bad
 *               day as −x%. An off-centre baseline turns every match into "who avoided
 *               a disaster" instead of "who played better today".
 *
 * The first implementation used a high-water statistic (mean of the top 30% of recent
 * runs) for the anti-sandbag property. Measured against 156 scenarios of real history,
 * that was badly off-centre: mean delta −3.8%, with only **26%** of genuine runs
 * landing above their own baseline.
 *
 * Comparing four definitions on that data (`compareBaselines.ts`) showed the
 * high-water statistic was not the part doing the work:
 *
 *     definition   mean delta   above baseline   sandbag drop
 *     top 30%          −3.8%             26%            3.0%
 *     median           +0.4%             58%            3.5%
 *     plain mean       +0.6%             60%            9.3%
 *
 * The **verified-PB floor** is what defeats sandbagging. With the floor in place, a
 * median is centred *and* nearly as hard to game as the high-water statistic, while a
 * plain mean is three times more gameable. So the baseline is now:
 *
 *     baseline = max( median(last 50 runs), 0.9 × verified PB )
 */

import { readStatsFolder } from "../stats/folderCache.ts";
import { baselineFromScores, type Baseline } from "./baseline.ts";

// The maths lives in baseline.ts so the server can import it without pulling in
// node:fs. Re-exported here so local callers have one place to look.
export {
  BASELINE_WINDOW,
  MIN_RUNS_FOR_BASELINE,
  PB_FLOOR_FRACTION,
  baselineFromScores,
  delta,
  recentMedian,
  type Baseline,
} from "./baseline.ts";

export interface ScenarioHistory {
  scenario: string;
  /** Every run, oldest first. */
  runs: { score: number; playedAt: Date | null }[];
  /** Best local score ever recorded. */
  best: number;
  /** Most recent run's timestamp, if known. */
  lastPlayed: Date | null;
}

/**
 * Build per-scenario history from a KovaaK's stats folder.
 *
 * Files that fail to parse are skipped silently, since an incomplete run is normal, not an
 * error. Returns a map keyed on the scenario name recorded inside the file. Each file is
 * parsed once per session (stats/folderCache.ts), so a rescan reads only new files.
 */
export function scanStatsFolder(dir: string): Map<string, ScenarioHistory> {
  const history = new Map<string, ScenarioHistory>();

  for (const { run } of readStatsFolder(dir)) {
    let entry = history.get(run.scenario);
    if (!entry) {
      entry = { scenario: run.scenario, runs: [], best: 0, lastPlayed: null };
      history.set(run.scenario, entry);
    }

    entry.runs.push({ score: run.score, playedAt: run.playedAt });
    if (run.score > entry.best) entry.best = run.score;
    if (run.playedAt && (!entry.lastPlayed || run.playedAt > entry.lastPlayed)) {
      entry.lastPlayed = run.playedAt;
    }
  }

  // readdir order is not chronological; baselines depend on "last N runs".
  for (const entry of history.values()) {
    entry.runs.sort((a, b) => {
      const at = a.playedAt?.getTime() ?? 0;
      const bt = b.playedAt?.getTime() ?? 0;
      return at - bt;
    });
  }

  return history;
}

/**
 * Compute a scenario's baseline from local history.
 *
 * A thin adapter over `baselineFromScores`, which holds the actual rule and is shared
 * with the server.
 *
 * @param verifiedPb KovaaK's server-side personal best, if known. Supplies the floor.
 */
export function computeBaseline(
  history: ScenarioHistory | undefined,
  verifiedPb?: number,
): Baseline {
  return baselineFromScores(
    history?.scenario ?? "",
    history?.runs.map((r) => r.score) ?? [],
    verifiedPb,
  );
}
