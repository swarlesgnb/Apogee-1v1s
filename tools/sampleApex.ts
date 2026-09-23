/**
 * Sample the top of every season scenario's board, in ranks rather than percentiles.
 *
 *   npx tsx tools/sampleApex.ts [--only <n>] [--delay <ms>] [--force]
 *
 * WHY THIS IS A SECOND FILE AND NOT MORE POINTS IN THE FIRST
 *
 * `sampleLeaderboards.ts` samples fractions, and its output is what every threshold in
 * the season is cut from. Adding points to `SAMPLE_POINTS` changes the shape of that file,
 * which invalidates all 437 cached distributions and forces a full re-sample of boards
 * whose thresholds are already published and already checked. The apex anchors serve one
 * consumer - the post-rank board - and nothing about the ladder depends on them, so they
 * get their own file and the thresholds keep their provenance untouched.
 *
 * It is also a different question. Fractions ask "what score is the top 5% of this
 * board"; this asks "what score is the fiftieth best anybody has posted". The second stops
 * being answerable by the first exactly where the board gets sparse, which is where the
 * post-rank measure lives. See `src/core/season/apex.ts`.
 *
 * The board serves any rank directly, so one anchor costs one request:
 *
 *   /leaderboard/scores/global?leaderboardId=<id>&page=<rank-1>&max=1
 *
 * Ten anchors across 88 scenarios at 400ms is about six minutes, and only needs doing when
 * the pool changes. Polite by construction, same as the fractional sampler: one request at
 * a time, a pause between, and a rate limit is waited out rather than treated as an
 * absent board.
 *
 * Output: data/leaderboard_apex.json, committed.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { loadSeason } from "../src/core/season/season.ts";
import { APEX_RANKS, apexRanksFor, type ApexBoard } from "../src/core/season/apex.ts";

const OUT = join(dataFile("."), "leaderboard_apex.json");

const BASE = "https://kovaaks.com/webapp-backend/leaderboard/scores/global";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";

/** Same ladder the fractional sampler waits on, and for the same reason. */
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 45_000, 90_000];

const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt !== -1 ? Number(args[onlyAt + 1]) : Infinity;
const delayAt = args.indexOf("--delay");
const DELAY_MS = delayAt !== -1 ? Number(args[delayAt + 1]) : 400;
/** Re-sample boards already in the file. Off by default: the top of a board moves slowly. */
const FORCE = args.includes("--force");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RateLimited extends Error {}

interface Cache {
  source: string;
  sampledAt: string;
  sampleRanks: number[];
  $comment: string;
  boards: ApexBoard[];
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, accept: "application/json" } });
      if (res.ok) return (await res.json()) as Record<string, unknown>;

      if (res.status === 429 || res.status >= 500) {
        if (attempt === RATE_LIMIT_BACKOFF_MS.length) throw new RateLimited(`HTTP ${res.status}`);
        const retryAfter = Number(res.headers.get("retry-after")) * 1000;
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter
            : RATE_LIMIT_BACKOFF_MS[attempt],
        );
        continue;
      }

      // A 404 or a 400 is an answer: this leaderboard is not there.
      return null;
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      if (attempt === RATE_LIMIT_BACKOFF_MS.length) throw new RateLimited("network");
      await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
    }
  }
  return null;
}

/**
 * Sample one board's apex.
 *
 * A board shorter than an anchor simply has no such rank, and that anchor is dropped
 * rather than clamped onto the last row: recording "rank 250" for a board with 200 entries
 * would put a floor under the interpolation that the board does not have.
 */
async function sampleApex(scenario: string, leaderboardId: number): Promise<ApexBoard | null> {
  const first = await getJson(`${BASE}?leaderboardId=${leaderboardId}&page=0&max=1`);
  const total = Number(first?.total ?? 0);
  if (!Number.isFinite(total) || total <= 0) return null;

  const points: { rank: number; score: number }[] = [];

  for (const rank of apexRanksFor(total)) {
    const body =
      rank === 1 ? first : await getJson(`${BASE}?leaderboardId=${leaderboardId}&page=${rank - 1}&max=1`);
    const score = Number((body?.data as { score?: number }[] | undefined)?.[0]?.score);
    if (Number.isFinite(score)) points.push({ rank, score });

    if (rank !== 1) await sleep(DELAY_MS);
  }

  // Two anchors is the minimum that can interpolate. One is a point, not a curve.
  if (points.length < 2) return null;

  // Scores must fall as rank grows. A board holds ties and the odd bad row, so this is
  // enforced rather than trusted - an out-of-order anchor would make the interpolation
  // return a rank outside the pair it sits between.
  points.sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < points.length; i++) {
    if (points[i].score > points[i - 1].score) points[i].score = points[i - 1].score;
  }

  return { scenario, leaderboardId, total, points, sampledAt: new Date().toISOString() };
}

