/**
 * Check the energy engine against KovaaK's own reported numbers.
 *
 * The engine's rules were derived by observation, so the only honest test is to feed it
 * a real player's real scores and confirm it reproduces the server's category energy,
 * category ranks, overall energy and overall rank. Any drift here means the model is
 * wrong and every rank the app displays is a lie.
 *
 *   npx tsx src/core/benchmarks/validateEngine.ts [steamId ...]
 */

import { readFileSync } from "node:fs";

import { evaluateBenchmark } from "./energy.ts";
import type { BenchmarkDef } from "./types.ts";

/** Accounts with real Voltaic S5 history, used as fixtures. */
const DEFAULT_STEAM_IDS = ["76561198710540626", "76561198277203834"];

const BENCHMARK_FILE = new URL("../../../data/benchmarks/voltaic-s5.json", import.meta.url);

const API =
  "https://kovaaks.com/webapp-backend/benchmarks/player-progress-rank-benchmark";

/** Server scores are fixed-point, scaled by 100; rankMaxes are in raw score units. */
const SERVER_SCORE_SCALE = 100;

/** Energy tolerance. Server rounds to 2dp, so anything under 0.05 is agreement. */
const TOLERANCE = 0.05;

interface ServerCategory {
  benchmark_progress: number;
  category_rank: number;
  scenarios: Record<string, { score: number }>;
}

interface ServerProgress {
  benchmark_progress: number;
  overall_rank: number;
  categories: Record<string, ServerCategory>;
}

async function fetchProgress(benchmarkId: number, steamId: string): Promise<ServerProgress> {
  const res = await fetch(`${API}?benchmarkId=${benchmarkId}&steamId=${steamId}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ServerProgress;
}

async function main(): Promise<void> {
  const steamIds = process.argv.slice(2);
  const targets = steamIds.length > 0 ? steamIds : DEFAULT_STEAM_IDS;

  const benchmark = JSON.parse(readFileSync(BENCHMARK_FILE, "utf8")) as BenchmarkDef;

  let checks = 0;
  let failures = 0;

  const fail = (msg: string) => {
    failures++;
    console.log(`   FAIL ${msg}`);
  };

  for (const steamId of targets) {
    for (const difficulty of benchmark.difficulties) {
      let server: ServerProgress;
      try {
        server = await fetchProgress(difficulty.kovaaksBenchmarkId, steamId);
      } catch (err) {
        console.log(`${steamId} ${difficulty.name}: fetch failed (${String(err)}) - skipped`);
        continue;
      }

      // Collect the player's scores as the engine expects them: raw units.
      const scores = new Map<string, number>();
      for (const cat of Object.values(server.categories ?? {})) {
        for (const [name, scen] of Object.entries(cat.scenarios ?? {})) {
          scores.set(name, (scen.score ?? 0) / SERVER_SCORE_SCALE);
        }
      }

      const anyScore = [...scores.values()].some((s) => s > 0);
      if (!anyScore) continue; // nothing to compare against

      const result = evaluateBenchmark(difficulty, scores);

      console.log(`\n${steamId}  ${benchmark.benchmarkName} ${difficulty.name}`);

      for (const cat of result.categories) {
        const serverCat = server.categories?.[cat.name];
        if (!serverCat) {
          fail(`no server data for category ${cat.name}`);
          continue;
        }

        checks++;
        const delta = Math.abs(cat.energy - serverCat.benchmark_progress);
        const energyOk = delta <= TOLERANCE;

        // Server ranks are 1-based over rankNames; the engine's index is 0-based.
        const serverRankIdx = (serverCat.category_rank ?? 0) - 1;
        const rankOk = cat.rankIndex === serverRankIdx;

        const mark = energyOk && rankOk ? "ok  " : "FAIL";
        console.log(
          `   ${mark} ${cat.name.padEnd(10)} energy ${cat.energy.toFixed(2).padStart(10)}` +
            ` vs ${serverCat.benchmark_progress.toFixed(2).padStart(10)}` +
            `  rank ${cat.rankIndex} vs ${serverRankIdx}`,
        );
        if (!energyOk) fail(`${cat.name} energy off by ${delta.toFixed(3)}`);
        if (!rankOk) fail(`${cat.name} rank ${cat.rankIndex} != server ${serverRankIdx}`);
      }

      checks++;
      const totalDelta = Math.abs(result.totalEnergy - server.benchmark_progress);
      const serverOverallIdx = (server.overall_rank ?? 0) - 1;
      const totalOk = totalDelta <= TOLERANCE;
      const overallRankOk = result.rankIndex === serverOverallIdx;

      console.log(
        `   ${totalOk && overallRankOk ? "ok  " : "FAIL"} ${"OVERALL".padEnd(10)}` +
          ` energy ${result.totalEnergy.toFixed(2).padStart(10)}` +
          ` vs ${server.benchmark_progress.toFixed(2).padStart(10)}` +
          `  rank ${result.rankIndex} vs ${serverOverallIdx}` +
          `  (${result.rankName ?? "unranked"})`,
      );
      if (!totalOk) fail(`overall energy off by ${totalDelta.toFixed(3)}`);
      if (!overallRankOk) fail(`overall rank ${result.rankIndex} != server ${serverOverallIdx}`);
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error("FAIL: engine disagrees with KovaaK's");
    process.exit(1);
  }
  console.log("OK: engine reproduces KovaaK's ranks and energy exactly");
}

main();
