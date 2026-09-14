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
    query = query
      .lt("played_at", before.at)
      .or(`match_id.is.null,match_id.neq.${before.matchId}`);
  }

  const [{ data: runs }, { data: pb }] = await Promise.all([
    query.order("played_at", { ascending: false }).limit(BASELINE_HISTORY),
    admin
      .from("verified_pbs")
      .select("score")
      .eq("player_id", playerId)
      .eq("scenario_id", scenarioId)
      .maybeSingle(),
  ]);

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
  reason: "forfeit" | "seeding" | "already-played";
  ratingBefore?: number;
  ratingAfter?: number;
  ratingChange?: number;
}

export async function forfeitMatch(
  admin: SupabaseClient,
  matchId: string,
  playerId: string,
  updateRating: (
    player: { rating: number; rd: number; volatility: number },
    games: { opponent: { rating: number; rd: number; volatility: number }; score: number }[],
  ) => { rating: number; rd: number; volatility: number },
): Promise<ForfeitOutcome> {
  const settledAt = new Date().toISOString();

  const { data: sides } = await admin
    .from("match_sides")
    .select("player_id, rating_before, rd_before, match_score")
    .eq("match_id", matchId);

  const mine = (sides ?? []).find((s: { player_id: string }) => s.player_id === playerId);
  const opponent = (sides ?? []).find((s: { player_id: string }) => s.player_id !== playerId);

  // Already scored: this is a finished match waiting to settle, not an abandoned one.
  if (mine?.match_score != null) {
    return { matchId, rated: false, verdict: null, reason: "already-played" };
  }

  if (!opponent) {
    await admin
      .from("match_sides")
      .update({ result: null, submitted_at: settledAt })
      .eq("match_id", matchId)
      .eq("player_id", playerId);

    await admin
      .from("matches")
      .update({ status: "void", settled_at: settledAt })
      .eq("id", matchId);

    return { matchId, rated: false, verdict: null, reason: "seeding" };
  }

  // A tournament leg: the loss is recorded, because it decides the fixture, and nothing
  // else moves. The rule that abandoning costs what losing costs still holds - in a
  // tournament what losing costs is the fixture, not rating.
  const { data: matchRow } = await admin.from("matches").select("rated").eq("id", matchId).maybeSingle();
  if (matchRow?.rated === false) {
    await admin
      .from("match_sides")
      .update({ result: "loss", submitted_at: settledAt })
      .eq("match_id", matchId)
      .eq("player_id", playerId);

    await admin
      .from("matches")
      .update({ status: "settled", settled_at: settledAt })
      .eq("id", matchId);

    return { matchId, rated: false, verdict: "loss", reason: "forfeit" };
  }

  const { data: ratingRow } = await admin
    .from("ratings")
    .select("rating, rd, volatility, matches_played")
    .eq("player_id", playerId)
    .maybeSingle();

  const before = {
    rating: Number(ratingRow?.rating ?? 1500),
    rd: Number(ratingRow?.rd ?? 350),
    volatility: Number(ratingRow?.volatility ?? 0.06),
  };

  const after = updateRating(before, [
    {
      opponent: {
        rating: Number(opponent.rating_before ?? 1500),
        rd: Number(opponent.rd_before ?? 350),
        volatility: 0.06,
      },
      score: 0,
    },
  ]);

  await admin
    .from("match_sides")
    .update({
      result: "loss",
      rating_before: before.rating,
      rating_after: after.rating,
      rd_before: before.rd,
      rd_after: after.rd,
      submitted_at: settledAt,
    })
    .eq("match_id", matchId)
    .eq("player_id", playerId);

  await admin.from("ratings").upsert(
    {
      player_id: playerId,
      rating: after.rating,
      rd: after.rd,
      volatility: after.volatility,
      matches_played: Number(ratingRow?.matches_played ?? 0) + 1,
      updated_at: settledAt,
    },
    { onConflict: "player_id" },
  );

  await admin.from("rating_history").insert({
    player_id: playerId,
    match_id: matchId,
    rating_before: before.rating,
    rating_after: after.rating,
    rd_before: before.rd,
    rd_after: after.rd,
    result: 0,
    weight: 1,
  });

  await admin
    .from("matches")
    .update({ status: "settled", settled_at: settledAt })
    .eq("id", matchId);

  return {
    matchId,
    rated: true,
    verdict: "loss",
    reason: "forfeit",
    ratingBefore: Math.round(before.rating),
    ratingAfter: Math.round(after.rating),
    ratingChange: Math.round(after.rating - before.rating),
  };
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
  season: { id: string; name: string; status: string; windows: string[] | null };
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
  const { data: openMatches } = await admin
    .from("match_sides")
    .select("match_id, matches!inner(id, status, category, difficulty, scenario_ids, expires_at)")
    .eq("player_id", playerId)
    .in("matches.status", ["open", "awaiting_runs"]);

  const now = Date.now();
  const stale = (openMatches ?? []).filter((row: any) => {
    const expiresAt = row.matches?.expires_at;
    return expiresAt != null && new Date(expiresAt).getTime() < now;
  });

  for (const row of stale) {
    await forfeitMatch(admin, (row as any).match_id, playerId, updateRating);
  }

  const staleIds = new Set(stale.map((row: any) => row.match_id));
  const live = (openMatches ?? []).find((row: any) => !staleIds.has(row.match_id));

  return live ? { matchId: (live as any).match_id, match: (live as any).matches } : null;
}

