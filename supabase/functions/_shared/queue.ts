/**
 * Shadows and Flags on the server, under ranked v2.
 *
 * Kept out of find-match and _shared/rankedV2.ts so each carries a few call-site hooks
 * rather than a second code path inline. What the two features are and the rules they hold
 * to live in src/core/match/shadow.ts and src/core/match/flags.ts; this file reads and
 * writes the rows those rules need.
 *
 * Nothing here takes a value from the client beyond which category and window it asks
 * about and how far it has read. A Shadow is chosen from the player's own Shadow history
 * and the committed table, judged from stored runs, and committed by commit_shadow_match.
 * Flags are read from the copies ranked v2 already writes.
 */

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { HttpError, isCopiedSide, loadSeasonPool, runSetId } from "./apogee.ts";

import { findOpponent, RECENT_MATCHES_FOR_VARIETY, shouldPlantFresh, type OpponentBank } from "../../../src/core/match/matchmaking.ts";
import { matchesCategory, type SelectableScenario } from "../../../src/core/match/scenarioSelection.ts";
import { settleSide, type RoundSubmission } from "../../../src/core/match/settle.ts";
import { SHADOW_SCORES } from "../../../src/core/match/shadowScores.ts";
import {
  explainShadow,
  judgeShadow,
  planShadow,
  shadowLabel,
  shadowStanding,
  tallyText,
  type ShadowPlan,
  type ShadowRecord,
  type ShadowResult,
} from "../../../src/core/match/shadow.ts";
import { bankNewsLine, bankTally, NEWS_DEFAULT_DAYS, NEWS_LIMIT, shadowQueueLine } from "../../../src/core/match/flags.ts";
import { eligibilityMessage, MIN_RUNS_TO_QUEUE, queueEligibility } from "../../../src/core/match/eligibility.ts";

/** What find-match writes to `matches.engine` for a queued match (rankedV2.ts). */
const RANKED_V2_ENGINE = 2;

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

/** A player's Shadow history, newest first. */
export async function shadowRecords(admin: SupabaseClient, playerId: string): Promise<ShadowRecord[]> {
  const { data, error } = await admin
    .from("match_shadows")
    .select("ordinal, percentile, result, rounds_won, rounds_lost, rounds_tied, decided_at")
    .eq("player_id", playerId)
    .order("ordinal", { ascending: false })
    .limit(200);
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((r: any) => ({
    ordinal: Number(r.ordinal),
    percentile: Number(r.percentile),
    result: (r.result ?? null) as ShadowResult | null,
    won: r.rounds_won, lost: r.rounds_lost, tied: r.rounds_tied,
    decidedAt: r.decided_at ?? null,
  }));
}

/** What the client is told about a Shadow before the match is played. Never its scores. */
export function shadowView(plan: Pick<ShadowPlan, "percentile" | "rung" | "ordinal">) {
  return {
    percentile: plan.percentile,
    label: shadowLabel(plan.percentile),
    rung: plan.rung,
    ordinal: plan.ordinal,
    synthetic: true as const,
  };
}

/**
 * Field a Shadow on a seeding match find-match has just opened, and freeze it.
 *
 * Called after open_ranked_match, which creates the match and its side in one transaction.
 * A failure here leaves an ordinary seeding match, which settles exactly as one did before
 * Shadows, so it is logged and the match is handed out without a Shadow rather than failed.
 */
export async function fieldShadow(
  admin: SupabaseClient,
  playerId: string,
  matchId: string,
  scenarioNames: string[],
): Promise<ReturnType<typeof shadowView> | null> {
  try {
    const plan = planShadow(SHADOW_SCORES, playerId, await shadowRecords(admin, playerId), scenarioNames);
    const { error } = await admin.from("match_shadows").insert({
      match_id: matchId, player_id: playerId, ordinal: plan.ordinal, rung: plan.rung,
      percentile: plan.percentile, scores: plan.scores, table_version: plan.tableVersion,
    });
    if (error) throw new Error(error.message);
    return shadowView(plan);
  } catch (err) {
    console.error(`could not field a Shadow on ${matchId}:`, err);
    return null;
  }
}

/** The Shadow on an open match, for a resumed match or a restarted client. */
export async function shadowForMatch(admin: SupabaseClient, matchId: string) {
  const { data } = await admin.from("match_shadows").select("percentile, rung, ordinal").eq("match_id", matchId).maybeSingle();
  return data ? shadowView({ percentile: Number(data.percentile), rung: Number(data.rung), ordinal: Number(data.ordinal) }) : null;
}

