/**
 * Shadows and Flags on the server: the empty-pool half of matchmaking and settlement.
 *
 * Kept out of find-match and settle-match so each of those carries a few call-site hooks
 * rather than a second code path inline. What the two features are, and the rules they
 * hold to, live in src/core/match/shadow.ts and src/core/match/flags.ts; this file only
 * reads and writes the rows those rules need.
 *
 * Nothing here takes a value from the client beyond which category and window it is asking
 * about. The Shadow is chosen from the player's own stored history and the committed table,
 * judged from stored runs, and every write is a service-role call into the functions of
 * migration 20261003000023.
 */

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { HttpError, isCopiedSide, loadSeasonPool, runSetId } from "./apogee.ts";

import { MIN_RUNS_FOR_BASELINE } from "../../../src/core/history/baseline.ts";
import { findOpponent, type StoredRunSet } from "../../../src/core/match/matchmaking.ts";
import type { SelectableScenario } from "../../../src/core/match/scenarioSelection.ts";
import { settleSide, type RoundSubmission } from "../../../src/core/match/settle.ts";
import { SHADOW_DAYS } from "../../../src/core/match/shadowDays.ts";
import {
  explainShadow,
  judgeShadow,
  placement,
  planShadow,
  selectShadowScenarios,
  shadowLabel,
  shadowStreak,
  type ShadowPlan,
  type ShadowRecord,
  type ShadowResult,
} from "../../../src/core/match/shadow.ts";
import {
  answeredLine,
  daysLeft,
  expiredLine,
  FLAG_TTL_DAYS,
  FLAG_TTL_MS,
  plantedLine,
  planterRating,
  planterVerdict,
  shadowQueueLine,
  shouldPlant,
} from "../../../src/core/match/flags.ts";
import { eligibilityMessage, MIN_RUNS_TO_QUEUE, queueEligibility } from "../../../src/core/match/eligibility.ts";

type Rating = { rating: number; rd: number; volatility: number };
type UpdateRating = (p: Rating, games: { opponent: Rating; score: number }[]) => Rating;

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

/** A player's Shadow history, newest first, enough for the ladder and the read-out. */
export async function shadowRecords(admin: SupabaseClient, playerId: string): Promise<ShadowRecord[]> {
  const { data, error } = await admin
    .from("match_shadows")
    .select("ordinal, percentile, result, decided_at")
    .eq("player_id", playerId)
    .order("ordinal", { ascending: false })
    .limit(200);
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((r: any) => ({
    ordinal: Number(r.ordinal),
    percentile: Number(r.percentile),
    result: (r.result ?? null) as ShadowResult | null,
    decidedAt: r.decided_at ?? null,
  }));
}

/**
 * How many uploaded runs the player has on each scenario in the pool.
 *
 * Counts what settlement will count: non-rejected runs, all of which precede a match created
 * now. Read up to PostgREST's page; past it only "measured" can be undercounted, and five
 * runs on a scenario is reached long before any page ends.
 */
async function runCounts(admin: SupabaseClient, playerId: string, scenarioIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (scenarioIds.length === 0) return counts;
  const { data, error } = await admin
    .from("runs")
    .select("scenario_id")
    .eq("player_id", playerId)
    .in("scenario_id", scenarioIds)
    .neq("verification_tier", "rejected")
    .limit(2000);
  if (error) throw new HttpError(500, error.message);
  for (const r of data ?? []) counts.set(Number((r as any).scenario_id), (counts.get(Number((r as any).scenario_id)) ?? 0) + 1);
  return counts;
}

export interface PreparedShadow {
  plan: ShadowPlan;
  /** The three scenarios for this seed, measured ones first. */
  scenarioIds: (seed: string) => number[];
}

/**
 * Decide the Shadow for a seeding match about to be created, and how to draw its three.
 *
 * Called by find-match where it used to call selectScenarios for an empty pool.
 */
export async function prepareShadow(
  admin: SupabaseClient,
  playerId: string,
  category: string,
  selectable: SelectableScenario[],
): Promise<PreparedShadow> {
  const [records, counts] = await Promise.all([
    shadowRecords(admin, playerId),
    runCounts(admin, playerId, selectable.map((s) => s.id)),
  ]);
  const plan = planShadow(SHADOW_DAYS, playerId, records, category);
  return {
    plan,
    scenarioIds: (seed) =>
      selectShadowScenarios(selectable, seed, category, counts, MIN_RUNS_FOR_BASELINE).map((s) => s.id),
  };
}

