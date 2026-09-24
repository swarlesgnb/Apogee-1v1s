/**
 * Hold the scenario reader to what its comments claim, against every scenario file on
 * this machine.
 *
 *   1. `serializeSce(parseSce(text))` is the input, byte for byte, for every file.
 *   2. The player/bot spawn split by `PlayerTeam` agrees with "the player's group is the
 *      smaller one" wherever the two groups differ in size. Reported as a rate; it fails
 *      below 90%, because the corpus has a few deliberately odd arenas but a convention
 *      that held less often than that would not be a convention.
 *   3. Geometry resolves for at least 95% of files, so a regression in either map format
 *      shows up as a number dropping rather than as quietly thinner model fits.
 *   4. Every authored Season 1 scenario parses, round-trips, and resolves geometry.
 *
 * A check that finds no files is a failure, not a pass: a machine with no KovaaK's
 * install has measured nothing.
 *
 *   npm run validate:sce
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dataFile } from "../dataDir.ts";
import { findStatsFolder } from "../../app/watcher.ts";
import { parseSce, serializeSce, get, num } from "./sce.ts";
import { jsonSpawns, reflexSpawns, scenarioFeatures } from "./features.ts";
import { scenarioFiles } from "../../../tools/scenarioCorpus.ts";

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const pass = (msg: string) => console.log(`  ok   ${msg}`);

const stats = findStatsFolder();
if (!stats) {
  console.log("FAIL no KovaaK's install found; nothing was measured");
  process.exit(1);
}
const root = dirname(stats);
const mapsDir = join(root, "maps");
const files = scenarioFiles(root);
if (files.length === 0) fail("found no .sce files");

let roundTrip = 0;
let geometry = 0;
const mapFormats = { json: 0, reflex: 0 };
let agree = 0;
let comparable = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const sce = parseSce(text);
  if (serializeSce(sce) === text) roundTrip++;
  else console.log(`  does not round-trip: ${file}`);
  const f = scenarioFeatures(sce, mapsDir);
  if (f.geometry) geometry++;
  if (f.geometry?.source === "embedded-json" || f.geometry?.source === "json-file") mapFormats.json++;
  else if (f.geometry) mapFormats.reflex++;

  const embedded = sce.sections.find((s) => s.type === "Map Data")?.raw;
  const mapName = get(sce.head, "MapName") ?? "";
  const spawns = embedded && /type PlayerSpawn/.test(embedded)
    ? reflexSpawns(embedded.replace(/\r\n/g, "\n"))
    : mapName.endsWith(".json") && existsSync(join(mapsDir, mapName))
      ? jsonSpawns(readFileSync(join(mapsDir, mapName), "utf8"))
      : [];
  const a = spawns.filter((s) => s.teams === 1).length;
  const b = spawns.filter((s) => s.teams === 2).length;
  if (a && b && a !== b) {
    comparable++;
    const mine = num(sce.head, "PlayerTeam", 1) === 2 ? b : a;
    if (mine === Math.min(a, b)) agree++;
  }
}

console.log(`${files.length} scenario files`);
if (roundTrip === files.length) pass(`all ${files.length} round-trip byte for byte`);
else fail(`${files.length - roundTrip} of ${files.length} do not round-trip`);

const rate = comparable ? agree / comparable : 0;
if (comparable === 0) fail("no file had unequal spawn groups; the team convention was not tested");
else if (rate >= 0.9) pass(`PlayerTeam split agrees with the smaller spawn group on ${agree}/${comparable} (${(rate * 100).toFixed(1)}%)`);
else fail(`PlayerTeam split agrees on only ${agree}/${comparable}`);

const coverage = geometry / Math.max(1, files.length);
if (coverage >= 0.95) pass(`geometry resolves for ${geometry}/${files.length} (${mapFormats.json} JSON maps, ${mapFormats.reflex} Reflex)`);
else fail(`geometry resolves for only ${geometry}/${files.length}`);

const authored = dataFile("season-1", "scenarios");
if (existsSync(authored)) {
  const own = readdirSync(authored).filter((f) => f.endsWith(".sce"));
  if (own.length === 0) fail("data/season-1/scenarios holds no .sce files");
  for (const f of own) {
    const text = readFileSync(join(authored, f), "utf8");
    const sce = parseSce(text);
    if (serializeSce(sce) !== text) fail(`${f} does not round-trip`);
    if (get(sce.head, "Name") !== f.replace(/\.sce$/, "")) fail(`${f}: Name= does not match the file name, so KovaaK's would list it under another name`);
    if (!scenarioFeatures(sce, mapsDir).geometry) fail(`${f}: geometry does not resolve`);
  }
  pass(`${own.length} authored Season 1 scenarios checked`);
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall scenario-file checks pass");
