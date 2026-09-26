/**
 * Correct predicted thresholds family by family, using one player as a ruler.
 *
 * Every Season 1 threshold is read off a board the difficulty model predicts, and the
 * model's errors are per mechanism: the first playtest had one player maxed on Thread
 * Intermediate and unranked on Orbit Intermediate, at the first of six ranks on skeeTS
 * Novice while at the fourth or better on every other Evasive Novice, and at the third on
 * Gravity Well Novice while maxed on the rest of Dynamic. Nobody's skill is that uneven
 * inside one category and band. The model's is.
 *
 * So a player's bests are read as positions on each family's predicted ladder, and the
 * families are moved toward the median position of their category and band. It corrects
 * how families compare with each other and nothing else: a player who is maxed everywhere
 * stays maxed everywhere, because the median moves with them.
 *
 * WHAT COUNTS AS EVIDENCE
 *
 *   - Only runs on the scenario file as it is now: KovaaK's writes the file's MD5 into
 *     every stats file, so a run on an earlier build of a scenario is simply not used.
 *   - A category and band needs MIN_FAMILIES families with runs before any is moved.
 *     Two families cannot say which of them the model got wrong.
 *   - Each correction is shrunk by n/(n+1) in log terms for n runs behind it, so one
 *     warm-up run moves a family half as far as its evidence says; clamped to CLAMP; and
 *     ignored inside DEADBAND, which is run-to-run noise rather than a mispriced family.
 *
 * WHAT IT PRODUCES
 *
 * One factor per family, applied to every band of it: the model's error is the family's
 * mechanism, which its bands share. The predicted board is multiplied by the factor and
 * cut at the same percentiles, so validate:season-files re-derives every calibrated row to
 * the digit from the model and data/season-1/calibration.json, and the uncalibrated
 * prediction stays on the row beside it.
 *
 * These are seeds, like the predictions they correct. A real board replaces both.
 */

export const MIN_FAMILIES = 3;
export const CLAMP: [number, number] = [0.6, 1.5];
export const DEADBAND = 0.05;

export interface CalibrationInput {
  scenario: string;
  category: string;
  family: string;
  window: number;
  /** The uncalibrated prediction, so re-running calibration never compounds. */
  predicted: number[];
  best: number;
  runs: number;
}

export interface FamilyCalibration {
  factor: number;
  /** Before shrinkage, clamp and deadband. */
  raw: number;
  runs: number;
  evidence: Array<{ scenario: string; runs: number; best: number; position: number; target: number; k: number }>;
}

export interface Calibration {
  about: string;
  builtAt: string;
  rules: { minFamilies: number; clamp: [number, number]; deadband: number };
  families: Record<string, FamilyCalibration>;
}

/**
 * Where a score sits on a ladder, continuously: 0 at the first threshold, 1 at the second,
 * and so on, straight-line between them, and extended past either end by the ladder's
 * mean step, so a score beyond the top still says how far beyond.
 *
 * The mean step and not the nearest one: top thresholds are cut close together, and
 * extending by the last step put a player slightly past the top of Stutter Novice at
 * position 13 on a six-rank ladder, which the median then treated as a real place.
 */
export function position(score: number, t: number[]): number {
  if (t.length === 1) return score / t[0] - 1;
  const n = t.length - 1;
  const mean = (t[n] - t[0]) / n;
  if (score <= t[0]) return (score - t[0]) / mean;
  for (let i = 0; i < n; i++) {
    if (score <= t[i + 1]) return i + (score - t[i]) / (t[i + 1] - t[i]);
  }
  return n + (score - t[n]) / mean;
}

/** The score at a position: the inverse of `position`. */
export function scoreAt(p: number, t: number[]): number {
  if (t.length === 1) return t[0] * (1 + p);
  const n = t.length - 1;
  const mean = (t[n] - t[0]) / n;
  if (p <= 0) return t[0] + p * mean;
  if (p >= n) return t[n] + (p - n) * mean;
  const i = Math.floor(p);
  return t[i] + (p - i) * (t[i + 1] - t[i]);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

export function calibrate(inputs: CalibrationInput[]): Record<string, FamilyCalibration> {
  const groups = new Map<string, CalibrationInput[]>();
  for (const x of inputs) {
    const key = `${x.category}\u0000${x.window}`;
    groups.set(key, [...(groups.get(key) ?? []), x]);
  }

  const perFamily = new Map<string, FamilyCalibration["evidence"]>();
  for (const group of groups.values()) {
    if (new Set(group.map((x) => x.family)).size < MIN_FAMILIES) continue;
    const target = median(group.map((x) => position(x.best, x.predicted)));
    for (const x of group) {
      const at = scoreAt(target, x.predicted);
      if (!(at > 0)) continue;
      const k = x.best / at;
      perFamily.set(x.family, [
        ...(perFamily.get(x.family) ?? []),
        { scenario: x.scenario, runs: x.runs, best: x.best, position: round(position(x.best, x.predicted), 3), target: round(target, 3), k: round(k, 4) },
      ]);
    }
  }

  const out: Record<string, FamilyCalibration> = {};
  for (const [family, evidence] of perFamily) {
    // Bands weighted by the runs behind them, in log space.
    const runs = evidence.reduce((n, e) => n + e.runs, 0);
    const logRaw = evidence.reduce((s, e) => s + e.runs * Math.log(e.k), 0) / runs;
    const shrunk = logRaw * (runs / (runs + 1));
    let factor = Math.min(CLAMP[1], Math.max(CLAMP[0], Math.exp(shrunk)));
    if (Math.abs(Math.log(factor)) < Math.log(1 + DEADBAND)) factor = 1;
    out[family] = { factor: round(factor, 4), raw: round(Math.exp(logRaw), 4), runs, evidence };
  }
  return out;
}

/** A predicted board with every score multiplied by `factor`. */
export function scalePoints<T extends { score: number }>(points: T[], factor: number): T[] {
  return points.map((p) => ({ ...p, score: p.score * factor }));
}
