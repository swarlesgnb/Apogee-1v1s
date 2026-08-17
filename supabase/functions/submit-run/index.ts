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
  handler,
  json,
  readJson,
  refreshBaseline,
  requireCaller,
  scenarioByName,
  HttpError,
} from "../_shared/apogee.ts";

import { parseStatsFile } from "../../../src/core/stats/parseStatsFile.ts";
import { runDurationSeconds } from "../../../src/core/stats/duration.ts";
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
}

/** How far outside the match window a run may sit before it is refused. */
const WINDOW_GRACE_MS = 5 * 60_000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
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
      start: new Date(new Date(match.created_at).getTime() - WINDOW_GRACE_MS),
      end: new Date(
        (match.expires_at ? new Date(match.expires_at).getTime() : Date.now()) + WINDOW_GRACE_MS,
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
      // Computed here, from this parse, because it cannot be recovered later: the two
      // ends are a local wall-clock time and a UTC timestamp, and subtracting those
      // across a timezone gives the offset rather than a duration. Both values are in
      // one frame only while the file is being read.
      duration_seconds: runDurationSeconds(run.challengeStart, run.playedAt),
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

  return json({
    runId: inserted?.id ?? null,
    scenario: run.scenario,
    score: run.score,
    verificationTier: outcome.tier,
    reasons: outcome.reasons,
    advisories: outcome.advisories,
    counted: outcome.tier !== "rejected",
  });
}));
