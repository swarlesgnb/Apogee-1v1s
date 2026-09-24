/**
 * Re-derive the measurements season 1's design rules rest on.
 *
 * `tools/season/design.ts` and docs/season-1-research.md state a handful of numbers -
 * that longer scenarios are steadier, that an accuracy multiplier adds noise, which design
 * features go with replay. Each is computed here, from the scenario files on this machine
 * and the local stats folder, and written to data/season-1/science.json, so a claim in a
 * comment is a line in a file this script regenerates.
 *
 *   NOISE    for every scenario with at least 8 local runs: the median absolute change
 *            between consecutive runs over the median score (the definition
 *            tools/funAudit.ts uses). One player's history, so it describes that player's
 *            consistency as much as the scenario's; the direction of an effect is the
 *            claim, not its size in general.
 *   REPLAY   for every catalogued scenario with at least 300 players: KovaaK's plays per
 *            player, and players ("reach"), against the same features.
 *
 * Correlations are Spearman's rank correlation, with a two-sided p from the t
 * approximation, which is adequate at these sample sizes.
 *
 *   npx tsx tools/scenarioScience.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { findStatsFolder } from "../src/app/watcher.ts";
import { buildCorpus, kovaaksRoot, type CorpusRow } from "./scenarioCorpus.ts";
import { parseStatsFile } from "../src/core/stats/parseStatsFile.ts";

const stats = findStatsFolder();
const root = kovaaksRoot();
if (!stats || !root) {
  console.error("Needs a KovaaK's install with a stats folder.");
  process.exit(1);
}

const rows = buildCorpus(root);
const byName = new Map(rows.map((r) => [r.name.trim().toLowerCase(), r]));

// ---- statistics ---------------------------------------------------------------------------

function ranks(v: number[]): number[] {
  const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(v.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const mean = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = mean;
    i = j + 1;
  }
  return r;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

/**
 * Two-sided p for a correlation r over n pairs: Student's t with n-2 degrees of freedom,
 * p = I_x(df/2, 1/2) at x = df / (df + t^2), the regularised incomplete beta.
 */
function pValue(r: number, n: number): number {
  const df = n - 2;
  const t2 = (r * r * df) / Math.max(1e-12, 1 - r * r);
  return incompleteBeta(df / (df + t2), df / 2, 0.5);
}

/** Regularised incomplete beta I_x(a, b), Numerical Recipes' betai and betacf. */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaFraction(x, a, b)) / a;
  return 1 - (front * betaFraction(1 - x, b, a)) / b;
}

function betaFraction(x: number, a: number, b: number): number {
  const TINY = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}