/**
 * Freeze the Shadow against the match just created.
 *
 * Written before the player's side, so a refusal here (two queue calls racing for the same
 * ordinal) leaves a match with no side, which nobody can see or be held in.
 */
export async function recordShadow(admin: SupabaseClient, matchId: string, playerId: string, plan: ShadowPlan): Promise<void> {
  const { error } = await admin.from("match_shadows").insert({
    match_id: matchId,
    player_id: playerId,
    ordinal: plan.ordinal,
    rung: plan.rung,
    percentile: plan.percentile,
    skill: plan.skill,
    quantiles: plan.quantiles,
    table_version: plan.tableVersion,
    table_method: plan.tableMethod,
  });
  if (error) {
    throw new HttpError(error.code === "23505" ? 409 : 500,
      error.code === "23505" ? "a match is already being created for you; queue again" : error.message);
  }
}

/** What the client is told about a Shadow before the match is played. Never its score. */
export function shadowView(plan: Pick<ShadowPlan, "percentile" | "rung" | "ordinal" | "skill">) {
  return {
    percentile: plan.percentile,
    label: shadowLabel(plan.percentile),
    rung: plan.rung,
    ordinal: plan.ordinal,
    skill: plan.skill,
    synthetic: true,
  };
}

/** The flag a Shadow match will plant, as promised before it is played. */
export function plannedFlag(band: string, category: string) {
  return { willPlant: true, band, category, ttlDays: FLAG_TTL_DAYS, line: plantedLine(band, category) };
}

/** The Shadow on an open match, for a resumed match or a restarted client. */
export async function shadowForMatch(admin: SupabaseClient, matchId: string) {
  const { data } = await admin
    .from("match_shadows")
    .select("percentile, rung, ordinal, skill")
    .eq("match_id", matchId)
    .maybeSingle();
  return data ? shadowView({ percentile: Number(data.percentile), rung: Number(data.rung), ordinal: Number(data.ordinal), skill: data.skill }) : null;
}

/**
 * A round left early voids a Shadow match the way it voids any match: no result, not a loss.
 *
 * Marked before settle-match closes the match, because the trigger that turns an unmarked
 * void into a forfeit (an abandon or an expiry) fires on that close.
 */
export async function markShadowVoid(admin: SupabaseClient, matchId: string): Promise<void> {
  const { error } = await admin
    .from("match_shadows")
    .update({ result: "void", decided_at: new Date().toISOString() })
    .eq("match_id", matchId)
    .is("result", null);
  if (error) throw new HttpError(500, error.message);
}

export interface ShadowSettleInput {
  matchId: string;
  match: { category: string; difficulty: string | null; rated?: boolean | null };
  playerId: string;
  scenarioIds: number[];
  playerRounds: RoundSubmission[];
  runIds: string[];
  /** Per round: the player had runs on that scenario before the match began. */
  hasHistory: boolean[];
}

/**
 * Settle a seeding match that was played against a Shadow. Null when it was not one.
 *
 * The player's side is scored and stored exactly as every seeding side is (settleSide); the
 * Shadow is judged against it with the same settleMatch a contested match uses; and the
 * side, the Shadow's result and the flag are committed together by commit_shadow_match.
 */
