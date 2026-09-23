/**
 * Measure every family in the pool, and every family the rebuild proposes, on the four
 * signals the rebuild was chosen by.
 *
 *   npx tsx tools/funAudit.ts [--refresh] [--stats <folder>]
 *
 * WHAT IS MEASURED
 *
 *   replay     plays / players on KovaaK's own scenario catalogue. The closest thing to
 *              "people enjoy this" that anybody publishes: a scenario players try once and
 *              drop sits near 2, one they come back to sits above 20. 1wall 6targets small
 *              is 57. Weighted towards Novice and Intermediate, because those are the rungs
 *              most players will ever see.
 *   reach      players on the Novice and Intermediate rungs, on a log scale. A rung nobody
 *              has played is a rung with no baseline, and a queue that serves it is a
 *              queue a new player bounces off.
 *   consensus  how many benchmarks evxl lists use any of the family's rungs. Benchmark
 *              authors keep choosing a scenario for a reason; 128 of them agreeing is
 *              evidence one of them alone is not.
 *   noise      median |score change| between consecutive local runs, over the median score,
 *              from the stats folder. Matches are decided on the delta from a baseline, so
 *              a noisy scenario is a coin flip. One player's corpus only covers what that
 *              player has played, so it is REPORTED and never folded into the composite:
 *              an unmeasured scenario must not score better than a measured one.
 *
 * WHY PLAYS PER PLAYER IS NOT USED ALONE
 *
 * It also rewards what is easy to spam. Piano Tiles I 50% SLOW is 64 plays per player and
 * nobody would call it training. So the composite is the mean of three percentiles across
 * every family measured here, and the rebuild's rules (duration, Pasu weight, Voltaic
 * share, circuit size) sit on top of it in data/season_fun_rebuild.json.
 *
 * CACHES
 *
 * The catalogue and benchmark membership are cached under .cache/fun-audit; --refresh
 * refetches them. The output, data/fun_audit.json, is committed, and every figure quoted in
 * pool_curation.json and scenario_rationale.json for the rebuild is read from it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const statsDir =
  args[args.indexOf("--stats") + 1] && args.includes("--stats")
    ? args[args.indexOf("--stats") + 1]
    : "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const CACHE = join(dataFile(".."), ".cache", "fun-audit");
mkdirSync(CACHE, { recursive: true });

const read = (name: string): any => JSON.parse(readFileSync(dataFile(name), "utf8"));
// Once the rebuild is applied the replaced families are gone from pool.json; measure the
// pool as it stood before it, so the audit re-derives the same comparison either side.
const pool = existsSync(dataFile("season_fun_rebuild_calibration.json"))
  ? (await import("./funRebuildHistory.ts")).beforeFunRebuildPool(read("pool.json"))
  : read("pool.json");
const spec = read("season_fun_rebuild.json");
const registry = read("evxl_registry.json");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 400ms between requests and a real wait on 429, as sampleLeaderboard.ts learned. */
async function get(url: string): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (response.ok && !text.includes("rate_limited")) {
      await sleep(400);
      return JSON.parse(text);
    }
    if (response.status !== 429 && response.status < 500 && !text.includes("rate_limited")) {
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    await sleep(Math.min(90_000, 5_000 * 2 ** attempt));
  }
  throw new Error(`Could not read ${url}`);
}

function cached<T>(name: string): T | null {
  const path = join(CACHE, name);
  return !refresh && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}
const store = (name: string, value: unknown) => writeFileSync(join(CACHE, name), JSON.stringify(value));

// ---- families -------------------------------------------------------------------------

interface Family {
  category: string;
  family: string;
  status: "kept" | "replaced" | "added";
  rungs: string[];
}