/**
 * A round left early voids a Shadow match the way it voids any seeding match: no result,
 * not a loss. Marked before settlement closes the match, because the trigger that turns an
 * unmarked void into a forfeit (an abandon or an expiry) fires on that close.
 */
export async function markShadowVoid(admin: SupabaseClient, matchId: string): Promise<void> {
  const { error } = await admin.from("match_shadows")
    .update({ result: "void", decided_at: new Date().toISOString() })
    .eq("match_id", matchId).is("result", null);
  if (error) throw new HttpError(500, error.message);
}

export interface ShadowSettleInput {
  matchId: string;
  match: { category: string; rated?: boolean | null };
  playerId: string;
  scenarioIds: number[];
  playerRounds: RoundSubmission[];
  runIds: string[];
}

/**
 * Settle a seeding match played against a Shadow. Null when it was not one.
 *
 * The side is scored and stored exactly as rankedV2.ts stores every seeding side (rounds
 * format, raw scores kept), so its rounds join the bank the same way; the Shadow is judged
 * by judgeShadow; and the two are committed together by commit_shadow_match.
 */
export async function settleShadowMatch(
  admin: SupabaseClient,
  input: ShadowSettleInput,
): Promise<{ retry: true } | { retry: false; body: Record<string, unknown> } | null> {
  const { data: row, error } = await admin.from("match_shadows")
    .select("percentile, rung, ordinal, scores").eq("match_id", input.matchId).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!row) return null;

  const scores: (number | null)[] = (row.scores ?? []).map((v: unknown) => (v == null ? null : Number(v)));
  const percentile = Number(row.percentile);
  const side = settleSide(input.playerRounds, "rounds");
  const judged = judgeShadow(input.playerRounds, scores);

  const { data: receipt, error: rpcError } = await admin.rpc("commit_shadow_match", {
    p_match_id: input.matchId,
    p_sides: [{
      player_id: input.playerId, run_ids: input.runIds,
      deltas: side.rounds.map((r) => r.delta ?? 0), match_score: side.matchScore,
      scores: input.playerRounds.map((r) => r.score), result: null, provisional: side.provisional,
    }],
    p_result: judged.verdict,
    p_won: judged.tally.won, p_lost: judged.tally.lost, p_tied: judged.tally.tied,
  });
  if (rpcError) throw new HttpError(rpcError.code === "40001" ? 409 : 500, rpcError.message);
  if (typeof receipt?.committed !== "boolean") throw new HttpError(500, "settlement receipt is missing");
  if (!receipt.committed) return { retry: true };

  const rounds = input.scenarioIds.length;
  const pooled = side.countedRounds === rounds;
  const line = explainShadow(judged, percentile, rounds);
  const bank = pooled
    ? " Your three runs are now in the bank: whoever draws them plays you, and you'll hear how it went."
    : " Not every scenario counted, so these runs are not in the bank.";

  return {
    retry: false,
    body: {
      matchId: input.matchId,
      engine: RANKED_V2_ENGINE,
      seeding: true,
      rated: false,
      tournament: null,
      // The ladder's verdict: there was nobody, so there is none. The Shadow's is below.
      verdict: null,
      category: input.match.category,
      yourMatchScore: side.matchScore,
      theirMatchScore: null,
      countedRounds: side.countedRounds,
      format: "rounds",
      rounds: side.rounds.map((r, i) => ({
        scenario: r.scenarioName,
        score: r.score,
        baseline: Math.round(r.baseline),
        delta: r.delta,
        opponentDelta: null,
        // The Shadow's score and the round's result, labelled as the Shadow's wherever drawn.
        opponentScore: scores[i],
        result: ["won", "lost", "tied"].includes(judged.rounds[i]) ? judged.rounds[i] : null,
        counted: r.counted,
        excludedReason: judged.rounds[i] === "no-score" ? "no committed Shadow score at this percentile" : r.excludedReason ?? null,
        verificationTier: r.verificationTier,
      })),
      roundTally: judged.verdict === "void" ? null : judged.tally,
      ratingChange: 0,
      shadow: {
        ...shadowView({ percentile, rung: Number(row.rung), ordinal: Number(row.ordinal) }),
        verdict: judged.verdict,
        tally: judged.tally,
        contested: judged.contested,
        rounds,
        scores,
      },
      explanation: line + bank,
      message: line,
    },
  };
}