export async function settleShadowMatch(
  admin: SupabaseClient,
  input: ShadowSettleInput,
): Promise<{ retry: true } | { retry: false; body: Record<string, unknown> } | null> {
  const { data: row, error } = await admin
    .from("match_shadows")
    .select("percentile, rung, ordinal, skill, quantiles")
    .eq("match_id", input.matchId)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!row) return null;

  const quantiles: number[] = (row.quantiles ?? []).map(Number);
  const percentile = Number(row.percentile);
  const side = settleSide(input.playerRounds);
  const judged = judgeShadow(input.playerRounds, input.hasHistory, quantiles);
  const rounds = input.scenarioIds.length;
  const plant = shouldPlant({ rated: input.match.rated !== false, countedRounds: side.countedRounds, rounds, shadow: true });
  const provisional = input.playerRounds.some((r, i) => r.provisional && input.hasHistory[i]);

  const { data: receipt, error: rpcError } = await admin.rpc("commit_shadow_match", {
    p_match_id: input.matchId,
    p_status: "settled",
    p_sides: [{
      player_id: input.playerId,
      run_ids: input.runIds,
      deltas: side.rounds.map((r) => r.delta ?? 0),
      match_score: side.matchScore,
      result: null,
      provisional: side.provisional,
    }],
    p_result: judged.verdict,
    p_player_score: judged.playerScore,
    p_shadow_score: judged.shadowScore,
    p_plant: plant,
    p_flag_ttl_seconds: Math.round(FLAG_TTL_MS / 1000),
  });
  if (rpcError) throw new HttpError(rpcError.code === "40001" ? 409 : 500, rpcError.message);
  if (typeof receipt?.committed !== "boolean") throw new HttpError(500, "settlement receipt is missing");
  if (!receipt.committed) return { retry: true };

  const band = input.match.difficulty ?? "";
  const flag = receipt.flag
    ? {
        id: receipt.flag.id,
        status: "open",
        category: receipt.flag.category,
        band: receipt.flag.band,
        plantedAt: receipt.flag.planted_at,
        expiresAt: receipt.flag.expires_at,
        ttlDays: FLAG_TTL_DAYS,
        line: plantedLine(receipt.flag.band || band, receipt.flag.category),
      }
    : null;
  const shadowLine = explainShadow(judged, percentile, rounds, provisional);
  const notPlanted = side.countedRounds === rounds
    ? ""
    : " Not every scenario counted, so this run set is not in the pool and no Flag was planted.";

  return {
    retry: false,
    body: {
      matchId: input.matchId,
      seeding: true,
      rated: false,
      tournament: null,
      // The ladder's verdict: there was nobody, so there is none. The Shadow's is below.
      verdict: null,
      category: input.match.category,
      yourMatchScore: side.matchScore,
      theirMatchScore: null,
      countedRounds: side.countedRounds,
      rounds: side.rounds.map((r, i) => ({
        scenario: r.scenarioName,
        score: r.score,
        baseline: Math.round(r.baseline),
        delta: r.delta,
        // The Shadow's round, labelled as the Shadow's wherever it is drawn.
        opponentDelta: judged.shadowDeltas[i],
        counted: r.counted,
        excludedReason: r.excludedReason ?? null,
        verificationTier: r.verificationTier,
      })),
      ratingChange: 0,
      shadow: {
        ...shadowView({ percentile, rung: Number(row.rung), ordinal: Number(row.ordinal), skill: row.skill }),
        verdict: judged.verdict,
        yourScore: judged.playerScore,
        shadowScore: judged.shadowScore,
        comparable: judged.comparable,
        rounds,
      },
      flag,
      explanation: shadowLine + notPlanted,
      message: flag ? flag.line : shadowLine,
    },
  };
}

/**
 * What abandoning a Shadow match says, in place of the seeding match's "there was no
 * opponent". Null when the match had no Shadow.
 */
export async function shadowAbandonMessage(admin: SupabaseClient, matchId: string): Promise<string | null> {
  const { data } = await admin.from("match_shadows").select("percentile, result").eq("match_id", matchId).maybeSingle();
  if (!data) return null;
  return `Shadow match abandoned. It counts as a loss to ${shadowLabel(Number(data.percentile))}; ` +
    "nothing was rated and no Flag was planted. You can queue again now.";
}

