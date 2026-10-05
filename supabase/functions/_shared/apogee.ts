/**
 * Shared helpers for Apogee's Edge Functions.
 *
 * Two clients, deliberately distinct:
 *
 *   caller client   carries the request's JWT, so RLS applies. Used only to establish
 *                   who is calling.
 *   admin client    service role, bypasses RLS. Used for everything the security model
 *                   says a client must never do: writing ratings, matches, baselines.
 *
 * Keeping them apart in one place makes it hard to reach for the admin client by
 * accident, which is the mistake that would quietly undo the whole design.
 */

import {
  eligibilityMessage,
  MIN_RUNS_TO_QUEUE,
  queueEligibility,
} from "../../../src/core/match/eligibility.ts";
import type { SelectableScenario } from "../../../src/core/match/scenarioSelection.ts";
import type { Rating } from "../../../src/core/rating/glicko2.ts";
import { seasonStanding, seedRating } from "../../../src/core/rating/seed.ts";

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Service-role client. Bypasses RLS: use only for server-owned writes. */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface Caller {
  playerId: string;
  steamId: string;
  displayName: string;
  kovaaksUsername: string | null;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface RatingProposal {
  player_id: string;
  before: { rating: number; rd: number; volatility: number };
  after: { rating: number; rd: number; volatility: number };
  matches_played: number;
  score: number;
  weight: number;
}

/** The database locks the match and commits its sides and ratings as one unit. */
export async function commitMatchResult(
  admin: SupabaseClient, matchId: string, status: "settled" | "void",
  sides: Record<string, unknown>[], ratings: RatingProposal[] = [], forfeit = false,
): Promise<{ committed: boolean; reason?: "already-settled" | "already-played" }> {
  const { data, error } = await admin.rpc("commit_match_result", {
    p_match_id: matchId, p_status: status, p_sides: sides, p_ratings: ratings, p_forfeit: forfeit,
  });
  if (error) throw new HttpError(error.code === "40001" ? 409 : 500, error.message);
  if (typeof data?.committed !== "boolean") throw new HttpError(500, "settlement receipt is missing");
  if (!data.committed && data.reason !== "already-settled" && !(forfeit && data.reason === "already-played")) {
    throw new HttpError(500, "settlement receipt is invalid");
  }
  return data;
}

/**
 * Identify the caller from their JWT.
 *
 * The player id is taken from the verified token, never from the request body. A body
 * field would let anyone file runs, or claim wins, as somebody else.
 */
export async function requireCaller(req: Request, admin: SupabaseClient): Promise<Caller> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "missing Authorization header");

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "invalid or expired session");

  const { data: player, error: playerError } = await admin
    .from("players")
    .select("id, steam_id, display_name, kovaaks_username")
    .eq("id", data.user.id)
    .maybeSingle();

  if (playerError) throw new HttpError(500, playerError.message);
  if (!player) throw new HttpError(403, "no player profile for this account");

  return {
    playerId: player.id,
    steamId: player.steam_id,
    displayName: player.display_name,
    kovaaksUsername: player.kovaaks_username,
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Wrap a handler so thrown HttpErrors become clean responses instead of 500s. */
export function handler(
  fn: (req: Request, admin: SupabaseClient) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
    }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    try {
      return await fn(req, adminClient());
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: err instanceof Error ? err.message : "unexpected error" }, 500);
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

export interface ScenarioRow {
  id: number;
  name: string;
  leaderboard_id: number | null;
  aim_type: string | null;
  sub_category: string | null;
  known_hash: string | null;
  score_model_stat: string | null;
  score_model_k: number | null;
  weapon_score_per_damage: number | null;
  weapon_damage_per_shot: number | null;
  shots_per_second: number | null;
  duration_seconds: number | null;
  world_record: number | null;
}

export async function scenarioByName(
  admin: SupabaseClient,
  name: string,
): Promise<ScenarioRow | null> {
  const { data } = await admin
    .from("scenarios")
    .select(
      "id, name, leaderboard_id, aim_type, sub_category, known_hash, score_model_stat, " +
        "score_model_k, weapon_score_per_damage, weapon_damage_per_shot, " +
        "shots_per_second, duration_seconds, world_record",
    )
    .eq("name", name)
    .maybeSingle();
  return (data as ScenarioRow) ?? null;
}

