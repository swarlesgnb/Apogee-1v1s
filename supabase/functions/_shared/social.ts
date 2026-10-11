/**
 * What the social functions (daily-submit, daily-board, open-duel) share.
 *
 * A file of its own rather than more exports on apogee.ts, which every function imports
 * and several people edit. The parse-and-verify step below is post-ghost's, line for
 * line in what it decides: the same `parseStatsFile`, the same `verifyRun` inputs from the
 * scenario row, the same KovaaK's cross-check when the caller has a linked username, and
 * the same `played_at` rebuilt from the filename's wall clock in the player's IANA zone.
 * A run the server stores from here is therefore the run submit-run or post-ghost would
 * have stored from the same file.
 */

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { HttpError, loadSeasonPool, scenarioByName, type Caller } from "./apogee.ts";

import { parseStatsFile } from "../../../src/core/stats/parseStatsFile.ts";
import { isAbandonedRun, runDurationSeconds } from "../../../src/core/stats/duration.ts";
import { verifyRun } from "../../../src/core/verify/verifyRun.ts";
import { matchServerRecord, recentScores } from "../../../src/core/verify/kovaaksClient.ts";
import { wallClockToInstant } from "../../../src/core/ghost/zone.ts";
import { dailyStreak, type DailyPoolEntry } from "../../../src/core/social/daily.ts";

export interface VerifiedUpload {
  scenario: string;
  scenarioId: number | null;
  sha: string;
  score: number;
  tier: ReturnType<typeof verifyRun>["tier"];
  /** The instant the run ended, read in the player's zone. */
  endedAt: Date;
  durationSeconds: number | null;
  abandoned: boolean;
  /** The `runs` row this file is, if it has to be inserted. */
  row: Record<string, unknown>;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse and verify one uploaded stats file. Writes nothing. A rejected run is refused
 * here, so nothing downstream ever counts one.
 */
export async function verifyUpload(
  admin: SupabaseClient,
  caller: Caller,
  upload: { filename?: unknown; csv?: unknown; csvSha256?: unknown },
  zone: string,
): Promise<VerifiedUpload> {
  if (typeof upload?.csv !== "string" || typeof upload.filename !== "string" || !upload.csv || !upload.filename) {
    throw new HttpError(400, "each run needs filename and csv");
  }
  if (upload.filename.length > 300) throw new HttpError(400, "that filename is too long to be a stats file");
  if (upload.csv.length > 4_000_000) throw new HttpError(413, "stats file is implausibly large");
  const digest = await sha256Hex(upload.csv);
  if (upload.csvSha256 !== undefined && upload.csvSha256 !== digest) {
    throw new HttpError(400, "csvSha256 does not match the uploaded file");
  }

  const parsed = parseStatsFile(upload.filename, upload.csv);
  if (!parsed.ok) throw new HttpError(400, `could not parse ${upload.filename}: ${parsed.reason}`);
  const run = parsed.run;

  // Duration from the unshifted parse: both ends are wall-clock readings of one file.
  const durationSeconds = runDurationSeconds(run.challengeStart, run.playedAt);
  const corrected = wallClockToInstant(upload.filename, zone);
  if (!corrected) throw new HttpError(400, `${upload.filename} has no timestamp in its name`);
  run.playedAt = corrected;

  const scenario = await scenarioByName(admin, run.scenario);
  let serverRecord = null;
  if (caller.kovaaksUsername) {
    try {
      serverRecord = matchServerRecord(await recentScores(caller.kovaaksUsername, run.scenario), run);
    } catch {
      serverRecord = null;
    }
  }

  const outcome = verifyRun({
    run,
    serverRecord,
    consistency: {
      worldRecord: scenario?.world_record ? Number(scenario.world_record) : undefined,
      knownHash: scenario?.known_hash ?? undefined,
      scoreModel:
        scenario?.score_model_stat && scenario.score_model_k != null
          ? { stat: scenario.score_model_stat as "kills" | "hitCount" | "damageDone", k: Number(scenario.score_model_k) }
          : undefined,
      weaponScoreModel:
        scenario?.weapon_score_per_damage != null && scenario.weapon_damage_per_shot != null
          ? { scorePerDamage: Number(scenario.weapon_score_per_damage), damagePerShot: Number(scenario.weapon_damage_per_shot) }
          : undefined,
      shotsPerSecond:
        scenario?.shots_per_second != null && scenario.duration_seconds != null ? Number(scenario.shots_per_second) : undefined,
      scenarioSeconds:
        scenario?.shots_per_second != null && scenario.duration_seconds != null ? Number(scenario.duration_seconds) : undefined,
    },
  });
  if (outcome.tier === "rejected") {
    throw new HttpError(422, `${run.scenario} failed verification (${outcome.reasons.join("; ")}), so it cannot count`);
  }

  return {
    scenario: run.scenario,
    scenarioId: scenario?.id ?? null,
    sha: digest,
    score: run.score,
    tier: outcome.tier,
    endedAt: run.playedAt,
    durationSeconds,
    abandoned: isAbandonedRun(durationSeconds, scenario?.duration_seconds ?? null),
    row: {
      player_id: caller.playerId,
      scenario_name: run.scenario,
      score: run.score,
      accuracy: run.accuracy,
      avg_ttk: run.avgTtk,
      kills: run.kills,
      hit_count: run.hitCount,
      miss_count: run.missCount,
      played_at: run.playedAt.toISOString(),
      challenge_start: run.challengeStart,
      duration_seconds: durationSeconds,
      hash: run.hash,
      game_version: run.gameVersion,
      avg_fps: run.avgFps,
      resolution: run.resolution,
      cm360: run.cm360,
      dpi: run.dpi,
      fov: run.fov,
      csv_sha256: digest,
      verification_tier: outcome.tier,
      verification_notes: { reasons: outcome.reasons, advisories: outcome.advisories, hardFailures: outcome.report.hardFailures },
    },
  };
}

/** The season's pool in one band, in the shape the daily draw reads, and the band's name. */
export async function dailyPool(
  admin: SupabaseClient,
  windowIndex: number,
): Promise<{ seasonName: string; band: string; pool: DailyPoolEntry[] }> {
  const { season, windowName, selectable } = await loadSeasonPool(admin, windowIndex);
  return {
    seasonName: season.name,
    band: windowName,
    pool: selectable.map((s) => ({ name: s.name, category: s.subCategory ?? "", window: windowIndex })),
  };
}

/** Consecutive dailies with an entry on the server, ending today or yesterday. */
export async function serverDailyStreak(admin: SupabaseClient, playerId: string, today: number): Promise<number> {
  const { data, error } = await admin
    .from("daily_results")
    .select("daily_number")
    .eq("player_id", playerId)
    .lte("daily_number", today)
    .order("daily_number", { ascending: false })
    .limit(400);
  if (error) throw new HttpError(500, error.message);
  const played = new Set((data ?? []).map((r: { daily_number: number }) => Number(r.daily_number)));
  return dailyStreak((n) => played.has(n), today);
}

/** One band of one day, as BoardRows. Bounded: the board is read whole at Apogee's size. */
export const BOARD_ROWS = 10_000;
