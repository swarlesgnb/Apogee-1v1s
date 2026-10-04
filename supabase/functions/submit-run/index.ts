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
  isCopiedSide,
  json,
  readJson,
  refreshBaseline,
  requireCaller,
  scenarioByName,
  HttpError,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { declaredOffset, firstSeenPlayTime, holdToMatchClock } from "../_shared/timeIntegrity.ts";

import { parseStatsFile } from "../../../src/core/stats/parseStatsFile.ts";
import { playedAtUtc, runDurationSeconds } from "../../../src/core/stats/duration.ts";
import { baselineFromScores } from "../../../src/core/history/baseline.ts";
import { verifyRun } from "../../../src/core/verify/verifyRun.ts";
import { matchServerRecord, recentScores, sameRunRecord } from "../../../src/core/verify/kovaaksClient.ts";
import {
  futureMessage,
  isFutureDated,
  isLateReceipt,
  LATE_RECEIPT_GRACE_MS,
  MAX_OFFSET_MINUTES,
  wallClock,
} from "../../../src/core/verify/timeIntegrity.ts";

interface Body {
  /** File name, which carries the date KovaaK's does not put inside the file. */
  filename: string;
  /** Raw contents of the stats CSV. */
  csv: string;
  /** SHA-256 of `csv`, recomputed server-side and compared. */
  csvSha256: string;
  /** Set when the run is being submitted for a match. */
  matchId?: string;
  /**
   * Minutes to add to the player's local time to reach UTC; see playedAtUtc. Required for
   * a ranked run, and held to the clock its match started with (timeIntegrity.ts).
   */
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
  // Server receipt: the clock every time rule below is measured against.
  const receivedAt = Date.now();

  if (!body || typeof body.csv !== "string" || typeof body.filename !== "string" ||
      !body.csv || !body.filename) throw new HttpError(400, "filename and csv are required");
  if (body.csv.length > 4_000_000) throw new HttpError(413, "stats file is implausibly large");
  const offset = declaredOffset(body);

  // Omitting the offset reads the wall clock as UTC, which is as much a choice as any
  // offset. An older client may still do that for a run that decides nothing; a ranked
  // run says which clock it was played on, so it can be held to its match's.
  if (body.matchId && offset === null) {
    throw new HttpError(400, "A ranked run has to say which UTC offset your PC was on. Update Apogee and play the scenario again.");
  }

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
  const wall = wallClock(body.filename);
  let storedOffset: number | null = null;
  if (offset !== null) {
    const corrected = playedAtUtc(body.filename, offset);
    if (corrected) {
      run.playedAt = corrected;
      storedOffset = offset;
    }
  }

  // Nothing from the future. A corrected end later than the server's clock plus slack is
  // either a PC clock that is badly wrong or an offset pushing a run past when it was
  // played; neither can count, and the second is how a run uploaded as it was played
  // would otherwise be restamped into a later match.
  if (run.playedAt && isFutureDated(run.playedAt.getTime(), receivedAt)) {
    throw new HttpError(422, futureMessage(run.playedAt.getTime(), receivedAt));
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

    // The caller must actually be playing this match. A copy of their stored run set
    // sitting in it as the opponent carries their player_id too, and does not count.
    const { data: side } = await admin
      .from("match_sides")
      .select("player_id, submitted_at, tz_offset_minutes, tz_declared_at")
      .eq("match_id", body.matchId)
      .eq("player_id", caller.playerId)
      .maybeSingle();
    if (!side || isCopiedSide(side, match)) throw new HttpError(403, "you are not in that match");

    if (!scenario || !(match.scenario_ids as number[]).includes(scenario.id)) {
      throw new HttpError(400, "that scenario is not part of this match");
    }

    // On time. A match nobody has swept stays open past its deadline, and a run reaching
    // the server long after that was played after time ran out or held back to be
    // stamped into it. The honest client submits as each file lands, seconds after the
    // run, and that run had to end inside the window anyway.
    const deadline = match.expires_at ? new Date(match.expires_at).getTime() : null;
    if (isLateReceipt(receivedAt, deadline, WINDOW_END_GRACE_MS)) {
      throw new HttpError(
        409,
        `This match ran out of time at ${new Date(deadline!).toISOString().slice(11, 16)} UTC. A ranked run ` +
          `has to reach the server within ${LATE_RECEIPT_GRACE_MS / 60_000} minutes of the deadline, so it was not counted.`,
      );
    }

    // One clock per match: the offset this run declares must be the one the match was
    // started with (or the one its first run pinned), daylight-saving changes aside.
    await holdToMatchClock(admin, {
      matchId: body.matchId,
      playerId: caller.playerId,
      side,
      matchCreatedAt: match.created_at,
      offset: offset!,
      runEndedAt: run.playedAt?.getTime() ?? null,
      now: receivedAt,
    });

    window = {
      start: new Date(new Date(match.created_at).getTime() - WINDOW_START_GRACE_MS),
      end: new Date(
        (match.expires_at ? new Date(match.expires_at).getTime() : Date.now()) +
          WINDOW_END_GRACE_MS,
      ),
    };
  }

