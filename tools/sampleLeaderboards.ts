/**
 * Sample every season scenario's KovaaK's leaderboard, and cache the distributions.
 *
 * This is what replaces a borrowed set of thresholds. KovaaK's publishes a global
 * leaderboard per scenario and will serve any rank on it directly, so the score at a given
 * percentile costs one request:
 *
 *   /leaderboard/scores/global?leaderboardId=<id>&page=<rank-1>&max=1
 *
 * `total` comes back with every response, so the page for a percentile is just
 * `floor(total * fraction) - 1`.
 *
 * Written to `data/leaderboard_percentiles.json` and committed, for the same reason every
 * other reference file here is: the app must owe nothing to a service being reachable at
 * runtime, and a ladder that changed underneath a season would defeat the point of
 * freezing one.
 *
 * Polite by construction - one request at a time with a pause between - because this is
 * somebody else's public API and the whole job only needs doing when the pool changes.
 *
 *   npx tsx tools/sampleLeaderboards.ts [--only <n>] [--delay <ms>]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { loadSeason } from "../src/core/season/season.ts";
import {
  sampleDistribution,
  RateLimited,
  SAMPLE_POINTS,
} from "../src/core/season/sampleLeaderboard.ts";
import type { Distribution } from "../src/core/season/percentiles.ts";

const OUT = join(dataFile("."), "leaderboard_percentiles.json");

const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt !== -1 ? Number(args[onlyAt + 1]) : Infinity;
const delayAt = args.indexOf("--delay");
const delayMs = delayAt !== -1 ? Number(args[delayAt + 1]) : undefined;

interface Cache {
  source: string;
  sampledAt: string;
  samplePoints: number[];
  distributions: Distribution[];
}

/**
 * Every scenario named by a committed benchmark definition.
 *
 * Sampling these is what makes another ladder usable as a reference: their thresholds are
 * scores on their own scenarios, and a score means nothing across two different scenarios.
 * Converted to percentiles of the board each was set on, they become comparable - and
 * comparable is the whole point of looking at somebody else's ladder.
 */
function benchmarkScenarios(): { scenario: string; label: string; leaderboardId: number | null; window: number }[] {
  const dir = join(dataFile("."), "benchmarks");
  const out = new Map<string, { scenario: string; label: string; leaderboardId: number | null; window: number }>();

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const def = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      benchmarkName: string;
      difficulties: { name: string; categories: { scenarios: { name: string; leaderboardId: number | null }[] }[] }[];
    };

    for (const difficulty of def.difficulties ?? []) {
      for (const category of difficulty.categories ?? []) {
        for (const scenario of category.scenarios ?? []) {
          if (!scenario.leaderboardId || out.has(scenario.name)) continue;
          out.set(scenario.name, {
            scenario: scenario.name,
            label: `${def.benchmarkName} ${difficulty.name}`,
            leaderboardId: scenario.leaderboardId,
            window: 0,
          });
        }
      }
    }
  }

  return [...out.values()];
}

