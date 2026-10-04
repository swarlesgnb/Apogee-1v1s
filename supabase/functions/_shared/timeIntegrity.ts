/**
 * The server half of src/core/verify/timeIntegrity.ts: the reads and writes that hold a
 * player's declared UTC offset to their own history.
 *
 * Shared because every path that starts a match has to record the clock the same way,
 * and a rule written into each of them separately is a rule one of them will skip. Paths
 * that do not record it yet (anything new) are not a hole: submit-run pins the clock on
 * the first ranked run of a match whose side has none, under the same continuity check.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { HttpError } from "./apogee.ts";
import {
  CLOCK_CONTINUITY_MS,
  clockContinuity,
  FUTURE_SKEW_MS,
  isOffsetMinutes,
  matchClockProblem,
  type ClockReading,
} from "../../../src/core/verify/timeIntegrity.ts";

/** Columns written onto the player's own side of a new match. Empty for an older client. */
export interface MatchClock {
  tz_offset_minutes?: number;
  tz_declared_at?: string;
}

/**
 * The offset a request declared, or null when it declared none.
 *
 * Null is an older client, not an error: it keeps working, and its clock is pinned by its
 * first ranked run instead. A value that is present and malformed is refused.
 */
export function declaredOffset(body: unknown): number | null {
  const value = (body as { tzOffsetMinutes?: unknown } | null)?.tzOffsetMinutes;
  if (value == null) return null;
  if (!isOffsetMinutes(value)) {
    throw new HttpError(400, "tzOffsetMinutes must be an integer between -840 and 840");
  }
  return value;
}

/**
 * Readings from the player's own recent uploads and matches that disagree with `offset`.
 *
 * Only disagreements are read: a reading that matches can never be a conflict, so an
 * honest player's check costs two indexed queries that return nothing. Runs are read by
 * the instant they were played, not when they arrived, so a late backfill of last week's
 * runs (honestly carrying last week's offset) says nothing about the clock today.
 */
export async function conflictingReadings(
  admin: SupabaseClient,
  playerId: string,
  offset: number,
  now: number,
): Promise<ClockReading[]> {
  const since = new Date(now - CLOCK_CONTINUITY_MS).toISOString();
  const until = new Date(now + FUTURE_SKEW_MS).toISOString();

  const runs = await admin
    .from("runs")
    .select("tz_offset_minutes, played_at")
    .eq("player_id", playerId)
    .not("tz_offset_minutes", "is", null)
    .neq("tz_offset_minutes", offset)
    .gte("played_at", since)
    .lte("played_at", until)
    .order("played_at", { ascending: false })
    .limit(200);
  if (runs.error) throw new HttpError(500, runs.error.message);

  const sides = await admin
    .from("match_sides")
    .select("tz_offset_minutes, tz_declared_at")
    .eq("player_id", playerId)
    .not("tz_offset_minutes", "is", null)
    .neq("tz_offset_minutes", offset)
    .gte("tz_declared_at", since)
    .order("tz_declared_at", { ascending: false })
    .limit(50);
  if (sides.error) throw new HttpError(500, sides.error.message);

  return [
    ...(runs.data ?? []).map((r: { tz_offset_minutes: number; played_at: string }) => ({
      offset: Number(r.tz_offset_minutes),
      at: new Date(r.played_at).getTime(),
    })),
    ...(sides.data ?? []).map((s: { tz_offset_minutes: number; tz_declared_at: string }) => ({
      offset: Number(s.tz_offset_minutes),
      at: new Date(s.tz_declared_at).getTime(),
    })),
  ];
}

/** Refuse an offset the player's own last few hours of uploads contradict. */
export async function requireClockContinuity(
  admin: SupabaseClient,
  playerId: string,
  offset: number,
  now: number,
): Promise<void> {
  const verdict = clockContinuity({ offset, at: now }, await conflictingReadings(admin, playerId, offset, now));
  if (!verdict.ok) throw new HttpError(409, verdict.message);
}

/**
 * Check the clock a request declared for a new match, and return the columns that record
 * it on the player's side. Call before the match is created, so a refusal creates nothing.
 */
export async function matchClock(
  admin: SupabaseClient,
  playerId: string,
  body: unknown,
  now = Date.now(),
): Promise<MatchClock> {
  const offset = declaredOffset(body);
  if (offset === null) return {};
  await requireClockContinuity(admin, playerId, offset, now);
  return { tz_offset_minutes: offset, tz_declared_at: new Date(now).toISOString() };
}

