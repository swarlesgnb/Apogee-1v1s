/**
 * Ghost cards: what post-ghost mints and ghost-card reads back.
 *
 * Shared so the two answer with one shape. The card carries no rating, rank or season
 * standing, because a ghost result moved none of them and a card implying otherwise is
 * "I scored more and lost" pointed at strangers (docs/overnight/mechanics.md, "Share card").
 */

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { ghostStreak, type GhostKind } from "../../../src/core/ghost/ghost.ts";
import { isTimeZone, toLocalFrame } from "../../../src/core/ghost/zone.ts";

export interface GhostResultRow {
  code: string;
  player_id: string;
  kind: GhostKind;
  scenario_names: string[];
  live_scores: (number | string)[];
  ghost_scores: (number | string)[];
  baselines: (number | string)[];
  pbs: (number | string)[];
  ghost_days: string[];
  tz_offset_minutes: number;
  time_zone: string;
  margin: number | string;
  verdict: "win" | "loss" | "draw";
  live_tier: string;
  played_at: string;
  created_at: string;
}

export const GHOST_ROW_COLUMNS =
  "code, player_id, kind, scenario_names, live_scores, ghost_scores, baselines, pbs, ghost_days, " +
  "tz_offset_minutes, time_zone, margin, verdict, live_tier, played_at, created_at";

export interface GhostCard {
  code: string;
  kind: GhostKind;
  displayName: string;
  verdict: "win" | "loss" | "draw";
  margin: number;
  liveTier: string;
  /** Always true: a server card's ghost is rebuilt from runs the player uploaded. */
  ghostFromUploadedHistory: true;
  streak: number;
  createdAt: string;
  rounds: {
    scenario: string;
    live: number;
    ghost: number;
    baseline: number;
    pb: number;
    ghostDay: string;
    gap: number;
  }[];
}

/**
 * Consecutive local days with a ghost win on the server's record, as of `row`: the days
 * the matches were played, not the days Share was pressed, which the client's streak
 * never counted.
 *
 * Each result is moved into its poster's local frame before its day is read, the same
 * move post-ghost makes before bucketing sessions: this runtime is UTC, and ghostStreak
 * reads days with the local getters.
 */
export async function serverStreak(admin: SupabaseClient, row: GhostResultRow): Promise<number> {
  const { data } = await admin
    .from("ghost_results")
    .select("played_at, tz_offset_minutes, time_zone, verdict")
    .eq("player_id", row.player_id)
    .eq("verdict", "win")
    .lte("played_at", row.played_at)
    .order("played_at", { ascending: false })
    .limit(400);
  // Each in its own poster's zone at its own offset; the stored offset only for a row
  // whose zone this runtime does not know.
  const shift = (at: string, zone: string, tz: number) =>
    (isTimeZone(zone) ? toLocalFrame(new Date(at).getTime(), zone) : new Date(new Date(at).getTime() - tz * 60_000)).toISOString();
  const records = (data ?? []).map((r) => ({ at: shift(r.played_at, r.time_zone, r.tz_offset_minutes), verdict: "win" as const }));
  return ghostStreak(records, new Date(shift(row.played_at, row.time_zone, row.tz_offset_minutes)));
}

export function cardOf(row: GhostResultRow, displayName: string, streak: number): GhostCard {
  const n = (v: number | string) => Number(v);
  return {
    code: row.code,
    kind: row.kind,
    displayName,
    verdict: row.verdict,
    margin: n(row.margin),
    liveTier: row.live_tier,
    ghostFromUploadedHistory: true,
    streak,
    createdAt: row.created_at,
    rounds: row.scenario_names.map((scenario, i) => ({
      scenario,
      live: n(row.live_scores[i]),
      ghost: n(row.ghost_scores[i]),
      baseline: n(row.baselines[i]),
      pb: n(row.pbs[i]),
      ghostDay: row.ghost_days[i],
      gap: (n(row.live_scores[i]) - n(row.ghost_scores[i])) / n(row.baselines[i]),
    })),
  };
}
