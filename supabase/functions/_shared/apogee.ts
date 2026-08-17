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
  world_record: number | null;
}

export async function scenarioByName(
  admin: SupabaseClient,
  name: string,
): Promise<ScenarioRow | null> {
  const { data } = await admin
    .from("scenarios")
    .select(
      "id, name, leaderboard_id, aim_type, sub_category, known_hash, score_model_stat, score_model_k, world_record",
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
export async function refreshBaseline(
  admin: SupabaseClient,
  playerId: string,
  scenarioId: number,
  scenarioName: string,
  baselineFromScores: (s: string, scores: number[], pb?: number | null) => {
    value: number;
    runCount: number;
    provisional: boolean;
    flooredByPb: boolean;
  },
): Promise<void> {
  const { data: runs } = await admin
    .from("runs")
    .select("score, played_at")
    .eq("player_id", playerId)
    .eq("scenario_id", scenarioId)
    .neq("verification_tier", "rejected")
    .order("played_at", { ascending: true })
    .limit(200);

  const scores = (runs ?? []).map((r: { score: number }) => Number(r.score));
  if (scores.length === 0) return;

  const { data: pb } = await admin
    .from("verified_pbs")
    .select("score")
    .eq("player_id", playerId)
    .eq("scenario_id", scenarioId)
    .maybeSingle();

  const baseline = baselineFromScores(scenarioName, scores, pb ? Number(pb.score) : null);
  if (!(baseline.value > 0)) return;

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
