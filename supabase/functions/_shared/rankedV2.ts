/**
 * Ranked v2, server side: settlement, forfeits and the expiry sweep under the rules in
 * src/core/rating/ranked.ts.
 *
 * Reached only through find-match-v2, settle-match-v2 and abandon-match-v2, and those
 * only answer an admin. The v1 functions do not import this file, so deploying it changes
 * nothing for anybody on a released build. What v2 changes, and what it was measured
 * against, is in ranked.ts and PLAN.md §4; this file is the plumbing.
 *
 * WHICH RULES A MATCH IS SETTLED BY
 *
 * The match's, not the caller's. `matches.engine` records which engine created it, and
 * everything here applies that engine's rules: a duel answer or a tournament leg is still
 * created by a v1 function, so a tester who settles one through v2 gets exactly what v1
 * would have done. (The v1 functions do not read the column, so the reverse - a v2 match
 * settled through settle-match by a build that fell back mid-match - is settled as v1.) Only a match find-match-v2 created is rated by rounds against the
 * opponent's rating at play, and only there does leaving a scenario early stop being free.
 */

import {
  baselineFor,
  commitMatchResult,
  HttpError,
  isCopiedSide,
  isOffPool,
  type ForfeitOutcome,
  type LiveMatch,
  type RatingProposal,
} from "./apogee.ts";
import { afterLegSettled } from "./tournament.ts";

import { baselineFromScores } from "../../../src/core/history/baseline.ts";
import { isAbandonedRun } from "../../../src/core/stats/duration.ts";
import type { Rating } from "../../../src/core/rating/glicko2.ts";
import { rateForfeit, rateResult, RANKED_OUTCOME, type OutcomeModel, type RoundTally } from "../../../src/core/rating/ranked.ts";
import {
  explainVerdict,
  roundTally,
  settleMatch,
  settleSide,
  type RoundSubmission,
} from "../../../src/core/match/settle.ts";
import type { VerificationTier } from "../../../src/core/verify/verifyRun.ts";

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** What find-match-v2 writes to `matches.engine`. */
export const RANKED_V2_ENGINE = 2;

/**
 * The refusal a non-tester gets. The client matches on it to fall back to v1, so a
 * development build used by somebody without access still plays ranked.
 */
export const RANKED_V2_CLOSED = "ranked v2 is only open to testers";

/**
 * The refusal when the functions are deployed but migration 20261010000025 is not. The
 * client falls back to v1 on it too: otherwise deploying in the wrong order turns every
 * queue from a development build into a 500.
 */
export const RANKED_V2_UNMIGRATED = "ranked v2's migration is not applied (npx supabase db push)";

/**
 * Free voids for leaving a scenario early, per player, per rolling week.
 *
 * Leaving a scenario before it ends used to void the match at no cost, always, because a
 * crash and a quit write the same short file. That made quitting the cheapest way out of
 * a match that started badly: play round one, dislike the number, leave round two, and
 * the match is gone. Expiring is a forfeit and Abandon is a forfeit; this was the one exit
 * that cost nothing.
 *
 * One a week, because honest early endings are rare enough that one covers them: 2 of
 * the corpus's 14,486 runs end before 90% of their length (`npm run validate:duration`),
 * one in about 7,000, which at three runs a match is one ranked match in about 2,400. A
 * second inside a week is a round lost, not a match: the other two rounds still count.
 */
export const FREE_ABANDONS_PER_WEEK = 1;
const ABANDON_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface EnginePolicy {
  engine: number;
  model: OutcomeModel;
  /** Null: leaving early always voids, as v1 does. */
  freeAbandons: number | null;
}

export function policyFor(engine: number | null | undefined): EnginePolicy {
  return engine === RANKED_V2_ENGINE
    ? { engine: RANKED_V2_ENGINE, model: RANKED_OUTCOME, freeAbandons: FREE_ABANDONS_PER_WEEK }
    : { engine: 1, model: "match", freeAbandons: null };
}

