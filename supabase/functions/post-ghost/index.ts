/**
 * Mint a shareable card for a finished ghost match.
 *
 * The match itself was played and judged on the client, and that result stands there
 * whether or not this function exists: it moves a quest and a streak, never a rating.
 * What the client cannot do is show it to anybody else, because a card it computed is a
 * claim. So this re-derives the whole thing from evidence the server trusts:
 *
 *   - the three live runs arrive as raw CSVs and go through the parse and `verifyRun`
 *     path submit-run uses, stored in `runs` (or, when backfill already put the same file
 *     there, re-verified in place);
 *   - each ghost and baseline is rebuilt from the caller's stored runs by the same
 *     src/core/ghost code the client runs, frozen at local midnight as the client does;
 *   - the verdict is judged again with `settleMatch` underneath.
 *
 * It writes one table, ghost_results, which nothing in rating, matchmaking or settlement
 * reads. It does not touch ratings, matches, match_sides, baselines or verified_pbs.
 *
 * TIME. `played_at` is a real instant, rebuilt from the filename's wall clock and the
 * client's offset (`playedAtUtc`), after the duration has been taken from the unshifted
 * parse. Session days, though, are the player's local days, and this runtime is UTC, so
 * every instant is shifted back by the offset before the core reads a day from it.
 * Without that a player west of UTC gets a ghost from the wrong evening.
 *
 * WHAT IT CANNOT CHECK. The draw. The client draws three scenarios from its whole local
 * library with a seed, and the server's copy of that library is whatever was uploaded,
 * so it cannot replay the draw reliably and does not pretend to: it checks that each
 * scenario has a ghost of the kind claimed in the uploaded history, and the card says the
 * ghost came from uploaded history. A modified client could choose which three to share.
 */

