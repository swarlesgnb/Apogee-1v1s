/**
 * Measure every scenario file on this machine and join it to what its leaderboard says.
 *
 * Season 1's scenarios are authored rather than chosen, so nobody has played them and
 * nothing about their difficulty can be read off a board. What can be done is to learn,
 * from scenarios that *have* been played, how the numbers in a file turn into scores -
 * and this is where that learning starts: one row per scenario, the geometry from
 * `core/scenario/features.ts`, the catalogue's aim type and play counts, and the sampled
 * leaderboard ladder where one exists.
 *
 * The files come from the KovaaK's install (its own Scenarios folder, and the Steam
 * workshop folder beside it, which holds every subscribed scenario unpacked). Nothing is
 * downloaded; a machine with fewer subscriptions measures fewer scenarios.
 *
 *   npx tsx tools/scenarioCorpus.ts [--out <file>]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { findStatsFolder } from "../src/app/watcher.ts";
import { readScenario, scenarioFeatures, type ScenarioFeatures } from "../src/core/scenario/features.ts";

export interface CorpusRow extends ScenarioFeatures {
  file: string;
  catalogue: {
    leaderboardId: number;
    aimType: string | null;
    difficulty: string | null;
    plays: number;
    entries: number;
    topScore: number | null;
  } | null;
  /** Score at each sampled fraction from the top, where a sample exists. */
  ladder: { total: number; points: Array<{ topFraction: number; score: number }> } | null;
}

/** The KovaaK's install root (…/FPSAimTrainer/FPSAimTrainer), found from the stats folder. */
export function kovaaksRoot(): string | null {
  const stats = findStatsFolder();
  return stats ? dirname(stats) : null;
}

export function scenarioFiles(root: string): string[] {
  const files: string[] = [];
  // Season 1's own files, once installed into the game folder, are not evidence about
  // what real scenarios look like: counting them would let validate:season-files compare the
  // season against itself. They are skipped by the file names the build writes.
  const authoredDir = dataFile("season-1", "scenarios");
  const authored = new Set(existsSync(authoredDir) ? readdirSync(authoredDir).filter((f) => f.endsWith(".sce")) : []);
  const own = join(root, "Saved", "SaveGames", "Scenarios");
  if (existsSync(own)) for (const f of readdirSync(own)) if (f.endsWith(".sce") && !authored.has(f)) files.push(join(own, f));
  // …/steamapps/common/FPSAimTrainer/FPSAimTrainer -> …/steamapps/workshop/content/824270
  const workshop = resolve(root, "..", "..", "..", "workshop", "content", "824270");
  if (existsSync(workshop)) {
    for (const item of readdirSync(workshop)) {
      const dir = join(workshop, item);
      try {
        for (const f of readdirSync(dir)) if (f.endsWith(".sce")) files.push(join(dir, f));
      } catch {
        /* a file rather than an item folder */
      }
    }
  }
  return files;
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(dataFile(name), "utf8")) as T;
}

export function buildCorpus(root: string): CorpusRow[] {
  const taxonomy = readJson<{ scenarios: Array<{ name: string; leaderboardId: number; aimType: string | null; difficulty: string | null; plays: number; entries: number; topScore: number | null }> }>("scenario_taxonomy.json");
  const byName = new Map(taxonomy.scenarios.map((s) => [s.name.trim().toLowerCase(), s]));
  const percentiles = readJson<{ distributions: Array<{ scenario: string; total: number; points: Array<{ topFraction: number; score: number }> }> }>("leaderboard_percentiles.json");
  const extra = existsSync(dataFile("season-1", "corpus_ladders.json"))
    ? readJson<{ distributions: typeof percentiles.distributions }>(join("season-1", "corpus_ladders.json")).distributions
    : [];
  const ladders = new Map([...percentiles.distributions, ...extra].map((d) => [d.scenario.trim().toLowerCase(), d]));

  const mapsDir = join(root, "maps");
  const seen = new Set<string>();
  const rows: CorpusRow[] = [];
  for (const file of scenarioFiles(root)) {
    let features: ScenarioFeatures;
    try {
      features = scenarioFeatures(readScenario(file), mapsDir);
    } catch {
      continue;
    }
    const key = features.name.trim().toLowerCase();
    // The same scenario is often both subscribed and saved locally; the first copy wins.
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cat = byName.get(key);
    const ladder = ladders.get(key);
    rows.push({
      ...features,
      file,
      catalogue: cat
        ? { leaderboardId: cat.leaderboardId, aimType: cat.aimType, difficulty: cat.difficulty, plays: cat.plays, entries: cat.entries, topScore: cat.topScore }
        : null,
      ladder: ladder ? { total: ladder.total, points: ladder.points } : null,
    });
  }
  return rows;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("scenarioCorpus.ts")) {
  const root = kovaaksRoot();
  if (!root) {
    console.error("No KovaaK's install found (looked for the stats folder in every Steam library).");
    process.exit(1);
  }
  const rows = buildCorpus(root);
  const outArg = process.argv.indexOf("--out");
  const out = outArg > 0 ? process.argv[outArg + 1] : dataFile("season-1", "corpus.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ builtAt: new Date().toISOString(), scenarios: rows.length, rows }, null, 1) + "\n");
  const geo = rows.filter((r) => r.geometry).length;
  const cat = rows.filter((r) => r.catalogue).length;
  const lad = rows.filter((r) => r.ladder).length;
  console.log(`${rows.length} scenarios; geometry ${geo}, catalogue ${cat}, ladder ${lad} -> ${out}`);
}