/** The stored Shadow result, for a repeated settle call. */
export async function shadowResultFor(admin: SupabaseClient, matchId: string) {
  const { data } = await admin
    .from("match_shadows")
    .select("percentile, rung, ordinal, skill, result, player_score, shadow_score")
    .eq("match_id", matchId)
    .maybeSingle();
  if (!data) return null;
  return {
    ...shadowView({ percentile: Number(data.percentile), rung: Number(data.rung), ordinal: Number(data.ordinal), skill: data.skill }),
    verdict: data.result,
    yourScore: data.player_score == null ? null : Number(data.player_score),
    shadowScore: data.shadow_score == null ? null : Number(data.shadow_score),
  };
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/** Whether a run set find-match just drew is an open flag, for the answerer's match panel. */
export async function flagForRunSet(admin: SupabaseClient, runSet: Pick<StoredRunSet, "id">) {
  const { data } = await admin
    .from("flags")
    .select("planted_at, expires_at, status, band, category")
    .eq("run_set_id", runSet.id)
    .maybeSingle();
  if (!data || data.status !== "open" || new Date(data.expires_at).getTime() <= Date.now()) return null;
  return {
    answering: true,
    plantedAt: data.planted_at,
    expiresAt: data.expires_at,
    line: "You're answering a Flag. When you finish, this settles rated for both of you.",
  };
}

export interface FlagAnswerPlan {
  flagId: string;
  side: Record<string, unknown>;
  rating: {
    player_id: string;
    before: Rating;
    after: Rating;
    matches_played: number;
    score: number;
    weight: number;
  };
}

/**
 * Prepare the planter's half of an answer that settles their flag. Null when it does not.
 *
 * `theirs` is the stored side in the answer match. Its identity names the run set, and the
 * run set names the flag. Nothing is written: commit_flag_answer claims the flag and commits
 * both ratings with the match, or refuses with 'flag-closed' and settle-match settles again
 * without it.
 */
export async function prepareFlagAnswer(
  admin: SupabaseClient,
  answerMatch: { id: string; created_at: string },
  theirs: { player_id: string; submitted_at: string | null },
  answererVerdict: "win" | "loss" | "draw",
  weight: number,
  updateRating: UpdateRating,
  answererBefore: { rating: number; rd: number },
): Promise<FlagAnswerPlan | null> {
  if (!theirs.submitted_at || !isCopiedSide(theirs, answerMatch)) return null;
  const { data: flag, error } = await admin
    .from("flags")
    .select("id, planter_id, status, expires_at")
    .eq("run_set_id", runSetId({ player_id: theirs.player_id, submitted_at: theirs.submitted_at }))
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!flag || flag.status !== "open" || flag.planter_id !== theirs.player_id) return null;
  if (new Date(flag.expires_at).getTime() <= new Date(answerMatch.created_at).getTime()) return null;

  // Read live, as prepareChallengerRating does: the frozen side's rating is days stale.
  const { data: row, error: ratingError } = await admin
    .from("ratings")
    .select("rating, rd, volatility, matches_played")
    .eq("player_id", flag.planter_id)
    .maybeSingle();
  if (ratingError) throw new HttpError(500, ratingError.message);
  const before = {
    rating: Number(row?.rating ?? 1500),
    rd: Number(row?.rd ?? 350),
    volatility: Number(row?.volatility ?? 0.06),
  };
  const verdict = planterVerdict(answererVerdict);
  const { after, score } = planterRating(before, answererBefore, verdict, weight, updateRating);
  return {
    flagId: flag.id,
    side: {
      player_id: flag.planter_id, result: verdict,
      rating_before: before.rating, rating_after: after.rating,
      rd_before: before.rd, rd_after: after.rd, record_submission: false,
    },
    rating: { player_id: flag.planter_id, before, after, matches_played: Number(row?.matches_played ?? 0), score, weight },
  };
}

/** Commit an answer that settles a flag; the same receipt shape as commitMatchResult, plus 'flag-closed'. */
export async function commitFlagAnswer(
  admin: SupabaseClient, flagId: string, matchId: string,
  sides: Record<string, unknown>[], ratings: FlagAnswerPlan["rating"][],
): Promise<{ committed: boolean; reason?: string }> {
  const { data, error } = await admin.rpc("commit_flag_answer", {
    p_flag_id: flagId, p_match_id: matchId, p_status: "settled", p_sides: sides, p_ratings: ratings,
  });
  if (error) throw new HttpError(error.code === "40001" ? 409 : 500, error.message);
  if (typeof data?.committed !== "boolean") throw new HttpError(500, "settlement receipt is missing");
  if (!data.committed && data.reason !== "already-settled" && data.reason !== "flag-closed") {
    throw new HttpError(500, "settlement receipt is invalid");
  }
  return data;
}

