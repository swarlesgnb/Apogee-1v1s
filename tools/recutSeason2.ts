/**
 * Replace season 2's predicted thresholds with ones read off real boards, as boards appear.
 *
 * Every season-2 threshold starts as a prediction (tools/buildSeason2.ts). Once a scenario
 * has been shared in game, KovaaK's gives it a leaderboard; once enough people have played
 * it, that board says more than any model. This finds each scenario's board by its exact
 * name, records the id either way - a ranked run cannot be verified without it (PLAN.md §5)
 * - and, for boards of at least MIN_ENTRIES, samples the board and recuts that row from it
 * at the same ladder percentiles, marking its source as a percentile of a real board.
 *
 * A published season is frozen (PLAN.md §14) and is refused. Rows whose board is still thin
 * keep their prediction. Re-running is safe: a row already recut is re-sampled, since a board
 * that has grown says more than it did.
 *
 *   npx tsx tools/recutSeason2.ts [--dry]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { dataFile } from "../src/core/dataDir.ts";
import { sampleDistribution } from "../src/core/season/sampleLeaderboard.ts";
import { thresholdsFrom, type Distribution } from "../src/core/season/percentiles.ts";
import { windowRankIndices } from "../src/core/season/windows.ts";
import { validateSeason, type Season } from "../src/core/season/season.ts";

/** The board size below which a percentile is a statement about too few people. */
export const MIN_ENTRIES = 500;

const SEARCH = "https://kovaaks.com/webapp-backend/scenario/popular";
const dry = process.argv.includes("--dry");

const seasonFile = dataFile("seasons", "season-2.json");
const season = JSON.parse(readFileSync(seasonFile, "utf8")) as Season & Record<string, unknown>;
if (season.status !== "draft") {
  console.error(`season 2 is ${season.status}; a published season's thresholds are frozen`);
  process.exit(1);
}
const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as { ladder: { ranks: number[]; overlap: number }; windowSize: number };
const boardsFile = dataFile("season-2", "boards.json");
const boards: { source: string; distributions: Distribution[] } = existsSync(boardsFile)
  ? JSON.parse(readFileSync(boardsFile, "utf8"))
  : { source: "kovaaks.com/webapp-backend/leaderboard/scores/global", distributions: [] };

async function leaderboardOf(name: string): Promise<{ id: number; entries: number } | null> {
  const res = await fetch(`${SEARCH}?page=0&max=20&scenarioNameSearch=${encodeURIComponent(name)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36", accept: "application/json" },
  });
  if (!res.ok) throw new Error(`search for ${name}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ scenarioName: string; leaderboardId: number; counts?: { entries?: number } }> };
  // Exact name only: a search for "Apogee Drift Novice" also returns "Apogee Drifters Novice".
  const row = body.data?.find((s) => s.scenarioName === name);
  return row ? { id: row.leaderboardId, entries: Number(row.counts?.entries ?? 0) } : null;
}

let found = 0;
let recut = 0;
for (const s of season.scenarios) {
  const board = await leaderboardOf(s.scenario);
  await new Promise((r) => setTimeout(r, 350));
  if (!board) continue;
  found++;
  s.leaderboardId = board.id;
  const dist = await sampleDistribution(s.scenario, board.id, { delayMs: 350 });
  if (!dist || dist.total < MIN_ENTRIES) {
    console.log(`${s.scenario}: board ${board.id}, ${dist?.total ?? 0} entries - keeps its prediction`);
    continue;
  }
  const ranks = windowRankIndices(s.window!, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap).map((i) => pool.ladder.ranks[i]);
  const rankMaxes = thresholdsFrom(dist, ranks);
  if (!rankMaxes) continue;
  s.rankMaxes = rankMaxes;
  (s as unknown as Record<string, unknown>).source = {
    kind: "percentile",
    why: `Read off this scenario's own KovaaK's board (${dist.total} entries, sampled ${dist.sampledAt.slice(0, 10)}) at the pool ladder's percentiles for the ranks this band grades. Replaces the model's prediction.`,
  };
  boards.distributions = [...boards.distributions.filter((d) => d.scenario !== s.scenario), dist];
  recut++;
  console.log(`${s.scenario}: recut from ${dist.total} entries`);
}

validateSeason(season);
console.log(`${found} of ${season.scenarios.length} scenarios have a board; ${recut} recut from one.`);
if (dry || found === 0) process.exit(0);
writeFileSync(seasonFile, JSON.stringify(season, null, 2) + "\n");
writeFileSync(boardsFile, JSON.stringify(boards, null, 1) + "\n");
