/**
 * Build the Shadow score table from what Season 1 already commits. Nothing is fitted or
 * assumed here; every point is a number the season wrote down for its ranks.
 *
 * Per scenario:
 *
 *   rank thresholds   data/seasons/season-1.json `rankMaxes`: the scores read off the
 *                     scenario's board at the pool ladder's percentiles for the ranks its
 *                     window grades (data/pool.json `ladder.ranks`, cut per window by
 *                     windowRankIndices, exactly as tools/buildSeason.ts cut them). A
 *                     threshold at "top 26%" is the 74th percentile from the bottom.
 *   the board median  data/season-1/families.json `median`: the same predicted board at
 *                     the 50th percentile. The season scales a scenario's whole board by
 *                     its calibration factor before cutting thresholds (scalePoints), so
 *                     the median is scaled by the same `source.factor` to sit on the board
 *                     the thresholds came from. A row whose thresholds came from anything
 *                     else (a real board, an authored number) does not get the predicted
 *                     median, because it would describe a different board.
 *
 * A median that would not sit in order among the thresholds is left out rather than
 * forced in, and the build says how many were.
 *
 * Pure: tools/buildShadowTable.ts reads the files.
 */

import { windowRankIndices } from "../season/windows.ts";
import type { ShadowScoreTable } from "./shadow.ts";

export const SHADOW_TABLE_VERSION = 2;

interface SeasonFile {
  name: string;
  builtAt?: string;
  windowSize?: number;
  scenarios: { scenario: string; window?: number; rankMaxes: number[]; source?: { kind?: string; factor?: number } }[];
}
interface FamiliesFile { scenarios: { scenario: string; median?: number }[] }
interface PoolFile { windowSize: number; ladder: { ranks: number[]; overlap: number } }

export interface ShadowBuild {
  table: ShadowScoreTable;
  /** Scenarios whose median was left out, and why. */
  skippedMedians: { scenario: string; why: string }[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function buildShadowScores(season: SeasonFile, families: FamiliesFile, pool: PoolFile): ShadowBuild {
  const ladder = pool.ladder.ranks;
  const windowSize = season.windowSize ?? pool.windowSize;
  const medians = new Map(families.scenarios.map((f) => [f.scenario, f.median]));
  const scenarios: ShadowScoreTable["scenarios"] = {};
  const skippedMedians: ShadowBuild["skippedMedians"] = [];

  for (const s of season.scenarios) {
    const window = s.window ?? 0;
    const fractions = windowRankIndices(window, windowSize, ladder.length, pool.ladder.overlap).map((i) => ladder[i]);
    if (fractions.length !== s.rankMaxes.length) {
      throw new Error(`${s.scenario}: ${s.rankMaxes.length} thresholds, but window ${window} grades ${fractions.length} ranks`);
    }
    const points: [number, number][] = s.rankMaxes.map((score, i) => [round2(100 * (1 - fractions[i])), score]);

    const kind = s.source?.kind;
    const factor = kind === "calibrated" ? s.source?.factor : kind === "predicted" ? 1 : undefined;
    const median = medians.get(s.scenario);
    if (median == null || factor == null) {
      skippedMedians.push({ scenario: s.scenario, why: median == null ? "no median in families.json" : `thresholds are ${kind ?? "unsourced"}, not the predicted board` });
    } else {
      const point: [number, number] = [50, Math.round(median * factor)];
      const merged = [...points, point].sort((a, b) => a[0] - b[0]);
      const ordered = merged.every((p, i) => i === 0 || (p[0] > merged[i - 1][0] && p[1] >= merged[i - 1][1]));
      if (ordered) points.splice(0, points.length, ...merged);
      else skippedMedians.push({ scenario: s.scenario, why: "the scaled median does not sit in order among the thresholds" });
    }
    points.sort((a, b) => a[0] - b[0]);
    scenarios[s.scenario] = { window, points };
  }

  return {
    table: {
      version: SHADOW_TABLE_VERSION,
      builtAt: season.builtAt ?? "",
      season: season.name,
      scenarios,
      sources: {
        thresholds: "data/seasons/season-1.json rankMaxes, at data/pool.json ladder.ranks cut per window by windowRankIndices",
        median: "data/season-1/families.json median, scaled by the row's source.factor (calibrated rows) as build:season scales the board",
        interpolation: "linear in score against percentile between committed points, as scoreAtTopFraction reads a board; nothing outside them",
      },
    },
    skippedMedians,
  };
}