export interface ChallengerOutcome {
  rated: boolean;
  reason: "not-a-duel" | "already-rated" | "no-deltas" | "rated";
  ratingBefore?: number;
  ratingAfter?: number;
  ratingChange?: number;
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
 * WHAT KEEPS IT FROM RUNNING TWICE
 *
 * The challenger's side carries no `result` until this writes one, so a second call finds
 * one and stops. That is the guard rather than a unique constraint because `rating_history`
 * deliberately has none - it is a log, and a log that refuses duplicates cannot record a
 * player meeting the same opponent twice.
 *
 * Their rating is read live from `ratings` rather than from `rating_before` on the frozen
 * side, which was written when they played and may be days and several matches stale. Same
 * split `forfeitMatch` makes above, and for the same reason.
 */
export async function rateChallenger(
  admin: SupabaseClient,
  answerMatchId: string,
  challengerVerdict: "win" | "loss" | "draw",
  weight: number,
  updateRating: (
    player: { rating: number; rd: number; volatility: number },
    games: { opponent: { rating: number; rd: number; volatility: number }; score: number }[],
  ) => { rating: number; rd: number; volatility: number },
): Promise<ChallengerOutcome> {
  const { data: duel } = await admin
    .from("duels")
    .select("id, challenger_id")
    .eq("answer_match_id", answerMatchId)
    .maybeSingle();

  if (!duel) return { rated: false, reason: "not-a-duel" };

  const { data: sides } = await admin
    .from("match_sides")
    .select("player_id, deltas, result, rating_before, rd_before")
    .eq("match_id", answerMatchId);

  const theirs = (sides ?? []).find(
    (s: { player_id: string }) => s.player_id === duel.challenger_id,
  );
  const opponent = (sides ?? []).find(
    (s: { player_id: string }) => s.player_id !== duel.challenger_id,
  );

  if (!theirs || !opponent) return { rated: false, reason: "not-a-duel" };
  if (theirs.result != null) return { rated: false, reason: "already-rated" };
  if (!Array.isArray(theirs.deltas) || theirs.deltas.length === 0) {
    return { rated: false, reason: "no-deltas" };
  }

  const settledAt = new Date().toISOString();

  const { data: ratingRow } = await admin
    .from("ratings")
    .select("rating, rd, volatility, matches_played")
    .eq("player_id", duel.challenger_id)
    .maybeSingle();

  const before = {
    rating: Number(ratingRow?.rating ?? 1500),
    rd: Number(ratingRow?.rd ?? 350),
    volatility: Number(ratingRow?.volatility ?? 0.06),
  };

  const score = challengerVerdict === "win" ? 1 : challengerVerdict === "loss" ? 0 : 0.5;

  const after = updateRating(before, [
    {
      opponent: {
        rating: Number(opponent.rating_before ?? 1500),
        rd: Number(opponent.rd_before ?? 350),
        volatility: 0.06,
      },
      score,
    },
  ]);

  await admin
    .from("match_sides")
    .update({
      result: challengerVerdict,
      rating_before: before.rating,
      rating_after: after.rating,
      rd_before: before.rd,
      rd_after: after.rd,
    })
    .eq("match_id", answerMatchId)
    .eq("player_id", duel.challenger_id);

  await admin.from("ratings").upsert(
    {
      player_id: duel.challenger_id,
      rating: after.rating,
      rd: after.rd,
      volatility: after.volatility,
      matches_played: Number(ratingRow?.matches_played ?? 0) + 1,
      updated_at: settledAt,
    },
    { onConflict: "player_id" },
  );

  await admin.from("rating_history").insert({
    player_id: duel.challenger_id,
    match_id: answerMatchId,
    rating_before: before.rating,
    rating_after: after.rating,
    rd_before: before.rd,
    rd_after: after.rd,
    result: score,
    weight,
  });

  return {
    rated: true,
    reason: "rated",
    ratingBefore: Math.round(before.rating),
    ratingAfter: Math.round(after.rating),
    ratingChange: Math.round(after.rating - before.rating),
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