/**
 * Recompute and store a player's baseline for one scenario.
 *
 * Always derived from stored runs plus the verified personal best, never from anything
 * the client supplied. This is called after every accepted run so the number a match is
 * scored against is current.
 */
type BaselineRule = (s: string, scores: number[], pb?: number | null) => {
  value: number;
  runCount: number;
  provisional: boolean;
  flooredByPb: boolean;
};

/** Runs read per baseline: the same 200 refresh-baselines keeps, of which the rule uses the last 50. */
const BASELINE_HISTORY = 200;

/**
 * One player's baseline on one scenario, from their stored runs.
 *
 * The newest runs, not the oldest. This query used to ask for 200 in ascending order,
 * which on a scenario with more than 200 uploaded runs measured the player against the
 * tail of their first 200, however long ago those were played.
 *
 * `before` restricts it to what the player had played when a match began, less that
 * match's own runs; settle-match says why that matters.
 */
export async function baselineFor(
  admin: SupabaseClient,
  playerId: string,
  scenarioId: number,
  scenarioName: string,
  baselineFromScores: BaselineRule,
  before?: { at: string; matchId: string },
): Promise<ReturnType<BaselineRule>> {
  let query = admin
    .from("runs")
    .select("score")
    .eq("player_id", playerId)
    .eq("scenario_id", scenarioId)
    .neq("verification_tier", "rejected");

  if (before) {
    // `match_id=neq.x` on its own also drops every row whose match_id is null, which is
    // all of uploaded history, so the null case is asked for by name.
    // Receipt time is server-owned. A later upload with a backdated played_at must
    // not change the baseline of a match that has already begun.
    query = query
      .lt("played_at", before.at)
      .lt("created_at", before.at)
      .or(`match_id.is.null,match_id.neq.${before.matchId}`);
  }

  const [runResult, pbResult] = await Promise.all([
    query.order("played_at", { ascending: false }).limit(BASELINE_HISTORY),
    admin
      .from("verified_pbs")
      .select("score")
      .eq("player_id", playerId)
      .eq("scenario_id", scenarioId)
      .maybeSingle(),
  ]);

  if (runResult.error) throw new HttpError(500, runResult.error.message);
  if (pbResult.error) throw new HttpError(500, pbResult.error.message);
  const runs = runResult.data, pb = pbResult.data;

  // Newest first from the query; the rule wants oldest first and reads the tail.
  const scores = (runs ?? []).map((r: { score: number }) => Number(r.score)).reverse();
  return baselineFromScores(scenarioName, scores, pb ? Number(pb.score) : null);
}

export async function refreshBaseline(
  admin: SupabaseClient,
  playerId: string,
  scenarioId: number,
  scenarioName: string,
  baselineFromScores: BaselineRule,
): Promise<void> {
  const baseline = await baselineFor(admin, playerId, scenarioId, scenarioName, baselineFromScores);
  if (baseline.runCount === 0 || !(baseline.value > 0)) return;

  await admin.from("baselines").upsert(
    {
      player_id: playerId,
      scenario_id: scenarioId,
      value: baseline.value,
      run_count: baseline.runCount,
      provisional: baseline.provisional,
      floored_by_pb: baseline.flooredByPb,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "player_id,scenario_id" },
  );
}

/**
 * End a match the player is not going to finish, and charge them for it if it counted.
 *
 * Shared because two paths reach it and they must agree. Pressing Abandon and letting
 * the clock run out are the same act from the ladder's point of view, and if only one
 * of them cost anything, the free one would be the only one anybody used.
 *
 * That mattered little while a match lasted six hours. With a five-minute deadline,
 * waiting it out is the cheapest possible way to escape a match that is going badly,
 * so it has to cost what forfeiting costs.
 *
 * The exceptions are the same in both directions:
 *
 *   SEEDING   one side, by design. There is no opponent to lose to, and inventing a
 *             loss against nobody would be a free way to tank a rating.
 *   PLAYED    the runs are already in. Settlement should decide it, not this.
 */
export interface ForfeitOutcome {
  matchId: string;
  rated: boolean;
  verdict: "loss" | null;
  reason: "forfeit" | "seeding" | "already-played" | "already-settled" | "off-pool";
  ratingBefore?: number;
  ratingAfter?: number;
  ratingChange?: number;
}