import {
  handler,
  json,
  readJson,
  requireCaller,
  scenarioByName,
  HttpError,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { cardOf, GHOST_ROW_COLUMNS, serverStreak, type GhostResultRow } from "../_shared/ghost.ts";

import { parseStatsFile } from "../../../src/core/stats/parseStatsFile.ts";
import { isAbandonedRun, playedAtUtc, runDurationSeconds } from "../../../src/core/stats/duration.ts";
import { verifyRun } from "../../../src/core/verify/verifyRun.ts";
import { matchServerRecord, recentScores } from "../../../src/core/verify/kovaaksClient.ts";
import {
  ghostCandidates,
  GHOST_END_GRACE_MS,
  GHOST_IDLE_ALLOWANCE_MS,
  GHOST_ROUNDS,
  isGhostKind,
  judge,
  startOfLocalDay,
  type GhostMatch,
} from "../../../src/core/ghost/ghost.ts";

interface Body {
  kind: string;
  ordinal?: number;
  runs: { filename: string; csv: string; csvSha256?: string }[];
  /** getTimezoneOffset() on the player's machine; see playedAtUtc. */
  tzOffsetMinutes: number;
}

/**
 * Stored runs read per scenario to rebuild a ghost and baseline. The baseline needs the
 * last 50; a month-ago ghost needs whatever was played a month back, which on the corpus
 * this was built on is at most a few hundred runs on one scenario. Newest first, so a
 * cap cuts the oldest, which no ghost reaches for.
 */
const HISTORY_ROWS = 1000;

/** No 0/O or 1/I/L: a code is read aloud and typed from a screenshot. Matches ghost_code_shape. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

const TIER_RANK: Record<string, number> = { verified: 3, consistent: 2, suspect: 1, rejected: 0 };

function mintCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  // 256 is not a multiple of 31, so this leans very slightly toward the first letters.
  // A share code has to be hard to guess, not uniform, and 31^8 is 8.5e11.
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "post-ghost");
  const body = await readJson<Body>(req);

  if (!isGhostKind(body.kind)) throw new HttpError(400, "unknown ghost kind");
  if (!Array.isArray(body.runs) || body.runs.length !== GHOST_ROUNDS) {
    throw new HttpError(400, `a ghost match is ${GHOST_ROUNDS} runs`);
  }
  const tz = Number(body.tzOffsetMinutes);
  // Required here, unlike submit-run's optional offset: every session day on the card
  // depends on it, and there is no older client of this function to stay compatible with.
  if (!Number.isInteger(tz) || Math.abs(tz) > 840) throw new HttpError(400, "tzOffsetMinutes is required");
  const local = (instant: Date) => new Date(instant.getTime() - tz * 60_000);

  // ---- the three live runs, verified the way submit-run verifies ------------------
  const live: {
    runId: string;
    scenario: string;
    score: number;
    tier: string;
    endedAt: Date;
    durationSeconds: number | null;
    abandoned: boolean;
  }[] = [];

  for (const upload of body.runs) {
    if (!upload?.csv || !upload.filename) throw new HttpError(400, "each run needs filename and csv");
    if (upload.csv.length > 4_000_000) throw new HttpError(413, "stats file is implausibly large");
    const digest = await sha256Hex(upload.csv);
    if (upload.csvSha256 && upload.csvSha256 !== digest) throw new HttpError(400, "csvSha256 does not match the uploaded file");

    const parsed = parseStatsFile(upload.filename, upload.csv);
    if (!parsed.ok) throw new HttpError(400, `could not parse ${upload.filename}: ${parsed.reason}`);
    const run = parsed.run;

    // Duration from the unshifted parse: both ends are local wall-clock readings of the
    // same file, and only in that frame is their difference right.
    const durationSeconds = runDurationSeconds(run.challengeStart, run.playedAt);
    const corrected = playedAtUtc(upload.filename, tz);
    if (!corrected) throw new HttpError(400, `${upload.filename} has no timestamp in its name`);
    run.playedAt = corrected;

    const scenario = await scenarioByName(admin, run.scenario);
    let serverRecord = null;
    if (caller.kovaaksUsername) {
      try {
        const recent = await recentScores(caller.kovaaksUsername, run.scenario);
        serverRecord = matchServerRecord(recent, { hash: run.hash, challengeStart: run.challengeStart, score: run.score });
      } catch {
        serverRecord = null;
      }
    }

    // Library scenarios are mostly not Apogee's, so most have no stored model and are
    // checked on the file's own coherence alone. That is what the card's tier reports.
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
      throw new HttpError(422, `${run.scenario} failed verification (${outcome.reasons.join("; ")}), so there is no card to make`);
    }

    const row = {
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
    };

    let { data: stored, error } = await admin.from("runs").insert(row).select("id").maybeSingle();
    if (error?.code === "23505") {
      // Already uploaded as history, which the client does the moment a run lands:
      // re-verified in place. A run already filed against a ranked match keeps that
      // match; only what this parse can say about the file is rewritten.
      const again = await admin
        .from("runs")
        .update(row)
        .eq("player_id", caller.playerId)
        .eq("csv_sha256", digest)
        .select("id")
        .maybeSingle();
      stored = again.data;
      error = again.error;
    }
    if (error || !stored) throw new HttpError(500, error?.message ?? "could not store the run");

    live.push({
      runId: stored.id,
      scenario: run.scenario,
      score: run.score,
      tier: outcome.tier,
      endedAt: run.playedAt,
      durationSeconds,
      abandoned: isAbandonedRun(durationSeconds, scenario?.duration_seconds ?? null),
    });
  }

  if (new Set(live.map((r) => r.scenario)).size !== GHOST_ROUNDS) {
    throw new HttpError(400, "a ghost match is three different scenarios");
  }

  // ---- one sitting, on the ranked clock ------------------------------------------
  // Start was pressed on the client and is not evidence. What the files can prove is
  // that the three were played as one match: each begun within the idle allowance of
  // the one before it ending, as applyRun demands.
  live.sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());
  const began = (r: (typeof live)[number]) => r.endedAt.getTime() - (r.durationSeconds ?? 0) * 1000;
  for (let i = 1; i < live.length; i++) {
    if (began(live[i]) > live[i - 1].endedAt.getTime() + GHOST_IDLE_ALLOWANCE_MS + GHOST_END_GRACE_MS) {
      throw new HttpError(422, "those three runs were not played as one match: too long between them");
    }
  }

  // ---- the ghosts, rebuilt from stored history --------------------------------------
  const startLocal = local(new Date(began(live[0])));
  const frozenLocal = startOfLocalDay(startLocal);
  const frozenInstant = new Date(frozenLocal.getTime() + tz * 60_000);

  const history = new Map<string, { scenario: string; runs: { score: number; playedAt: Date | null }[] }>();
  for (const r of live) {
    const { data, error } = await admin
      .from("runs")
      .select("score, played_at")
      .eq("player_id", caller.playerId)
      .eq("scenario_name", r.scenario)
      .lt("played_at", frozenInstant.toISOString())
      .neq("verification_tier", "rejected")
      .order("played_at", { ascending: false })
      .limit(HISTORY_ROWS);
    if (error) throw new HttpError(500, error.message);
    history.set(r.scenario, {
      scenario: r.scenario,
      runs: (data ?? []).reverse().map((x) => ({ score: Number(x.score), playedAt: local(new Date(x.played_at)) })),
    });
  }

  const candidates = new Map(ghostCandidates(history, frozenLocal, body.kind).map((c) => [c.scenario, c]));
  const missing = live.filter((r) => !candidates.has(r.scenario)).map((r) => r.scenario);
  if (missing.length) {
    throw new HttpError(
      422,
      `No ${body.kind} ghost in your uploaded history for ${missing.join(", ")}. Upload history from the app and try again.`,
    );
  }

  const match: GhostMatch = {
    id: "server",
    kind: body.kind,
    day: frozenLocal.toISOString().slice(0, 10),
    ordinal: Number.isInteger(body.ordinal) ? body.ordinal! : 0,
    drawnAt: frozenLocal.getTime(),
    startedAt: startLocal.getTime(),
    deadline: null,
    rounds: live.map((r) => {
      const { lastPlayed: _lastPlayed, ...c } = candidates.get(r.scenario)!;
      return { ...c, live: { score: r.score, at: local(r.endedAt).getTime(), abandoned: r.abandoned } };
    }),
    result: null,
  };
  const result = judge(match, "complete", Date.now());
  if (result.verdict === "void") {
    // The match_result enum has no void, and a void has nothing to show anybody.
    throw new HttpError(422, `No result to share: ${result.explanation}`);
  }

  const liveTier = live.reduce((low, r) => (TIER_RANK[r.tier] < TIER_RANK[low] ? r.tier : low), "verified");
  const runIds = live.map((r) => r.runId);

  const existing = await admin
    .from("ghost_results")
    .select(GHOST_ROW_COLUMNS)
    .eq("player_id", caller.playerId)
    .eq("live_run_ids", `{${runIds.join(",")}}`)
    .maybeSingle();
  let saved = existing.data as GhostResultRow | null;

  for (let attempt = 0; !saved && attempt < 3; attempt++) {
    const { data, error } = await admin
      .from("ghost_results")
      .insert({
        player_id: caller.playerId,
        code: mintCode(),
        kind: body.kind,
        scenario_names: match.rounds.map((r) => r.scenario),
        live_run_ids: runIds,
        live_scores: result.rounds.map((r) => r.live),
        ghost_scores: result.rounds.map((r) => r.ghost),
        baselines: result.rounds.map((r) => r.baseline),
        pbs: result.rounds.map((r) => r.pb),
        ghost_days: result.rounds.map((r) => r.sessionDay),
        tz_offset_minutes: tz,
        margin: result.margin,
        verdict: result.verdict,
        live_tier: liveTier,
      })
      .select(GHOST_ROW_COLUMNS)
      .maybeSingle();
    if (data) saved = data as GhostResultRow;
    // A code collision is the only conflict worth another try; the same three runs posted
    // twice is ghost_runs_once, answered below by the card already minted for them.
    else if (error?.code === "23505" && /ghost_runs_once/.test(error.message)) break;
    else if (error?.code !== "23505") throw new HttpError(500, error?.message ?? "could not save the card");
  }
  if (!saved) {
    const again = await admin
      .from("ghost_results")
      .select(GHOST_ROW_COLUMNS)
      .eq("player_id", caller.playerId)
      .eq("live_run_ids", `{${runIds.join(",")}}`)
      .maybeSingle();
    saved = again.data as GhostResultRow | null;
  }
  if (!saved) throw new HttpError(500, "could not save the card");

  return json(cardOf(saved, caller.displayName, await serverStreak(admin, saved)));
}));