function lgamma(z: number): number {
  const g = 7;
  const coef = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = coef[0];
  for (let i = 1; i < g + 2; i++) x += coef[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function spearman(pairs: Array<[number, number]>) {
  const clean = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const rho = pearson(ranks(clean.map((p) => p[0])), ranks(clean.map((p) => p[1])));
  return { n: clean.length, rho: Math.round(rho * 1000) / 1000, p: Math.round(pValue(rho, clean.length) * 10000) / 10000 };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---- features used in both analyses --------------------------------------------------------

const FEATURES: Record<string, (r: CorpusRow) => number | null> = {
  timelimit: (r) => r.timelimit,
  accuracyMultiplier: (r) => (r.scoring.accuracyMult ? 1 : 0),
  aliveAtOnce: (r) => r.concurrent,
  targetDeg: (r) => r.derived.targetDeg,
  angularSpeed: (r) => r.derived.angularSpeed,
  shotsToKill: (r) => r.derived.shotsToKill,
  strafePeriod: (r) => r.derived.strafePeriod,
  botUnderGravity: (r) => (r.targets[0] ? (r.targets[0].gravity > 0 ? 1 : 0) : null),
  regeneratingTarget: (r) => (r.targets[0] ? (r.targets[0].regenPerSec > 0 ? 1 : 0) : null),
};

// ---- noise -------------------------------------------------------------------------------

const runs = new Map<string, Array<[string, number]>>();
for (const file of readdirSync(stats)) {
  const m = /^(.*) - Challenge - (\d{4}\.\d\d\.\d\d-\d\d\.\d\d\.\d\d) Stats\.csv$/.exec(file);
  if (!m) continue;
  const s = /\nScore:,([\d.\-]+)/.exec(readFileSync(join(stats, file), "utf8"));
  if (!s) continue;
  const key = m[1].trim().toLowerCase();
  runs.set(key, [...(runs.get(key) ?? []), [m[2], Number(s[1])]]);
}
const noisy: Array<{ row: CorpusRow; noise: number; runs: number }> = [];
for (const [name, list] of runs) {
  const row = byName.get(name);
  if (!row || !row.geometry) continue;
  const scores = list.sort().map((x) => x[1]).filter((x) => x > 0);
  if (scores.length < 8) continue;
  const steps = scores.slice(1).map((s, i) => Math.abs(s - scores[i]));
  noisy.push({ row, noise: median(steps) / median(scores), runs: scores.length });
}
const noise = {
  scenarios: noisy.length,
  medianNoise: Math.round(median(noisy.map((n) => n.noise)) * 1000) / 1000,
  correlations: Object.fromEntries(
    Object.entries(FEATURES).map(([k, f]) => [k, spearman(noisy.map((n) => [f(n.row) ?? NaN, n.noise]))]),
  ),
  accuracyMultiplier: {
    with: Math.round(median(noisy.filter((n) => n.row.scoring.accuracyMult).map((n) => n.noise)) * 1000) / 1000,
    without: Math.round(median(noisy.filter((n) => !n.row.scoring.accuracyMult).map((n) => n.noise)) * 1000) / 1000,
  },
  // Voltaic's other way to make misses cost: a magazine and more than one round a shot.
  reloadEconomy: (() => {
    const economy = noisy.filter((n) => (n.row.weapon?.magazine ?? 0) > 0 && (n.row.weapon?.ammoPerShot ?? 1) > 1);
    return { scenarios: economy.length, medianNoise: economy.length ? Math.round(median(economy.map((n) => n.noise)) * 1000) / 1000 : null };
  })(),
};

// ---- replay and reach ----------------------------------------------------------------------

const catalogued = rows.filter((r) => r.catalogue && r.catalogue.entries >= 300 && r.geometry);
const replay = (r: CorpusRow) => r.catalogue!.plays / r.catalogue!.entries;
const reach = (r: CorpusRow) => Math.log(r.catalogue!.entries);
const popularity = {
  scenarios: catalogued.length,
  replay: Object.fromEntries(Object.entries(FEATURES).map(([k, f]) => [k, spearman(catalogued.map((r) => [f(r) ?? NaN, replay(r)]))])),
  reach: Object.fromEntries(Object.entries(FEATURES).map(([k, f]) => [k, spearman(catalogued.map((r) => [f(r) ?? NaN, reach(r)]))])),
  strongestReplayCorrelation: 0,
};
popularity.strongestReplayCorrelation = Math.max(...Object.values(popularity.replay).map((c) => Math.abs(c.rho)));

// ---- the shape of static spawn fields ---------------------------------------------------------

// Zenith's reason to exist: static clicking with 10,000+ players, one-hit kills, targets
// that do not move, and how many of them spread targets wider than tall.
const staticPopular = rows.filter(
  (r) => r.geometry && r.catalogue && r.catalogue.entries >= 10_000 && r.derived.shotsToKill === 1 &&
    (r.derived.angularSpeed ?? 0) < 1 && r.scoring.perKill > 0 && r.scoring.perDamage === 0,
);
const fieldShape = {
  staticScenarios: staticPopular.length,
  widerThanTall: staticPopular.filter((r) => r.geometry!.yawExtentDeg > r.geometry!.pitchExtentDeg).length,
};

// ---- misses a kill costs -------------------------------------------------------------------

// What a miss penalty takes out of a kill's worth (MISSES_PER_KILL in difficulty.ts): on
// every moving one-hit clicking scenario with at least five local runs, each run's misses
// over its kills, the median per scenario, and the median of those.
const missRatios = new Map<string, number[]>();
for (const file of readdirSync(stats)) {
  if (!file.endsWith("Stats.csv")) continue;
  const parsed = parseStatsFile(file, readFileSync(join(stats, file), "utf8"));
  if (!parsed.ok || parsed.run.kills == null || !(parsed.run.kills > 0) || parsed.run.missCount == null) continue;
  const row = byName.get(parsed.run.scenario.trim().toLowerCase());
  if (!row || row.name.startsWith("Apogee ")) continue;
  const moving = (row.derived.angularSpeed ?? 0) >= 5 && row.derived.shotsToKill === 1 &&
    row.scoring.perKill > 0 && row.scoring.perDamage === 0 && row.weapon && !row.weapon.fullyAutomatic;
  if (!moving) continue;
  missRatios.set(row.name, [...(missRatios.get(row.name) ?? []), parsed.run.missCount / parsed.run.kills!]);
}
const perScenario = [...missRatios.values()].filter((v) => v.length >= 5).map(median);
const misses = {
  scenarios: perScenario.length,
  medianMissesPerKill: Math.round(median(perScenario) * 100) / 100,
};

const out = dataFile("season-1", "science.json");
writeFileSync(
  out,
  JSON.stringify({ $comment: "Written by tools/scenarioScience.ts; do not hand-edit.", measuredAt: new Date().toISOString(), noise, popularity, fieldShape, misses }, null, 1) + "\n",
);

const line = (name: string, c: { n: number; rho: number; p: number }) =>
  `  ${name.padEnd(20)} rho ${c.rho >= 0 ? "+" : ""}${c.rho.toFixed(2)}  p ${c.p.toFixed(3)}  n ${c.n}`;
console.log(`noise: ${noise.scenarios} scenarios, median ${noise.medianNoise}; accuracy multiplier ${noise.accuracyMultiplier.with} with, ${noise.accuracyMultiplier.without} without; reload economy ${noise.reloadEconomy.medianNoise} over ${noise.reloadEconomy.scenarios}`);
for (const [k, c] of Object.entries(noise.correlations)) console.log(line(k, c));
console.log(`replay (plays per player), ${popularity.scenarios} scenarios; strongest |rho| ${popularity.strongestReplayCorrelation}`);
for (const [k, c] of Object.entries(popularity.replay)) console.log(line(k, c));
console.log("reach (log players)");
for (const [k, c] of Object.entries(popularity.reach)) console.log(line(k, c));
console.log(`static fields: ${fieldShape.widerThanTall} of ${fieldShape.staticScenarios} popular static scenarios are wider than tall`);
console.log(`misses: ${misses.medianMissesPerKill} a kill, median over ${misses.scenarios} moving one-hit clicking scenarios`);
console.log(`-> ${out}`);