/**
 * Whether a match names scenarios its window of the current pool no longer has.
 *
 * Such a match cannot be played: the season's playlists no longer install those scenarios,
 * so there is nothing in KovaaK's to launch, and before `0e1df13` they reached the client
 * as "scenario 947". Membership rather than the season's name, because a rebuilt pool keeps
 * the name.
 *
 * An unreadable pool answers false. That is not evidence the match was unplayable, and a
 * true here makes leaving free.
 */
export async function isOffPool(
  admin: SupabaseClient,
  scenarioIds: number[] | null | undefined,
  windowIndex: number | null | undefined,
): Promise<boolean> {
  const ids = scenarioIds ?? [];
  if (ids.length === 0 || windowIndex == null) return false;
  try {
    const { selectable } = await loadSeasonPool(admin, windowIndex);
    const inPool = new Set(selectable.map((s) => s.id));
    return !ids.every((id) => inPool.has(id));
  } catch {
    return false;
  }
}

export async function forfeitMatch(
  admin: SupabaseClient, matchId: string, playerId: string,
  updateRating: (player: { rating: number; rd: number; volatility: number },
    games: { opponent: { rating: number; rd: number; volatility: number }; score: number }[],
  ) => { rating: number; rd: number; volatility: number },
): Promise<ForfeitOutcome> {
  const sideResult = await admin.from("match_sides")
    .select("player_id, rating_before, rd_before, match_score").eq("match_id", matchId);
  if (sideResult.error) throw new HttpError(500, sideResult.error.message);
  const mine = (sideResult.data ?? []).find((s: any) => s.player_id === playerId);
  const opponent = (sideResult.data ?? []).find((s: any) => s.player_id !== playerId);
  if (!mine) throw new HttpError(403, "you are not in that match");
  const matchResult = await admin.from("matches")
    .select("status, rated, scenario_ids, window_index").eq("id", matchId).maybeSingle();
  if (matchResult.error) throw new HttpError(500, matchResult.error.message);
  const match = matchResult.data;
  if (!match) throw new HttpError(404, "no such match");
  if (match.status === "settled" || match.status === "void") {
    return { matchId, rated: false, verdict: null, reason: "already-settled" };
  }
  if (mine.match_score != null) return { matchId, rated: false, verdict: null, reason: "already-played" };

  const simple = async (status: "settled" | "void", verdict: "loss" | null,
    reason: "seeding" | "off-pool" | "forfeit"): Promise<ForfeitOutcome> => {
    const receipt = await commitMatchResult(admin, matchId, status,
      [{ player_id: playerId, result: verdict }], [], true);
    return { matchId, rated: false, verdict: receipt.committed ? verdict : null,
      reason: receipt.committed ? reason : receipt.reason ?? "already-settled" };
  };
  if (!opponent) return simple("void", null, "seeding");
  if (match.rated === false) return simple("settled", "loss", "forfeit");
  if (await isOffPool(admin, match.scenario_ids, match.window_index)) return simple("void", null, "off-pool");

  const ratingResult = await admin.from("ratings").select("rating, rd, volatility, matches_played")
    .eq("player_id", playerId).maybeSingle();
  if (ratingResult.error) throw new HttpError(500, ratingResult.error.message);
  const ratingRow = ratingResult.data;
  const before = { rating: Number(ratingRow?.rating ?? 1500), rd: Number(ratingRow?.rd ?? 350),
    volatility: Number(ratingRow?.volatility ?? 0.06) };
  const after = updateRating(before, [{ opponent: { rating: Number(opponent.rating_before ?? 1500),
    rd: Number(opponent.rd_before ?? 350), volatility: 0.06 }, score: 0 }]);
  const plans: RatingProposal[] = [{ player_id: playerId, before, after,
    matches_played: Number(ratingRow?.matches_played ?? 0), score: 0, weight: 1 }];
  const sides: Record<string, unknown>[] = [{ player_id: playerId, result: "loss",
    rating_before: before.rating, rating_after: after.rating, rd_before: before.rd, rd_after: after.rd }];
  const challenger = await prepareChallengerRating(admin, matchId, "win", 1, updateRating, before);
  if (challenger) { sides.push(challenger.side); plans.push(challenger.rating); }
  const receipt = await commitMatchResult(admin, matchId, "settled", sides, plans, true);
  if (!receipt.committed) return { matchId, rated: false, verdict: null, reason: receipt.reason ?? "already-settled" };
  return { matchId, rated: true, verdict: "loss", reason: "forfeit",
    ratingBefore: Math.round(before.rating), ratingAfter: Math.round(after.rating),
    ratingChange: Math.round(after.rating - before.rating) };
}

