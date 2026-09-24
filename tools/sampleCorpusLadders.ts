/**
 * Sample leaderboards for the scenarios the corpus measured but the season never needed.
 *
 * `leaderboard_percentiles.json` only covers scenarios that were once in the pool, which
 * is a narrow and skewed sample to learn difficulty from: every scenario in it was picked
 * for being a good benchmark. The workshop folder holds hundreds more that have boards.
 * This fills `data/season-2/corpus_ladders.json` with them, resuming where a previous run
 * stopped, because a full pass is a few thousand requests at the sampler's polite pace.
 *
 * Boards under MIN_ENTRIES are skipped: a percentile of forty people is a statement about
 * forty people.
 *
 *   npx tsx tools/sampleCorpusLadders.ts <corpus.json>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { sampleDistribution, RateLimited } from "../src/core/season/sampleLeaderboard.ts";
import type { Distribution } from "../src/core/season/percentiles.ts";

const MIN_ENTRIES = 500;

const corpusPath = process.argv[2] ?? dataFile("season-2", "corpus.json");
const out = dataFile("season-2", "corpus_ladders.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  rows: Array<{ name: string; catalogue: { leaderboardId: number; entries: number } | null; ladder: unknown }>;
};

const saved: { source: string; distributions: Distribution[] } = existsSync(out)
  ? JSON.parse(readFileSync(out, "utf8"))
  : { source: "kovaaks.com/webapp-backend/leaderboard/scores/global", distributions: [] };
const done = new Set(saved.distributions.map((d) => d.leaderboardId));

const todo = corpus.rows.filter(
  (r) => r.catalogue && !r.ladder && r.catalogue.entries >= MIN_ENTRIES && !done.has(r.catalogue.leaderboardId),
);
console.log(`${todo.length} boards to sample`);
mkdirSync(dirname(out), { recursive: true });

for (const [i, row] of todo.entries()) {
  try {
    const dist = await sampleDistribution(row.name, row.catalogue!.leaderboardId, { delayMs: 350 });
    if (dist) {
      saved.distributions.push(dist);
      writeFileSync(out, JSON.stringify(saved, null, 1) + "\n");
    }
    console.log(`${i + 1}/${todo.length} ${row.name}: ${dist ? dist.total : "no board"}`);
  } catch (err) {
    if (err instanceof RateLimited) {
      console.log("rate limited; stopping so a rerun resumes here");
      break;
    }
    console.log(`${row.name}: ${(err as Error).message}`);
  }
}
