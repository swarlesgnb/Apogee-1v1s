/**
 * Accept a single run for a match, verify it, and store it.
 *
 * The client sends the **raw CSV**, not a parsed summary. That matters: parsing on the
 * server means the integrity checks run over the file as KovaaK's wrote it, and a
 * client cannot present a tidy summary that contradicts rows it never sent. For bulk
 * backfill the client inserts summaries directly under RLS, which is fine because
 * historical runs decide nothing on their own.
 *
 * Verification is two independent layers (PLAN.md §5):
 *
 *   LOCAL   the file must be internally coherent. Measured against 11,058 genuine runs,
 *           every hard check has a 0.00% false-positive rate.
 *   REMOTE  KovaaK's own servers hold the player's recent runs, keyed to their Steam
 *           account. A forged local file cannot produce a matching server record.
 *
 * Nothing here trusts a score. The tier that comes out says how much it can be trusted,
 * and settlement decides what to do about it.
 */

import {
  deadlineAfterRun,
  handler,
  json,
  readJson,
  refreshBaseline,
  requireCaller,
  scenarioByName,
  HttpError,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

import { parseStatsFile } from "../../../src/core/stats/parseStatsFile.ts";
import { playedAtUtc, runDurationSeconds } from "../../../src/core/stats/duration.ts";
import { baselineFromScores } from "../../../src/core/history/baseline.ts";
import { verifyRun } from "../../../src/core/verify/verifyRun.ts";
import { matchServerRecord, recentScores } from "../../../src/core/verify/kovaaksClient.ts";

interface Body {
  /** File name, which carries the date KovaaK's does not put inside the file. */
  filename: string;
  /** Raw contents of the stats CSV. */
  csv: string;
  /** SHA-256 of `csv`, recomputed server-side and compared. */
  csvSha256: string;
  /** Set when the run is being submitted for a match. */
  matchId?: string;
  /** Minutes to add to the player's local time to reach UTC; see playedAtUtc. */
  tzOffsetMinutes?: number;
}

/**
 * Slack at each end of the match window, before a run is refused as out of time.
 *
 * One value used to serve both ends, which stopped working when the match deadline
 * became five minutes: five minutes of slack on the end silently made it ten.
 *
 * They answer different questions, so they are separate now.
 */

/** Before the start: how wrong the player's clock is allowed to be. */
const WINDOW_START_GRACE_MS = 3 * 60_000;

/**
 * After the deadline: long enough for a run already under way to finish.
 *
 * `played_at` comes from the filename, which KovaaK's writes when the run *ends*. A
 * scenario begun at 4:59 of a five-minute match therefore lands at 5:59, and refusing
 * it would mean the real deadline was four minutes with no warning. The rule is that
 * the last run must be *started* before time is up.
 */
const WINDOW_END_GRACE_MS = 90_000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "submit-run");
  const body = await readJson<Body>(req);

  if (!body.csv || !body.filename) throw new HttpError(400, "filename and csv are required");
  if (body.csv.length > 4_000_000) throw new HttpError(413, "stats file is implausibly large");

  // The client's hash is not trusted; it is only checked for agreement, which catches
  // a truncated or altered upload in transit.
  const digest = await sha256Hex(body.csv);
  if (body.csvSha256 && body.csvSha256 !== digest) {
    throw new HttpError(400, "csvSha256 does not match the uploaded file");
  }

  const parsed = parseStatsFile(body.filename, body.csv);
  if (!parsed.ok) throw new HttpError(400, `could not parse stats file: ${parsed.reason}`);
  const run = parsed.run;

  // Duration first, from the wall clock, then the wall clock is corrected to an instant.
  //
  // The two need opposite things from the same digits. A duration is the gap between
  // two local readings and is only right while both are in the same frame - which is
  // why it is computed here at all. `played_at` has to be a real moment, comparable to
  // a match window recorded in UTC, and the filename alone cannot supply one.
  const durationSeconds = runDurationSeconds(run.challengeStart, run.playedAt);

  // Correct the parse, which read the filename's local wall clock in the server's own
  // timezone. Without this every run from a player outside UTC lands hours from where
  // it belongs and falls outside its match window; that is what rejected all three runs
  // of the first real match. An older client that sends no offset keeps the old
  // behaviour rather than being refused.
  if (body.tzOffsetMinutes != null) {
    const corrected = playedAtUtc(body.filename, body.tzOffsetMinutes);
    if (corrected) run.playedAt = corrected;
  }

  const scenario = await scenarioByName(admin, run.scenario);

  // A match window, when this run is for a match.
  let window: { start: Date; end: Date } | undefined;
  if (body.matchId) {
    const { data: match } = await admin
      .from("matches")
      .select("id, created_at, expires_at, status, scenario_ids")
      .eq("id", body.matchId)
      .maybeSingle();

    if (!match) throw new HttpError(404, "no such match");
    if (match.status === "settled") throw new HttpError(409, "match is already settled");

    // The caller must actually be in this match.
    const { data: side } = await admin
      .from("match_sides")
      .select("player_id")
      .eq("match_id", body.matchId)
      .eq("player_id", caller.playerId)
      .maybeSingle();
    if (!side) throw new HttpError(403, "you are not in that match");

    if (scenario && !(match.scenario_ids as number[]).includes(scenario.id)) {
      throw new HttpError(400, "that scenario is not part of this match");
    }

    window = {
      start: new Date(new Date(match.created_at).getTime() - WINDOW_START_GRACE_MS),
      end: new Date(
        (match.expires_at ? new Date(match.expires_at).getTime() : Date.now()) +
          WINDOW_END_GRACE_MS,
      ),
    };
  }

  // Cross-check against KovaaK's, where the player has linked an account. Their recent
  // runs include sub-personal-best results, so a match run is verifiable whether or not
  // it was a record.
  let serverRecord = null;
  if (caller.kovaaksUsername) {
    try {
      const recent = await recentScores(caller.kovaaksUsername, run.scenario);
      serverRecord = matchServerRecord(recent, {
        hash: run.hash,
        challengeStart: run.challengeStart,
        score: run.score,
      });
    } catch {
      // KovaaK's being unreachable must degrade verification, never block submission.
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
          ? {
              stat: scenario.score_model_stat as "kills" | "hitCount" | "damageDone",
              k: Number(scenario.score_model_k),
            }
          : undefined,
      // Both rates or neither: the score relation and the shot-count relation only
      // pin the weapon block between them, and half of it verifies nothing.
      weaponScoreModel:
        scenario?.weapon_score_per_damage != null &&
        scenario.weapon_damage_per_shot != null
          ? {
              scorePerDamage: Number(scenario.weapon_score_per_damage),
              damagePerShot: Number(scenario.weapon_damage_per_shot),
            }
          : undefined,
      // Both, or neither: a rate with no length to be a rate over bounds nothing.
      shotsPerSecond:
        scenario?.shots_per_second != null && scenario.duration_seconds != null
          ? Number(scenario.shots_per_second)
          : undefined,
      scenarioSeconds:
        scenario?.shots_per_second != null && scenario.duration_seconds != null
          ? Number(scenario.duration_seconds)
          : undefined,
      window,
    },
  });

  const { data: inserted, error } = await admin
    .from("runs")
    .insert({
      player_id: caller.playerId,
      scenario_name: run.scenario,
      score: run.score,
      accuracy: run.accuracy,
      avg_ttk: run.avgTtk,
      kills: run.kills,
      hit_count: run.hitCount,
      miss_count: run.missCount,
      played_at: (run.playedAt ?? new Date()).toISOString(),
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
      match_id: body.matchId ?? null,
      verification_tier: outcome.tier,
      verification_notes: {
        reasons: outcome.reasons,
        advisories: outcome.advisories,
        hardFailures: outcome.report.hardFailures,
      },
      // Per-kill detail is kept only for match runs, where anti-cheat may need to
      // re-derive the score. Keeping it for every backfilled run would be enormous.
      kill_rows: body.matchId ? run.killRows : null,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // The unique constraint on (player_id, csv_sha256) is replay protection, so a
    // duplicate is a meaningful answer rather than a failure.
    if (error.code === "23505") {
      return json({ error: "this run has already been submitted", duplicate: true }, 409);
    }
    throw new HttpError(500, error.message);
  }

  if (scenario) {
    await refreshBaseline(
      admin,
      caller.playerId,
      scenario.id,
      scenario.name,
      baselineFromScores,
    );
  }

  // Push the deadline forward from the moment this run ended.
  //
  // The clock is an idle allowance, not a total (see IDLE_ALLOWANCE_MS): a single
  // deadline from match creation would charge the player for their own loading screens,
  // and losing to one is not a rule anybody would accept. Restarting it here is what
  // makes playing free and leaves only idling in a menu to spend it.
  //
  // A rejected run still counts as activity. It is evidence the player is at their
  // machine playing, which is the only thing this clock is measuring, and letting a bad
  // verification also start a countdown would punish the same run twice.
  let expiresAt: string | null = null;
  if (body.matchId) {
    expiresAt = deadlineAfterRun(run.playedAt ?? new Date()).toISOString();
    await admin.from("matches").update({ expires_at: expiresAt }).eq("id", body.matchId);
  }

  return json({
    runId: inserted?.id ?? null,
    scenario: run.scenario,
    score: run.score,
    verificationTier: outcome.tier,
    reasons: outcome.reasons,
    advisories: outcome.advisories,
    counted: outcome.tier !== "rejected",
    expiresAt,
  });
}));