const replaced = new Set(spec.families.map((f: any) => `${f.category}/${f.replaces}`));
const families: Family[] = pool.families.map((f: any) => ({
  category: f.category,
  family: f.family,
  status: replaced.has(`${f.category}/${f.family}`) ? "replaced" : "kept",
  rungs: [...f.variants].sort((a: any, b: any) => a.window - b.window).map((v: any) => v.scenario),
}));
for (const f of spec.families) {
  families.push({ category: f.category, family: f.family, status: "added", rungs: f.rungs });
}
// A rung swap inside a kept family is audited as the family it produces.
for (const r of spec.rungs) {
  const f = families.find((x) => x.category === r.category && x.family === r.family && x.status === "kept");
  if (!f) throw new Error(`${r.category}/${r.family}: rung swap names no kept family`);
  if (f.rungs[r.window] !== r.replaces) throw new Error(`${r.family}: window ${r.window} is not ${r.replaces}`);
  f.rungs = f.rungs.map((s, i) => (i === r.window ? r.scenario : s));
}
const names = [...new Set(families.flatMap((f) => f.rungs))];

// ---- catalogue ------------------------------------------------------------------------

interface Row {
  leaderboardId: number;
  plays: number;
  players: number;
  aimType: string | null;
  description: string;
}

const catalogue: Record<string, Row | null> = cached("catalogue.json") ?? {};
let fetched = 0;
for (const name of names) {
  if (name in catalogue) continue;
  const url =
    "https://kovaaks.com/webapp-backend/scenario/popular?page=0&max=50&scenarioNameSearch=" +
    encodeURIComponent(name);
  const row = (await get(url)).data?.find((d: any) => d.scenarioName === name);
  catalogue[name] = row
    ? {
        leaderboardId: row.leaderboardId,
        plays: row.counts?.plays ?? 0,
        players: row.counts?.entries ?? 0,
        aimType: row.scenario?.aimType ?? null,
        description: String(row.scenario?.description ?? "").replace(/\s+/g, " ").trim(),
      }
    : null;
  if (++fetched % 20 === 0) {
    store("catalogue.json", catalogue);
    console.log(`${DIM}  catalogue ${fetched}${RESET}`);
  }
}
store("catalogue.json", catalogue);

// ---- benchmark membership -------------------------------------------------------------

const membership: Record<string, string[]> =
  cached("benchmarks.json") ??
  (await (async () => {
    const out: Record<string, Set<string>> = {};
    for (const b of registry.benchmarks) {
      for (const d of b.difficulties) {
        if (!d.kovaaksBenchmarkId) continue;
        const j = await get(
          "https://kovaaks.com/webapp-backend/benchmarks/player-progress-rank-benchmark" +
            `?benchmarkId=${d.kovaaksBenchmarkId}&steamId=76561198000000000`,
        );
        for (const c of Object.values<any>(j.categories ?? {})) {
          for (const s of Object.keys(c.scenarios ?? {})) (out[s] ??= new Set()).add(b.benchmarkName);
        }
      }
    }
    const plain = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
    store("benchmarks.json", plain);
    return plain;
  })());

// ---- local noise ----------------------------------------------------------------------

const median = (a: number[]) => {
  const b = [...a].sort((p, q) => p - q);
  return b.length ? b[Math.floor(b.length / 2)] : NaN;
};
const noise = new Map<string, { runs: number; noise: number }>();
if (existsSync(statsDir)) {
  const byScenario = new Map<string, [string, number][]>();
  for (const file of readdirSync(statsDir)) {
    const m = /^(.*) - Challenge - (\d{4}\.\d\d\.\d\d-\d\d\.\d\d\.\d\d) Stats\.csv$/.exec(file);
    if (!m) continue;
    const s = /\nScore:,([\d.\-]+)/.exec(readFileSync(join(statsDir, file), "utf8"));
    if (!s) continue;
    const list = byScenario.get(m[1]) ?? [];
    list.push([m[2], Number(s[1])]);
    byScenario.set(m[1], list);
  }
  for (const [name, list] of byScenario) {
    // The filename stamp sorts chronologically as text.
    const runs = list.sort().map((x) => x[1]).filter((x) => x > 0);
    if (runs.length < 8) continue;
    const steps = runs.slice(1).map((s, i) => Math.abs(s - runs[i]));
    noise.set(name, { runs: runs.length, noise: median(steps) / median(runs) });
  }
}

// ---- durations ------------------------------------------------------------------------

