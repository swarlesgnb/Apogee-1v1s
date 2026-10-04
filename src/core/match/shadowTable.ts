/**
 * Build the table Shadows are fielded from: quantiles of genuine three-scenario days.
 *
 * Two ways to build it, and the JSON says which one it holds (`method`):
 *
 *   CORPUS  Replay a real stats folder. For every play day and every scenario that had at
 *           least MIN_RUNS_FOR_BASELINE runs on earlier days, the first run of the day is
 *           scored against baselineFromScores over those earlier runs: the same rule a
 *           ranked match uses, less the verified-PB floor, which lives server-side. Each
 *           day's rounds in one skill are drawn into a seeded 1-, 2- and 3-round match, and
 *           the quantiles are read off the means. This is the honest source, and it needs
 *           the owner's folder, which this repository does not carry.
 *
 *   MODEL   What ships until somebody runs CORPUS on a real folder. A normal distribution
 *           per skill and round count, every parameter read from a committed measurement:
 *
 *             centre       +0.4%, the mean delta of genuine runs under the median baseline
 *                          rule, measured over 156 scenarios (src/core/history/baseline.ts).
 *             day spread   the 10th and 90th percentiles of genuine three-scenario days
 *                          scored against a near-baseline reference: the "trailing 7-day
 *                          median" row of docs/overnight/mechanics.md, 199 days of real
 *                          first-runs-of-the-day, -5.6% / +5.8%.
 *             round noise  per skill, the median run-to-run change over median score on
 *                          every scenario with 10 or more local runs in data/fun_audit.json
 *                          (87 scenarios). It sets how the skills differ from each other and
 *                          how much a single round spreads compared with a three-round mean.
 *
 *           The day spread is the anchor because it is the only committed number measured on
 *           three-scenario days rather than single runs. Its reference was a 7-day median
 *           rather than the baseline, which adds a little noise of its own, so the model is
 *           slightly wider than the truth: high Shadows slightly harder and low ones slightly
 *           easier than they would be on a corpus build. The validator prints the size of that.
 *
 * Pure: the caller reads the files. tools/buildShadowTable.ts is the command.
 */

import { baselineFromScores, MIN_RUNS_FOR_BASELINE } from "../history/baseline.ts";
import { seededRandom } from "./scenarioSelection.ts";
import { SHADOW_SKILLS, type ShadowQuantiles, type ShadowSkill, type ShadowTable } from "./shadow.ts";

export const SHADOW_TABLE_VERSION = 1;
export const PERCENTILES = Array.from({ length: 99 }, (_, i) => i + 1);

/** median |X - Y| for X, Y independent N(0, s^2) is s * sqrt(2) * 0.67449. */
export const CONSECUTIVE_MEDIAN_FACTOR = Math.SQRT2 * 0.6744897501960817;
/** z at the 90th percentile. */
const Z90 = 1.2815515655446004;

