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
 * measured against, by a one-off scan of gaps between consecutive runs:
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

  /**
   * 10 per 5 minutes. Reasoned rather than measured - there is no corpus of leaderboard
   * refreshes - and set by what the call costs: it reads the caller's verified bests on
   * the graded scenarios and the sampled board for each, which is bounded by the size of
   * the pool rather than by the player's history. Cheaper than a baseline refresh, so a
   * looser limit, but not free, and the standing only moves when a PB does.
   *
   * Note that an action absent from this record is not limited at all - `enforceRateLimit`
   * returns on an unknown key - so a new function that forgets to add itself here gets a
   * silent pass rather than a default.
   */
  "refresh-apex": { max: 10, windowSeconds: 300 },

  /**
   * 60 per 5 minutes. A read, and the cheapest one here: two counts and a fifty-row
   * page off an index built for exactly this query. Loose because opening the Apex
   * screen and flicking between its four categories is four calls, and a player doing
   * that a few times in a session should never meet a limit they did nothing to earn.
   */
  "apex-board": { max: 60, windowSeconds: 300 },

  /**
   * 10 per 5 minutes. The expensive one of the three and the only abusable one: each call
   * inserts a match and a duel, and a loop here fills somebody else's inbox rather than
   * costing only the caller. Reasoned rather than measured - there is no corpus of duels,
   * which is the honest state - and set well above what anybody sends in a sitting.
   */
  "send-duel": { max: 10, windowSeconds: 300 },

  /** Accepting creates a match; declining is free. One limit, set by the expensive half. */
  "answer-duel": { max: 30, windowSeconds: 300 },

  /**
   * 60 per 5 minutes. A read, and the client refreshes it after every action as well as
   * on the way in, so this is loose on purpose: somebody working through an inbox of five
   * should never meet a limit they did nothing to earn.
   */
  "list-duels": { max: 60, windowSeconds: 300 },

  /**
   * 60 per 5 minutes, the same as the duel board and for the same reason: a read, and the
   * client asks again after every action and every half minute while the tournament screen
   * is open. Twenty seconds of polling is ten calls per window, a sixth of this.
   */
  "list-tournaments": { max: 60, windowSeconds: 300 },

  /**
   * 30 per 5 minutes. Entering, checking in and out, and a host sorting a roster of
   * sixteen are a few calls each; nothing here is expensive, but every one is a write.
   */
  "tournament-action": { max: 30, windowSeconds: 300 },

  /**
   * 5 per hour, counted on top of tournament-action. Creating is the one action that adds
   * a row to everybody's list, and one live tournament per host is already the rule, so
   * anybody hitting this is creating and cancelling in a loop.
   */
  "tournament-create": { max: 5, windowSeconds: 3600 },

  /**
   * 20 per 5 minutes, the same as find-match: each call can create a match, and a player
   * has at most one fixture open at a time.
   */
  "play-fixture": { max: 20, windowSeconds: 300 },

  /**
   * 10 per 5 minutes, send-duel's number and for a like reason: each call parses and
   * verifies three CSVs, may ask KovaaK's about each, and reads three scenarios of
   * history. A ghost match takes several minutes to play, so nobody honest posts more
   * than one card in five, and a retry after a refusal still has room. Reasoned rather
   * than measured: there are no ghost cards yet.
   */
  "post-ghost": { max: 10, windowSeconds: 300 },

  /** 60 per 5 minutes: a read by code off a unique index, the price of list-duels. */
  "ghost-card": { max: 60, windowSeconds: 300 },
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