/**
 * The match clock only runs while nobody is playing.
 *
 * A single deadline from match creation charges the player for their own hardware: the
 * three runs are three fixed minutes, and everything left over has to cover launching
 * Steam, loading the game, and moving between scenarios. On a slow machine that is the
 * whole budget, and losing a match to a loading screen is not a rule anybody would
 * agree to.
 *
 * So the deadline is not a total, it is an idle allowance, and it is pushed forward
 * every time a run lands. Playing costs nothing because the clock restarts once the run
 * is in; only sitting in a menu spends it.
 *
 * Enforced from the runs themselves rather than from anything the client reports about
 * what it is doing, which keeps it the same kind of fact as everything else the server
 * decides.
 */

/**
 * Refuse a caller who has not uploaded enough history to play a rated match.
 *
 * Shared rather than copied because it now guards three doors - the queue, sending a
 * duel and accepting one - and a gate enforced in three places is a gate that will be
 * enforced in two of them. A duel is rated exactly like a queued match, so a duel that
 * skipped this would be a documented way around the only thing standing between a fresh
 * Steam account and a rated result.
 *
 * Rejected runs are excluded from the count: a rejection is the file failing local
 * integrity, so uploading garbage must not buy a ticket. See eligibility.ts for where the
 * number comes from and, more importantly, for what this does not prove.
 */
export async function requireEligible(
  admin: SupabaseClient,
  playerId: string,
): Promise<void> {
  const { count, error } = await admin
    .from("runs")
    .select("id", { count: "exact", head: true })
    .eq("player_id", playerId)
    .neq("verification_tier", "rejected");

  if (error) throw new HttpError(500, error.message);

  const eligibility = queueEligibility(count ?? 0, MIN_RUNS_TO_QUEUE);
  if (!eligibility.eligible) throw new HttpError(403, eligibilityMessage(eligibility));
}

export interface SeasonPool {
  season: { id: string; name: string; status: string; windows: string[] | null; window_size: number | null };
  windowName: string;
  selectable: SelectableScenario[];
}

/**
 * The season everybody is playing, and the scenarios in one of its windows.
 *
 * The season owns the pool (PLAN.md §14), so this reads `season_scenarios` rather than a
 * benchmark's membership table. Published wins over draft even when the draft is newer:
 * a published season is frozen, which is the entire reason to publish one, and a draft is
 * what somebody is still editing.
 */
export async function loadSeasonPool(
  admin: SupabaseClient,
  windowIndex: number,
): Promise<SeasonPool> {
  const { data: seasons, error: seasonError } = await admin
    .from("seasons")
    .select("id, name, status, windows, window_size")
    .in("status", ["published", "draft"])
    .order("created_at", { ascending: false })
    .limit(10);

  if (seasonError) throw new HttpError(500, seasonError.message);

  const season =
    (seasons ?? []).find((s: any) => s.status === "published") ?? (seasons ?? [])[0];

  if (!season) {
    // Explicit rather than falling back to some other pool. A match drawn from scenarios
    // the season does not contain would be graded against thresholds that do not
    // describe it, which is worse than no match at all.
    throw new HttpError(503, "no season is loaded: push one with npm run push:season");
  }

  const windowName: string = season.windows?.[windowIndex] ?? `window ${windowIndex + 1}`;

  const { data: pool, error: poolError } = await admin
    .from("season_scenarios")
    .select("scenario_id, window_index, category, scenarios!inner(id, name, aim_type, sub_category)")
    .eq("season_id", season.id)
    .eq("window_index", windowIndex);

  if (poolError) throw new HttpError(500, poolError.message);

  // Filed by the category the season gives the scenario, not the catalogue-wide
  // sub_category. The season decides which ladder a scenario belongs to (PLAN.md §14),
  // and reading the other column let the two disagree, so a queue could draw a scenario
  // the season files under a different category whenever the catalogue lagged a season
  // edit. The catalogue value stays as the fallback for a row pushed before seasons
  // recorded a category.
  const selectable: SelectableScenario[] = (pool ?? []).map((row: any) => ({
    id: row.scenarios.id,
    name: row.scenarios.name,
    aimType: row.scenarios.aim_type,
    subCategory: row.category ?? row.scenarios.sub_category,
  }));

  if (selectable.length === 0) {
    throw new HttpError(404, `${season.name} has no scenarios in ${windowName}`);
  }

  return { season, windowName, selectable };
}

