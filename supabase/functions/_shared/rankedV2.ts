/**
 * Ranked, server side: settlement, forfeits and the expiry sweep under the rules in
 * src/core/rating/ranked.ts. settle-match and abandon-match are thin over this, and
 * find-match, send-duel, answer-duel, play-fixture and the tournament reconciler all
 * retire stale matches through it, so there is one rule for ending a match.
 *
 * What v2 changed, and what it was measured against, is in ranked.ts and PLAN.md §4; this
 * file is the plumbing. It ran beside v1 for admins first, then replaced it.
 *
 * Settlement is idempotent. A client that calls it twice, or two clients racing, must not
 * apply the rating change twice: every terminal write goes through commit_match_result,
 * which commits once, and a match already settled returns its stored result untouched.
 *
 * WHICH RULES A MATCH IS SETTLED BY
 *
 * The match's, not the caller's. `matches.engine` records which engine created it, and
 * everything here applies that engine's rules. Only find-match writes 2. A duel answer or
 * a tournament leg is created as 1, as is every match from before v2, and is settled,
 * forfeited and swept exactly as v1 did: one result against the opponent's rating, and
 * leaving a scenario early always voids. Only a queued match is rated by rounds against
 * the opponent's rating at play, and only there does leaving early stop being free.
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
import { arenaNote } from "./arena.ts";

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

/** What find-match writes to `matches.engine`. */
export const RANKED_V2_ENGINE = 2;

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
 * find-match writes the owner's rating when they played those rounds; before v2 it wrote
 * their rating when the match was created, and a duel carries the sender's from when
 * they sent it. Either way it is the number matchmaking used, so the
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
 * Rate the player whose stored run set was just played against, when it was a duel.
 *
 * WHY THIS DOES NOT APPLY TO THE QUEUE
 *
 * Settlement rates the caller and nobody else, and for the pool that is right rather
 * than an oversight. A stored side is never consumed: it answers as many callers as draw
 * it, so rating its owner on every one would multiply a single afternoon's performance
 * into ten rating changes they did not play for. You are rated for matches you played,
 * not for being a record somebody else played against.
 *
 * A duel is the one case where that reasoning does not hold. It is addressed at exactly
 * one person and answered exactly once, so the run set is used for one contest and its
 * owner sat down to play it knowing who it was for. Leaving them unrated is what makes
 * sending a duel a purely charitable act - it would move nothing for the sender, so the
 * only rated thing anybody could do is answer one, and a feature nobody has a reason to
 * start is a feature that does not happen.
 *
 * This prepares both a side update and a rating proposal without writing either.
 * The caller commits these with its own result in commit_match_result, which checks
 * current ratings under locks and refuses duplicate terminal transitions.
 *
 * Their rating is read live from `ratings` rather than from `rating_before` on the frozen
 * side, which was written when they played and may be days and several matches stale.
 * They are rated by the same rounds the caller was, seen from the other side, under the
 * match's engine.
 */
