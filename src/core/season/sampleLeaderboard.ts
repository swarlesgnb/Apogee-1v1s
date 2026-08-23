/**
 * Sample one scenario's KovaaK's leaderboard into a score distribution.
 *
 * Extracted so the batch tool and the season editor derive thresholds the same way. A
 * scenario added by hand with invented numbers would be the one row in the season that
 * cannot answer "why is this rank here", and the whole point of percentile thresholds is
 * that every one of them can.
 *
 * The board serves any rank directly, so a percentile costs one request:
 *
 *   /leaderboard/scores/global?leaderboardId=<id>&page=<rank-1>&max=1
 *
 * `total` comes back with every response, so the page for a percentile is
 * `floor(total * fraction) - 1`.
 */

import type { Distribution, DistributionPoint } from "./percentiles.ts";

const BASE = "https://kovaaks.com/webapp-backend/leaderboard/scores/global";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";

/**
 * Where to sample, as fractions from the top.
 *
 * Dense at the top and sparse at the bottom, because that is where the curve bends and
 * where the ranks anybody argues about live. Interpolating between 50% and 90% is fine;
 * interpolating between 1% and 25% would not be.
 */
export const SAMPLE_POINTS = [
  0.001, 0.005, 0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8,
  0.95,
];

/**
 * Backoff for a rate limit, in ms.
 *
 * A 429 is not an absent leaderboard, it is a request to slow down, and the only correct
 * response is to wait long enough to matter. Treating the third quick failure as "this
 * scenario has no leaderboard" is how a throttled run once wrote off eighteen scenarios
 * that were all fine.
 */
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 45_000, 90_000];

/** Distinguishes "throttled, gave up" from "there is genuinely nothing here". */
export class RateLimited extends Error {}

export interface SampleOptions {
  /** Pause between requests. 400ms was arrived at by being throttled at 120ms. */
  delayMs?: number;
  points?: number[];
  fetchImpl?: typeof fetch;
  /** Called with 0..1 as sampling proceeds, for a progress readout. */
  onProgress?: (fraction: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(
  url: string,
  impl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFF_MS.length; attempt++) {
    try {
      const res = await impl(url, { headers: { "User-Agent": UA, accept: "application/json" } });
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
 * Sample a leaderboard. Null when it has no entries; throws `RateLimited` when the API
 * asked us to stop and waiting did not clear it.
 */
export async function sampleDistribution(
  scenario: string,
  leaderboardId: number,
  options: SampleOptions = {},
): Promise<Distribution | null> {
  const impl = options.fetchImpl ?? fetch;
  const points = options.points ?? SAMPLE_POINTS;
  const delayMs = options.delayMs ?? 400;

  const first = await getJson(`${BASE}?leaderboardId=${leaderboardId}&page=0&max=1`, impl);
  const total = Number(first?.total ?? 0);
  if (!Number.isFinite(total) || total <= 0) return null;

  const sampled: DistributionPoint[] = [];

  for (const [i, topFraction] of points.entries()) {
    // Rank 1 is the world record, so a fraction maps to a 0-based page directly.
    const page = Math.min(total - 1, Math.max(0, Math.floor(total * topFraction) - 1));
    const body = await getJson(`${BASE}?leaderboardId=${leaderboardId}&page=${page}&max=1`, impl);
    const score = Number((body?.data as { score?: number }[] | undefined)?.[0]?.score);
    if (Number.isFinite(score)) sampled.push({ topFraction, score });
    options.onProgress?.((i + 1) / points.length);
    await sleep(delayMs);
  }

  // Sampled short means gaps an interpolation would cross confidently with no data in
  // them, which is worse than having nothing.
  if (sampled.length !== points.length) return null;

  // Scores must fall as the fraction grows. A board holds ties and the odd bad row, so
  // this is enforced rather than trusted: an out-of-order point would make an
  // interpolation return a score between two numbers it does not sit between.
  sampled.sort((a, b) => a.topFraction - b.topFraction);
  for (let i = 1; i < sampled.length; i++) {
    if (sampled[i].score > sampled[i - 1].score) sampled[i].score = sampled[i - 1].score;
  }

  return {
    scenario,
    leaderboardId,
    total,
    points: sampled,
    sampledAt: new Date().toISOString(),
  };
}