export interface LiveMatch {
  matchId: string;
  /** The joined `matches` row, so a caller can answer with it rather than re-reading. */
  match: {
    id: string;
    status: string;
    category: string;
    difficulty: string;
    scenario_ids: number[];
    expires_at: string | null;
  };
}

/**
 * Retire this player's expired matches, and report whether a live one is left.
 *
 * THE RULE THIS CARRIES
 *
 * A player may hold one match at a time. Without that they could open several, play the
 * scenarios, see which set went best, submit that one and abandon the rest - and because
 * scores are read from a stats folder rather than typed in, every one of those matches is
 * playable before the choice is made. It is the only thing standing between the ladder
 * and a free reroll.
 *
 * It lived inside find-match while find-match was the only way to start a match. Duels
 * are a second and a third, and a rule enforced in three places is a rule that will be
 * enforced in two of them.
 *
 * WHY IT SWEEPS BEFORE IT ANSWERS
 *
 * Matches were given an `expires_at` and for a while nothing ever acted on it, so a match
 * somebody walked away from blocked them permanently rather than until it expired: the
 * guard reads the status, and the status never changed on its own. Running out of time is
 * a forfeit rather than a free pass - at eight minutes it means they did not finish, and
 * if that costs nothing then waiting out the clock is strictly cheaper than pressing
 * Abandon, so the button that costs a loss would never be pressed again.
 *
 * `forfeitMatch` does the charging, shared with abandon-match so the two cannot disagree,
 * and it still costs nothing for a seeding match or one whose runs are already in.
 */
export async function sweepStaleMatches(
  admin: SupabaseClient,
  playerId: string,
  updateRating: (
    player: { rating: number; rd: number; volatility: number },
    games: { opponent: { rating: number; rd: number; volatility: number }; score: number }[],
  ) => { rating: number; rd: number; volatility: number },
): Promise<LiveMatch | null> {
  const { data: rows } = await admin
    .from("match_sides")
    .select("match_id, submitted_at, matches!inner(id, status, category, difficulty, scenario_ids, window_index, expires_at, created_at)")
    .eq("player_id", playerId)
    .in("matches.status", ["open", "awaiting_runs"]);

  // A copy of this player's stored run set, sitting in somebody else's live match, is not
  // a match this player is in. Treating it as one resumed them into a stranger's match.
  const openMatches = (rows ?? []).filter((row: any) => !isCopiedSide(row, row.matches));

  const now = Date.now();
  const expired = openMatches.filter((row: any) => {
    const expiresAt = row.matches?.expires_at;
    return expiresAt != null && new Date(expiresAt).getTime() < now;
  });

  // A live match on a pool that has since been rebuilt is retired here too, rather than
  // handed back. Resuming it was the playtest bug: the queue kept returning the same
  // unplayable three, and the only exit was Abandon. forfeitMatch voids it for nothing.
  const offPool: any[] = [];
  for (const row of openMatches) {
    if (expired.includes(row)) continue;
    const m = (row as any).matches;
    if (await isOffPool(admin, m?.scenario_ids, m?.window_index)) offPool.push(row);
  }
  const stale = [...expired, ...offPool];

  for (const row of stale) {
    await forfeitMatch(admin, (row as any).match_id, playerId, updateRating);
  }

  const staleIds = new Set(stale.map((row: any) => row.match_id));
  const live = openMatches.find((row: any) => !staleIds.has(row.match_id));

  return live ? { matchId: (live as any).match_id, match: (live as any).matches } : null;
}

/**
 * Whether a side is a stored run set copied into someone else's match.
 *
 * find-match, answer-duel and play-fixture all answer a caller with an opponent's
 * finished side, inserted into the new match under the OPPONENT's player_id. Every
 * lookup of the form "this player's side of an open match" therefore also finds those
 * copies, and each one that trusted it was a bug: the owner was resumed into the
 * stranger's match, could submit runs into it and settle it out from under them, and
 * Abandon hit the copy and reported "already played" while their real match stayed open.
 *
 * A copy carries the submitted_at of the run set it was copied from, which was
 * necessarily before the match it now sits in was created; a side played IN a match is
 * submitted after it. That holds through a settle that died halfway, which is why this
 * is not "match_score is set": a retried settle would have been refused by that.
 */
