/**
 * Shared helpers for Arena's Edge Functions.
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
