/**
 * Everything the bot knows about Apogee, read from Supabase.
 *
 * Read-only by construction: this module has no insert, update, upsert, delete or rpc
 * call, and validateDiscord.ts greps for them. It uses the service key because RLS
 * restricts player reads to the player themself, and the bot reads on behalf of a whole
 * server; it must therefore never write, since that key bypasses every guard the database
 * has. Ratings, results and run verification are the server's to decide. The bot reports
 * them.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadRankTheme, type RankTier } from "../src/core/ranks/apogeeRanks.ts";
import { PLACEMENT_MATCHES } from "../src/core/ranks/placement.ts";
import { apogeeEnv } from "./env.ts";

export interface PlayerInfo {
  id: string;
  steam_id: string;
  display_name: string;
}

export interface RatingInfo {
  player_id: string;
  rating: number;
  rd: number;
  matches_played: number;
  percentile: number | null;
  tier_id: string | null;
}

export interface SettledSide {
  match_id: string;
  player_id: string;
  result: "win" | "loss" | "draw";
  rating_before: number | null;
  rating_after: number | null;
  match_score: number | null;
  provisional: boolean;
  category: string;
  difficulty: string;
  settled_at: string;
}

export interface OpenSide {
  match_id: string;
  player_id: string;
  category: string;
  difficulty: string;
  created_at: string;
}

export interface RunInfo {
  player_id: string;
  score: number;
  accuracy: number | null;
  played_at: string;
  verification_tier: string;
}

/** Tiers a run must hold to count anywhere the bot ranks people by score. */
export const COUNTED_TIERS = ["verified", "consistent"];

export class Apogee {
  private readonly db: SupabaseClient;
  readonly tiers: RankTier[];
  readonly steamKey: string | undefined;