export async function prepareChallenger(
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
 * Settle one player's match and move the ladder. settle-match's whole job, and what the
 * sweep runs for a match whose runs are all in but which nobody settled before it expired.
 *
 * Everything that decides the result is recomputed here from stored rows: the runs, the
 * baselines, the deltas, the verdict, the rating change. Nothing is taken from the
 * request beyond which match to settle. That is the whole point of the security model
 * (PLAN.md §7) and the reason this runs with the service role rather than in the app.
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

  // False only for a tournament leg (migration 20260912000018). Everything below still runs
  // - the runs, the baselines, the deltas, the verdict - and only the rating writes are
  // skipped, so a tournament result is decided exactly the way a ladder one is.
  const rated = match.rated !== false;
  const policy = policyFor(match.engine);

  const { data: sides, error: sidesError } = await admin
    .from("match_sides")
    .select("match_id, player_id, run_ids, deltas, scores, match_score, result, provisional, rating_before, rd_before, rating_after, rd_after, submitted_at")
    .eq("match_id", matchId);
  if (sidesError) throw new HttpError(500, sidesError.message);

  // The caller's own side, never a copy of their stored run set that is the opponent
  // here: settling through that closed a stranger's match before they had played it.
  const mine = (sides ?? []).find((s: any) => s.player_id === playerId && !isCopiedSide(s, match));
  const theirs = (sides ?? []).find((s: any) => s.player_id !== playerId);
  if (!mine) throw new HttpError(403, "you are not in that match");

  // Already settled: return what was stored rather than recomputing and re-applying. The
  // tournament fold runs again on a repeat call, a no-op once it has landed and the retry
  // that lands it if the first call died before it could.
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
        // A Crown challenge or a race leg: what the database decided about it.
        arena: rated ? null : await arenaNote(admin, matchId, playerId),
        verdict: match.status === "void" ? "void" : mine.result,
        yourMatchScore: mine.match_score != null ? Number(mine.match_score) : null,
        theirMatchScore: theirs?.match_score != null ? Number(theirs.match_score) : null,
        ratingBefore: mine.rating_before != null ? Number(mine.rating_before) : null,
        ratingAfter: mine.rating_after != null ? Number(mine.rating_after) : null,
      },
    };
  }

  // A seeding match has one side by design: the pool was empty when it was handed out, so
  // there was never an opponent to be found. Nothing was contested, so nothing is rated,
  // but the side still has to be scored and stored here, because submit-run only records
  // runs and it is this function that writes deltas and match_score. Until those exist
  // the pool read in find-match cannot see the run set.
  const seeding = !theirs;
  const scenarioIds: number[] = (match.scenario_ids ?? []).map(Number);

  // ---- the caller's runs for this match ------------------------------------------

  const { data: runs, error: runsError } = await admin
    .from("runs")
    .select("id, scenario_id, scenario_name, score, verification_tier, played_at, duration_seconds")
    .eq("player_id", playerId)
    .eq("match_id", matchId)
    .order("match_submitted_at", { ascending: true })
    .order("id", { ascending: true });
  if (runsError) throw new HttpError(500, runsError.message);

  // How long each of these scenarios is supposed to last, so a run that stopped early
  // can be told from one that went badly.
  const { data: scenarioRows, error: scenarioError } = await admin
    .from("scenarios")
    .select("id, name, duration_seconds")
    .in("id", scenarioIds);
  if (scenarioError) throw new HttpError(500, scenarioError.message);
  const expectedSeconds = new Map<number, number | null>(
    (scenarioRows ?? []).map((s: any) => [Number(s.id), s.duration_seconds ?? null]),
  );

  // One run per scenario: the first submitted counts, in the server's receipt order, so a
  // player cannot keep retrying a scenario until it goes well and then settle, nor
  // backdate a later attempt's played_at to put it first.
  const firstByScenario = new Map<number, any>();
  for (const r of runs ?? []) {
    const id = Number(r.scenario_id);
    if (r.scenario_id != null && !firstByScenario.has(id)) firstByScenario.set(id, r);
  }

  // Left before the scenario finished: not a bad score, an absent one. Both sides of this
  // can be null - an unreadable duration, or a scenario with no fixed length - and
  // isAbandonedRun answers false to either, so a check that cannot be confident never
  // costs anyone a round or a void.
  const abandoned = (r: any) =>
    isAbandonedRun(
      r.duration_seconds != null ? Number(r.duration_seconds) : null,
      expectedSeconds.get(Number(r.scenario_id)) ?? null,
    );
  const abandonedRun = [...firstByScenario.values()].find(abandoned);

  // ---- leaving a scenario early --------------------------------------------------
  //
  // Said now rather than after two more scenarios, while the player still wants the
  // queue. An engine-1 match voids on the spot, always, as v1 did. A v2 match does too
  // while the week's free void is unspent, and for anything with nothing at stake (a
  // seeding match, a tournament leg); otherwise the round is lost and the match plays on
  // (FREE_ABANDONS_PER_WEEK says why).
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
      const arena = rated ? null : await arenaNote(admin, matchId, playerId);
      const name = abandonedRun.scenario_name;
      return {
        status: 200,
        body: {
          matchId,
          engine: policy.engine,
          verdict: "void",
          rated: false,
          tournament,
          arena,
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

  // ---- baselines, as they stood when the match began ------------------------------
  //
  // Recomputed from the runs played before the match, never read from the stored row.
  // submit-run refreshes that row as each match run lands, so by the time this ran it
  // already held the very runs it was about to measure. On a scenario with no earlier
  // history uploaded the baseline was the run itself, and every such round read exactly
  // 0%; with some history it was still pulled toward the score. The rule was measured
  // (compareBaselines, coldStart) against the runs strictly before each one, and that is
  // what this restores.
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
      // Nothing played before the match to measure against: the run stands as its own
      // baseline for a provisional 0%, stated rather than arrived at by accident. PLAN.md
      // §3's fallback chain (a sibling scenario, the sub-category, the rank cohort) is the
      // better answer and is not built yet.
      baseline: baseline.runCount > 0 ? baseline.value : Number(run.score),
      provisional: baseline.provisional,
      verificationTier: run.verification_tier as VerificationTier,
      abandoned: abandoned(run),
    };
  });
  const runIds = scenarioIds.map((id) => firstByScenario.get(id)!.id);

  // A seeding match has nothing to compare against, so it is scored on its own and
  // recorded without touching the ladder. Storing the deltas is the whole purpose: this
  // side is what the next player to queue will be matched against. Scored as rounds, the
  // format whoever draws these rounds will be settled in.
  if (seeding) {
    const side = settleSide(playerRounds, "rounds");
    const receipt = await commitMatchResult(admin, matchId, "settled", [{
      player_id: playerId, run_ids: runIds,
      deltas: side.rounds.map((r) => r.delta ?? 0), match_score: side.matchScore,
      scores: playerRounds.map((r) => r.score), result: null, provisional: side.provisional,
    }]);
    if (!receipt.committed) return again();

    // The first leg of a tournament fixture: same scoring, same storage, but it is not
    // going to the pool (the pool reads only rated sides), so the sentence about the pool
    // would be untrue.
    const tournament = rated ? null : await afterLegSettled(admin, matchId);
    const firstLeg = tournament
      ? `Your three are in for ${tournament.label}. Your opponent plays the same three next, ` +
        "and the fixture is decided when they have. Nothing is rated."
      : null;
    // A claim on a vacant Crown or a race leg is one-sided too, and does not go to the pool
    // either. The Crown or the race says what it came to instead.
    const arena = rated ? null : await arenaNote(admin, matchId, playerId);
    const pooled = side.countedRounds === scenarioIds.length;
    return {
      status: 200,
      body: {
        matchId, engine: policy.engine, seeding: true, rated: false, tournament, arena, verdict: null,
        // Null, not zero: zero would read as an opponent who scored exactly their
        // baseline, which is a claim about somebody who does not exist.
        yourMatchScore: side.matchScore, theirMatchScore: null, countedRounds: side.countedRounds,
        rounds: side.rounds.map((r) => ({
          scenario: r.scenarioName, score: r.score, baseline: Math.round(r.baseline), delta: r.delta,
          opponentDelta: null, counted: r.counted, excludedReason: r.excludedReason ?? null,
          verificationTier: r.verificationTier,
        })),
        ratingChange: 0,
        explanation: firstLeg ?? arena?.explanation ?? (pooled
          ? "Nothing was rated: there was no opponent to play against. Your run set is now in the pool, " +
            "and the next player to queue this category plays against it."
          : "Recorded, but not every scenario counted, so this run set is not in the pool yet."),
        message: firstLeg ?? arena?.headline ?? (pooled
          ? "Your run set is in the pool. The next player to queue this category plays against it."
          : "Recorded, but not every scenario counted, so this run set is not in the pool yet."),
      },
    };
  }

  // ---- contested ------------------------------------------------------------------
  //
  // The opponent's rounds were frozen when they played. Reconstruct their side from what
  // was stored rather than re-deriving, which is what makes an async match reproducible.
  // Rounds when the raw scores are there, which is every match created since they were
  // stored. A copy that predates them and whose original cannot be found either is still
  // settled, by the mean-delta rule it was created under, rather than voided for a gap
  // that is nobody's doing.
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
      // The baseline that reproduces the frozen delta exactly from the stored score.
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

  // ---- rating ---------------------------------------------------------------------
  //
  // Provisional baselines make a noisy result, so the change is damped by ratingWeight
  // rather than discarded: the match still counts, it just moves the ladder less.
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

  // Who it was against, so the result screen can say who you beat and offer a rematch.
  // The id comes with it because a duel has to be addressed and a display name cannot
  // address one. Null on a void: there is nothing to rematch about a match that did not
  // count.
  const { data: opponentPlayer } = await admin
    .from("players").select("id, display_name").eq("id", theirs!.player_id).maybeSingle();
  // The second leg of a tournament fixture decides it. Folded in before answering, so the
  // result screen and the bracket agree the moment the player looks at either.
  const tournament = rated ? null : await afterLegSettled(admin, matchId);
  const arena = rated ? null : await arenaNote(admin, matchId, playerId);
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
      arena,
      opponent: opponentPlayer && settlement.verdict !== "void"
        ? { playerId: opponentPlayer.id, displayName: opponentPlayer.display_name }
        : null,
      category: match.category,
      explanation: rated
        ? explainVerdict(settlement)
        : arena
          ? `${explainVerdict(settlement)} ${arena.headline}`
          : `${explainVerdict(settlement)} Unrated: this was ${tournament ? "a tournament fixture" : "an open challenge"}.`,
      voidReason: settlement.voidReason ?? null,
      ratingWeight: settlement.ratingWeight,
      yourMatchScore: settlement.player.matchScore,
      theirMatchScore: settlement.opponent.matchScore,
      format: settlement.format,
      // Null outside the rounds format, so the client does not print "0–0" over a match
      // that was decided some other way.
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

