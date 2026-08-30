/**
 * Per-player request limits.
 *
 * A new file rather than another export bolted onto apogee.ts, because the limits below
 * are a claim about measured behaviour and they should sit next to the evidence for
 * them rather than in a grab bag of helpers.
 *
 * The counter itself lives in Postgres (`consume_rate_limit`, migration
 * 20260824000012). Edge Functions run on many isolates at once, so an in-memory counter
 * would see a fraction of the traffic and limit nothing.
 */

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { HttpError } from "./apogee.ts";

export interface Limit {
  /** Requests permitted per window. */
  max: number;
  /** Window length, in seconds. */
  windowSeconds: number;
}

/**
 * The limits, and why each number is that number.
 *
 * MEASURED against the 11,606-file stats corpus that every verification check was
 * measured against (`scratchpad/measureGaps.mjs` derived these):
 *
 *   shortest gap between two genuine consecutive runs   2.0s
 *   busiest genuine 60-second window                    12 runs
 *   busiest genuine 5-minute window                     28 runs
 *
 * So 12 per minute is a number a real player has already beaten. Anything at or below
 * it would reject honest play, which the codebase treats as worse than no check at all.
 */
export const LIMITS: Record<string, Limit> = {
  /**
   * 30/min: two and a half times the busiest minute ever observed, so no genuine burst
   * reaches it, while a scripted caller is still capped. This is the expensive one -
   * every call parses a CSV, runs verification, and may hit KovaaK's servers, so the
   * limit protects them as much as us.
   */
  "submit-run": { max: 30, windowSeconds: 60 },

  /**
   * 20 per 5 minutes. No corpus for this one - queueing is not something the stats
   * folder records - so it is reasoned rather than measured, and deliberately loose:
   * a player fiddling with categories, cancelling and requeueing, should never see it.
   * Worth revisiting once real queue traffic exists, which is the honest state today.
   */
  "find-match": { max: 20, windowSeconds: 300 },

  /** Settlement is driven by run submission, so this only catches a loop. */
  "settle-match": { max: 30, windowSeconds: 60 },

  /** Abandoning repeatedly is cheap for us and pointless for them, but cap it anyway. */
  "abandon-match": { max: 20, windowSeconds: 300 },

  /**
   * Baseline refresh is the heaviest read in the system: it walks a player's history.
   * Nothing legitimate calls it in a loop.
   */
  "refresh-baselines": { max: 6, windowSeconds: 300 },
};

/**
 * Count one request and reject it if the player is over their limit.
 *
 * Fails OPEN. If the counter itself errors - a migration not yet applied, a transient
 * database problem - the request proceeds and the failure is logged. That is the right
 * trade for this system: rate limiting protects against abuse, and refusing every
 * honest player because the limiter is unavailable turns a small problem into an
 * outage. Nothing here is a security control; the security controls are RLS and the
 * verification tiers, and neither depends on this.
 */
export async function enforceRateLimit(
  admin: SupabaseClient,
  playerId: string,
  action: keyof typeof LIMITS | string,
): Promise<void> {
  const limit = LIMITS[action];
  if (!limit) return;

  const { data, error } = await admin.rpc("consume_rate_limit", {
    p_player: playerId,
    p_action: action,
    p_limit: limit.max,
    p_window: `${limit.windowSeconds} seconds`,
  });

  if (error) {
    console.error(`rate limit check failed for ${action}, allowing request:`, error.message);
    return;
  }

  if (data === false) {
    throw new HttpError(
      429,
      `Too many ${action} requests. The limit is ${limit.max} every ` +
        `${limit.windowSeconds} seconds; wait a moment and try again.`,
    );
  }
}