  // First seen wins. If this performance is already stored - uploaded as history the
  // moment it landed, or submitted before - it keeps the time it was stored with, whatever
  // offset or filename this request carries. Graded against that time, so a run restamped
  // into a match it was not played in fails that match's window, the existing rule. The
  // database trigger enforces the same thing for every writer (20261003000026).
  const advisories: string[] = [];
  if (scenario && run.playedAt) {
    const first = await firstSeenPlayTime(admin, {
      playerId: caller.playerId,
      scenarioId: scenario.id,
      challengeStart: run.challengeStart,
      endedLocal: wall?.local ?? null,
      score: run.score,
      ranked: !!body.matchId,
    });
    if (first && first.playedAt.getTime() !== run.playedAt.getTime()) {
      advisories.push(
        `first uploaded ending at ${first.playedAt.toISOString()}; this submission said ${run.playedAt.toISOString()}`,
      );
      run.playedAt = first.playedAt;
      const implied = wall ? Math.round((first.playedAt.getTime() - wall.ms) / 60_000) : null;
      storedOffset = implied !== null && Math.abs(implied) <= MAX_OFFSET_MINUTES ? implied : first.offset;
    }
  }

  // Cross-check against KovaaK's, where the player has linked an account. Their recent
  // runs include sub-personal-best results, so a match run is verifiable whether or not
  // it was a record.
  //
  // Two questions, not one. `matchServerRecord` asks whether KovaaK's saw this run at
  // this time, which is Verified. `sameRunRecord` asks whether KovaaK's has this run at
  // all; when it does and the times disagree, that is a contradiction, not an absence,
  // and verifyRun reads it as one.
  let serverRecord = null;
  let sameRun = null;
  if (caller.kovaaksUsername) {
    try {
      const recent = await recentScores(caller.kovaaksUsername, run.scenario);
      const evidence = {
        playedAt: run.playedAt,
        hash: run.hash,
        challengeStart: run.challengeStart,
        score: run.score,
      };
      serverRecord = matchServerRecord(recent, evidence);
      sameRun = serverRecord ? null : sameRunRecord(recent, evidence);
    } catch {
      // KovaaK's being unreachable must degrade verification, never block submission.
      serverRecord = null;
      sameRun = null;
    }
  }

  const outcome = verifyRun({
    run,
    serverRecord,
    sameRunRecord: sameRun,
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
  outcome.advisories.push(...advisories);

  const row = {
    player_id: caller.playerId,
    scenario_name: run.scenario,
    score: run.score,
    accuracy: run.accuracy,
    avg_ttk: run.avgTtk,
    kills: run.kills,
    hit_count: run.hitCount,
    miss_count: run.missCount,
    played_at: (run.playedAt ?? new Date()).toISOString(),
    tz_offset_minutes: storedOffset,
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
  };

  let { data: inserted, error } = await admin.from("runs").insert(row).select("id").maybeSingle();

  // The same file already uploaded as plain history, attached to no match: claim it.
  //
  // The client uploads every run as history the moment it lands, and on launch it uploads
  // whatever was played while it was shut. A match run can reach the table that way
  // first - played with the app closed, or while Upload history was running - and then
  // the replay check below refused its own submission and the match could never settle.
  // Replay protection is about one run deciding two matches, and a row with no match has
  // decided none, so it is taken over. Every column is rewritten from this parse, so
  // nothing the client inserted survives into the match.
  if (error?.code === "23505" && body.matchId) {
    const claimed = await admin
      .from("runs")
      .update(row)
      .eq("player_id", caller.playerId)
      .eq("csv_sha256", digest)
      .is("match_id", null)
      .select("id")
      .maybeSingle();
    if (claimed.data) {
      inserted = claimed.data;
      error = null;
    } else if (claimed.error) {
      error = claimed.error;
    }
  }

  if (error) {
    if (error.code === "55000") throw new HttpError(409, "match is already finished");
    // The trigger's own time rules, reached only when another upload of this performance
    // raced this request between the lookup above and the write.
    if (error.code === "TI409") throw new HttpError(409, "this run was uploaded with a different end time; submit it again");
    if (error.code === "TI422") throw new HttpError(422, futureMessage(run.playedAt?.getTime() ?? receivedAt, receivedAt));
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
  // A rejected score can still record activity, but an absent or out-of-window
  // timestamp cannot extend the deadline. Those values are supplied by the client.
  let expiresAt: string | null = null;
  // Nor can a time KovaaK's own record of the run contradicts.
  const insideWindow = outcome.report.checks.some(c => c.id === "in_match_window" && c.status === "pass") &&
    !outcome.report.checks.some(c => c.id === "server_time_in_window" && c.status === "fail");
  if (body.matchId && insideWindow && run.playedAt) {
    expiresAt = deadlineAfterRun(run.playedAt).toISOString();
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