/**
 * The opponent's raw scores: on the side itself, or, for a side copied whole without
 * them (a tournament's second leg, written by open_fixture_leg, always is one), on the
 * original it shares an owner and submitted_at with.
 */
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
 * End a match the player is not going to finish, and charge them for it if it counted.
 *
 * Shared because two paths reach it and they must agree. Pressing Abandon and letting
 * the clock run out are the same act from the ladder's point of view, and if only one
 * of them cost anything, the free one would be the only one anybody used.
 *
 * That mattered little while a match lasted six hours. With a five-minute deadline,
 * waiting it out is the cheapest possible way to escape a match that is going badly,
 * so it has to cost what forfeiting costs.
 *
 * What it costs is what the match's engine says a forfeit costs: under v2 every round
 * lost, so leaving is never cheaper than playing on and losing all three; under v1 one
 * lost game.
 *
 * The exceptions are the same in both directions:
 *
 *   SEEDING   one side, by design. There is no opponent to lose to, and inventing a
 *             loss against nobody would be a free way to tank a rating.
 *   PLAYED    the runs are already in. Settlement should decide it, not this.
 *   UNRATED   a tournament leg: recorded as a loss for the fixture, rating untouched.
 *   OFF-POOL  the pool was rebuilt under it, so it could not be played. Void.
 */
