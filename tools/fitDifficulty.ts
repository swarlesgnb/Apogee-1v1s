/**
 * Fit the difficulty model and write the evidence behind it.
 *
 * Reads every scenario file on this machine through `scenarioCorpus`, keeps the ones with a
 * sampled board, fits `core/scenario/difficulty.ts` per class, and writes
 * `data/season-1/difficulty_model.json`: coefficients, leave-one-out error at every board
 * fraction, and the names of the scenarios each class learned from.
 *
 * It also re-measures the alternative that was rejected - predicting a variant from a
 * sibling's board, scaled by the same physics - so the reason for pooling stays a number
 * anyone can regenerate rather than a sentence.
 *
 *   npx tsx tools/fitDifficulty.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { buildCorpus, kovaaksRoot } from "./scenarioCorpus.ts";
import {
  classify,
  featureVector,
  fitClass,
  toMetric,
  type ClassModel,
  type DifficultyClass,
  type Sample,
} from "../src/core/scenario/difficulty.ts";

const root = kovaaksRoot();
if (!root) {
  console.error("No KovaaK's install found; the model is fitted from the scenario files it holds.");
  process.exit(1);
}

const samples: Sample[] = buildCorpus(root)
  .filter((r) => r.ladder && r.ladder.total >= 500)
  .map((r) => ({ name: r.name, features: r, ladder: r.ladder!.points }));

const classes: DifficultyClass[] = ["click", "track", "switch"];
const models: ClassModel[] = classes.map((c) => fitClass(c, samples));

/**
 * The rejected alternative. Variants are grouped by the name with difficulty words and
 * size percentages removed, and each is predicted from each sibling: the sibling's own
 * metric at the median, moved by the pooled slope times the feature difference.
 */
const DIFFICULTY_WORDS =
  /\b(easy|easier|entry|novice|int|intermediate|adv|advanced|hard|harder|medium|small|smaller|larger|bigger|slightly|extra|elite|goated|slow|slower|fast|faster|\d+%|v\d+|s\d+)\b/gi;
function siblingTest(model: ClassModel): { pairs: number; median: number; pooledMedian: number } {
  const median = model.fits.find((f) => f.topFraction === 0.5)!;
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    if (classify(s.features) !== model.class) continue;
    const stem = s.name.toLowerCase().replace(DIFFICULTY_WORDS, " ").replace(/\s+/g, " ").trim();
    groups.set(stem, [...(groups.get(stem) ?? []), s]);
  }
  const errors: number[] = [];
  const metricAt = (s: Sample) => {
    const p = s.ladder.find((q) => q.topFraction === 0.5);
    return p ? toMetric(model.class, s.features, p.score) : null;
  };
  for (const group of groups.values()) {
    for (const a of group) {
      for (const b of group) {
        if (a === b) continue;
        const ma = metricAt(a);
        const mb = metricAt(b);
        if (ma === null || mb === null) continue;
        const xa = featureVector(model.class, a.features);
        const xb = featureVector(model.class, b.features);
        const shift = xb.reduce((s, v, i) => s + (v - xa[i]) * median.coefficients[i + 1], 0);
        errors.push(Math.abs(ma + shift - mb));
      }
    }
  }
  errors.sort((p, q) => p - q);
  return { pairs: errors.length, median: errors[Math.floor(errors.length / 2)] ?? NaN, pooledMedian: median.looMedian };
}

/**
 * Ablation: each feature removed in turn, leave-one-out error at the top 5% and the median.
 * A feature whose removal does not raise the error is not earning its place.
 */
const ablation = models.map((m) => {
  const at = (model: ClassModel, q: number) => model.fits.find((f) => f.topFraction === q)!.looMedian;
  return {
    class: m.class,
    full: { top5: at(m, 0.05), median: at(m, 0.5) },
    without: m.features.map((feature, i) => {
      const reduced = fitClass(m.class, samples, i, [0.05, 0.5]);
      return { feature, top5: at(reduced, 0.05), median: at(reduced, 0.5) };
    }),
  };
});

const evidence = models.map((m) => ({ class: m.class, sibling: siblingTest(m) }));

/**
 * Flying tracking targets as a group: is the fit biased on them? Voltaic's Aether is
 * over-predicted at every tier; whether that is Aether or flying decides whether anything
 * should be corrected. Recorded so the answer is re-derived, not remembered.
 */
const tracking = models.find((m) => m.class === "track")!;
const flierMisses = samples
  .filter((s) => s.features.targets[0]?.flyer && tracking.residualsAtMedian?.[s.name] !== undefined)
  .map((s) => tracking.residualsAtMedian![s.name]);
const mean = flierMisses.reduce((a, v) => a + v, 0) / Math.max(1, flierMisses.length);
const fliers = {
  n: flierMisses.length,
  meanMiss: Math.round(mean * 1000) / 1000,
  spread: Math.round(Math.sqrt(flierMisses.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, flierMisses.length)) * 1000) / 1000,
  overPredicted: flierMisses.filter((v) => v > 0).length,
};

const out = dataFile("season-1", "difficulty_model.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      $comment:
        "Written by tools/fitDifficulty.ts; do not hand-edit. One least-squares fit per class and board fraction; looMedian/loo90 are leave-one-out absolute errors in the class's metric (click: log seconds per kill, so 0.1 is about 10%; track and switch: logit of the share of the maximum score, where 0.4 is about 10 points of share near the middle). `sibling` is the rejected alternative, measured at the median.",
      fittedAt: new Date().toISOString(),
      scenarioFiles: samples.length,
      models,
      sibling: evidence,
      ablation,
      fliers,
    },
    null,
    1,
  ) + "\n",
);

for (const m of models) {
  const at = (q: number) => m.fits.find((f) => f.topFraction === q)!;
  const s = evidence.find((e) => e.class === m.class)!.sibling;
  console.log(
    `${m.class.padEnd(6)} n=${at(0.5).n}  LOO median error at top 5%: ${at(0.05).looMedian.toFixed(3)}, ` +
      `20%: ${at(0.2).looMedian.toFixed(3)}, 50%: ${at(0.5).looMedian.toFixed(3)}  ` +
      `| sibling transfer ${s.median.toFixed(3)} over ${s.pairs} pairs`,
  );
}
for (const a of ablation) {
  console.log(`${a.class} ablation (LOO median error at top 5% / median; full ${a.full.top5.toFixed(3)} / ${a.full.median.toFixed(3)}):`);
  for (const w of a.without) console.log(`   without ${w.feature.padEnd(32)} ${w.top5.toFixed(3)} / ${w.median.toFixed(3)}`);
}
console.log(`fliers in tracking: ${fliers.n}, mean miss ${fliers.meanMiss}, spread ${fliers.spread}, ${fliers.overPredicted} over-predicted`);
console.log(`-> ${out}`);
