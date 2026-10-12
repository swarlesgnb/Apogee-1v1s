/**
 * Prove the synthetic stats folder is one the app reads as real.
 *
 * Three sizes (a new player under ranked's 50-run gate, a regular, a 15,000-run veteran),
 * each written to a temporary folder and then read back by the code the app runs:
 *
 *   PARSE       every file name matches the parser's pattern, every file parses, nothing
 *               throws, and the filename's time is the run's end.
 *   VERIFY      every run is graded `consistent` by verifyRun with everything the server
 *               would hand it (score models, weapon models, firing rates and lengths,
 *               world records, and the known hash of every Apogee scenario), and the hard
 *               checks that can fire did fire rather than skip.
 *   PLAY        every run lasts its scenario's length and none reads as abandoned.
 *   READ        the folder cache marks every file coherent, history groups them, and a
 *               snapshot builds with the season's ranks painted on it.
 *   SHAPE       the history ends today with yesterday played, nothing is after `end`,
 *               season runs exist only inside the season, scores improve, and a seed
 *               gives the same bytes twice.
 *   CACHE       the folder cache's sliced first read (`primeStatsFolder`) gives what a
 *               plain read gives without holding the event loop, and its cache on disk
 *               gives back exactly what was parsed, for the same folder and key only.
 *
 *   npm run validate:fixture
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSnapshot } from "../../src/core/report/snapshot.ts";
import { scanStatsFolder } from "../../src/core/history/history.ts";
import { primeStatsFolder, readStatsFolder, saveDiskCache, useDiskCache } from "../../src/core/stats/folderCache.ts";
import { isAbandonedRun, runDurationSeconds } from "../../src/core/stats/duration.ts";
import { parseFilename, parseStatsFile, type ParsedRun } from "../../src/core/stats/parseStatsFile.ts";
import type { ConsistencyContext, ScoreModel, WeaponScoreModel } from "../../src/core/verify/consistency.ts";
import { verifyRun } from "../../src/core/verify/verifyRun.ts";
import { MIN_RUNS_FOR_BASELINE } from "../../src/core/history/baseline.ts";
import { appendRun, catalog, PRESETS, writeStatsFolder, type PresetName } from "./syntheticStats.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const DATA = new URL("../../data/", import.meta.url);
const json = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, DATA), "utf8")) as T;

const learned = json<{
  models: Record<string, ScoreModel>;
  weaponModels: Record<string, WeaponScoreModel>;
  shotRates: Record<string, number>;
}>("score_models.json");
const durations = new Map(
  json<{ durations: { scenario: string; seconds: number | null }[] }>("scenario_durations.json").durations
    .filter((d) => d.seconds != null)
    .map((d) => [d.scenario, d.seconds!]),
);
const worldRecords = new Map(
  json<{ scenarios: { name: string; topScore: number | null }[] }>("scenario_taxonomy.json").scenarios
    .filter((s) => s.topScore)
    .map((s) => [s.name, s.topScore!]),
);
const seasonHashes = new Map(catalog().season.map((s) => [s.name, s.hash]));

/** What submit-run hands verifyRun, built the way syncReferenceData fills the table. */
function contextFor(run: ParsedRun): ConsistencyContext {
  const rate = learned.shotRates[run.scenario];
  const seconds = durations.get(run.scenario);
  return {
    worldRecord: worldRecords.get(run.scenario),
    knownHash: seasonHashes.get(run.scenario),
    scoreModel: learned.models[run.scenario],
    weaponScoreModel: learned.weaponModels[run.scenario],
    shotsPerSecond: rate != null && seconds != null ? rate : undefined,
    scenarioSeconds: rate != null && seconds != null ? seconds : undefined,
  };
}