// ---------------------------------------------------------------------------
// the queue board: what happens if you queue, your flags, your Shadow ladder
// ---------------------------------------------------------------------------

/**
 * The pool find-match would search, and whether it would find anybody for this caller.
 *
 * The same queries and the same filters as find-match, in the same order, so the sentence
 * shown before queueing is the outcome queueing produces. find-match keeps its own copy for
 * now so this branch's edit to it stays a set of hooks; validate:queue drives both against
 * one database and fails if they disagree.
 */
export async function previewPool(
  admin: SupabaseClient,
  callerId: string,
  category: string,
  windowIndex: number,
  selectable: SelectableScenario[],
  windowName: string,
): Promise<{ opponent: boolean; eligible: number }> {
  const { data: ratingRow } = await admin.from("ratings").select("rating, rd, volatility").eq("player_id", callerId).maybeSingle();
  const rating: Rating = ratingRow
    ? { rating: Number(ratingRow.rating), rd: Number(ratingRow.rd), volatility: Number(ratingRow.volatility) }
    : { rating: 1500, rd: 350, volatility: 0.06 };

  let candidateQuery = admin
    .from("match_sides")
    .select(
      "match_id, player_id, deltas, match_score, provisional, submitted_at, " +
        "players!inner(display_name), " +
        "matches!inner(category, difficulty, window_index, scenario_ids, benchmark_name, created_at), " +
        "ratings:players!inner(id)",
    )
    .not("match_score", "is", null)
    .neq("player_id", callerId)
    .eq("matches.window_index", windowIndex)
    .eq("matches.rated", true);
  if (category !== "Any") candidateQuery = candidateQuery.eq("matches.category", category);
  const { data: candidates } = await candidateQuery.order("submitted_at", { ascending: false }).limit(200);

  const opponentIds = [...new Set((candidates ?? []).map((c: any) => c.player_id))];
  const ratingByPlayer = new Map<string, Rating>();
  if (opponentIds.length > 0) {
    const { data: rs } = await admin.from("ratings").select("player_id, rating, rd, volatility").in("player_id", opponentIds);
    for (const r of rs ?? []) ratingByPlayer.set(r.player_id, { rating: Number(r.rating), rd: Number(r.rd), volatility: Number(r.volatility) });
  }

  const { data: myGames } = await admin
    .from("match_sides")
    .select("match_id, submitted_at, matches!inner(created_at)")
    .eq("player_id", callerId)
    .not("submitted_at", "is", null)
    .order("submitted_at", { ascending: false })
    .limit(500);
  const playedAtByMatch = new Map<string, number>(
    (myGames ?? []).filter((m: any) => !isCopiedSide(m, m.matches)).map((m: any) => [m.match_id, new Date(m.submitted_at).getTime()]),
  );
  const { data: theirSides } = playedAtByMatch.size
    ? await admin.from("match_sides").select("match_id, player_id, submitted_at").in("match_id", [...playedAtByMatch.keys()]).neq("player_id", callerId)
    : { data: [] as { match_id: string; player_id: string; submitted_at: string | null }[] };
  const recentSince = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentOpponentIds = new Set<string>();
  const facedRunSetIds = new Set<string>();
  for (const side of (theirSides ?? []) as { match_id: string; player_id: string; submitted_at: string | null }[]) {
    if (side.submitted_at) facedRunSetIds.add(runSetId({ player_id: side.player_id, submitted_at: side.submitted_at }));
    if ((playedAtByMatch.get(side.match_id) ?? 0) >= recentSince) recentOpponentIds.add(side.player_id);
  }

  const inPool = new Set(selectable.map((s) => s.id));
  const runSets: StoredRunSet[] = (candidates ?? [])
    .filter((c: any) => ratingByPlayer.has(c.player_id))
    .filter((c: any) => {
      const ids: number[] = c.matches.scenario_ids ?? [];
      return ids.length > 0 && ids.every((id) => inPool.has(id));
    })
    .filter((c: any) => !isCopiedSide(c, c.matches))
    .map((c: any) => ({
      id: runSetId(c),
      playerId: c.player_id,
      displayName: c.players?.display_name ?? "player",
      category: c.matches.category,
      difficulty: c.matches.difficulty ?? windowName,
      scenarioIds: c.matches.scenario_ids ?? [],
      deltas: (c.deltas ?? []).map(Number),
      matchScore: Number(c.match_score),
      rating: ratingByPlayer.get(c.player_id)!,
      createdAt: new Date(c.submitted_at),
      provisional: !!c.provisional,
    }));

  const result = findOpponent(
    { playerId: callerId, rating, category, difficulty: windowName, recentOpponentIds, facedRunSetIds },
    runSets,
  );
  const eligible = runSets.length - result.rejected.reduce((n, r) => n + r.count, 0);
  return { opponent: !!result.opponent, eligible: Math.max(0, eligible) };
}