export function isCopiedSide(
  side: { submitted_at?: string | null },
  match: { created_at?: string | null } | null | undefined,
): boolean {
  if (!side.submitted_at || !match?.created_at) return false;
  return new Date(side.submitted_at).getTime() < new Date(match.created_at).getTime();
}

/**
 * The identity of a stored run set, shared by the original and every copy of it.
 *
 * `match_id:player_id` named the SIDE, and a copy is a new side, so a player who had
 * played a copy was offered the original straight back, and each copy became a fresh
 * candidate of its own. The owner and the moment it was played survive copying.
 */
export function runSetId(side: { player_id: string; submitted_at: string }): string {
  return `${side.player_id}@${new Date(side.submitted_at).toISOString()}`;
}

/**
 * Rate the player whose stored run set was just played against, when it was a duel.
 *
 * WHY THIS DOES NOT APPLY TO THE QUEUE
 *
 * `settle-match` rates the caller and nobody else, and for the pool that is right rather
 * than an oversight. A stored side is never consumed: it answers as many callers as draw
 * it, so rating its owner on every one would multiply a single afternoon's performance
 * into ten rating changes they did not play for. You are rated for matches you played,
 * not for being a record somebody else played against.
 *
 * A duel is the one case where that reasoning does not hold. It is addressed at exactly
 * one person and answered exactly once, so the run set is used for one contest and its
 * owner sat down to play it knowing who it was for. Leaving them unrated is what makes
 * sending a duel a purely charitable act - it would move nothing for the sender, so the
 * only rated thing anybody could do is answer one, and a feature nobody has a reason to
 * start is a feature that does not happen.
 *
 * This prepares both a side update and a rating proposal without writing either.
 * The caller commits these with its own result in commit_match_result, which checks
 * current ratings under locks and refuses duplicate terminal transitions.
 *
 * Their rating is read live from `ratings` rather than from `rating_before` on the frozen
 * side, which was written when they played and may be days and several matches stale. Same
 * split `forfeitMatch` makes above, and for the same reason.
 */
export async function prepareChallengerRating(
  admin: SupabaseClient,
  answerMatchId: string,
  challengerVerdict: "win" | "loss" | "draw",
  weight: number,
  updateRating: (
    player: { rating: number; rd: number; volatility: number },
    games: { opponent: { rating: number; rd: number; volatility: number }; score: number }[],
  ) => { rating: number; rd: number; volatility: number },
  opponentBefore?: { rating: number; rd: number },
): Promise<{ side: Record<string, unknown>; rating: RatingProposal } | null> {
  const { data: duel, error: duelError } = await admin
    .from("duels")
    .select("id, challenger_id")
    .eq("answer_match_id", answerMatchId)
    .maybeSingle();

  if (duelError) throw new HttpError(500, duelError.message);
  if (!duel) return null;

  const { data: sides, error: sidesError } = await admin
    .from("match_sides")
    .select("player_id, deltas, result, rating_before, rd_before")
    .eq("match_id", answerMatchId);

  if (sidesError) throw new HttpError(500, sidesError.message);
  const theirs = (sides ?? []).find(
    (s: { player_id: string }) => s.player_id === duel.challenger_id,
  );
  const opponent = (sides ?? []).find(
    (s: { player_id: string }) => s.player_id !== duel.challenger_id,
  );

  if (!theirs || !opponent) throw new HttpError(500, "duel sides are incomplete");
  if (theirs.result != null) return null;
  if (!Array.isArray(theirs.deltas) || theirs.deltas.length === 0) {
    return null;
  }

  const { data: ratingRow, error: ratingError } = await admin
    .from("ratings")
    .select("rating, rd, volatility, matches_played")
    .eq("player_id", duel.challenger_id)
    .maybeSingle();

  if (ratingError) throw new HttpError(500, ratingError.message);
  const before = {
    rating: Number(ratingRow?.rating ?? 1500),
    rd: Number(ratingRow?.rd ?? 350),
    volatility: Number(ratingRow?.volatility ?? 0.06),
  };

  const score = challengerVerdict === "win" ? 1 : challengerVerdict === "loss" ? 0 : 0.5;

  const raw = updateRating(before, [
    {
      opponent: {
        rating: opponentBefore?.rating ?? Number(opponent.rating_before ?? 1500),
        rd: opponentBefore?.rd ?? Number(opponent.rd_before ?? 350),
        volatility: 0.06,
      },
      score,
    },
  ]);

  const after = {
    rating: before.rating + (raw.rating - before.rating) * weight,
    rd: before.rd + (raw.rd - before.rd) * weight,
    volatility: raw.volatility,
  };
  return {
    side: {
      player_id: duel.challenger_id, result: challengerVerdict,
      rating_before: before.rating, rating_after: after.rating,
      rd_before: before.rd, rd_after: after.rd, record_submission: false,
    },
    rating: {
      player_id: duel.challenger_id, before, after,
      matches_played: Number(ratingRow?.matches_played ?? 0), score, weight,
    },
  };
}