// A fixed end, so the run is the same every time. Evening, so today has room for a session.
const END = new Date(2026, 9, 3, 20, 0, 0);
const SEED = 7;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function validatePreset(name: PresetName, root: string): void {
  const preset = PRESETS[name];
  const dir = join(root, name, "stats");
  console.log(`\n── ${name}: ${preset.runs.toLocaleString()} runs ───────────────────────────`);

  const written = writeStatsFolder(dir, { ...preset, seed: SEED, end: END });
  console.log(`  wrote ${written.files} files, ${(written.bytes / 1e6).toFixed(1)} MB, in ${written.ms} ms`);
  check("wrote the number of runs asked for", written.files === preset.runs, `${written.files}`);

  // -- parse and verify ---------------------------------------------------------
  const files = readdirSync(dir).filter((f) => f.endsWith("Stats.csv"));
  const started = performance.now();
  let exceptions = 0;
  let failedParse = 0;
  let badName = 0;
  let badStamp = 0;
  const tiers = new Map<string, number>();
  const rejected: string[] = [];
  const passes = new Map<string, number>();
  let wrongLength = 0;
  let abandoned = 0;
  const runs: ParsedRun[] = [];

  for (const file of files) {
    const info = parseFilename(file);
    if (!info) badName++;
    let parsed;
    try {
      parsed = parseStatsFile(file, readFileSync(join(dir, file), "utf8"));
    } catch {
      exceptions++;
      continue;
    }
    if (!parsed.ok) {
      failedParse++;
      continue;
    }
    const run = parsed.run;
    runs.push(run);
    if (run.scenario !== info?.scenario) badName++;

    const outcome = verifyRun({ run, serverRecord: null, consistency: contextFor(run) });
    tiers.set(outcome.tier, (tiers.get(outcome.tier) ?? 0) + 1);
    if (outcome.tier === "rejected" && rejected.length < 3) rejected.push(`${file}: ${outcome.reasons.join("; ")}`);
    for (const c of outcome.report.checks) {
      if (c.status === "pass") passes.set(c.id, (passes.get(c.id) ?? 0) + 1);
    }

    const seconds = runDurationSeconds(run.challengeStart, run.playedAt);
    const expected = durations.get(run.scenario) ?? 60;
    if (seconds == null || seconds < expected - 1 || seconds > expected + 1.5) wrongLength++;
    if (isAbandonedRun(seconds, expected)) abandoned++;
    if (!run.playedAt || run.playedAt.getTime() > END.getTime()) badStamp++;
  }
  const readMs = Math.round(performance.now() - started);

  check("every file name matches the parser's pattern and its body", badName === 0, `${badName}`);
  check("no file throws in the parser", exceptions === 0, `${exceptions}`);
  check("every file parses", failedParse === 0, `${failedParse} failed`);
  check(
    "verifyRun grades every run consistent",
    (tiers.get("consistent") ?? 0) === files.length,
    [...tiers].map(([t, n]) => `${t} ${n}`).join(", ") + (rejected.length ? ` | ${rejected.join(" | ")}` : ""),
  );

  // The hard checks have to have run, not skipped, or "no rejections" means nothing.
  const total = files.length;
  const libraryShare = written.libraryRuns / total;
  check("shot balance was checked on every run", passes.get("shots_balance") === total, `${passes.get("shots_balance")}`);
  check("weapon hits were checked on every run", passes.get("hits_match_weapon") === total, `${passes.get("hits_match_weapon")}`);
  check("the kill counter and kill times were checked", (passes.get("kill_sequence") ?? 0) > 0 && (passes.get("timestamps_monotonic") ?? 0) > 0);
  if (written.seasonRuns > 0) {
    check("every season run carries its scenario's known hash", passes.get("hash_known") === written.seasonRuns, `${passes.get("hash_known")} of ${written.seasonRuns}`);
  }
  if (libraryShare > 0) {
    check(
      "every library run was held to its score model, weapon model and world record",
      passes.get("score_matches_model") === written.libraryRuns &&
        passes.get("score_matches_weapon_block") === written.libraryRuns &&
        passes.get("damage_possible_rate") === written.libraryRuns &&
        passes.get("below_world_record") === written.libraryRuns,
      ["score_matches_model", "score_matches_weapon_block", "damage_possible_rate", "below_world_record"]
        .map((id) => `${id} ${passes.get(id) ?? 0}`)
        .join(", ") + ` of ${written.libraryRuns}`,
    );
  }
  if (name !== "new") check("the firing-rate ceiling was exercised", (passes.get("shots_per_second") ?? 0) > 0);

  check("every run lasts its scenario's length", wrongLength === 0, `${wrongLength}`);
  check("no run reads as abandoned", abandoned === 0, `${abandoned}`);
  check("no run is stamped after the end of the history", badStamp === 0, `${badStamp}`);

  // -- the app's own readers ----------------------------------------------------
  const cacheStarted = performance.now();
  const cached = readStatsFolder(dir);
  const cacheMs = Math.round(performance.now() - cacheStarted);
  check("the folder cache reads every file", cached.length === total, `${cached.length}`);
  check("the folder cache marks every file coherent", cached.every((c) => c.run.coherent), `${cached.filter((c) => !c.run.coherent).length} incoherent`);

  const history = scanStatsFolder(dir);
  const scenarioRuns = [...history.values()].reduce((n, h) => n + h.runs.length, 0);
  check("history holds every run", scenarioRuns === total, `${scenarioRuns}`);

  // -- shape --------------------------------------------------------------------
  const times = runs.map((r) => r.playedAt!).sort((a, b) => a.getTime() - b.getTime());
  const last = times[times.length - 1];
  const yesterday = new Date(END.getFullYear(), END.getMonth(), END.getDate() - 1);
  check("the history ends today", sameDay(last, END), last.toString());
  check("yesterday was played, so a streak exists", times.some((t) => sameDay(t, yesterday)));
  const spanDays = (last.getTime() - times[0].getTime()) / 86_400_000;
  console.log(`  ${history.size} scenarios over ${spanDays.toFixed(0)} days`);
  if (name === "veteran") check("a veteran's history spans more than a year", spanDays > 365, `${spanDays.toFixed(0)} days`);

  const seasonFrom = new Date(END.getFullYear(), END.getMonth(), END.getDate() - (preset.seasonDays - 1));
  const early = runs.filter((r) => seasonHashes.has(r.scenario) && r.playedAt! < seasonFrom).length;
  check("season scenarios are played only after the season shipped", early === 0, `${early} before`);
  check("season and library scenarios are both played", written.seasonRuns > 0 && written.libraryRuns > 0);

  const withBaseline = [...history.values()].filter((h) => seasonHashes.has(h.scenario) && h.runs.length >= MIN_RUNS_FOR_BASELINE).length;
  if (name !== "new") check("some season scenarios have a baseline's worth of runs", withBaseline >= 6, `${withBaseline}`);
  console.log(`  ${withBaseline} season scenarios with ${MIN_RUNS_FOR_BASELINE}+ runs`);

  // Improvement: on scenarios with real history, later runs score higher than early ones.
  const long = [...history.values()].filter((h) => h.runs.length >= 40);
  if (long.length > 0) {
    const improved = long.filter((h) => {
      const q = Math.floor(h.runs.length / 4);
      return median(h.runs.slice(-q).map((r) => r.score)) > median(h.runs.slice(0, q).map((r) => r.score));
    }).length;
    check(
      "scores improve over a scenario's history",
      improved / long.length >= 0.8,
      `${improved} of ${long.length} scenarios with 40+ runs`,
    );
  }

  // -- the snapshot the app paints from ------------------------------------------
  const snapStarted = performance.now();
  const snapshot = buildSnapshot({ statsDir: dir, now: END });
  const snapMs = Math.round(performance.now() - snapStarted);
  check("a snapshot builds", snapshot !== null);
  if (snapshot) {
    check("the snapshot counts every run", snapshot.player.totalRuns === total, `${snapshot.player.totalRuns}`);
    const bands = (snapshot.categories as { bands?: { rankIndex: number; played: number }[] }[]).flatMap((c) => c.bands ?? []);
    const held = bands.filter((b) => b.rankIndex >= 0).length;
    const played = bands.filter((b) => b.played > 0).length;
    console.log(`  ${played} of ${bands.length} bands played, ${held} hold a rank`);
    // A new player is mostly under the first threshold, which is a state the Ranks screen
    // draws on its own ("played, not ranked yet"); anyone with weeks of play holds ranks.
    if (name === "new") check("the season's bands are painted as played", played > 0);
    else check("the season's bands are painted with ranks", held > 0);
    check("the streak counts today and yesterday", snapshot.player.streak >= 2, `${snapshot.player.streak}`);
  }

  console.log(`  read+verify ${readMs} ms, folder cache ${cacheMs} ms, snapshot ${snapMs} ms`);
}

