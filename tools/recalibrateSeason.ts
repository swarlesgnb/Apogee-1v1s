/**
 * Re-cut Season 1's predicted thresholds with the current calibration, without forging the
 * scenario files again.
 *
 *   npm run recalibrate:season [-- --dry]
 *
 * build:season does this as its last step, but it first rebuilds every file from its
 * Voltaic template, and it refuses to run when any template is missing from the local
 * KovaaK's install. On 28 September 2026 six of them were missing from this machine's
 * workshop folder, which left no way to apply a new calibration.json at all. Nothing about a
 * threshold needs the template: it is the committed file, measured, predicted and cut at
 * the ladder, which is exactly what validate:season-files re-derives on every run. This
 * does the same and writes the result.
 *
 * Only rows whose thresholds are predicted or calibrated are touched. A row recut from a
 * real board keeps it. Scenario files are never written, so every stats file's Hash still
 * matches and calibrate:season keeps reading the runs it read before.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { parseSce } from "../src/core/scenario/sce.ts";
import { scenarioFeatures } from "../src/core/scenario/features.ts";
import { classify, predictFromAnchor, predictLadder, type ClassModel } from "../src/core/scenario/difficulty.ts";
import { thresholdsFrom } from "../src/core/season/percentiles.ts";
import { calibratedWhy, factorFor, predictedWhy, scalePoints, type Calibration } from "../src/core/season/calibration.ts";
import { windowRankIndices } from "../src/core/season/windows.ts";
import { validateSeason, type Season, type SeasonScenario } from "../src/core/season/season.ts";
import { rebuildPool, type RebuildSeason } from "../src/core/season/rebuildPool.ts";
import { kovaaksRoot } from "./scenarioCorpus.ts";

const dry = process.argv.includes("--dry");
const root = kovaaksRoot();
if (!root) {
  // The maps folder is part of what a file is measured by; without it the features differ.
  console.error("No KovaaK's install found; its maps folder is needed to measure the files.");
  process.exit(1);
}
const mapsDir = join(root, "maps");

type Row = SeasonScenario & { source?: { kind?: string; factor?: number; predicted?: number[]; why?: string } };
const season = JSON.parse(readFileSync(dataFile("seasons", "season-1.json"), "utf8")) as Season & { scenarios: Row[] } & Record<string, unknown>;
const model = JSON.parse(readFileSync(dataFile("season-1", "difficulty_model.json"), "utf8")) as { models: ClassModel[] };
const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as { ladder: { ranks: number[]; overlap: number }; windowSize: number };
const designed = JSON.parse(readFileSync(dataFile("season-1", "families.json"), "utf8")) as { families: Array<{ family: string; anchor?: string; pressure?: boolean }> };
const anchors = (JSON.parse(readFileSync(dataFile("season-1", "anchors.json"), "utf8")) as {
  anchors: Record<string, { features: ReturnType<typeof scenarioFeatures>; ladder: Array<{ topFraction: number; score: number }> }>;
}).anchors;
const calibration = JSON.parse(readFileSync(dataFile("season-1", "calibration.json"), "utf8")) as Calibration;

let changed = 0;
const scenarios = (season.scenarios as Row[]).map((s): Row => {
  const kind = s.source?.kind;
  if (kind !== "predicted" && kind !== "calibrated") return s;

  const sce = parseSce(readFileSync(join(dataFile("season-1", "scenarios"), `${s.scenario}.sce`), "utf8"));
  const features = scenarioFeatures(sce, mapsDir);
  const design = designed.families.find((f) => f.family === s.family);
  const cls = classify(features, { pressure: design?.pressure });
  const m = model.models.find((x) => x.class === cls);
  if (!cls || !m) throw new Error(`${s.scenario}: no difficulty class`);
  const anchor = design?.anchor ? anchors[design.anchor] : undefined;
  if (design?.anchor && !anchor) throw new Error(`${s.scenario}: predicts from ${design.anchor}, and no board for it is on record`);
  const prediction = anchor ? predictFromAnchor(m, features, anchor.features, anchor.ladder) : predictLadder(m, features);
  const points = prediction.points.map((p) => ({ topFraction: p.topFraction, score: p.score }));
  const ranks = windowRankIndices(s.window!, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap).map((i) => pool.ladder.ranks[i]);
  const board = (pts: typeof points) => ({ scenario: s.scenario, leaderboardId: 0, total: 0, sampledAt: "", points: pts });

  const predicted = thresholdsFrom(board(points), ranks);
  if (!predicted) throw new Error(`${s.scenario}: the predicted board does not reach every rank's percentile`);
  // A row already calibrated says what the model gave; if the model disagrees, the file
  // or the model moved under it and a re-cut would hide that.
  if (kind === "calibrated" && JSON.stringify(predicted) !== JSON.stringify(s.source!.predicted)) {
    throw new Error(`${s.scenario}: the model now gives ${predicted.join(" ")}, not the recorded ${s.source!.predicted!.join(" ")}`);
  }

  const factor = factorFor(calibration, s.family!, s.window!);
  const next: Row =
    factor === 1
      ? { ...s, rankMaxes: predicted, source: { kind: "predicted", why: predictedWhy(cls, m.fits.find((f) => f.topFraction === 0.5)!.looMedian) } }
      : (() => {
          const rankMaxes = thresholdsFrom(board(scalePoints(points, factor)), ranks);
          if (!rankMaxes) throw new Error(`${s.scenario}: the calibrated board does not reach every rank's percentile`);
          return { ...s, rankMaxes, source: { kind: "calibrated", factor, predicted, why: calibratedWhy(calibration, s.family!, s.window!) } };
        })();
  if (JSON.stringify(next.rankMaxes) !== JSON.stringify(s.rankMaxes)) {
    changed++;
    console.log(`  ${s.scenario.padEnd(36)} ${s.rankMaxes.join(" ")}  ->  ${next.rankMaxes.join(" ")}  (x${factor})`);
  }
  return next;
});

const out = { ...season, builtAt: new Date().toISOString(), scenarios };
validateSeason(out);
console.log(`${changed} of ${season.scenarios.length} rows re-cut`);
if (!dry) {
  writeFileSync(dataFile("seasons", "season-1.json"), JSON.stringify(out, null, 2) + "\n");
  // The season editor rebuilds the season from pool.json; see the same step in buildSeason.
  writeFileSync(
    dataFile("pool.json"),
    JSON.stringify(rebuildPool(JSON.parse(readFileSync(dataFile("pool.json"), "utf8")), out as unknown as RebuildSeason, {}), null, 2) + "\n",
  );
  console.log("wrote data/seasons/season-1.json and data/pool.json; npm run build:app shows them, npm run push:season updates the draft on the server");
}
