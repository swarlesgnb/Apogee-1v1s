/**
 * Put a finished Apogee Daily on the day's board.
 *
 * The Daily is played and scored on the client, and that result stands there signed out
 * and offline. A board is something other people read, so its entries are the server's,
 * rebuilt from evidence it trusts (PLAN.md §7):
 *
 *   - the day's three are drawn again here, from the season pool in the database and the
 *     same seed (src/core/social/daily.ts), so a client cannot choose its scenarios;
 *   - the three runs arrive as raw CSVs and go through post-ghost's parse and verify path
 *     (_shared/social.ts), with `played_at` read in the player's IANA zone;
 *   - each run must have ended inside the day, and must be the first stored,
 *     non-rejected run on its scenario inside the day, so an evening's best cannot stand
 *     in for the attempt of record;
 *   - each baseline is rebuilt from the caller's stored runs that ended before the day
 *     began AND reached the server before it began, with the verified-PB floor, so history
 *     uploaded during the day (backdated or not) cannot lower the bar the day is measured
 *     against. That is ranked's rule (settle-match), with the day's start for the match's.
 *
 * ORDER. Everything that can refuse runs before anything is written, as in post-ghost.
 * WRITES. The runs, under `planRunWrite` (a run a ranked match counted is never
 * rewritten), and one daily_results row. The first entry for a day and band stands: the
 * first-run rule makes a second one the same, and refusing to overwrite makes it so.
 *
 * WHAT IT CANNOT CHECK. Whether an earlier attempt on a scenario was played and never
 * uploaded. A client that holds back its first try and posts its second is not caught
 * here; the client sends history as runs land, which is what makes it visible when it is.
 *
 * Moves no rating. Nothing in rating, matchmaking or settlement reads daily_results.
 */

import { handler, json, readJson, requireCaller, HttpError } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { BOARD_ROWS, dailyPool, serverDailyStreak, verifyUpload, type VerifiedUpload } from "../_shared/social.ts";

import {
  boardFromRows,
  dailyNumberAt,
  dailyWindow,
  drawDaily,
  glyphLetters,
  isDailyNumber,
  scoreRound,
  summarise,
  DAILY_ROUNDS,
  type BoardRow,
} from "../../../src/core/social/daily.ts";
import { isTimeZone } from "../../../src/core/ghost/zone.ts";
import { lowerTier, planRunWrite, type StoredRunRow } from "../../../src/core/ghost/serverRules.ts";

interface Body {
  dailyNumber: unknown;
  window: unknown;
  runs: unknown;
  timeZone: unknown;
}