async function main(): Promise<void> {
  // The pool, not the season built from it. These anchors are what lets `buildSeason`
  // tell a rank nobody can hold apart from one the fractional sampling cannot see, so a
  // season with a new scenario cannot be built until that scenario has them - and reading
  // the season here made that circular: the build refuses, so the season never names the
  // scenario, so the sampler never fetches it. The pool is where a scenario enters the
  // season anyway, which is what this file's own header already says it samples.
  const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as {
    windows?: string[];
    families: { variants: { scenario: string; label?: string; leaderboardId: number | null; window: number }[] }[];
  };

  const wanted = pool.families
    .flatMap((f) => f.variants)
    .filter((v) => v.leaderboardId != null)
    .map((v) => ({
      scenario: v.scenario,
      label: v.label ?? v.scenario,
      leaderboardId: v.leaderboardId as number,
      window: v.window ?? 0,
    }));

  const cached = new Map<string, ApexBoard>();
  if (existsSync(OUT)) {
    const prior = JSON.parse(readFileSync(OUT, "utf8")) as Cache;
    for (const b of prior.boards ?? []) cached.set(b.scenario, b);
  }

  console.log(`\napex sampling  ${Math.min(only, wanted.length)} of ${wanted.length} scenarios\n`);

  const boards: ApexBoard[] = [];
  let done = 0;
  let reused = 0;
  let stoppedEarly = false;

  for (const s of wanted) {
    if (done >= only || stoppedEarly) {
      const prior = cached.get(s.scenario);
      if (prior) boards.push(prior);
      continue;
    }

    const prior = cached.get(s.scenario);
    if (prior && !FORCE) {
      boards.push(prior);
      reused++;
      done++;
      continue;
    }

    let board: ApexBoard | null = null;
    try {
      board = await sampleApex(s.scenario, s.leaderboardId);
    } catch (err) {
      // Throttled past the point where waiting is reasonable. Stop, keep what is sampled,
      // and let the next run resume.
      const why = err instanceof RateLimited ? "rate limited" : String(err);
      console.log(
        `\n  stopped at ${s.label}: ${why}\n` +
          `  ${done} of ${wanted.length} done. Re-run to resume; what is sampled is kept.`,
      );
      stoppedEarly = true;
      if (prior) boards.push(prior);
      continue;
    }

    if (!board) {
      console.log(`  ${s.label.padEnd(38)} no usable leaderboard for id ${s.leaderboardId}`);
      done++;
      continue;
    }

    boards.push(board);

    const at = (r: number) => board!.points.find((p) => p.rank === r)?.score ?? "-";
    console.log(
      `  ${`${s.label} ${(pool.windows?.[s.window] ?? "").slice(0, 3)}`.padEnd(38)}` +
        `${String(board.total).padStart(7)} players   ` +
        `WR ${String(at(1)).padStart(8)}   #100 ${String(at(100)).padStart(8)}`,
    );

    done++;
    await sleep(DELAY_MS);
  }

  const merged = new Map(cached);
  for (const b of boards) merged.set(b.scenario, b);

  const cache: Cache = {
    source: "kovaaks.com/webapp-backend/leaderboard/scores/global",
    sampledAt: new Date().toISOString(),
    sampleRanks: APEX_RANKS,
    $comment:
      "The score at fixed board ranks, for the scenarios the season pool names. Serves the " +
      "post-rank board only: no season threshold is cut from this file. It exists because a " +
      "percentile stops resolving at the top - the finest fraction sampled into " +
      "leaderboard_percentiles.json is 0.1%, and the ladder's own hardest rank is already " +
      "0.8% - so the range a post-rank board has to separate is inside the clamp. A rank " +
      "means the same thing on a board of any size, which is what a fraction stops doing up " +
      "here. Re-run tools/sampleApex.ts when the pool changes.",
    boards: [...merged.values()].sort((a, b) => a.scenario.localeCompare(b.scenario)),
  };

  writeFileSync(OUT, JSON.stringify(cache, null, 2) + "\n");

  const covered = wanted.filter((s) => merged.has(s.scenario)).length;
  console.log(
    `\nwrote ${OUT}\n  ${covered}/${wanted.length} scenarios covered` +
      (reused > 0 ? `, ${reused} reused` : "") +
      `\n  ${cache.boards.length} boards cached in total`,
  );

  if (covered < wanted.length) {
    console.log(`\n  ${wanted.length - covered} not sampled. Re-run to resume.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
