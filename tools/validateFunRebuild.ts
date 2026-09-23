/** Check the fun rebuild as it ships: the selections, their evidence, their targets and the live circuits.
 *
 *   npx tsx tools/validateFunRebuild.ts
 *
 * The claim the rebuild rests on is that every family it added measures better than the
 * family whose slot it took, so that is checked against the committed audit rather than
 * asserted in prose. The rest holds each new rung to the rules the rest of the
 * pool lives by: an exact identity, a board big enough to cut its ranks from, a length a
 * match can hold, and targets that reproduce from the frozen evidence to the point.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dataFile } from "../src/core/dataDir.ts";
import { loadSeason, seasonAsDifficulties, validateSeason } from "../src/core/season/season.ts";
import { thresholdsFrom } from "../src/core/season/percentiles.ts";
import { windowRankCount, windowRankIndices } from "../src/core/season/windows.ts";
import { practicePlaylists } from "../src/core/season/practice.ts";
import { matchesCategory } from "../src/core/match/scenarioSelection.ts";
import { rankIndex, scenarioEnergy } from "../src/core/benchmarks/energy.ts";
import { beforeFunRebuildPool } from "./funRebuildHistory.ts";

const read = (name: string): any => JSON.parse(readFileSync(dataFile(name), "utf8"));
const spec = read("season_fun_rebuild.json");
const calibration = read("season_fun_rebuild_calibration.json");
const evidence = read("season_fun_rebuild_evidence.json").identities;
const audit = read("fun_audit.json");
const pool = read("pool.json");
const curation = read("pool_curation.json");
const season = loadSeason();
validateSeason(season);
const identity = read("scenario_identity.json").scenarios;
const taxonomy = new Map<string, any>(read("scenario_taxonomy.json").scenarios.map((s: any) => [s.name, s]));
const distributions = new Map<string, any>(read("leaderboard_percentiles.json").distributions.map((s: any) => [s.scenario, s]));
const boards = new Map<string, any>(read("leaderboard_apex.json").boards.map((s: any) => [s.scenario, s]));
const durations = new Map<string, number | null>(read("scenario_durations.json").durations.map((d: any) => [d.scenario, d.seconds]));
const hash = (v: any) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function minEntriesFor(window: number): number {
  const first = window * pool.windowSize;
  const width = windowRankCount(window, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap);
  const slice = pool.ladder.ranks.slice(first, first + width);
  let tightest = Infinity;
  for (let i = 1; i < slice.length; i++) tightest = Math.min(tightest, slice[i - 1] - slice[i]);
  return Math.max(1000, Math.ceil(5 / tightest));
}

// ---- nothing else moved --------------------------------------------------------------
const before = beforeFunRebuildPool(pool);
const touched = new Set<number>(calibration.beforeFamilies.map((b: any) => b.index));
const rungSwapped = new Set<string>(spec.rungs.map((r: any) => `${r.category}/${r.family}`));
pool.families.forEach((f: any, i: number) => {
  if (touched.has(i)) return;
  const old = before.families[i];
  assert.equal(old.family, f.family, `position ${i}: family order changed`);
  if (rungSwapped.has(`${f.category}/${f.family}`)) {
    const swapped = new Set(spec.rungs.filter((r: any) => r.family === f.family).map((r: any) => r.window));
    f.variants.forEach((v: any, j: number) => { if (!swapped.has(v.window)) assert.equal(hash(v), hash(old.variants[j]), `${f.family}: unswapped rung changed`); });
  } else assert.equal(hash(f), hash(old), `${f.family}: a family the rebuild does not name changed`);
});
for (const s of season.scenarios) {
  const shipped = before.families.flatMap((f: any) => f.variants).find((v: any) => v.scenario === s.scenario);
  if (shipped && !calibration.adjustments.some((a: any) => a.scenario === s.scenario)) assert.deepEqual(s.rankMaxes, shipped.rankMaxes, `${s.scenario}: kept threshold moved`);
}
console.log(`ok ${pool.families.length - touched.size} families outside the rebuild are byte-identical outside their swapped rungs, thresholds included`);

// ---- the selections ------------------------------------------------------------------
const sizes = Object.fromEntries(pool.categories.map((c: string) => [c, pool.families.filter((f: any) => f.category === c).length]));
assert.deepEqual(sizes, spec.rules.sizes);
const pasuStyle = pool.families.filter((f: any) => f.category === "Dynamic Clicking" && /pasu|angelic|popcorn/i.test(f.family));
assert(pasuStyle.length <= spec.rules.maxPasuStyleDynamic, `${pasuStyle.length} Pasu-style dynamic families`);
for (const b of calibration.beforeFamilies) {
  const s = spec.families.find((f: any) => f.replaces === b.family.family && f.category === b.family.category);
  const now = pool.families[b.index];
  assert.equal(now.family, s.family); assert.equal(now.category, s.category);
  assert.deepEqual(now.variants.map((v: any) => v.scenario), s.rungs);
  if (spec.rules.noVoltaicAddedTo.includes(s.category)) assert(!s.rungs.some((r: string) => /\bVT\b|voltaic/i.test(r)), `${s.family}: Voltaic added to ${s.category}`);
}
for (const r of spec.rungs) {
  const f = pool.families.find((f: any) => f.family === r.family && f.category === r.category);
  assert.equal(f.variants.find((v: any) => v.window === r.window).scenario, r.scenario);
}
console.log(`ok ${spec.families.length} families replaced in place, ${spec.rungs.length} rungs swapped, circuit sizes and Pasu weight held`);

// ---- the claim -----------------------------------------------------------------------
const composite = new Map<string, any>(audit.families.map((a: any) => [`${a.status}/${a.category}/${a.family}`, a]));
for (const category of pool.categories) {
  const added = audit.families.filter((a: any) => a.category === category && a.status === "added");
  // Pairwise, not against every replaced family: Tamspeed measures below Pasu, and Pasu
  // was replaced by Pasu Wall, not by Tamspeed. The claim is that no swap made a slot worse.
  for (const a of added) {
    const replaces = spec.families.find((s: any) => s.category === category && s.family === a.family).replaces;
    const r = composite.get(`replaced/${category}/${replaces}`);
    assert(r, `${replaces}: not in the audit`);
    assert(a.composite > r.composite, `${category}: ${a.family} (${a.composite}) does not measure above ${replaces} (${r.composite})`);
  }
  for (const a of added) {
    const shipped = pool.families.find((f: any) => f.category === category && f.family === a.family);
    assert(shipped, `${a.family}: audited but not shipped`);
    assert.deepEqual(shipped.variants.map((v: any) => v.scenario), a.rungs.map((r: any) => r.scenario), `${a.family}: audit measured different rungs`);
  }
  assert(composite.size > 0);
}
console.log("ok every added family measures above the family it replaced");

// ---- each new rung -------------------------------------------------------------------
let thin = 0;
for (const a of calibration.adjustments) {
  const f = pool.families.find((f: any) => f.family === a.family);
  const v = f.variants.find((v: any) => v.scenario === a.scenario);
  assert.equal(v.window, a.window);
  const e = evidence[a.scenario];
  assert(e?.verifiedAt && e.url, `${a.scenario}: no exact identity evidence`);
  for (const id of [taxonomy.get(a.scenario)?.leaderboardId, identity[a.scenario]?.leaderboardId, distributions.get(a.scenario)?.leaderboardId])
    assert.equal(id, e.leaderboardId, `${a.scenario}: leaderboard id disagrees`);
  assert.equal(v.leaderboardId, e.leaderboardId);
  assert(matchesCategory({ id: v.leaderboardId, name: v.scenario, ...identity[a.scenario] }, f.category), `${a.scenario}: unreachable from the ${f.category} queue`);
  const seconds = durations.get(a.scenario);
  assert(!(seconds && seconds > spec.rules.maxSeconds), `${a.scenario}: runs ${seconds}s`);
  assert(!/\b\d+\s*(?:-\s*\d+\s*)?min(?:ute)?s?\b/i.test(e.description ?? ""), `${a.scenario}: announces a multi-minute run`);

  const d = distributions.get(a.scenario); const board = boards.get(a.scenario);
  if (d.total < minEntriesFor(a.window)) { thin++; assert(v.thinBoard?.why, `${a.scenario}: board under the floor without saying so`); }
  const ranks = windowRankIndices(a.window, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap);
  const fractions = ranks.map((r, i) => pool.ladder.ranks[r] * (a.window < pool.windows.length - 1 && i >= 4 ? [0.5, 0.4][i - 4] : 1));
  assert.deepEqual(a.ranks, ranks); assert.deepEqual(a.topFractions, fractions);
  assert.equal(a.sampledAt, d.sampledAt); assert.equal(a.recordSampledAt, board.sampledAt);
  assert.equal(a.record, Math.floor(board.points[0].score));
  const expected = thresholdsFrom(d, fractions)!;
  assert.deepEqual(a.raw, expected);
  expected[expected.length - 1] = Math.min(a.record, expected.at(-1)!);
  for (let i = expected.length - 2; i >= 0; i--) expected[i] = Math.min(expected[i], expected[i + 1] - 1);
  assert.deepEqual(v.rankMaxes, expected, `${a.scenario}: targets do not reproduce`);
  assert(expected[0] > 0 && expected.every((x, i) => i === 0 || x > expected[i - 1]) && expected.at(-1)! <= a.record);
  assert.deepEqual(season.scenarios.find(s => s.scenario === a.scenario)!.rankMaxes, expected);
}
console.log(`ok ${calibration.adjustments.length} new rungs: exact identities, queue reach, no known run over 60s, targets reproduced from their boards, ${thin} thin boards`);

// ---- the live circuits ---------------------------------------------------------------
const playlists = practicePlaylists(season);
const difficulties = seasonAsDifficulties(season);
for (const category of season.categories) {
  const guide = curation.categories[category.name];
  for (let window = 0; window < 4; window++) {
    assert.deepEqual(playlists.find(p => p.category === category.name && p.window === window)!.scenarios,
      guide.families.map((f: any) => f.rungs[window]), `${category.name}/${window}: circuit`);
    const definition = difficulties[window].categories.find(c => c.name === category.name)!;
    const band = category.bands![window];
    for (let step = 0; step < band.rankMaxes.length; step++) {
      const energy = definition.scenarios.reduce((sum, s) => sum + scenarioEnergy(s.rankMaxes[step], s.rankMaxes), 0);
      assert.equal(rankIndex(energy, band.rankMaxes), step, `${category.name}/${window}: rank ${step} is not earned at its own targets`);
    }
  }
}
console.log("ok every circuit plays in curated order and every rank of every band is earned at its own targets");
console.log(`OK: fun rebuild validated - ${spec.families.length} families, ${spec.rungs.length} rungs, ${calibration.adjustments.length} reproducible targets.`);