/** Refuse anybody who is not an admin, and everybody while the migration is missing. */
export async function requireRankedV2(admin: SupabaseClient, playerId: string): Promise<void> {
  const { data, error } = await admin.from("admins").select("player_id").eq("player_id", playerId).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(403, RANKED_V2_CLOSED);

  // A window that cannot exist, so this reads nothing and only asks whether the function
  // is there. PGRST202 is PostgREST's "no such function".
  const probe = await admin.rpc("ranked_pool_rounds", {
    p_window: -1, p_caller: playerId, p_rating: 0, p_players: 1, p_sides_per_player: 1,
  });
  if (probe.error?.code === "PGRST202") throw new HttpError(503, RANKED_V2_UNMIGRATED);
  if (probe.error) throw new HttpError(500, probe.error.message);
}

async function readRating(admin: SupabaseClient, playerId: string): Promise<{ rating: Rating; matchesPlayed: number }> {
  const { data, error } = await admin
    .from("ratings")
    .select("rating, rd, volatility, matches_played")
    .eq("player_id", playerId)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  return {
    rating: {
      rating: Number(data?.rating ?? 1500),
      rd: Number(data?.rd ?? 350),
      volatility: Number(data?.volatility ?? 0.06),
    },
    matchesPlayed: Number(data?.matches_played ?? 0),
  };
}

/**
 * The rating a stored side is played against: what find-match wrote on it.
 *
 * find-match-v2 writes the owner's rating when they played those rounds; v1 wrote their
 * rating when the match was created. Either way it is the number matchmaking used, so the
 * two cannot disagree about who the opponent was.
 */
function sideRating(side: { rating_before?: unknown; rd_before?: unknown }): Rating {
  return {
    rating: Number(side.rating_before ?? 1500),
    rd: Number(side.rd_before ?? 350),
    volatility: 0.06,
  };
}