/** The stored Shadow result, for a repeated settle call. */
export async function shadowResultFor(admin: SupabaseClient, matchId: string) {
  const { data } = await admin.from("match_shadows")
    .select("percentile, rung, ordinal, scores, result, rounds_won, rounds_lost, rounds_tied").eq("match_id", matchId).maybeSingle();
  if (!data) return null;
  return {
    ...shadowView({ percentile: Number(data.percentile), rung: Number(data.rung), ordinal: Number(data.ordinal) }),
    verdict: data.result,
    tally: data.rounds_won == null ? null : { won: data.rounds_won, lost: data.rounds_lost, tied: data.rounds_tied },
    scores: (data.scores ?? []).map((v: unknown) => (v == null ? null : Number(v))),
  };
}

/** What abandoning a Shadow match says, in place of "there was no opponent". Null without one. */
export async function shadowAbandonMessage(admin: SupabaseClient, matchId: string): Promise<string | null> {
  const { data } = await admin.from("match_shadows").select("percentile").eq("match_id", matchId).maybeSingle();
  if (!data) return null;
  return `Shadow match abandoned. It counts as a loss to ${shadowLabel(Number(data.percentile))}; ` +
    "nothing was rated and nothing went into the bank. You can queue again now.";
}

// ---------------------------------------------------------------------------
// Flags: who played your banked rounds
// ---------------------------------------------------------------------------

export interface BankNewsItem {
  matchId: string;
  settledAt: string;
  by: string;
  category: string;
  theirResult: "win" | "loss" | "draw" | null;
  tally: { theirs: number; yours: number; tied: number } | null;
  line: string;
}

/**
 * Settled, rated, queued (engine 2) matches that a copy of this player's side was drawn
 * into, settled after `since`, newest first. Unrated for the owner: ranked v2 rated the
 * player who played and nobody else.
 */
export async function bankNews(admin: SupabaseClient, playerId: string, since: string): Promise<BankNewsItem[]> {
  const { data, error } = await admin.from("match_sides")
    .select("match_id, scores, submitted_at, matches!inner(created_at, settled_at, status, rated, engine, category)")
    .eq("player_id", playerId)
    .eq("matches.status", "settled")
    .eq("matches.rated", true)
    .eq("matches.engine", RANKED_V2_ENGINE)
    .gte("matches.settled_at", since);
  if (error) throw new HttpError(500, error.message);
  const copies = (data ?? [])
    .filter((row: any) => isCopiedSide(row, row.matches) && new Date(row.matches.settled_at) > new Date(since))
    .sort((a: any, b: any) => new Date(b.matches.settled_at).getTime() - new Date(a.matches.settled_at).getTime())
    .slice(0, NEWS_LIMIT);
  if (copies.length === 0) return [];

  const { data: others, error: otherError } = await admin.from("match_sides")
    .select("match_id, player_id, scores, result, players!inner(display_name)")
    .in("match_id", copies.map((c: any) => c.match_id))
    .neq("player_id", playerId);
  if (otherError) throw new HttpError(500, otherError.message);
  const byMatch = new Map((others ?? []).map((o: any) => [o.match_id, o]));

  return copies.flatMap((c: any) => {
    const o = byMatch.get(c.match_id);
    if (!o) return [];
    const theirResult = (o.result ?? null) as BankNewsItem["theirResult"];
    const tally = bankTally((c.scores ?? []).map(Number), (o.scores ?? []).map(Number), theirResult);
    const by = o.players?.display_name ?? "a player";
    return [{
      matchId: c.match_id, settledAt: c.matches.settled_at, by, category: c.matches.category,
      theirResult, tally, line: bankNewsLine(by, tally, theirResult),
    }];
  });
}

// ---------------------------------------------------------------------------
// the queue board: what happens if you queue, your Shadow ladder, your Flags
// ---------------------------------------------------------------------------

type Rating = { rating: number; rd: number; volatility: number };

/**
 * What find-match would do for this caller: draw an opponent, or hand out a seeding match
 * (empty pool, or fresh scenarios planted).
 *
 * The same reads and the same core calls as find-match, in the same order, so the sentence
 * shown before queueing is the outcome queueing produces. find-match keeps its own copy so
 * this branch's edit to it stays a hook; validate:queue drives both against one database
 * and fails if they disagree. One known difference: a player with no ratings row is read
 * here at the default rather than seeded from their PBs, since a preview must not write.
 */