/**
 * How long a player may idle between runs before the match expires.
 *
 * Three, not five, because this clock no longer has to cover playing. Once loading and
 * running are free, the only thing left to buy is the gap between scenarios, and a
 * generous gap is exactly what lets someone hold an opponent's run set hostage: stall
 * to the last second of each round and a three-minute match becomes a quarter of an
 * hour, with a win at the end of it.
 */
export const IDLE_ALLOWANCE_MS = 3 * 60_000;

/**
 * Extra allowance before the first run only.
 *
 * The first one may need Steam started and the game loaded from cold, which has nothing
 * to do with how long the player is willing to take.
 */
export const LAUNCH_ALLOWANCE_MS = 5 * 60_000;

/**
 * How long a new match has before it is forfeit.
 *
 * Long enough to start Steam, launch the game and play three scenarios, and no longer.
 * Shared because three paths create matches now - the queue and both ends of a duel - and
 * a deadline that differed between them would be a match that expired early on one route
 * and late on another.
 *
 * Not to be confused with a duel's own clock, which is days: that one is how long a
 * person has to notice an invitation, this one is how long a session takes.
 */
export const INITIAL_TTL_MS = IDLE_ALLOWANCE_MS + LAUNCH_ALLOWANCE_MS;

/** When a match should expire, given the moment the last run finished. */
export function deadlineAfterRun(lastRunEndedAt: Date): Date {
  return new Date(lastRunEndedAt.getTime() + IDLE_ALLOWANCE_MS);
}

/**
 * The rating a player without one starts at, written so settlement reads the same one.
 *
 * Seeded from where their verified PBs sit on this season's thresholds (core/rating/
 * seed.ts). Written here rather than only returned, because settle-match reads the
 * ratings row and would otherwise settle a seeded player's first match from the 1500 a
 * missing row defaults to. A row somebody else wrote first wins: on conflict the seed is
 * dropped and the stored row is read back.
 */
export async function seedRatingRow(
  admin: SupabaseClient,
  seasonId: string,
  windowSize: number | null,
  playerId: string,
): Promise<Rating> {
  const [scenarioResult, pbResult] = await Promise.all([
    admin
      .from("season_scenarios")
      .select("scenario_id, family, window_index, rank_maxes")
      .eq("season_id", seasonId),
    admin.from("verified_pbs").select("scenario_id, score").eq("player_id", playerId),
  ]);
  if (scenarioResult.error) throw new HttpError(500, scenarioResult.error.message);
  if (pbResult.error) throw new HttpError(500, pbResult.error.message);

  const standing = seasonStanding(
    (scenarioResult.data ?? []).map((s: any) => ({
      scenarioId: Number(s.scenario_id),
      family: s.family ?? null,
      windowIndex: Number(s.window_index ?? 0),
      rankMaxes: (s.rank_maxes ?? []).map(Number),
    })),
    new Map((pbResult.data ?? []).map((p: any) => [Number(p.scenario_id), Number(p.score)])),
    windowSize,
  );
  const seeded = seedRating(standing?.standing ?? null);

  const { error: insertError } = await admin
    .from("ratings")
    .upsert(
      { player_id: playerId, rating: seeded.rating, rd: seeded.rd, volatility: seeded.volatility },
      { onConflict: "player_id", ignoreDuplicates: true },
    );
  if (insertError) throw new HttpError(500, insertError.message);

  const { data: row, error: readError } = await admin
    .from("ratings")
    .select("rating, rd, volatility")
    .eq("player_id", playerId)
    .maybeSingle();
  if (readError) throw new HttpError(500, readError.message);

  return row
    ? { rating: Number(row.rating), rd: Number(row.rd), volatility: Number(row.volatility) }
    : seeded;
}
