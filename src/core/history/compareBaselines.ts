/**
 * Compare candidate baseline definitions against real play.
 *
 * The baseline is the centre every match is measured from, so its distribution decides
 * how matches feel. Two properties are wanted at once, and they pull against each
 * other:
 *
 *   CENTRED    a typical run should sit near 0%, so a good day is +x% and a bad day is
 *              -x%. If the centre is wrong, matches stop being "who played better
 *              today" and become "who avoided a disaster".
 *
 *   UNGAMEABLE deliberately playing badly must not drag the baseline down (PLAN.md §3).
 *
 * The shipped definition (mean of the top 30% of recent runs) is maximally
 * ungameable, but this measures whether it is also badly off-centre.
 *
 *   npx tsx src/core/history/compareBaselines.ts [statsFolder]
 */

import { scanStatsFolder, type ScenarioHistory } from "./history.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const WINDOW = 50;
const PB_FLOOR = 0.9;

type Definition = {
  name: string;
  note: string;
  compute: (recent: number[], verifiedPb: number) => number;
};

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function topFraction(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => b - a);
  const take = Math.max(1, Math.round(sorted.length * fraction));
  return mean(sorted.slice(0, take));
}

const DEFINITIONS: Definition[] = [
  {
    name: "top30% (shipped)",
    note: "mean of the best 30% of recent runs",
    compute: (recent, pb) => Math.max(topFraction(recent, 0.3), pb * PB_FLOOR),
  },
  {
    name: "median",
    note: "median of recent runs, floored at 0.9x verified PB",
    compute: (recent, pb) =>
      Math.max(quantile([...recent].sort((a, b) => a - b), 0.5), pb * PB_FLOOR),
  },
  {
    name: "mean",
    note: "plain mean of recent runs, floored at 0.9x verified PB",
    compute: (recent, pb) => Math.max(mean(recent), pb * PB_FLOOR),
  },
  {
    name: "top60%",
    note: "mean of the best 60% of recent runs, floored",
    compute: (recent, pb) => Math.max(topFraction(recent, 0.6), pb * PB_FLOOR),
  },
];

interface Stats {
  n: number;
  mean: number;
  p05: number;
  p50: number;
  p95: number;
  aboveZero: number;
  /** How far a bad day reaches versus a good day. 1.0 is symmetric. */
  symmetry: number;
}

function summarise(deltas: number[]): Stats {
  const sorted = [...deltas].sort((a, b) => a - b);
  const p05 = quantile(sorted, 0.05);
  const p50 = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  return {
    n: deltas.length,
    mean: mean(deltas),
    p05,
    p50,
    p95,
    aboveZero: deltas.filter((d) => d > 0).length / deltas.length,
    symmetry: Math.abs(p95 - p50) / Math.max(1e-9, Math.abs(p50 - p05)),
  };
}

/**
 * Simulate sandbagging: the player deliberately posts a run at 60% of their usual
 * level, repeatedly, and we measure how far the baseline sinks. A definition that
 * lets the baseline fall a long way is one that rewards tanking.
 */
function sandbagDrop(def: Definition, recent: number[], verifiedPb: number): number {
  const honest = def.compute(recent, verifiedPb);
  const typical = quantile([...recent].sort((a, b) => a - b), 0.5);

  // Ten deliberately bad runs appended to the window.
  const tanked = [...recent, ...new Array(10).fill(typical * 0.6)].slice(-WINDOW);
  const gamed = def.compute(tanked, verifiedPb);

  return (honest - gamed) / honest;
}

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;
  const history = scanStatsFolder(dir);

  const usable: ScenarioHistory[] = [...history.values()].filter(
    (h) => h.runs.length >= 20,
  );

  console.log(`scenarios with >=20 runs : ${usable.length}\n`);
  if (usable.length === 0) {
    console.error("not enough history to compare");
    process.exit(1);
  }

  console.log(
    "definition          n      mean     p05     p50     p95   >0%   symmetry  sandbag",
  );

  for (const def of DEFINITIONS) {
    const deltas: number[] = [];
    const drops: number[] = [];

    for (const h of usable) {
      const scores = h.runs.map((r) => r.score);
      // Walk forward: baseline from history to date, then score the next run against
      // it. Using the whole history including the run itself would leak the future.
      for (let i = WINDOW; i < scores.length; i++) {
        const recent = scores.slice(Math.max(0, i - WINDOW), i);
        if (recent.length < 10) continue;
        const pb = Math.max(...recent);
        const baseline = def.compute(recent, pb);
        if (baseline <= 0) continue;
        deltas.push((scores[i] - baseline) / baseline);
      }

      const tail = scores.slice(-WINDOW);
      if (tail.length >= 20) drops.push(sandbagDrop(def, tail, Math.max(...tail)));
    }

    if (deltas.length === 0) continue;
    const s = summarise(deltas);
    const worstDrop = Math.max(...drops);

    console.log(
      `${def.name.padEnd(19)} ${String(s.n).padStart(5)} ` +
        `${(s.mean * 100).toFixed(1).padStart(7)}% ` +
        `${(s.p05 * 100).toFixed(1).padStart(6)}% ` +
        `${(s.p50 * 100).toFixed(1).padStart(6)}% ` +
        `${(s.p95 * 100).toFixed(1).padStart(6)}% ` +
        `${(s.aboveZero * 100).toFixed(0).padStart(4)}% ` +
        `${s.symmetry.toFixed(2).padStart(9)} ` +
        `${(worstDrop * 100).toFixed(1).padStart(7)}%`,
    );
  }

  console.log(
    "\nsymmetry 1.00 = a good day reaches as far above the centre as a bad day\n" +
      "reaches below. sandbag = how far ten deliberately bad runs move the baseline;\n" +
      "lower is harder to game.",
  );
}

main();