export async function previewPool(
  admin: SupabaseClient,
  callerId: string,
  category: string,
  windowIndex: number,
  selectable: SelectableScenario[],
  windowName: string,
): Promise<{ outcome: "opponent" | "shadow" | "plant"; opponents: number }> {
  const { data: ratingRow } = await admin.from("ratings").select("rating, rd, volatility").eq("player_id", callerId).maybeSingle();
  const rating: Rating = ratingRow
    ? { rating: Number(ratingRow.rating), rd: Number(ratingRow.rd), volatility: Number(ratingRow.volatility) }
    : { rating: 1500, rd: 350, volatility: 0.06 };

  const { data: candidates, error: poolError } = await admin.rpc("ranked_pool_rounds", {
    p_window: windowIndex, p_caller: callerId, p_rating: rating.rating, p_players: 40, p_sides_per_player: 20,
  });
  if (poolError) throw new HttpError(500, poolError.message);

  const { data: myGames } = await admin.from("match_sides")
    .select("match_id, submitted_at, matches!inner(created_at, scenario_ids)")
    .eq("player_id", callerId).not("submitted_at", "is", null)
    .order("submitted_at", { ascending: false }).limit(500);
  const myPlayed = (myGames ?? []).filter((m: any) => !isCopiedSide(m, m.matches));
  const playedAtByMatch = new Map<string, number>(myPlayed.map((m: any) => [m.match_id, new Date(m.submitted_at).getTime()]));
  const playedRecently = new Set<number>(
    myPlayed.slice(0, RECENT_MATCHES_FOR_VARIETY).flatMap((m: any) => (m.matches.scenario_ids ?? []).map(Number)),
  );
  const { data: theirSides } = playedAtByMatch.size
    ? await admin.from("match_sides").select("match_id, player_id, run_ids, submitted_at")
      .in("match_id", [...playedAtByMatch.keys()]).neq("player_id", callerId)
    : { data: [] as any[] };
  const recentSince = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentOpponentIds = new Set<string>();
  const facedRunIds = new Set<string>();
  const facedSideIds = new Set<string>();
  for (const side of (theirSides ?? []) as any[]) {
    const runIds: string[] = side.run_ids ?? [];
    if (runIds.length > 0) for (const id of runIds) facedRunIds.add(id);
    else if (side.submitted_at) facedSideIds.add(runSetId({ player_id: side.player_id, submitted_at: side.submitted_at }));
    if ((playedAtByMatch.get(side.match_id) ?? 0) >= recentSince) recentOpponentIds.add(side.player_id);
  }

  const inPool = new Set(selectable.map((s) => s.id));
  const banks = new Map<string, OpponentBank>();
  for (const c of (candidates ?? []) as any[]) {
    let bank = banks.get(c.player_id);
    if (!bank) {
      bank = { playerId: c.player_id, displayName: c.display_name ?? "player",
        rating: { rating: Number(c.rating), rd: Number(c.rd), volatility: Number(c.volatility) }, rounds: [] };
      banks.set(c.player_id, bank);
    }
    const scenarioIds: number[] = (c.scenario_ids ?? []).map(Number);
    const runIds: string[] = c.run_ids ?? [];
    const deltas: number[] = (c.deltas ?? []).map(Number);
    const scores: number[] = (c.scores ?? []).map(Number);
    for (const [i, scenarioId] of scenarioIds.entries()) {
      if (!inPool.has(scenarioId) || deltas[i] === undefined || scores[i] === undefined) continue;
      bank.rounds.push({
        runId: runIds[i] ?? null, scenarioId, score: scores[i], delta: deltas[i], provisional: !!c.provisional,
        difficulty: c.difficulty ?? windowName, playedAt: new Date(c.submitted_at), sideId: runSetId(c),
        strength: { rating: c.rating_before != null ? Number(c.rating_before) : null, rd: c.rd_before != null ? Number(c.rd_before) : null },
      });
    }
  }

  const criteria = {
    playerId: callerId, rating, category, difficulty: windowName, pool: selectable, seed: crypto.randomUUID(),
    recentOpponentIds, playedRecently, facedRunIds, facedSideIds, strength: "at-play" as const,
  };
  const result = findOpponent(criteria, [...banks.values()]);
  const outcome = !result.candidate ? "shadow" : shouldPlantFresh(criteria, result) ? "plant" : "opponent";
  return { outcome, opponents: banks.size };
}

/** The caller's open match, read without retiring anything (find-match's sweep does that). */
async function liveMatchId(admin: SupabaseClient, playerId: string): Promise<string | null> {
  const { data } = await admin.from("match_sides")
    .select("match_id, submitted_at, matches!inner(id, status, expires_at, created_at)")
    .eq("player_id", playerId).in("matches.status", ["open", "awaiting_runs"]);
  const now = Date.now();
  const live = (data ?? []).find((row: any) =>
    !isCopiedSide(row, row.matches) && (row.matches.expires_at == null || new Date(row.matches.expires_at).getTime() > now));
  return live ? (live as any).match_id : null;
}

