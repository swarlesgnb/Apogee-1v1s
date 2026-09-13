/** Validate the theory-led curation against scenario evidence and shipping data. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dataFile } from "../src/core/dataDir.ts";
import { loadSeason } from "../src/core/season/season.ts";
import { matchesCategory } from "../src/core/match/scenarioSelection.ts";

const read = (name: string): any => JSON.parse(readFileSync(dataFile(name), "utf8"));
const pool = read("pool.json");
const theory = read("benchmark_theory.json");
const season = loadSeason();
const taxonomy = new Map<string, any>(read("scenario_taxonomy.json").scenarios.map((s: any) => [s.name, s]));
const identity = read("scenario_identity.json").scenarios;
const canonical = (value: any): any => value && typeof value === "object"
  ? Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : value;
const hash = (value: any) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

assert.equal(hash(pool.families.filter((f: any) => f.category === "Static Clicking")), theory.staticPoolSha256,
  "Static Clicking changed: this theory pass must preserve its authored data");
assert.deepEqual(pool.windows, ["Novice", "Intermediate", "Advanced", "Expert"]);
const nonStatic = pool.families.filter((f: any) => f.category !== "Static Clicking");
const variants = nonStatic.flatMap((f: any) => f.variants);
assert.equal(variants.length, 120);
assert(variants.filter((v: any) => /\bVT\b|voltaic/i.test(v.scenario)).length <= theory.maxDirectVoltaicScenarios,
  "Direct Voltaic selections grew beyond the reviewed mix");
for (const replacement of theory.replacements) {
  assert(nonStatic.some((f: any) => f.family === replacement.family && f.category === replacement.category));
  assert(!nonStatic.some((f: any) => f.family === replacement.previous));
}
for (const item of theory.newScenarios) {
  const v = variants.find((v: any) => v.scenario === item.scenario);
  const t = taxonomy.get(item.scenario);
  const shipped = season.scenarios.find(s => s.scenario === item.scenario);
  assert(v && t && shipped, item.scenario + ": missing selection or evidence");
  assert.equal(v.leaderboardId, item.leaderboardId);
  assert.equal(t.leaderboardId, item.leaderboardId);
  assert.equal(shipped.leaderboardId, item.leaderboardId);
  assert.equal(identity[item.scenario]?.leaderboardId, item.leaderboardId);
  assert.equal(identity[item.scenario]?.subCategory, shipped.category);
  assert.equal(v.source.kind, "percentile");
  assert.equal(v.source.cut.sampledAt, item.sampledAt);
  assert.equal(t.fetchedAt, item.sampledAt);
  assert(matchesCategory({ id: item.leaderboardId, name: item.scenario,
    aimType: identity[item.scenario].aimType, subCategory: identity[item.scenario].subCategory }, shipped.category),
  item.scenario + ": unavailable to its category queue");
}

// Catch misleading name matches: e.g. VT Multiclick is static single-hit clicking,
// while this circuit needs three hits on a moving target. Catalogue prose supplies
// evidence for the mechanic; this does not claim to simulate or playtest the bot.
const family = (name: string): any => nonStatic.find((f: any) => f.family === name);
const evidence = (name: string): string => taxonomy.get(name)?.description ?? "";
for (const v of family("Pasu Sequence").variants) assert(/3[- ]click|3 clicks/i.test(evidence(v.scenario)));
for (const v of family("Vertical Control").variants) assert(/vertical smoothness/i.test(evidence(v.scenario)));
for (const v of family("Centering").variants) assert(/centering/i.test(evidence(v.scenario)));
assert(/stopping/i.test(evidence(family("Recovery").variants[0].scenario)));
for (const v of family("Recovery").variants.slice(1)) assert(/teleport/i.test(evidence(v.scenario)));
assert(/decrease in size/i.test(evidence(family("Vox Pace").variants[2].scenario)));
for (const v of family("Regen Control").variants) assert(/regen/i.test(evidence(v.scenario)));
console.log(`OK: ${theory.newScenarios.length} new identities reach the season and category queues; source-backed mechanics, four bands, preserved Static Clicking and restrained Voltaic mix`);