/** The caller's open match, read without retiring anything (find-match's sweep does that). */
async function liveMatchId(admin: SupabaseClient, playerId: string): Promise<string | null> {
  const { data } = await admin
    .from("match_sides")
    .select("match_id, submitted_at, matches!inner(id, status, expires_at, created_at)")
    .eq("player_id", playerId)
    .in("matches.status", ["open", "awaiting_runs"]);
  const now = Date.now();
  const live = (data ?? []).find((row: any) =>
    !isCopiedSide(row, row.matches) && (row.matches.expires_at == null || new Date(row.matches.expires_at).getTime() > now));
  return live ? (live as any).match_id : null;
}

export interface BoardRequest {
  category?: string | null;
  window?: number | null;
  ack?: string[] | null;
}

/** Everything the queue screen's Shadow and Flag panels draw, for the signed-in caller. */
export async function queueBoard(admin: SupabaseClient, playerId: string, body: BoardRequest) {
  const now = new Date();

  // Acknowledged news is marked first, so this answer already reflects it.
  const ack = Array.isArray(body.ack) ? body.ack.filter((id) => typeof id === "string").slice(0, 50) : [];
  if (ack.length > 0) {
    const { error } = await admin.from("flags").update({ seen_at: now.toISOString() })
      .eq("planter_id", playerId).eq("status", "answered").is("seen_at", null).in("id", ack);
    if (error) throw new HttpError(500, error.message);
  }

  // Expired flags are closed lazily, by their planter's own read. Nothing else needs them
  // closed: settlement refuses an answer created after expires_at whatever the status says.
  {
    const { error } = await admin.from("flags").update({ status: "expired" })
      .eq("planter_id", playerId).eq("status", "open").lt("expires_at", now.toISOString());
    if (error) throw new HttpError(500, error.message);
  }

  const [records, flagRows, liveId] = await Promise.all([
    shadowRecords(admin, playerId),
    admin.from("flags")
      .select("id, category, band, status, planted_at, expires_at, answer_match_id, answered_by, answered_at, seen_at")
      .eq("planter_id", playerId)
      .order("planted_at", { ascending: false })
      .limit(20)
      .then(({ data, error }) => {
        if (error) throw new HttpError(500, error.message);
        return (data ?? []) as any[];
      }),
    liveMatchId(admin, playerId),
  ]);

  // ---- the planter's view of each flag ----------------------------------------------
  const answerIds = flagRows.map((f) => f.answer_match_id).filter(Boolean);
  const sidesByMatch = new Map<string, any[]>();
  if (answerIds.length > 0) {
    const { data } = await admin.from("match_sides")
      .select("match_id, player_id, match_score, result, rating_before, rating_after")
      .in("match_id", answerIds);
    for (const s of data ?? []) sidesByMatch.set(s.match_id, [...(sidesByMatch.get(s.match_id) ?? []), s]);
  }
  const answererIds = [...new Set(flagRows.map((f) => f.answered_by).filter(Boolean))];
  const nameById = new Map<string, string>();
  if (answererIds.length > 0) {
    const { data } = await admin.from("players").select("id, display_name").in("id", answererIds);
    for (const p of data ?? []) nameById.set(p.id, p.display_name);
  }
  const flags = flagRows.map((f) => {
    const sides = f.answer_match_id ? sidesByMatch.get(f.answer_match_id) ?? [] : [];
    const mine = sides.find((s) => s.player_id === playerId);
    const theirs = sides.find((s) => s.player_id !== playerId);
    const verdict = (mine?.result ?? null) as "win" | "loss" | "draw" | null;
    const ratingChange = mine?.rating_after != null && mine?.rating_before != null
      ? Math.round(Number(mine.rating_after) - Number(mine.rating_before)) : null;
    const by = f.answered_by ? nameById.get(f.answered_by) ?? "a player" : null;
    return {
      id: f.id,
      category: f.category,
      band: f.band,
      status: f.status,
      plantedAt: f.planted_at,
      expiresAt: f.expires_at,
      daysLeft: f.status === "open" ? daysLeft(new Date(f.expires_at), now) : 0,
      answeredAt: f.answered_at,
      answeredBy: by,
      verdict,
      ratingChange,
      yourScore: mine?.match_score != null ? Number(mine.match_score) : null,
      theirScore: theirs?.match_score != null ? Number(theirs.match_score) : null,
      seen: f.seen_at != null,
      line: f.status === "answered" && verdict && by
        ? answeredLine({ category: f.category, by, verdict, ratingChange })
        : f.status === "expired" ? expiredLine(f.category) : plantedLine(f.band, f.category),
    };
  });

  // ---- the Shadow ladder ------------------------------------------------------------
  const category = typeof body.category === "string" && body.category ? body.category : "Any";
  const next = planShadow(SHADOW_DAYS, playerId, records, category);
  const shadow = {
    next: shadowView(next),
    placement: placement(records),
    streak: shadowStreak(records),
    played: records.filter((r) => r.result != null).length,
    recent: records.filter((r) => r.result != null).slice(0, 8).map((r) => ({
      ordinal: r.ordinal, percentile: r.percentile, label: shadowLabel(r.percentile), result: r.result, decidedAt: r.decidedAt,
    })),
  };

  const activeShadow = liveId ? await shadowForMatch(admin, liveId) : null;

  // ---- what queueing would do -------------------------------------------------------
  let preview: Record<string, unknown> | null = null;
  if (typeof body.window === "number" && body.window >= 0 && typeof body.category === "string" && body.category) {
    const { count } = await admin.from("runs").select("id", { count: "exact", head: true })
      .eq("player_id", playerId).neq("verification_tier", "rejected");
    const eligibility = queueEligibility(count ?? 0, MIN_RUNS_TO_QUEUE);
    const pool = await loadSeasonPool(admin, body.window);
    const inCategory = pool.selectable.filter((s) => body.category === "Any" || s.aimType === body.category || s.subCategory === body.category);
    const counts = await runCounts(admin, playerId, inCategory.map((s) => s.id));
    const measured = {
      full: inCategory.filter((s) => (counts.get(s.id) ?? 0) >= MIN_RUNS_FOR_BASELINE).length,
      some: inCategory.filter((s) => { const n = counts.get(s.id) ?? 0; return n > 0 && n < MIN_RUNS_FOR_BASELINE; }).length,
      total: inCategory.length,
    };
    const base = { category: body.category, window: body.window, band: pool.windowName, measured };
    if (liveId) {
      preview = { ...base, outcome: "live", line: "You have a match open. Finish or abandon it to queue again." };
    } else if (!eligibility.eligible) {
      preview = { ...base, outcome: "ineligible", line: eligibilityMessage(eligibility) };
    } else {
      const found = await previewPool(admin, playerId, body.category, body.window, pool.selectable, pool.windowName);
      preview = found.opponent
        ? {
            ...base, outcome: "opponent", opponents: found.eligible,
            line: `${found.eligible === 1 ? "A stored run set is" : `${found.eligible} stored run sets are`} waiting in ` +
              `${pool.windowName} · ${body.category}. You'll be matched on rating; the result is rated.`,
          }
        : {
            ...base, outcome: "shadow", opponents: 0,
            shadow: shadowView(next),
            flag: plannedFlag(pool.windowName, body.category),
            line: shadowQueueLine(shadowLabel(next.percentile)),
          };
    }
  }

  return {
    now: now.toISOString(),
    preview,
    shadow,
    activeShadow: activeShadow && liveId ? { matchId: liveId, ...activeShadow } : null,
    flags,
    news: flags.filter((f) => f.status === "answered" && !f.seen).map((f) => f.id),
  };
}