export interface BoardRequest {
  category?: string | null;
  window?: number | null;
  /** The newest settledAt the client has shown; news up to it is marked read. */
  ack?: string | null;
}

/** Everything the queue screen's Shadow and Flag panels draw, for the signed-in caller. */
export async function queueBoard(admin: SupabaseClient, playerId: string, body: BoardRequest) {
  const now = new Date();

  // Acknowledged news first, so this answer already reflects it. Never past now, and never
  // backwards.
  const { data: readRow, error: readError } = await admin.from("flag_reads").select("seen_through").eq("player_id", playerId).maybeSingle();
  if (readError) throw new HttpError(500, readError.message);
  let seenThrough: string = readRow?.seen_through ?? new Date(now.getTime() - NEWS_DEFAULT_DAYS * 86_400_000).toISOString();
  if (typeof body.ack === "string" && Number.isFinite(Date.parse(body.ack))) {
    const acked = new Date(Math.min(Date.parse(body.ack), now.getTime()));
    if (acked > new Date(seenThrough)) {
      seenThrough = acked.toISOString();
      const { error } = await admin.from("flag_reads").upsert({ player_id: playerId, seen_through: seenThrough }, { onConflict: "player_id" });
      if (error) throw new HttpError(500, error.message);
    }
  }

  // The last week whether read or not, for the panel; unread is what the toast says.
  const weekAgo = new Date(now.getTime() - NEWS_DEFAULT_DAYS * 86_400_000).toISOString();
  const [records, recentBank, liveId] = await Promise.all([
    shadowRecords(admin, playerId),
    bankNews(admin, playerId, seenThrough < weekAgo ? seenThrough : weekAgo),
    liveMatchId(admin, playerId),
  ]);
  const news = recentBank.filter((n) => new Date(n.settledAt) > new Date(seenThrough));

  const nextPlan = planShadow(SHADOW_SCORES, playerId, records, []);
  const standing = shadowStanding(records);
  const shadow = {
    next: shadowView(nextPlan),
    standing,
    recent: records.filter((r) => r.result != null).slice(0, 8).map((r) => ({
      ordinal: r.ordinal, percentile: r.percentile, label: shadowLabel(r.percentile), result: r.result,
      tally: r.won == null ? null : tallyText({ won: r.won, lost: r.lost ?? 0, tied: r.tied ?? 0 }),
      decidedAt: r.decidedAt,
    })),
  };
  const activeShadow = liveId ? await shadowForMatch(admin, liveId) : null;

  let preview: Record<string, unknown> | null = null;
  if (typeof body.window === "number" && body.window >= 0 && typeof body.category === "string" && body.category) {
    const pool = await loadSeasonPool(admin, body.window);
    const inCategory = pool.selectable.filter((s) => matchesCategory(s, body.category as string));
    // How many of this category's scenarios a Shadow has a committed score on at the next
    // percentile, so the queue can say so before the player commits.
    const scored = inCategory.filter((s) => planShadow(SHADOW_SCORES, playerId, records, [s.name]).scores[0] != null).length;
    const base = { category: body.category, window: body.window, band: pool.windowName, scored, total: inCategory.length };
    if (liveId) {
      preview = { ...base, outcome: "live", line: "You have a match open. Finish or abandon it to queue again." };
    } else {
      const { count } = await admin.from("runs").select("id", { count: "exact", head: true })
        .eq("player_id", playerId).neq("verification_tier", "rejected");
      const eligibility = queueEligibility(count ?? 0, MIN_RUNS_TO_QUEUE);
      if (!eligibility.eligible) {
        preview = { ...base, outcome: "ineligible", line: eligibilityMessage(eligibility) };
      } else {
        const found = await previewPool(admin, playerId, body.category, body.window, pool.selectable, pool.windowName);
        preview = found.outcome === "opponent"
          ? { ...base, outcome: "opponent", opponents: found.opponents,
              line: `Banked rounds near your rating are waiting in ${pool.windowName} · ${body.category}. ` +
                "You'll play them best of three on raw score, and the result is rated." }
          : { ...base, outcome: found.outcome, opponents: found.opponents, shadow: shadowView(nextPlan),
              line: shadowQueueLine(shadowLabel(nextPlan.percentile), found.outcome === "plant") };
      }
    }
  }

  return {
    now: now.toISOString(),
    preview,
    shadow,
    activeShadow: activeShadow && liveId ? { matchId: liveId, ...activeShadow } : null,
    news,
    recentBank: recentBank.slice(0, 8),
    /** The newest settledAt in `news`; sent back as `ack` once shown. */
    newsThrough: news[0]?.settledAt ?? null,
  };
}