async function main(): Promise<void> {
  const season = loadSeason();

  // Re-sampling is expensive and mostly unnecessary, so anything already cached for the
  // same scenario is kept unless the pool changed.
  let existing: Cache | null = null;
  try {
    existing = JSON.parse(readFileSync(OUT, "utf8")) as Cache;
  } catch {
    // First run.
  }
  const cached = new Map((existing?.distributions ?? []).map((d) => [d.scenario, d]));
  const sameShape =
    JSON.stringify(existing?.samplePoints ?? []) === JSON.stringify(SAMPLE_POINTS);

  // The season pool by default; every benchmark's scenarios with --benchmarks, which is
  // what the cross-benchmark reference sheet reads.
  const source = args.includes("--benchmarks")
    ? benchmarkScenarios()
    : season.scenarios.map((s) => ({
        scenario: s.scenario,
        label: s.label ?? s.scenario,
        leaderboardId: s.leaderboardId,
        window: s.window ?? 0,
      }));

  const wanted = source.filter((s) => s.leaderboardId != null);
  const skipped = source.length - wanted.length;

  console.log(
    `sampling ${Math.min(wanted.length, only)} of ${wanted.length} scenarios at ` +
      `${SAMPLE_POINTS.length} points each` +
      (skipped > 0 ? `, skipping ${skipped} with no leaderboard` : ""),
  );

  const distributions: Distribution[] = [];
  let done = 0;
  let reused = 0;
  let stoppedEarly = false;

  for (const s of wanted) {
    if (stoppedEarly) {
      const prior = cached.get(s.scenario);
      if (prior && prior.points.length === SAMPLE_POINTS.length) distributions.push(prior);
      continue;
    }

    if (done >= only) {
      // Keep whatever was already cached for the rest, so a partial run is still a valid
      // file rather than one that silently lost most of its scenarios.
      const prior = cached.get(s.scenario);
      if (prior) distributions.push(prior);
      continue;
    }

    // Reused only when complete. A partially-sampled distribution is worse than none: it
    // interpolates confidently across gaps it has no points in, and it looks cached.
    const prior = cached.get(s.scenario);
    if (prior && sameShape && prior.points.length === SAMPLE_POINTS.length) {
      distributions.push(prior);
      reused++;
      done++;
      continue;
    }

    let dist: Distribution | null = null;

    try {
      dist = await sampleDistribution(s.scenario, s.leaderboardId!, {
        points: SAMPLE_POINTS,
        delayMs,
      });
    } catch (err) {
      // Throttled past the point where waiting is reasonable. Stop, keep what is already
      // sampled, and let the next run resume - rather than marching through the rest of
      // the pool recording every scenario as missing.
      const why =
        err instanceof RateLimited
          ? "rate limited"
          : err instanceof Error
            ? err.message
            : String(err);
      console.log(
        `\n  stopped at ${s.label ?? s.scenario}: ${why}\n` +
          `  ${done} of ${wanted.length} done. Re-run to resume; what is sampled is kept.`,
      );
      stoppedEarly = true;
      continue;
    }

    if (!dist) {
      console.log(
        `  ${(s.label ?? s.scenario).padEnd(22)} no usable leaderboard for id ${s.leaderboardId}`,
      );
      done++;
      continue;
    }

    distributions.push(dist);

    // The window, because three variants of a family share a label and three identical
    // lines with different numbers is a log nobody can read.
    const shown = args.includes("--benchmarks")
      ? s.scenario
      : `${s.label} ${(season.windows?.[s.window] ?? "").slice(0, 3)}`;
    const at = (f: number) => dist!.points.find((x) => x.topFraction === f)?.score ?? "?";

    console.log(
      `  ${shown.padEnd(22)} ${String(dist.total).padStart(7)} players   ` +
        `top 1% ${String(at(0.01)).padStart(8)}   median ${at(0.5)}`,
    );

    done++;
  }

  // Merged with whatever was already cached, never replacing it.
  //
  // A run only walks the scenarios it was asked for, so writing just those would delete
  // every distribution outside this run's scope - and sampling the benchmark scenarios
  // would silently take the season's own thresholds with it. The cache is a growing store
  // of boards, not a record of the last invocation.
  const merged = new Map(cached);
  for (const d of distributions) merged.set(d.scenario, d);

  const cache: Cache = {
    source: "kovaaks.com/webapp-backend/leaderboard/scores/global",
    sampledAt: new Date().toISOString(),
    samplePoints: SAMPLE_POINTS,
    distributions: [...merged.values()].sort((a, b) => a.scenario.localeCompare(b.scenario)),
  };

  writeFileSync(OUT, JSON.stringify(cache, null, 2) + "\n");

  // Coverage is of what this run asked for; the cache holds more than that.
  const covered = wanted.filter((s) => merged.has(s.scenario)).length;

  console.log(
    `\nwrote ${OUT}\n  ${covered}/${wanted.length} asked for` +
      (reused > 0 ? `, ${reused} reused from cache` : "") +
      `\n  ${cache.distributions.length} distributions cached in total, behind ` +
      `${cache.distributions.reduce((n, d) => n + d.total, 0).toLocaleString()} entries`,
  );

  if (covered < wanted.length) {
    console.log(
      `\n${wanted.length - covered} still to sample. Re-run this; everything already ` +
        `cached is kept.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
