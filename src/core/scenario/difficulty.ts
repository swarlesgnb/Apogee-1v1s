/**
 * Predict a scenario's leaderboard from its file.
 *
 * Season 2's scenarios are new, so no board exists to cut their thresholds from. What
 * does exist is some five hundred scenarios with both a file and a sampled board, and on
 * those the physics of a scenario explains a useful share of where its board lands. This
 * learns that relation and applies it: a prediction of what the board of an unplayed
 * scenario will look like once people play it, which is what a threshold needs.
 *
 * Scores are not comparable across scenarios - ten points a kill here, one a hit there -
 * so every score is first turned into a quantity a player produces, in units that mean the
 * same thing everywhere:
 *
 *   click    seconds per kill: timelimit / (score / points per kill). Fitts' law predicts
 *            its logarithm is linear in the index of difficulty of the flick, and on the
 *            static-clicking scenarios measured it is (see `fit` evidence).
 *   track    the share of the maximum score earned, as a logit, for a gun that fires while
 *            held on one target. The maximum is every tick of the run landing.
 *   switch   the same share, with several targets alive.
 *
 * One least-squares fit per class and per sampled board fraction, on features chosen in
 * `features.ts`. Each class's fit carries its leave-one-out error, measured the way it
 * will be used - predicting a scenario the fit did not see - and `predictLadder` hands that
 * error back with every prediction, because a threshold seeded from a model is a guess of
 * known size and the season says so.
 *
 * What is left out, and why: a population term. Harder variants of a family draw stronger
 * crowds, so their boards sit higher than their physics alone predicts. Predicting a
 * variant from a sibling's board, which would carry the crowd with it, was measured as
 * well (`tools/fitDifficulty.ts` records it beside the pooled error): it is about as good,
 * not clearly better, and a season-2 scenario has no sibling with a board anyway.
 */

import type { ScenarioFeatures } from "./features.ts";

export type DifficultyClass = "click" | "track" | "switch";

export const FRACTIONS = [
  0.001, 0.005, 0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 0.95,
];

/** The class a scenario's scoring puts it in, or null when no class describes it. */
export function classify(f: ScenarioFeatures): DifficultyClass | null {
  const w = f.weapon;
  const s = f.scoring;
  if (!w || !f.geometry || !f.targets.length || f.multipliers.adaptive) return null;
  if (f.timelimit <= 0 || f.timelimit > 200 || s.perTime !== 0) return null;
  // Pressure scenarios refill the clock, so a board of them measures survival, not rate.
  if (s.timeRefilledByKill > 0) return null;
  // Targets that lose health on their own despawn: a pressure scenario, where the board
  // measures how many were caught before they vanished rather than how fast each fell.
  const expiring = f.targets.some((t) => t.regenPerSec < 0);
  if (w.fullyAutomatic === false && s.perKill > 0 && s.perDamage === 0 && s.perHit === 0) {
    if (expiring) return null;
    return f.derived.fittsIdNearest !== null && f.derived.targetDeg ? "click" : null;
  }
  if (w.fullyAutomatic && w.interval > 0 && w.interval <= 0.06 && s.perKill === 0 && (s.perHit > 0 || s.perDamage > 0)) {
    if (!f.derived.targetDeg) return null;
    if (f.concurrent <= 1.01) return "track";
    return f.derived.fittsIdNearest !== null ? "switch" : null;
  }
  return null;
}

/** The most a run could score, for the two share-of-maximum classes. */
function maxScore(f: ScenarioFeatures): number {
  const w = f.weapon!;
  return (f.timelimit / w.interval) * (f.scoring.perHit + f.scoring.perDamage * w.damage);
}

/**
 * Accuracy-multiplied scores undo to the underlying share: with a plain multiplier the
 * score is share squared, with the square-root one it is share to the 3/2.
 */
function unAccuracy(f: ScenarioFeatures, share: number): number {
  if (!f.scoring.accuracyMult) return share;
  return f.scoring.sqrtAccuracy ? Math.pow(share, 2 / 3) : Math.sqrt(share);
}
function reAccuracy(f: ScenarioFeatures, share: number): number {
  if (!f.scoring.accuracyMult) return share;
  return f.scoring.sqrtAccuracy ? Math.pow(share, 3 / 2) : share * share;
}

const logit = (p: number) => Math.log(p / (1 - p));
const expit = (x: number) => 1 / (1 + Math.exp(-x));

/** Score -> the class's comparable quantity. Null where it has none (a zero score). */
export function toMetric(cls: DifficultyClass, f: ScenarioFeatures, score: number): number | null {
  if (!(score > 0)) return null;
  if (cls === "click") {
    const kills = score / f.scoring.perKill;
    return Math.log(f.timelimit / kills);
  }
  const share = unAccuracy(f, score / maxScore(f));
  if (!(share > 0.005 && share < 0.995)) return null;
  return logit(share);
}

export function fromMetric(cls: DifficultyClass, f: ScenarioFeatures, metric: number): number {
  if (cls === "click") return (f.timelimit / Math.exp(metric)) * f.scoring.perKill;
  return reAccuracy(f, expit(metric)) * maxScore(f);
}

