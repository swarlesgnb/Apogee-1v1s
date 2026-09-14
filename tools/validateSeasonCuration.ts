/**
 * The rebuilt circuits, checked against the curation that chose them.
 *
 * pool_curation.json is where each selection is argued for; the season is what ships. This
 * holds them to each other: all six expanded categories, every window's
 * playlist in circuit order with the exact scenario names, no top target above the
 * sampled leaderboard record, and the four hand-calibrated Elite ladders reproduced from
 * the evidence frozen beside them.
 *
 * The last check guards the rebuild: saving the season from the editor used to
 * alphabetize every circuit, because families were sorted by name.
 *
 *   npm run validate:curation
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dataFile } from "../src/core/dataDir.ts";
import { loadSeason } from "../src/core/season/season.ts";
import { practicePlaylists } from "../src/core/season/practice.ts";
import { rebuildPool, type RebuildSeason } from "../src/core/season/rebuildPool.ts";

const read = (name: string): any => JSON.parse(readFileSync(dataFile(name), "utf8"));
const pool = read("pool.json");
const season = loadSeason();
const curation = read("pool_curation.json");
const calibration = read("season_rebuild_calibration.json");
const apex = new Map<string, any>(read("leaderboard_apex.json").boards.map((b: any) => [b.scenario, b]));
const playlists = practicePlaylists(season);
const curatedCategories = Object.keys(curation.categories);
assert.equal(curatedCategories.length, 6);
const expansion = read("season_expansion.json");
const newFamilies = new Set(expansion.families.map((f: any) => f.family));
assert.deepEqual(season.windows, ["Novice", "Intermediate", "Advanced", "Expert"]);

for (const name of curatedCategories) {
  const guide = curation.categories[name];
  const families = pool.families.filter((f: any) => f.category === name);
  assert.equal(families.length, name === "Static Clicking" ? 13 : 10, `${name}: core plus four variety families`);
  assert.deepEqual(families.map((f: any) => f.family), guide.families.map((f: any) => f.family));
  const category = season.categories.find(c => c.name === name)!;
  assert.equal(category.headline, guide.title);
  assert.equal(category.description, guide.description);
  for (let window = 0; window < 4; window++) {
    const expected = guide.families.map((f: any) => f.rungs[window]);
    const actual = playlists.find(p => p.category === name && p.window === window)!;
    assert.deepEqual(actual.scenarios, expected, `${name}/${window}: circuit order and exact scenario names`);
  }
  for (const f of families) {
    const chosen = guide.families.find((c: any) => c.family === f.family);
    assert.deepEqual(f.variants.map((v: any) => v.scenario), chosen.rungs);
    for (const v of f.variants) {
      const scenario = season.scenarios.find(s => s.scenario === v.scenario)!;
      assert.equal(scenario.focus, chosen.focus);
      assert.deepEqual(scenario.rankMaxes, v.rankMaxes);
      const board = apex.get(v.scenario);
      assert(board?.points.length, `${v.scenario}: missing apex evidence`);
      // Older static Expert targets are authored; their existing ceiling warnings
      // are separate from the expansion. All additions and revised tails must fit.
      if (name !== "Static Clicking" || newFamilies.has(f.family) || v.window < 3) {
        assert(v.rankMaxes.at(-1) <= board.points[0].score, `${v.scenario}: target above demonstrated record`);
      }
    }
  }
  console.log(`ok ${name}: four ordered ${families.length}-test circuits, guide coverage, demonstrated targets`);
}

for (const item of calibration.adjustments) {
  const variant = pool.families.flatMap((f: any) => f.variants).find((v: any) => v.scenario === item.scenario);
  assert.equal(variant.source.kind, "authored");
  const start = item.published.from[0].used[0];
  const end = Math.floor(item.anchor.score);
  const expected = Array.from({ length: 4 }, (_, i) => Math.floor(start * (end / start) ** (i / 3)));
  expected[0] = start;
  expected[3] = end;
  assert.equal(item.anchor.rank, 5);
  assert.deepEqual(variant.rankMaxes, expected, `${item.family}: reproduce the frozen calibration`);
  assert.deepEqual(item.rankMaxes, expected);
}
console.log(`ok ${calibration.adjustments.length} Elite adjustments reproduce their frozen source evidence`);

// Renderer ordering must not turn an unrelated editor save into a playlist reorder.
const reversed = { ...season, scenarios: [...season.scenarios].reverse() } as unknown as RebuildSeason;
const rebuilt = rebuildPool(pool, reversed) as any;
assert.deepEqual(rebuilt.families, pool.families);
console.log("ok circuit order and metadata survive saving reordered scenario rows");
console.log("OK: season curation validated");