function validateDeterminism(root: string): void {
  console.log("\n── determinism ─────────────────────────────────────");
  const a = join(root, "det-a");
  const b = join(root, "det-b");
  writeStatsFolder(a, { ...PRESETS.new, seed: 11, end: END });
  writeStatsFolder(b, { ...PRESETS.new, seed: 11, end: END });
  const fa = readdirSync(a).sort();
  const fb = readdirSync(b).sort();
  const same = fa.length === fb.length && fa.every((f, i) => f === fb[i] && readFileSync(join(a, f), "utf8") === readFileSync(join(b, f), "utf8"));
  check("one seed writes the same bytes twice", same);
  const c = join(root, "det-c");
  writeStatsFolder(c, { ...PRESETS.new, seed: 12, end: END });
  check("another seed writes a different history", readdirSync(c).sort().join() !== fa.join());
}

/** A folder cache read, in a form two reads can be compared by. */
function snapshotOf(rows: { file: string; run: unknown }[]): string {
  return JSON.stringify([...rows].sort((a, b) => a.file.localeCompare(b.file)));
}

async function validateFolderCache(root: string): Promise<void> {
  console.log("\n── folder cache: sliced first read, cache on disk ──");
  const veteran = join(root, "veteran", "stats");
  const regular = join(root, "regular", "stats");
  const copy = join(root, "regular-copy", "stats");
  const small = join(root, "new", "stats");
  cpSync(regular, copy, { recursive: true, preserveTimestamps: true });

  // Sliced first read of the big folder, with the event loop watched while it runs.
  readStatsFolder(regular); // leave the veteran folder, so its read starts from nothing
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const started = performance.now();
  await primeStatsFolder(veteran);
  const primeMs = Math.round(performance.now() - started);
  loop.disable();
  const stall = Math.round(loop.max / 1e6);
  console.log(`  primed ${PRESETS.veteran.runs.toLocaleString()} files in ${primeMs} ms, longest stall ${stall} ms`);
  check("the sliced first read never holds the event loop for 250 ms", stall < 250, `${stall} ms`);
  check("after it, a read of the folder returns every run", readStatsFolder(veteran).length === PRESETS.veteran.runs);

  // The same files read plainly from another path, for comparison.
  const plain = snapshotOf(readStatsFolder(copy));
  await primeStatsFolder(regular);
  check("a primed read gives exactly what a plain read gives", snapshotOf(readStatsFolder(regular)) === plain);

  // The cache on disk.
  const cacheFile = join(root, "stats-cache.json");
  useDiskCache(cacheFile, "build-1");
  readStatsFolder(small); // leave, so the next read of the copy starts from the disk cache
  readStatsFolder(copy);
  check("a first read writes the cache", saveDiskCache() && existsSync(cacheFile));
  readStatsFolder(small);
  const fromDisk = readStatsFolder(copy);
  check("a later session gets every run back from the cache", snapshotOf(fromDisk) === plain);
  check("and parsed nothing to get them", saveDiskCache() === false);

  const added = appendRun(copy, { at: new Date(Date.now() - 5_000), seed: 3 });
  // Written a moment ago reads as still being written; this one is finished.
  utimesSync(join(copy, added.file), added.endedAt, added.endedAt);
  const gone = fromDisk[0].file;
  rmSync(join(copy, gone));
  readStatsFolder(small);
  const after = readStatsFolder(copy);
  check("a run added since is read from its file", after.some((r) => r.file === added.file));
  check("a run deleted since is not returned from the cache", !after.some((r) => r.file === gone));
  check("the count follows the folder, not the cache", after.length === fromDisk.length);

  useDiskCache(cacheFile, "build-2");
  readStatsFolder(small);
  readStatsFolder(copy);
  check("another build's key reads as no cache, and parses again", saveDiskCache() === true);
}

const root = mkdtempSync(join(tmpdir(), "apogee-fixture-"));
try {
  for (const name of ["new", "regular", "veteran"] as PresetName[]) validatePreset(name, root);
  validateDeterminism(root);
  await validateFolderCache(root);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log();
if (failures > 0) {
  console.log(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: synthetic stats folders parse, verify Consistent, and paint");