/** For a side written somewhere this code cannot reach into (tournament_open_leg). */
export async function recordMatchClock(
  admin: SupabaseClient,
  matchId: string,
  playerId: string,
  clock: MatchClock,
): Promise<void> {
  if (clock.tz_offset_minutes == null) return;
  const { error } = await admin
    .from("match_sides")
    .update(clock)
    .eq("match_id", matchId)
    .eq("player_id", playerId)
    .is("tz_offset_minutes", null);
  if (error) throw new HttpError(500, error.message);
}

/**
 * Hold a ranked submission to its match's clock.
 *
 * The side's recorded offset, or - for a match started by a client that sent none - the
 * offset this submission declares, pinned now under the same continuity check a new match
 * gets. Then the run's offset must equal it, or differ only by a daylight-saving change a
 * real zone made between the two.
 */
export async function holdToMatchClock(
  admin: SupabaseClient,
  args: {
    matchId: string;
    playerId: string;
    side: { tz_offset_minutes?: number | null; tz_declared_at?: string | null };
    matchCreatedAt: string;
    offset: number;
    runEndedAt: number | null;
    now: number;
  },
): Promise<void> {
  let sideOffset = args.side.tz_offset_minutes ?? null;
  let sideAt = args.side.tz_declared_at
    ? new Date(args.side.tz_declared_at).getTime()
    : new Date(args.matchCreatedAt).getTime();

  if (sideOffset === null) {
    await requireClockContinuity(admin, args.playerId, args.offset, args.now);
    const pinned = await admin
      .from("match_sides")
      .update({ tz_offset_minutes: args.offset, tz_declared_at: new Date(args.now).toISOString() })
      .eq("match_id", args.matchId)
      .eq("player_id", args.playerId)
      .is("tz_offset_minutes", null)
      .select("tz_offset_minutes, tz_declared_at")
      .maybeSingle();
    if (pinned.error) throw new HttpError(500, pinned.error.message);

    // Two runs racing to pin: whichever landed first is the match clock.
    const row = pinned.data ?? (await admin
      .from("match_sides")
      .select("tz_offset_minutes, tz_declared_at")
      .eq("match_id", args.matchId)
      .eq("player_id", args.playerId)
      .maybeSingle()).data;
    if (!row || row.tz_offset_minutes == null) throw new HttpError(500, "could not record the match clock");
    sideOffset = Number(row.tz_offset_minutes);
    sideAt = new Date(row.tz_declared_at ?? args.now).getTime();
  }

  const problem = matchClockProblem(
    { offset: sideOffset, at: sideAt },
    { offset: args.offset, at: args.runEndedAt ?? args.now },
  );
  if (problem) throw new HttpError(409, problem);
}

/**
 * The play time this performance was first stored with, if the server has seen it.
 *
 * The same rule the database trigger enforces (20261003000026), read first so the run is
 * graded against the time it will be stored with. "The same performance" is the same
 * scenario and challenge start plus the same filename wall clock, or - for a ranked
 * submission - the same score, which also finds a copy whose filename was edited.
 */
export async function firstSeenPlayTime(
  admin: SupabaseClient,
  args: {
    playerId: string;
    scenarioId: number;
    challengeStart: string | null;
    endedLocal: string | null;
    score: number;
    ranked: boolean;
  },
): Promise<{ playedAt: Date; offset: number | null } | null> {
  const alternatives: string[] = [];
  if (args.endedLocal) alternatives.push(`ended_local.eq.${args.endedLocal.replace(" ", "T")}`);
  if (args.ranked) alternatives.push(`score.eq.${args.score}`);
  if (alternatives.length === 0) return null;

  let query = admin
    .from("runs")
    .select("played_at, tz_offset_minutes")
    .eq("player_id", args.playerId)
    .eq("scenario_id", args.scenarioId);
  query = args.challengeStart ? query.eq("challenge_start", args.challengeStart) : query.is("challenge_start", null);

  const { data, error } = await query
    .or(alternatives.join(","))
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) return null;
  return {
    playedAt: new Date(data.played_at),
    offset: data.tz_offset_minutes == null ? null : Number(data.tz_offset_minutes),
  };
}