/** Acklam's rational approximation to the standard normal quantile; |error| < 1.2e-9. */
export function inverseNormal(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`inverseNormal needs 0 < p < 1, got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -inverseNormal(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------------------------------------------------------------------------
// MODEL
// ---------------------------------------------------------------------------

export interface ModelInputs {
  centre: number;
  dayP10: number;
  dayP90: number;
  /** Median run-to-run change over median score, per skill. */
  roundNoise: Record<ShadowSkill, number>;
  /** Scenarios behind each noise figure. */
  noiseScenarios: Record<ShadowSkill, number>;
  sources: Record<string, string>;
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The baseline rule's measured centre, from the table in baseline.ts's header. */
export function centreFromBaselineDoc(source: string): number {
  const row = /^\s*\*\s+median\s+([+−-]?\d+(?:\.\d+)?)%/m.exec(source);
  if (!row) throw new Error("baseline.ts no longer states the median rule's mean delta");
  return Number(row[1].replace("−", "-")) / 100;
}

/** The trailing 7-day median row of the ghost table: p10 / p50 / p90 margins. */
export function daySpreadFromMechanicsDoc(source: string): { p10: number; p50: number; p90: number; days: number } {
  const row = /\|\s*trailing 7-day median\s*\|\s*(\d+)\s*\|[^|]*\|\s*([+−-]?\d+(?:\.\d+)?)%\s*\/\s*([+−-]?\d+(?:\.\d+)?)%\s*\/\s*([+−-]?\d+(?:\.\d+)?)%\s*\|/.exec(source);
  if (!row) throw new Error("docs/overnight/mechanics.md no longer carries the trailing 7-day median row");
  const n = (s: string) => Number(s.replace("−", "-")) / 100;
  return { days: Number(row[1]), p10: n(row[2]), p50: n(row[3]), p90: n(row[4]) };
}

interface FunAudit {
  families: { category: string; rungs: { scenario: string; noise: number | null; localRuns: number }[] }[];
}

/** Per-skill round noise: every scenario with at least `minRuns` local runs, counted once. */
export function noiseFromFunAudit(audit: FunAudit, minRuns = 10): { noise: Record<ShadowSkill, number>; scenarios: Record<ShadowSkill, number> } {
  const by: Record<ShadowSkill, number[]> = { All: [], Clicking: [], Tracking: [], Switching: [] };
  const seen = new Set<string>();
  for (const family of audit.families) {
    const skill = family.category.split(" ").pop() as ShadowSkill;
    for (const rung of family.rungs) {
      if (rung.noise == null || rung.localRuns < minRuns || seen.has(rung.scenario)) continue;
      seen.add(rung.scenario);
      by.All.push(rung.noise);
      if (skill in by && skill !== "All") by[skill].push(rung.noise);
    }
  }
  const noise = {} as Record<ShadowSkill, number>;
  const scenarios = {} as Record<ShadowSkill, number>;
  for (const skill of SHADOW_SKILLS) {
    if (by[skill].length < 5) throw new Error(`fun_audit.json has ${by[skill].length} measured ${skill} scenarios; need 5`);
    noise[skill] = median(by[skill]);
    scenarios[skill] = by[skill].length;
  }
  return { noise, scenarios };
}

export function modelInputs(baselineSource: string, mechanicsSource: string, audit: FunAudit): ModelInputs {
  const day = daySpreadFromMechanicsDoc(mechanicsSource);
  const { noise, scenarios } = noiseFromFunAudit(audit);
  return {
    centre: centreFromBaselineDoc(baselineSource),
    dayP10: day.p10,
    dayP90: day.p90,
    roundNoise: noise,
    noiseScenarios: scenarios,
    sources: {
      centre: "src/core/history/baseline.ts header: median rule, mean delta over 156 scenarios",
      daySpread: `docs/overnight/mechanics.md ghost table, trailing 7-day median row: ${day.days} genuine three-scenario days`,
      roundNoise: "data/fun_audit.json: median run-to-run change over median score, scenarios with 10+ local runs",
    },
  };
}

/** The spreads the model implies, for the table's `inputs` and for the validator. */
export function modelSpreads(inputs: ModelInputs): {
  day3: number;
  correlation: number;
  sigma: Record<ShadowSkill, [number, number, number]>;
} {
  const day3 = (inputs.dayP90 - inputs.dayP10) / (2 * Z90);
  const round1All = inputs.roundNoise.All / CONSECUTIVE_MEDIAN_FACTOR;
  // How strongly one day's rounds move together, implied by a three-round spread that is
  // more than a third of the single-round variance. Clamped to what a correlation can be.
  const ratio = day3 / round1All;
  const correlation = Math.min(1, Math.max(0, (3 * ratio * ratio - 1) / 2));
  const sigma = {} as Record<ShadowSkill, [number, number, number]>;
  for (const skill of SHADOW_SKILLS) {
    const round1 = inputs.roundNoise[skill] / CONSECUTIVE_MEDIAN_FACTOR;
    sigma[skill] = [1, 2, 3].map((k) => round1 * Math.sqrt((1 + (k - 1) * correlation) / k)) as [number, number, number];
  }
  return { day3, correlation, sigma };
}

export function modelTable(inputs: ModelInputs, builtAt: string): ShadowTable {
  const { day3, correlation, sigma } = modelSpreads(inputs);
  const skills = {} as Record<ShadowSkill, ShadowQuantiles>;
  for (const skill of SHADOW_SKILLS) {
    const column = (k: number) => PERCENTILES.map((p) => round5(inputs.centre + sigma[skill][k - 1] * inverseNormal(p / 100)));
    skills[skill] = { k1: column(1), k2: column(2), k3: column(3), n: null };
  }
  return {
    version: SHADOW_TABLE_VERSION,
    method: "model",
    builtAt,
    percentiles: PERCENTILES,
    skills,
    inputs: {
      ...inputs,
      daySpreadSigma: round5(day3),
      impliedCorrelation: round5(correlation),
      sigma: Object.fromEntries(SHADOW_SKILLS.map((s) => [s, sigma[s].map(round5)])),
    },
  };
}

// ---------------------------------------------------------------------------
// CORPUS
// ---------------------------------------------------------------------------

export type RoundSkill = Exclude<ShadowSkill, "All">;

export interface DayRounds {
  day: string;
  skill: RoundSkill;
  /** First run of the day on each scenario, as a delta over the baseline from earlier days. */
  deltas: number[];
}

interface HistoryLike {
  runs: { score: number; playedAt: Date | null }[];
}

export const localDayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Every genuine round a corpus holds, grouped by play day and skill.
 *
 * A delta beyond +-100% is dropped as unreadable rather than kept as a tail: it is a
 * scenario whose scoring changed under the same name, not a day.
 */
export function corpusDays(
  history: Map<string, HistoryLike>,
  skillOfScenario: (name: string) => RoundSkill | null,
  dayKey: (d: Date) => string = localDayKey,
): DayRounds[] {
  const groups = new Map<string, DayRounds>();
  for (const [name, h] of history) {
    const skill = skillOfScenario(name);
    if (!skill) continue;
    const runs = h.runs.filter((r) => r.playedAt && Number.isFinite(r.score) && r.score > 0)
      .sort((a, b) => a.playedAt!.getTime() - b.playedAt!.getTime());
    const earlier: number[] = [];
    let i = 0;
    while (i < runs.length) {
      const key = dayKey(runs[i].playedAt!);
      let j = i;
      while (j < runs.length && dayKey(runs[j].playedAt!) === key) j++;
      if (earlier.length >= MIN_RUNS_FOR_BASELINE) {
        const base = baselineFromScores(name, earlier).value;
        const delta = base > 0 ? (runs[i].score - base) / base : NaN;
        if (Number.isFinite(delta) && Math.abs(delta) <= 1) {
          const gk = `${key}|${skill}`;
          let g = groups.get(gk);
          if (!g) groups.set(gk, (g = { day: key, skill, deltas: [] }));
          g.deltas.push(delta);
        }
      }
      for (let r = i; r < j; r++) earlier.push(runs[r].score);
      i = j;
    }
  }
  return [...groups.values()].sort((a, b) => (a.day + a.skill).localeCompare(b.day + b.skill));
}

/** Linear-interpolated quantiles at 1..99. */
export function quantilesOf(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  return PERCENTILES.map((p) => {
    const i = (s.length - 1) * (p / 100);
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return round5(lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo));
  });
}

/** Days a skill needs before its own column is trusted over the pooled one. */
export const MIN_CORPUS_DAYS = 40;

export function corpusTable(days: DayRounds[], builtAt: string, seed = "shadow-corpus", minDays = MIN_CORPUS_DAYS): ShadowTable {
  const random = seededRandom(seed);
  const pick = (deltas: number[], k: number): number => {
    const pool = [...deltas];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, k).reduce((a, b) => a + b, 0) / k;
  };

  // "All" pools a day's rounds across skills, the way an Any queue draws.
  const byDay = new Map<string, number[]>();
  for (const d of days) byDay.set(d.day, [...(byDay.get(d.day) ?? []), ...d.deltas]);

  const groupsFor = (skill: ShadowSkill): number[][] =>
    skill === "All" ? [...byDay.values()] : days.filter((d) => d.skill === skill).map((d) => d.deltas);

  const skills = {} as Record<ShadowSkill, ShadowQuantiles>;
  const counts: Record<string, number[]> = {};
  for (const skill of SHADOW_SKILLS) {
    const groups = groupsFor(skill);
    const k1 = groups.flat();
    const k2 = groups.filter((g) => g.length >= 2).map((g) => pick(g, 2));
    const k3 = groups.filter((g) => g.length >= 3).map((g) => pick(g, 3));
    counts[skill] = [k1.length, k2.length, k3.length];
    if (k3.length < minDays) continue;
    skills[skill] = { k1: quantilesOf(k1), k2: quantilesOf(k2), k3: quantilesOf(k3), n: k3.length };
  }
  if (!skills.All) {
    throw new Error(`the corpus has ${counts.All?.[2] ?? 0} three-scenario days; ${minDays} are needed for a table`);
  }
  for (const skill of SHADOW_SKILLS) {
    if (!skills[skill]) skills[skill] = { ...skills.All, borrowedFrom: "All" };
  }
  return {
    version: SHADOW_TABLE_VERSION,
    method: "corpus",
    builtAt,
    percentiles: PERCENTILES,
    skills,
    inputs: {
      sources: { corpus: "a KovaaK's stats folder, replayed by corpusDays (first run of each day against the baseline from earlier days)" },
      samples: counts,
      minDays,
      seed,
    },
  };
}

function round5(v: number): number {
  return Math.round(v * 100000) / 100000;
}