const durations = new Map<string, number | null>(
  read("scenario_durations.json").durations.map((d: any) => [d.scenario, d.seconds]),
);
function seconds(name: string): number | null {
  const known = durations.get(name);
  if (known) return known;
  // Descriptions that announce their length are the only other evidence there is.
  const m = /(\d+)\s*(?:-\s*\d+\s*)?min(?:ute)?s?\b/i.exec(catalogue[name]?.description ?? "");
  return m ? Number(m[1]) * 60 : null;
}

// ---- score ----------------------------------------------------------------------------

const WEIGHTS = [0.35, 0.35, 0.2, 0.1];

const measured = families.map((f) => {
  const rungs = f.rungs.map((name) => {
    const c = catalogue[name];
    const n = noise.get(name);
    return {
      scenario: name,
      leaderboardId: c?.leaderboardId ?? null,
      plays: c?.plays ?? null,
      players: c?.players ?? null,
      replay: c && c.players > 0 ? Math.round((c.plays / c.players) * 10) / 10 : null,
      benchmarks: membership[name]?.length ?? 0,
      seconds: seconds(name),
      noise: n ? Math.round(n.noise * 1000) / 1000 : null,
      localRuns: n?.runs ?? 0,
    };
  });
  let replay = 0;
  let weight = 0;
  rungs.forEach((r, i) => {
    if (r.replay == null) return;
    replay += r.replay * WEIGHTS[i];
    weight += WEIGHTS[i];
  });
  const reachPlayers = (rungs[0].players ?? 0) + (rungs[1].players ?? 0);
  const noises = rungs.map((r) => r.noise).filter((x): x is number => x != null);
  return {
    ...f,
    replay: weight ? Math.round((replay / weight) * 10) / 10 : 0,
    reach: reachPlayers,
    consensus: new Set(f.rungs.flatMap((n) => membership[n] ?? [])).size,
    noise: noises.length ? median(noises) : null,
    rungs,
  };
});

const percentile = (values: number[], v: number) =>
  values.filter((x) => x < v).length / Math.max(1, values.length - 1);
const replays = measured.map((m) => m.replay);
const reaches = measured.map((m) => Math.log10(1 + m.reach));
const consensuses = measured.map((m) => m.consensus);
const scored = measured.map((m) => ({
  ...m,
  composite:
    Math.round(
      ((percentile(replays, m.replay) +
        percentile(reaches, Math.log10(1 + m.reach)) +
        percentile(consensuses, m.consensus)) /
        3) *
        100,
    ) / 100,
}));

writeFileSync(
  dataFile("fun_audit.json"),
  JSON.stringify(
    {
      $comment:
        "Written by tools/funAudit.ts; do not hand-edit. replay = KovaaK's plays/players, weighted 35/35/20/10 over the four rungs; reach = players on the Novice and Intermediate rungs; consensus = distinct evxl-listed benchmarks using any rung; noise = median local run-to-run change over median score (one player's corpus, reported only). composite = mean percentile of replay, log reach and consensus across every family listed here.",
      measuredAt: new Date().toISOString(),
      benchmarksCrawled: registry.benchmarks.length,
      families: scored,
    },
    null,
    2,
  ) + "\n",
);

for (const category of pool.categories) {
  console.log(`\n${BOLD}${category}${RESET}  ${DIM}composite  replay  reach  consensus  noise${RESET}`);
  for (const f of scored.filter((s) => s.category === category).sort((a, b) => b.composite - a.composite)) {
    const mark = f.status === "added" ? "+" : f.status === "replaced" ? "-" : " ";
    console.log(
      `  ${mark} ${f.family.padEnd(26)} ${f.composite.toFixed(2).padStart(5)} ` +
        `${f.replay.toFixed(1).padStart(7)} ${String(f.reach).padStart(8)} ` +
        `${String(f.consensus).padStart(6)} ${f.noise == null ? "    -" : (f.noise * 100).toFixed(1).padStart(5) + "%"}`,
    );
  }
}
const missing = names.filter((n) => !catalogue[n]);
if (missing.length) console.log(`\n${BOLD}not in KovaaK's catalogue:${RESET} ${missing.join(", ")}`);
console.log(`\n${DIM}+ added by the rebuild, - replaced by it. Written data/fun_audit.json.${RESET}`);