export const FEATURE_NAMES: Record<DifficultyClass, string[]> = {
  click: ["fitts ID of the nearest flick", "log(1 + angular speed)", "log(shots to kill)"],
  track: ["log(angular speed / size)", "log(size)", "log(strafe period)", "leaves the ground", "log(seconds to full speed)"],
  switch: ["log(angular speed / size)", "fitts ID of the nearest flick", "log(time to kill)"],
};

/** The regressors, in FEATURE_NAMES order. */
export function featureVector(cls: DifficultyClass, f: ScenarioFeatures): number[] {
  const d = f.derived;
  const main = f.targets[0];
  const speed = Math.max(d.angularSpeed ?? 0, 1);
  if (cls === "click") {
    return [d.fittsIdNearest ?? 0, Math.log1p(d.angularSpeed ?? 0), Math.log(Math.max(1, d.shotsToKill ?? 1))];
  }
  if (cls === "track") {
    const airborne = main.flyer || ((main.jumpFrequency ?? 0) > 0 && main.jumpVelocity > 0) ? 1 : 0;
    // How sharply it turns: a target that takes a third of a second to reach speed reverses
    // in a curve a player can follow, one that takes a hundredth reverses in a corner.
    // Clamped because a zero acceleration in a file means "instant" to some templates.
    const ramp = main.acceleration > 0 ? main.speed / main.acceleration : 0.01;
    return [Math.log(speed / d.targetDeg!), Math.log(d.targetDeg!), Math.log(d.strafePeriod ?? 1), airborne, Math.log(Math.min(5, Math.max(0.01, ramp)))];
  }
  return [Math.log(speed / d.targetDeg!), d.fittsIdNearest ?? 0, Math.log(Math.max(d.ttk ?? 0, 0.02))];
}

// ---- least squares ------------------------------------------------------------------------

/** Solve (XᵀX + λI) b = Xᵀy. The ridge is tiny and there only to survive a singular column. */
export function leastSquares(X: number[][], y: number[], ridge = 1e-6): number[] {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let r = 0; r < X.length; r++) {
    for (let i = 0; i < k; i++) {
      b[i] += X[r][i] * y[r];
      for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j];
    }
  }
  for (let i = 1; i < k; i++) A[i][i] += ridge;
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < k; r++) {
      const m = A[r][c] / A[c][c];
      for (let j = c; j < k; j++) A[r][j] -= m * A[c][j];
      b[r] -= m * b[c];
    }
  }
  const x = new Array<number>(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < k; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

const withIntercept = (v: number[]) => [1, ...v];
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

export interface FractionFit {
  topFraction: number;
  coefficients: number[];
  n: number;
  /** Leave-one-out residuals' absolute median and 90th percentile, in metric units. */
  looMedian: number;
  loo90: number;
}

export interface ClassModel {
  class: DifficultyClass;
  features: string[];
  fits: FractionFit[];
  /** The scenarios the fit learned from, so a claim about it can be re-derived. */
  scenarios: string[];
}

export interface Sample {
  name: string;
  features: ScenarioFeatures;
  ladder: Array<{ topFraction: number; score: number }>;
}

function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo);
}

export function fitClass(cls: DifficultyClass, samples: Sample[]): ClassModel {
  const mine = samples.filter((s) => classify(s.features) === cls);
  const fits: FractionFit[] = [];
  for (const topFraction of FRACTIONS) {
    const X: number[][] = [];
    const y: number[] = [];
    for (const s of mine) {
      const point = s.ladder.find((p) => Math.abs(p.topFraction - topFraction) < 1e-9);
      const m = point ? toMetric(cls, s.features, point.score) : null;
      if (m === null || !Number.isFinite(m)) continue;
      X.push(withIntercept(featureVector(cls, s.features)));
      y.push(m);
    }
    const coefficients = leastSquares(X, y);
    const residuals: number[] = [];
    for (let i = 0; i < X.length; i++) {
      const b = leastSquares(X.filter((_, j) => j !== i), y.filter((_, j) => j !== i));
      residuals.push(Math.abs(dot(X[i], b) - y[i]));
    }
    fits.push({ topFraction, coefficients, n: X.length, looMedian: quantile(residuals, 0.5), loo90: quantile(residuals, 0.9) });
  }
  return { class: cls, features: FEATURE_NAMES[cls], fits, scenarios: mine.map((s) => s.name).sort() };
}

export interface Prediction {
  class: DifficultyClass;
  points: Array<{ topFraction: number; score: number; low: number; high: number }>;
}

/**
 * The board a scenario is predicted to have, with the band a leave-one-out median error
 * puts around each point. Forced to fall as the fraction grows, the same repair the
 * sampler applies to a real board.
 */
export function predictLadder(model: ClassModel, f: ScenarioFeatures): Prediction {
  const x = withIntercept(featureVector(model.class, f));
  const points = model.fits.map((fit) => {
    const m = dot(x, fit.coefficients);
    // For clicking a larger metric is a slower kill, so the low score comes from +error.
    const sign = model.class === "click" ? -1 : 1;
    const a = fromMetric(model.class, f, m - sign * fit.looMedian);
    const b = fromMetric(model.class, f, m + sign * fit.looMedian);
    return { topFraction: fit.topFraction, score: fromMetric(model.class, f, m), low: Math.min(a, b), high: Math.max(a, b) };
  });
  for (let i = 1; i < points.length; i++) {
    if (points[i].score > points[i - 1].score) points[i].score = points[i - 1].score;
  }
  return { class: model.class, points };
}