/** Runs read per scenario to rebuild a baseline: the rule reads the last 50. */
const BASELINE_ROWS = 200;

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "daily-submit");
  const body = await readJson<Body>(req);

  // ---- 0. the request's shape ------------------------------------------------------
  if (!isDailyNumber(body.dailyNumber)) throw new HttpError(400, "dailyNumber must be a daily's number");
  const n = body.dailyNumber;
  if (typeof body.window !== "number" || !Number.isInteger(body.window) || body.window < 0 || body.window > 15) {
    throw new HttpError(400, "window must be a band index");
  }
  const windowIndex = body.window;
  if (!Array.isArray(body.runs) || body.runs.length !== DAILY_ROUNDS) throw new HttpError(400, `a daily is ${DAILY_ROUNDS} runs`);
  if (!isTimeZone(body.timeZone)) throw new HttpError(400, "timeZone must be an IANA zone name");
  const zone = body.timeZone;

  // A day that has not begun has no board, and its draw is not handed out here. A day may
  // still be posted for one day after it ends, so a run that ended at 07:59 UTC can be
  // posted after the change; the runs must be inside the day whenever they are posted.
  const today = dailyNumberAt(Date.now());
  if (n > today) throw new HttpError(422, `Apogee Daily #${n} has not started yet`);
  if (n < today - 1) throw new HttpError(410, `Apogee Daily #${n} is over; its board is closed`);
  const { start, end } = dailyWindow(n);

  // ---- 1. the day's three, drawn here ----------------------------------------------
  const { seasonName, band, pool } = await dailyPool(admin, windowIndex);
  const draw = drawDaily(pool, seasonName, n, windowIndex);
  if (!draw) throw new HttpError(404, `${band} has too few scenarios for a daily`);

  // ---- 2. parse and verify all three; nothing is written yet ------------------------
  const uploads: VerifiedUpload[] = [];
  for (const raw of body.runs as { filename?: unknown; csv?: unknown; csvSha256?: unknown }[]) {
    uploads.push(await verifyUpload(admin, caller, raw ?? {}, zone));
  }
  if (new Set(uploads.map((u) => u.sha)).size !== DAILY_ROUNDS) throw new HttpError(400, "the same file was posted twice");
  const byScenario = new Map(uploads.map((u) => [u.scenario, u]));
  if (byScenario.size !== DAILY_ROUNDS || !draw.scenarios.every((s) => byScenario.has(s))) {
    throw new HttpError(422, `Those are not Apogee Daily #${n}'s three in ${band}.`);
  }
  const outside = uploads.filter((u) => u.endedAt.getTime() < start || u.endedAt.getTime() >= end).map((u) => u.scenario);
  if (outside.length) throw new HttpError(422, `Not played during Apogee Daily #${n}: ${outside.join(", ")}.`);
  // A run that stopped early is an absent round, as settle-match has it, and a day with an
  // absent round has no result. Posting the next attempt instead would break first-run.
  const left = uploads.filter((u) => u.abandoned).map((u) => u.scenario);
  if (left.length) throw new HttpError(422, `${left.join(", ")} ended early, so the day has no result to post.`);

  // ---- 3. an entry already made stands ---------------------------------------------
  const boardFor = async () => {
    const { data, error } = await admin
      .from("daily_results")
      .select("player_id, mean_delta, glyphs, provisional")
      .eq("daily_number", n)
      .eq("window_index", windowIndex)
      .limit(BOARD_ROWS);
    if (error) throw new HttpError(500, error.message);
    const streak = await serverDailyStreak(admin, caller.playerId, today);
    return boardFromRows((data ?? []) as BoardRow[], caller.playerId, { dailyNumber: n, window: windowIndex, band, streak });
  };
  const { data: already, error: alreadyError } = await admin
    .from("daily_results")
    .select("player_id")
    .eq("daily_number", n)
    .eq("window_index", windowIndex)
    .eq("player_id", caller.playerId)
    .maybeSingle();
  if (alreadyError) throw new HttpError(500, alreadyError.message);
  if (already) return json({ board: await boardFor(), alreadyPosted: true });

  // ---- 4. the first run of the day on each, not the best ---------------------------
  const { data: sameDay, error: sameDayError } = await admin
    .from("runs")
    .select("scenario_name, csv_sha256, played_at")
    .eq("player_id", caller.playerId)
    .in("scenario_name", draw.scenarios)
    .gte("played_at", new Date(start).toISOString())
    .lt("played_at", new Date(end).toISOString())
    .neq("verification_tier", "rejected");
  if (sameDayError) throw new HttpError(500, sameDayError.message);
  const earlier = uploads
    .filter((u) =>
      (sameDay ?? []).some((s: { scenario_name: string; csv_sha256: string; played_at: string }) =>
        s.scenario_name === u.scenario && s.csv_sha256 !== u.sha && new Date(s.played_at).getTime() < u.endedAt.getTime()))
    .map((u) => u.scenario);
  if (earlier.length) {
    throw new HttpError(422, `Not the first run of the day on ${earlier.join(", ")}: an earlier run on it is already uploaded.`);
  }

  // ---- 5. baselines, as they stood when the day began ------------------------------
  const rounds = [];
  for (const [i, scenario] of draw.scenarios.entries()) {
    const u = byScenario.get(scenario) as VerifiedUpload;
    const [history, pb] = await Promise.all([
      admin
        .from("runs")
        .select("score")
        .eq("player_id", caller.playerId)
        .eq("scenario_name", scenario)
        .lt("played_at", new Date(start).toISOString())
        .lt("created_at", new Date(start).toISOString())
        .neq("verification_tier", "rejected")
        .order("played_at", { ascending: false })
        .limit(BASELINE_ROWS),
      u.scenarioId === null
        ? Promise.resolve({ data: null, error: null })
        : admin.from("verified_pbs").select("score").eq("player_id", caller.playerId).eq("scenario_id", u.scenarioId).maybeSingle(),
    ]);
    if (history.error) throw new HttpError(500, history.error.message);
    if (pb.error) throw new HttpError(500, pb.error.message);
    const before = (history.data ?? []).map((r: { score: number | string }) => Number(r.score)).reverse();
    rounds.push(scoreRound(scenario, draw.skills[i] ?? null, before, { score: u.score, at: u.endedAt.getTime() },
      pb.data ? Number((pb.data as { score: number | string }).score) : null));
  }
  const result = summarise(n, windowIndex, draw.scenarios, rounds);
  const glyphs = glyphLetters(result.rounds);
  if (!result.complete || !glyphs) throw new HttpError(500, "the day did not come out complete");

  // ---- 6. the writes, only now ----------------------------------------------------
  const { data: storedRows, error: storedError } = await admin
    .from("runs")
    .select("id, match_id, verification_tier, csv_sha256")
    .eq("player_id", caller.playerId)
    .in("csv_sha256", uploads.map((u) => u.sha));
  if (storedError) throw new HttpError(500, storedError.message);
  const storedBySha = new Map((storedRows ?? []).map((r: StoredRunRow & { csv_sha256: string }) => [r.csv_sha256, r as StoredRunRow]));

  const runIds: string[] = [];
  let lowest = "verified";
  for (const scenario of draw.scenarios) {
    const u = byScenario.get(scenario) as VerifiedUpload;
    let plan = planRunWrite(storedBySha.get(u.sha) ?? null, u.tier);
    let id: string | null = null;
    let tier: string = u.tier;
    const reread = async () => {
      const { data: now } = await admin
        .from("runs")
        .select("id, match_id, verification_tier")
        .eq("player_id", caller.playerId)
        .eq("csv_sha256", u.sha)
        .maybeSingle();
      return planRunWrite((now as StoredRunRow | null) ?? null, u.tier);
    };
    if (plan.action === "insert") {
      const inserted = await admin.from("runs").insert(u.row).select("id").maybeSingle();
      if (inserted.data) id = (inserted.data as { id: string }).id;
      else if (inserted.error?.code === "23505") plan = await reread();
      else throw new HttpError(500, inserted.error?.message ?? "could not store the run");
    }
    if (plan.action === "update-unbound") {
      // `match_id is null` here as well as in the plan, as post-ghost: a ranked submission
      // can claim the row between the read and this write, and then this writes nothing.
      const updated = await admin
        .from("runs")
        .update(u.row)
        .eq("player_id", caller.playerId)
        .eq("csv_sha256", u.sha)
        .is("match_id", null)
        .select("id")
        .maybeSingle();
      if (updated.error) throw new HttpError(500, updated.error.message);
      if (updated.data) id = (updated.data as { id: string }).id;
      else plan = await reread();
    }
    if (plan.action === "keep") {
      id = plan.id;
      tier = plan.tier;
    }
    if (!id) throw new HttpError(500, "could not store the run");
    if (tier === "rejected") throw new HttpError(422, `${scenario} is stored as rejected, so it cannot count`);
    runIds.push(id);
    lowest = lowerTier(lowest, tier);
  }

  const { error: insertError } = await admin.from("daily_results").insert({
    daily_number: n,
    window_index: windowIndex,
    player_id: caller.playerId,
    season_name: seasonName,
    scenario_names: draw.scenarios,
    run_ids: runIds,
    scores: result.rounds.map((r) => r.score),
    baselines: result.rounds.map((r) => r.baseline ?? 0),
    prior_runs: result.rounds.map((r) => r.priorRuns),
    glyphs,
    mean_delta: result.meanDelta,
    provisional: result.provisional,
    lowest_tier: lowest,
    played_at: new Date(Math.max(...uploads.map((u) => u.endedAt.getTime()))).toISOString(),
  });
  // Two posts racing: the other one's entry stands, and it is the same day.
  if (insertError && insertError.code !== "23505") throw new HttpError(500, insertError.message);

  return json({ board: await boardFor(), alreadyPosted: !!insertError });
}));