/** Voids this player has spent on leaving early inside the last week. */
async function abandonsThisWeek(admin: SupabaseClient, playerId: string): Promise<{ count: number; oldest: Date | null }> {
  const since = new Date(Date.now() - ABANDON_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from("match_sides")
    .select("submitted_at, matches!inner(created_at, status, void_reason, settled_at)")
    .eq("player_id", playerId)
    .eq("matches.status", "void")
    .eq("matches.void_reason", "abandoned")
    .gte("matches.settled_at", since);
  if (error) throw new HttpError(500, error.message);

  // The player's own side, not a copy of their rounds in a match somebody else left.
  const own = (data ?? []).filter((row: any) => !isCopiedSide(row, row.matches));
  const oldest = own
    .map((row: any) => new Date(row.matches.settled_at))
    .sort((a: Date, b: Date) => a.getTime() - b.getTime())[0] ?? null;
  return { count: own.length, oldest };
}

function flip(tally: RoundTally): RoundTally {
  return { won: tally.lost, lost: tally.won, tied: tally.tied };
}

/**
 * Rate the sender of a duel too, as prepareChallengerRating does for v1, by the same
 * rounds the caller was rated on, seen from the other side.
 */
async function prepareChallenger(
  admin: SupabaseClient,
  answerMatchId: string,
  challengerTally: RoundTally,
  weight: number,
  model: OutcomeModel,
  opponentBefore: Rating,
): Promise<{ side: Record<string, unknown>; rating: RatingProposal } | null> {
  const { data: duel, error: duelError } = await admin
    .from("duels")
    .select("id, challenger_id")
    .eq("answer_match_id", answerMatchId)
    .maybeSingle();
  if (duelError) throw new HttpError(500, duelError.message);
  if (!duel) return null;

  const { data: sides, error: sidesError } = await admin
    .from("match_sides")
    .select("player_id, deltas, result")
    .eq("match_id", answerMatchId);
  if (sidesError) throw new HttpError(500, sidesError.message);
  const theirs = (sides ?? []).find((s: { player_id: string }) => s.player_id === duel.challenger_id);
  if (!theirs) throw new HttpError(500, "duel sides are incomplete");
  if (theirs.result != null || !Array.isArray(theirs.deltas) || theirs.deltas.length === 0) return null;

  const { rating: before, matchesPlayed } = await readRating(admin, duel.challenger_id);
  const update = rateResult({ before, opponent: opponentBefore, tally: challengerTally, weight, model });
  const result = challengerTally.won > challengerTally.lost ? "win" : challengerTally.won < challengerTally.lost ? "loss" : "draw";

  return {
    side: {
      player_id: duel.challenger_id, result,
      rating_before: before.rating, rating_after: update.after.rating,
      rd_before: before.rd, rd_after: update.after.rd, record_submission: false,
    },
    rating: {
      player_id: duel.challenger_id, before, after: update.after,
      matches_played: matchesPlayed, score: update.score, weight,
    },
  };
}

export interface SettleOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Settle one player's match. settle-match-v2's whole job, and what the sweep runs for a
 * match whose runs are all in but which nobody settled before it expired.
 *
 * Follows settle-match step for step; where it differs, it says so.
 */
export async function settleForPlayer(
  admin: SupabaseClient,
  matchId: string,
  playerId: string,
  depth = 0,
): Promise<SettleOutcome> {
  if (depth > 2) throw new HttpError(409, "the match changed while it was being settled; try again");
  const again = () => settleForPlayer(admin, matchId, playerId, depth + 1);

  const { data: match, error: matchError } = await admin
    .from("matches")
    .select("id, status, category, difficulty, scenario_ids, created_at, expires_at, settled_at, rated, engine")
    .eq("id", matchId)
    .maybeSingle();
  if (matchError) throw new HttpError(500, matchError.message);
  if (!match) throw new HttpError(404, "no such match");

  const rated = match.rated !== false;
  const policy = policyFor(match.engine);

  const { data: sides, error: sidesError } = await admin
    .from("match_sides")
    .select("match_id, player_id, run_ids, deltas, scores, match_score, result, provisional, rating_before, rd_before, rating_after, rd_after, submitted_at")
    .eq("match_id", matchId);
  if (sidesError) throw new HttpError(500, sidesError.message);

  const mine = (sides ?? []).find((s: any) => s.player_id === playerId && !isCopiedSide(s, match));
  const theirs = (sides ?? []).find((s: any) => s.player_id !== playerId);
  if (!mine) throw new HttpError(403, "you are not in that match");

  if (match.status === "settled" || match.status === "void") {
    return {
      status: 200,
      body: {
        matchId,
        alreadySettled: true,
        engine: policy.engine,
        seeding: !theirs,
        rated,
        tournament: rated ? null : await afterLegSettled(admin, matchId),
        verdict: match.status === "void" ? "void" : mine.result,
        yourMatchScore: mine.match_score != null ? Number(mine.match_score) : null,
        theirMatchScore: theirs?.match_score != null ? Number(theirs.match_score) : null,
        ratingBefore: mine.rating_before != null ? Number(mine.rating_before) : null,
        ratingAfter: mine.rating_after != null ? Number(mine.rating_after) : null,
      },
    };
  }

  const seeding = !theirs;
  const scenarioIds: number[] = (match.scenario_ids ?? []).map(Number);

  const { data: runs, error: runsError } = await admin
    .from("runs")
    .select("id, scenario_id, scenario_name, score, verification_tier, played_at, duration_seconds")
    .eq("player_id", playerId)
    .eq("match_id", matchId)
    .order("match_submitted_at", { ascending: true })
    .order("id", { ascending: true });
  if (runsError) throw new HttpError(500, runsError.message);

  const { data: scenarioRows, error: scenarioError } = await admin
    .from("scenarios")
    .select("id, name, duration_seconds")
    .in("id", scenarioIds);
  if (scenarioError) throw new HttpError(500, scenarioError.message);
  const expectedSeconds = new Map<number, number | null>(
    (scenarioRows ?? []).map((s: any) => [Number(s.id), s.duration_seconds ?? null]),
  );

  // The first run submitted on each scenario is the one that counts.
  const firstByScenario = new Map<number, any>();
  for (const r of runs ?? []) {
    const id = Number(r.scenario_id);
    if (r.scenario_id != null && !firstByScenario.has(id)) firstByScenario.set(id, r);
  }

  const abandoned = (r: any) =>
    isAbandonedRun(
      r.duration_seconds != null ? Number(r.duration_seconds) : null,
      expectedSeconds.get(Number(r.scenario_id)) ?? null,
    );
  const abandonedRun = [...firstByScenario.values()].find(abandoned);

  // ---- leaving a scenario early --------------------------------------------------
  //
  // v1 voids on the spot, always. v2 does too while the week's free void is unspent, and
  // for anything with nothing at stake (a seeding match, a tournament leg); otherwise the
  // round is lost and the match plays on (FREE_ABANDONS_PER_WEEK says why).
  let loseAbandoned = false;
  let freeAbandon: { used: true; nextFreeAt: string | null } | null = null;
  if (abandonedRun) {
    const contested = !seeding && rated && policy.freeAbandons !== null;
    const spent = contested ? await abandonsThisWeek(admin, playerId) : { count: 0, oldest: null };
    const free = !contested || spent.count < (policy.freeAbandons as number);

    if (free) {
      if (contested) {
        // Before the commit, so the void and its reason land together or not at all: a
        // reason on a match that then settles normally is never counted (status 'void').
        const { error } = await admin.from("matches").update({ void_reason: "abandoned" })
          .eq("id", matchId).in("status", ["open", "awaiting_runs"]);
        if (error) throw new HttpError(500, error.message);
        freeAbandon = { used: true, nextFreeAt: new Date(Date.now() + ABANDON_WINDOW_MS).toISOString() };
      }
      const receipt = await commitMatchResult(admin, matchId, "void", [{ player_id: playerId, result: null }]);
      if (!receipt.committed) return again();

      const tournament = rated ? null : await afterLegSettled(admin, matchId);
      const name = abandonedRun.scenario_name;
      return {
        status: 200,
        body: {
          matchId,
          engine: policy.engine,
          verdict: "void",
          rated: false,
          tournament,
          voidReason: "a scenario was left before it finished",
          scenario: name,
          playedSeconds: abandonedRun.duration_seconds != null ? Number(abandonedRun.duration_seconds) : null,
          expectedSeconds: expectedSeconds.get(Number(abandonedRun.scenario_id)) ?? null,
          ratingChange: 0,
          freeAbandon,
          message: tournament
            ? `${name} ended early, so this leg is void and ${tournament.label} will be replayed. Nothing was rated.`
            : freeAbandon
              ? `${name} ended early, so this match is void and nothing was rated. That was this week's free ` +
                "one: leave another scenario early within seven days and that round counts as lost."
              : `${name} ended early, so this match is void. Nothing was rated. You can queue again now.`,
        },
      };
    }
    loseAbandoned = true;
  }

  const missing = scenarioIds.filter((id) => !firstByScenario.has(id));
  if (missing.length > 0) {
    const nameById = new Map((scenarioRows ?? []).map((s: any) => [Number(s.id), s.name]));
    return {
      status: 409,
      body: {
        error: "match is not complete yet",
        remaining: missing.map((id) => nameById.get(id) ?? `scenario ${id}`),
        submitted: firstByScenario.size,
        required: scenarioIds.length,
        // Said now, while the player can still win the other rounds, rather than at the end.
        lostRound: loseAbandoned ? abandonedRun.scenario_name : null,
      },
    };
  }

  // ---- baselines as they stood when the match began (settle-match says why) ----------
  const baselines = await Promise.all(
    scenarioIds.map((scenarioId) =>
      baselineFor(admin, playerId, scenarioId, firstByScenario.get(scenarioId)!.scenario_name,
        baselineFromScores, { at: match.created_at, matchId }),
    ),
  );

  const playerRounds: RoundSubmission[] = scenarioIds.map((scenarioId, i) => {
    const run = firstByScenario.get(scenarioId)!;
    const baseline = baselines[i];
    return {
      scenarioId,
      scenarioName: run.scenario_name,
      score: Number(run.score),
      baseline: baseline.runCount > 0 ? baseline.value : Number(run.score),
      provisional: baseline.provisional,
      verificationTier: run.verification_tier as VerificationTier,
      abandoned: abandoned(run),
    };
  });
  const runIds = scenarioIds.map((id) => firstByScenario.get(id)!.id);

  if (seeding) {
    const side = settleSide(playerRounds, "rounds");
    const receipt = await commitMatchResult(admin, matchId, "settled", [{
      player_id: playerId, run_ids: runIds,
      deltas: side.rounds.map((r) => r.delta ?? 0), match_score: side.matchScore,
      scores: playerRounds.map((r) => r.score), result: null, provisional: side.provisional,
    }]);
    if (!receipt.committed) return again();

    const tournament = rated ? null : await afterLegSettled(admin, matchId);
    const firstLeg = tournament
      ? `Your three are in for ${tournament.label}. Your opponent plays the same three next, ` +
        "and the fixture is decided when they have. Nothing is rated."
      : null;
    const pooled = side.countedRounds === scenarioIds.length;
    return {
      status: 200,
      body: {
        matchId, engine: policy.engine, seeding: true, rated: false, tournament, verdict: null,
        yourMatchScore: side.matchScore, theirMatchScore: null, countedRounds: side.countedRounds,
        rounds: side.rounds.map((r) => ({
          scenario: r.scenarioName, score: r.score, baseline: Math.round(r.baseline), delta: r.delta,
          opponentDelta: null, counted: r.counted, excludedReason: r.excludedReason ?? null,
          verificationTier: r.verificationTier,
        })),
        ratingChange: 0,
        explanation: firstLeg ?? (pooled
          ? "Nothing was rated: there was no opponent to play against. Your run set is now in the pool, " +
            "and the next player to queue this category plays against it."
          : "Recorded, but not every scenario counted, so this run set is not in the pool yet."),
        message: firstLeg ?? (pooled
          ? "Your run set is in the pool. The next player to queue this category plays against it."
          : "Recorded, but not every scenario counted, so this run set is not in the pool yet."),
      },
    };
  }

  // ---- contested ------------------------------------------------------------------
  const opponentDeltas: number[] = (theirs!.deltas ?? []).map(Number);
  const opponentScores = await frozenScores(admin, theirs!, scenarioIds.length);
  const format = opponentScores ? "rounds" : "mean-delta";

  const opponentRounds: RoundSubmission[] = scenarioIds.map((scenarioId, i) => {
    const delta = opponentDeltas[i] ?? 0;
    const score = opponentScores ? opponentScores[i] : 1 + delta;
    return {
      scenarioId,
      scenarioName: playerRounds[i].scenarioName,
      score,
      baseline: 1 + delta > 0 ? score / (1 + delta) : score,
      provisional: !!theirs!.provisional,
      verificationTier: "consistent",
    };
  });

  const settlement = settleMatch({ playerRounds, opponentRounds, format, abandonedRoundsLose: loseAbandoned });
  const tally = settlement.format === "rounds"
    ? roundTally(settlement)
    : settlement.verdict === "win" ? { won: 1, lost: 0, tied: 0 }
    : settlement.verdict === "loss" ? { won: 0, lost: 1, tied: 0 } : { won: 0, lost: 0, tied: 1 };
  // A match decided on deltas is one result, whatever the engine.
  const model: OutcomeModel = settlement.format === "rounds" ? policy.model : "match";

  const { rating: before, matchesPlayed } = await readRating(admin, playerId);
  const opponentRating = sideRating(theirs!);
  const counts = settlement.verdict !== "void" && rated;
  const update = counts
    ? rateResult({ before, opponent: opponentRating, tally, weight: settlement.ratingWeight, model })
    : { before, after: before, score: 0.5 };

  const sidePlans: Record<string, unknown>[] = [{
    player_id: playerId, run_ids: runIds,
    deltas: settlement.player.rounds.map((r) => r.delta ?? 0),
    scores: playerRounds.map((r) => r.score),
    match_score: settlement.player.matchScore,
    result: settlement.verdict === "void" ? null : settlement.verdict,
    provisional: settlement.player.provisional,
    rating_before: before.rating, rating_after: update.after.rating,
    rd_before: before.rd, rd_after: update.after.rd,
  }];
  const ratingPlans: RatingProposal[] = [];
  if (counts) {
    ratingPlans.push({ player_id: playerId, before, after: update.after, matches_played: matchesPlayed,
      score: update.score, weight: settlement.ratingWeight });
    const challenger = await prepareChallenger(admin, matchId, flip(tally), settlement.ratingWeight, model, before);
    if (challenger) { sidePlans.push(challenger.side); ratingPlans.push(challenger.rating); }
  }
  const receipt = await commitMatchResult(admin, matchId,
    settlement.verdict === "void" ? "void" : "settled", sidePlans, ratingPlans);
  if (!receipt.committed) return again();

  const { data: opponentPlayer } = await admin
    .from("players").select("id, display_name").eq("id", theirs!.player_id).maybeSingle();
  const tournament = rated ? null : await afterLegSettled(admin, matchId);
  const roundResults = settlement.roundResults ?? [];
  let counted = 0;

  return {
    status: 200,
    body: {
      matchId,
      engine: policy.engine,
      ratingModel: model,
      verdict: settlement.verdict,
      rated,
      tournament,
      opponent: opponentPlayer && settlement.verdict !== "void"
        ? { playerId: opponentPlayer.id, displayName: opponentPlayer.display_name }
        : null,
      category: match.category,
      explanation: rated
        ? explainVerdict(settlement)
        : `${explainVerdict(settlement)} Unrated: this was a tournament fixture.`,
      voidReason: settlement.voidReason ?? null,
      ratingWeight: settlement.ratingWeight,
      yourMatchScore: settlement.player.matchScore,
      theirMatchScore: settlement.opponent.matchScore,
      format: settlement.format,
      roundTally: settlement.format === "rounds" && settlement.verdict !== "void" ? tally : null,
      ratingBefore: Math.round(before.rating),
      ratingAfter: Math.round(update.after.rating),
      ratingChange: Math.round(update.after.rating - before.rating),
      // What the opponent was rated as, so the result can say who those rounds were.
      opponentRating: Math.round(opponentRating.rating),
      rounds: settlement.player.rounds.map((r, i) => ({
        scenario: r.scenarioName,
        score: r.score,
        baseline: Math.round(r.baseline),
        delta: r.delta,
        opponentDelta: opponentDeltas[i] ?? null,
        opponentScore: opponentScores ? opponentScores[i] : null,
        result: settlement.format === "rounds" && r.counted && settlement.verdict !== "void"
          ? roundResults[counted++] ?? null
          : null,
        counted: r.counted,
        excludedReason: r.excludedReason ?? null,
        verificationTier: r.verificationTier,
      })),
    },
  };
}

/** The opponent's raw scores, as settle-match's frozenScores finds them. */
async function frozenScores(
  admin: SupabaseClient,
  side: { player_id: string; submitted_at: string | null; scores?: unknown[] | null },
  rounds: number,
): Promise<number[] | null> {
  const own = (side.scores ?? []).map(Number);
  if (own.length === rounds && own.every(Number.isFinite)) return own;
  if (!side.submitted_at) return null;

  const { data, error } = await admin
    .from("match_sides")
    .select("scores")
    .eq("player_id", side.player_id)
    .eq("submitted_at", side.submitted_at)
    .neq("scores", "{}")
    .limit(1);
  if (error) throw new HttpError(500, error.message);
  const found = ((data ?? [])[0]?.scores ?? []).map(Number);
  return found.length === rounds && found.every(Number.isFinite) ? found : null;
}

/**
 * End a match the player will not finish: forfeitMatch's rules, and the rating change
 * the match's engine gives a forfeit (under rounds, every round lost).
 */
export async function forfeitMatchV2(admin: SupabaseClient, matchId: string, playerId: string): Promise<ForfeitOutcome> {
  const sideResult = await admin.from("match_sides")
    .select("player_id, rating_before, rd_before, match_score").eq("match_id", matchId);
  if (sideResult.error) throw new HttpError(500, sideResult.error.message);
  const mine = (sideResult.data ?? []).find((s: any) => s.player_id === playerId);
  const opponent = (sideResult.data ?? []).find((s: any) => s.player_id !== playerId);
  if (!mine) throw new HttpError(403, "you are not in that match");

  const matchResult = await admin.from("matches")
    .select("status, rated, scenario_ids, window_index, engine").eq("id", matchId).maybeSingle();
  if (matchResult.error) throw new HttpError(500, matchResult.error.message);
  const match = matchResult.data;
  if (!match) throw new HttpError(404, "no such match");
  if (match.status === "settled" || match.status === "void") {
    return { matchId, rated: false, verdict: null, reason: "already-settled" };
  }
  if (mine.match_score != null) return { matchId, rated: false, verdict: null, reason: "already-played" };

  const simple = async (status: "settled" | "void", verdict: "loss" | null,
    reason: "seeding" | "off-pool" | "forfeit"): Promise<ForfeitOutcome> => {
    const receipt = await commitMatchResult(admin, matchId, status, [{ player_id: playerId, result: verdict }], [], true);
    return { matchId, rated: false, verdict: receipt.committed ? verdict : null,
      reason: receipt.committed ? reason : receipt.reason ?? "already-settled" };
  };
  if (!opponent) return simple("void", null, "seeding");
  if (match.rated === false) return simple("settled", "loss", "forfeit");
  if (await isOffPool(admin, match.scenario_ids, match.window_index)) return simple("void", null, "off-pool");

  const policy = policyFor(match.engine);
  const rounds = (match.scenario_ids ?? []).length || 3;
  const { rating: before, matchesPlayed } = await readRating(admin, playerId);
  const update = rateForfeit({ before, opponent: sideRating(opponent), rounds, model: policy.model });

  const plans: RatingProposal[] = [{ player_id: playerId, before, after: update.after,
    matches_played: matchesPlayed, score: update.score, weight: 1 }];
  const sides: Record<string, unknown>[] = [{ player_id: playerId, result: "loss",
    rating_before: before.rating, rating_after: update.after.rating, rd_before: before.rd, rd_after: update.after.rd }];
  const challengerTally = policy.model === "rounds" ? { won: rounds, lost: 0, tied: 0 } : { won: 1, lost: 0, tied: 0 };
  const challenger = await prepareChallenger(admin, matchId, challengerTally, 1, policy.model, before);
  if (challenger) { sides.push(challenger.side); plans.push(challenger.rating); }

  const receipt = await commitMatchResult(admin, matchId, "settled", sides, plans, true);
  if (!receipt.committed) return { matchId, rated: false, verdict: null, reason: receipt.reason ?? "already-settled" };
  return { matchId, rated: true, verdict: "loss", reason: "forfeit",
    ratingBefore: Math.round(before.rating), ratingAfter: Math.round(update.after.rating),
    ratingChange: Math.round(update.after.rating - before.rating) };
}

/**
 * sweepStaleMatches, with one hole closed: a match whose runs are all in, but which was
 * never settled, is settled here instead of being left open forever.
 *
 * v1 asks forfeitMatch to retire every expired match, and forfeitMatch rightly refuses
 * one whose runs are in ("already-played"). Nothing then settles it: the client gives up
 * after four retries, the match stays `awaiting_runs` for good, its result never reaches
 * the ladder and its rounds never reach the pool, and the sweep steps around it on every
 * queue after. Settling it is the only answer that matches what the player did.
 */
export async function sweepStaleMatchesV2(admin: SupabaseClient, playerId: string): Promise<LiveMatch | null> {
  const { data: rows, error } = await admin
    .from("match_sides")
    .select("match_id, submitted_at, matches!inner(id, status, category, difficulty, scenario_ids, window_index, expires_at, created_at, engine)")
    .eq("player_id", playerId)
    .in("matches.status", ["open", "awaiting_runs"]);
  if (error) throw new HttpError(500, error.message);

  const openMatches = (rows ?? []).filter((row: any) => !isCopiedSide(row, row.matches));
  const now = Date.now();
  const stale: any[] = [];
  for (const row of openMatches as any[]) {
    const expiresAt = row.matches?.expires_at;
    if (expiresAt != null && new Date(expiresAt).getTime() < now) stale.push(row);
    else if (await isOffPool(admin, row.matches?.scenario_ids, row.matches?.window_index)) stale.push(row);
  }

  for (const row of stale) {
    const outcome = await forfeitMatchV2(admin, row.match_id, playerId);
    if (outcome.reason === "already-played") {
      try {
        await settleForPlayer(admin, row.match_id, playerId);
      } catch (err) {
        // Logged rather than thrown: a match that cannot be settled must not also stop
        // the player queueing. It stays open, and the next sweep tries again.
        console.error(`sweep could not settle ${row.match_id}:`, err);
      }
    }
  }

  const staleIds = new Set(stale.map((row) => row.match_id));
  const live = (openMatches as any[]).find((row) => !staleIds.has(row.match_id));
  return live ? { matchId: live.match_id, match: live.matches } : null;
}