export async function forfeitMatch(admin: SupabaseClient, matchId: string, playerId: string): Promise<ForfeitOutcome> {
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
 * Retire this player's expired matches, and report whether a live one is left.
 *
 * THE RULE THIS CARRIES
 *
 * A player may hold one match at a time. Without that they could open several, play the
 * scenarios, see which set went best, submit that one and abandon the rest - and because
 * scores are read from a stats folder rather than typed in, every one of those matches is
 * playable before the choice is made. It is the only thing standing between the ladder
 * and a free reroll.
 *
 * It lived inside find-match while find-match was the only way to start a match. Duels
 * are a second and a third, and a rule enforced in three places is a rule that will be
 * enforced in two of them.
 *
 * WHY IT SWEEPS BEFORE IT ANSWERS
 *
 * Matches were given an `expires_at` and for a while nothing ever acted on it, so a match
 * somebody walked away from blocked them permanently rather than until it expired: the
 * guard reads the status, and the status never changed on its own. Running out of time is
 * a forfeit rather than a free pass - at eight minutes it means they did not finish, and
 * if that costs nothing then waiting out the clock is strictly cheaper than pressing
 * Abandon, so the button that costs a loss would never be pressed again.
 *
 * `forfeitMatch` does the charging, shared with abandon-match so the two cannot disagree,
 * and it still costs nothing for a seeding match.
 *
 * WHY IT SETTLES A FINISHED ONE
 *
 * forfeitMatch rightly refuses a match whose runs are in ("already-played"), and before
 * v2 nothing then settled it: the client gives up after four retries, the match stayed
 * `awaiting_runs` for good, its result never reached the ladder and its rounds never
 * reached the pool, and the sweep stepped around it on every queue after. Settling it is
 * the only answer that matches what the player did.
 */
export async function sweepStaleMatches(admin: SupabaseClient, playerId: string): Promise<LiveMatch | null> {
  const { data: rows, error } = await admin
    .from("match_sides")
    .select("match_id, submitted_at, matches!inner(id, status, category, difficulty, scenario_ids, window_index, expires_at, created_at, engine)")
    .eq("player_id", playerId)
    .in("matches.status", ["open", "awaiting_runs"]);
  if (error) throw new HttpError(500, error.message);

  // A copy of this player's stored run set, sitting in somebody else's live match, is not
  // a match this player is in. Treating it as one resumed them into a stranger's match.
  const openMatches = (rows ?? []).filter((row: any) => !isCopiedSide(row, row.matches));
  const now = Date.now();
  // Expired, or on a pool that has since been rebuilt. Resuming the second was the
  // playtest bug: the queue kept returning the same unplayable three, and the only exit
  // was Abandon. forfeitMatch voids it for nothing.
  const stale: any[] = [];
  for (const row of openMatches as any[]) {
    const expiresAt = row.matches?.expires_at;
    if (expiresAt != null && new Date(expiresAt).getTime() < now) stale.push(row);
    else if (await isOffPool(admin, row.matches?.scenario_ids, row.matches?.window_index)) stale.push(row);
  }

  for (const row of stale) {
    const outcome = await forfeitMatch(admin, row.match_id, playerId);
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