  constructor() {
    const env = apogeeEnv();
    this.db = createClient(env.supabaseUrl, env.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.tiers = loadRankTheme().tiers;
    this.steamKey = env.steamKey;
  }

  tier(id: string | null): RankTier | null {
    return id ? (this.tiers.find((t) => t.id === id) ?? null) : null;
  }

  /** Placement still running: no tier, whatever the cached column says. */
  rankedTier(r: RatingInfo | undefined): RankTier | null {
    if (!r || r.matches_played < PLACEMENT_MATCHES) return null;
    return this.tier(r.tier_id);
  }

  async playerBySteam(steamId: string): Promise<PlayerInfo | null> {
    const { data, error } = await this.db
      .from("players")
      .select("id, steam_id, display_name")
      .eq("steam_id", steamId)
      .maybeSingle();
    if (error) throw new Error(`players read failed: ${error.message}`);
    return data as PlayerInfo | null;
  }

  async ratings(playerIds: string[]): Promise<Map<string, RatingInfo>> {
    const out = new Map<string, RatingInfo>();
    if (playerIds.length === 0) return out;
    const { data, error } = await this.db
      .from("ratings")
      .select("player_id, rating, rd, matches_played, percentile, tier_id")
      .in("player_id", playerIds);
    if (error) throw new Error(`ratings read failed: ${error.message}`);
    for (const r of data ?? []) {
      out.set(r.player_id, {
        ...r,
        rating: Number(r.rating),
        rd: Number(r.rd),
        percentile: r.percentile === null ? null : Number(r.percentile),
      } as RatingInfo);
    }
    return out;
  }

  /** Settled sides for these players after `sinceIso`, oldest first. */
  async settledSince(playerIds: string[], sinceIso: string): Promise<SettledSide[]> {
    if (playerIds.length === 0) return [];
    const { data, error } = await this.db
      .from("match_sides")
      .select(
        "match_id, player_id, result, rating_before, rating_after, match_score, provisional, matches!inner(category, difficulty, status, settled_at)",
      )
      .in("player_id", playerIds)
      .not("result", "is", null)
      .eq("matches.status", "settled")
      .gt("matches.settled_at", sinceIso)
      .limit(200);
    if (error) throw new Error(`match_sides read failed: ${error.message}`);
    const rows = (data ?? []).map((r) => {
      const m = (Array.isArray(r.matches) ? r.matches[0] : r.matches) as {
        category: string;
        difficulty: string;
        settled_at: string;
      };
      return {
        match_id: r.match_id,
        player_id: r.player_id,
        result: r.result,
        rating_before: r.rating_before === null ? null : Number(r.rating_before),
        rating_after: r.rating_after === null ? null : Number(r.rating_after),
        match_score: r.match_score === null ? null : Number(r.match_score),
        provisional: r.provisional,
        category: m.category,
        difficulty: m.difficulty,
        settled_at: m.settled_at,
      } as SettledSide;
    });
    return rows.sort((a, b) => a.settled_at.localeCompare(b.settled_at));
  }

  /** Matches these players are in that have not settled yet. */
  async openSides(playerIds: string[]): Promise<OpenSide[]> {
    if (playerIds.length === 0) return [];
    const { data, error } = await this.db
      .from("match_sides")
      .select("match_id, player_id, matches!inner(category, difficulty, status, created_at)")
      .in("player_id", playerIds)
      .in("matches.status", ["open", "awaiting_runs"])
      .limit(100);
    if (error) throw new Error(`open match read failed: ${error.message}`);
    return (data ?? []).map((r) => {
      const m = (Array.isArray(r.matches) ? r.matches[0] : r.matches) as {
        category: string;
        difficulty: string;
        created_at: string;
      };
      return { match_id: r.match_id, player_id: r.player_id, category: m.category, difficulty: m.difficulty, created_at: m.created_at };
    });
  }

  /** How a match ended for one side, or null while it is still open. Void counts as a draw. */
  async sideOutcome(matchId: string, playerId: string): Promise<"win" | "loss" | "draw" | null> {
    const { data, error } = await this.db
      .from("match_sides")
      .select("result, matches!inner(status)")
      .eq("match_id", matchId)
      .eq("player_id", playerId)
      .maybeSingle();
    if (error) throw new Error(`match read failed: ${error.message}`);
    if (!data) return "draw";
    const m = (Array.isArray(data.matches) ? data.matches[0] : data.matches) as { status: string };
    if (m.status === "void") return "draw";
    if (m.status !== "settled" || !data.result) return null;
    return data.result as "win" | "loss" | "draw";
  }

  /** Every counted run by these players on one scenario since a moment. */
  async runsOn(scenario: string, playerIds: string[], sinceIso: string, untilIso?: string): Promise<RunInfo[]> {
    if (playerIds.length === 0) return [];
    let q = this.db
      .from("runs")
      .select("player_id, score, accuracy, played_at, verification_tier")
      .eq("scenario_name", scenario)
      .in("player_id", playerIds)
      .in("verification_tier", COUNTED_TIERS)
      .gte("played_at", sinceIso);
    if (untilIso) q = q.lt("played_at", untilIso);
    const { data, error } = await q.limit(1000);
    if (error) throw new Error(`runs read failed: ${error.message}`);
    return (data ?? []).map((r) => ({ ...r, score: Number(r.score), accuracy: r.accuracy === null ? null : Number(r.accuracy) })) as RunInfo[];
  }

  /** Settled results for one player since a moment, for bounties. */
  async resultsSince(playerId: string, sinceIso: string): Promise<SettledSide[]> {
    return this.settledSince([playerId], sinceIso);
  }

  // -- Steam ---------------------------------------------------------------

  async resolveVanity(vanity: string): Promise<string | null> {
    if (!this.steamKey) return null;
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${this.steamKey}&vanityurl=${encodeURIComponent(vanity)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Steam vanity lookup failed (${res.status})`);
    const body = (await res.json()) as { response?: { success?: number; steamid?: string } };
    return body.response?.success === 1 ? (body.response.steamid ?? null) : null;
  }

  /** The two names a player can set freely on their own profile. */
  async steamNames(steamId: string): Promise<{ persona: string; real: string } | null> {
    if (!this.steamKey) return null;
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${this.steamKey}&steamids=${steamId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Steam profile lookup failed (${res.status})`);
    const body = (await res.json()) as {
      response?: { players?: { personaname?: string; realname?: string }[] };
    };
    const p = body.response?.players?.[0];
    return p ? { persona: p.personaname ?? "", real: p.realname ?? "" } : null;
  }
}
