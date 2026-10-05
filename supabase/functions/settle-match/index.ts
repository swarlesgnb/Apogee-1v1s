/**
 * Settle a match and move the ladder.
 *
 * Everything that decides the result is recomputed here from stored rows: the runs, the
 * baselines, the deltas, the verdict, the rating change. Nothing is taken from the
 * request beyond which match to settle. That is the whole point of the security model
 * (PLAN.md §7) and the reason this runs with the service role rather than in the app.
 *
 * Settlement is idempotent. A client that calls it twice, or two clients racing, must
 * not apply the rating change twice, so a match already marked settled returns its
 * stored result untouched.
 */

import {
  baselineFor,
  handler,
  isCopiedSide,
  json,
  prepareChallengerRating,
  commitMatchResult,
  type RatingProposal,
  readJson,
  requireCaller,
  HttpError,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { afterLegSettled } from "../_shared/tournament.ts";

import { baselineFromScores } from "../../../src/core/history/baseline.ts";
import { isAbandonedRun } from "../../../src/core/stats/duration.ts";
import { updateRating, type Rating } from "../../../src/core/rating/glicko2.ts";
import {
  explainVerdict,
  roundTally,
  settleMatch,
  settleSide,
  verdictToScore,
  type RoundSubmission,
} from "../../../src/core/match/settle.ts";
import type { VerificationTier } from "../../../src/core/verify/verifyRun.ts";

interface Body {
  matchId: string;
}

Deno.serve(handler(async function settleRequest(req, admin) {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "settle-match");
  const { matchId } = await readJson<Body>(req.clone());
  if (!matchId) throw new HttpError(400, "matchId is required");

  const { data: match, error: matchError } = await admin
    .from("matches")
    .select("id, status, category, difficulty, scenario_ids, created_at, expires_at, settled_at, rated")
    .eq("id", matchId)
    .maybeSingle();

  if (matchError) throw new HttpError(500, matchError.message);

  if (!match) throw new HttpError(404, "no such match");

  // False only for a tournament leg (migration 20260912000018). Everything below still runs
  // - the runs, the baselines, the deltas, the verdict - and only the rating writes are
  // skipped, so a tournament result is decided exactly the way a ladder one is.
  const rated = match.rated !== false;

  const { data: sides, error: sidesError } = await admin
    .from("match_sides")
    .select("match_id, player_id, run_ids, deltas, scores, match_score, result, provisional, rating_before, rd_before, rating_after, rd_after, submitted_at")
    .eq("match_id", matchId);

  if (sidesError) throw new HttpError(500, sidesError.message);

  // The caller's own side, never a copy of their stored run set that is the opponent
  // here: settling through that closed a stranger's match before they had played it.
  const mine = (sides ?? []).find((s: any) => s.player_id === caller.playerId && !isCopiedSide(s, match));
  const theirs = (sides ?? []).find((s: any) => s.player_id !== caller.playerId);

  if (!mine) throw new HttpError(403, "you are not in that match");

  // Already settled: return what was stored rather than recomputing and re-applying.
  if (match.status === "settled" || match.status === "void") {
    return json({
      matchId,
      alreadySettled: true,
      seeding: !theirs,
      rated,
      // Folded in again on a repeat call, which is a no-op once it has landed and the
      // retry that lands it if the first call died before it could.
      tournament: rated ? null : await afterLegSettled(admin, matchId),
      verdict: match.status === "void" ? "void" : mine.result,
      yourMatchScore: mine.match_score != null ? Number(mine.match_score) : null,
      theirMatchScore: theirs?.match_score != null ? Number(theirs.match_score) : null,
      ratingBefore: mine.rating_before != null ? Number(mine.rating_before) : null,
      ratingAfter: mine.rating_after != null ? Number(mine.rating_after) : null,
    });
  }

  // A seeding match has one side by design: the pool was empty when it was handed out
  // (find-match), so there was never an opponent to be found. Nothing was contested, so
  // nothing is rated, but the side still has to be scored and stored here, because
  // submit-run only records runs and it is this function that writes deltas and
  // match_score. Until those exist the candidate query in find-match cannot see the run
  // set, and the pool stays empty however many times somebody plays.
  const seeding = !theirs;

  const scenarioIds: number[] = match.scenario_ids ?? [];

  // ---- the caller's runs for this match ------------------------------------------
  const { data: runs, error: runsError } = await admin
    .from("runs")
    .select("id, scenario_id, scenario_name, score, verification_tier, played_at, duration_seconds")
    .eq("player_id", caller.playerId)
    .eq("match_id", matchId)
    .order("match_submitted_at", { ascending: true })
    .order("id", { ascending: true });

  if (runsError) throw new HttpError(500, runsError.message);

  // How long each of these scenarios is supposed to last, so a run that stopped early
  // can be told from one that went badly.
  const { data: scenarioRows, error: scenarioError } = await admin
    .from("scenarios")
    .select("id, duration_seconds")
    .in("id", scenarioIds);

  if (scenarioError) throw new HttpError(500, scenarioError.message);

  const expectedSeconds = new Map<number, number | null>(
    (scenarioRows ?? []).map((s: any) => [s.id, s.duration_seconds ?? null]),
  );

  // One run per scenario: the first submitted counts, so a player cannot keep
  // retrying a scenario until it goes well and then settle.
  const firstByScenario = new Map<number, any>();
  for (const r of runs ?? []) {
    if (r.scenario_id != null && !firstByScenario.has(r.scenario_id)) {
      firstByScenario.set(r.scenario_id, r);
    }
  }

  // An abandoned round decides the match on its own: it is dropped rather than scored,
  // which leaves the sides uneven and voids whatever else happens. So say so now rather
  // than making the player finish two more scenarios to be told the same thing, and
  // free the queue while they still want to use it.
  const abandonedRun = [...firstByScenario.values()].find((r: any) =>
    isAbandonedRun(
      r.duration_seconds != null ? Number(r.duration_seconds) : null,
      expectedSeconds.get(r.scenario_id) ?? null,
    ),
  );

  if (abandonedRun) {
    const receipt = await commitMatchResult(admin, matchId, "void",
      [{ player_id: caller.playerId, result: null }]);
    if (!receipt.committed) return settleRequest(req, admin);

    const tournament = rated ? null : await afterLegSettled(admin, matchId);

    return json({
      matchId,
      verdict: "void",
      rated: false,
      tournament,
      voidReason: "a scenario was left before it finished",
      scenario: abandonedRun.scenario_name,
      playedSeconds: abandonedRun.duration_seconds != null ? Number(abandonedRun.duration_seconds) : null,
      expectedSeconds: expectedSeconds.get(abandonedRun.scenario_id) ?? null,
      ratingChange: 0,
      message: tournament
        ? `${abandonedRun.scenario_name} ended early, so this leg is void and ${tournament.label} ` +
          "will be replayed. Nothing was rated."
        : `${abandonedRun.scenario_name} ended early, so this match is void. ` +
          "Nothing was rated. You can queue again now.",
    });
  }

  const missing = scenarioIds.filter((id) => !firstByScenario.has(id));
  if (missing.length > 0) {
    const { data: names } = await admin.from("scenarios").select("id, name").in("id", missing);
    return json(
      {
        error: "match is not complete yet",
        remaining: (names ?? []).map((n: any) => n.name),
        submitted: firstByScenario.size,
        required: scenarioIds.length,
      },
      409,
    );
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
      baselineFor(
        admin,
        caller.playerId,
        scenarioId,
        firstByScenario.get(scenarioId)!.scenario_name,
        baselineFromScores,
        { at: match.created_at, matchId },
      ),
    ),
  );

  const playerRounds: RoundSubmission[] = [];

  for (const [i, scenarioId] of scenarioIds.entries()) {
    const run = firstByScenario.get(scenarioId)!;
    const baseline = baselines[i];

    // Nothing played before the match to measure against. This keeps what settlement
    // has always done in that case, the run standing as its own baseline for a
    // provisional 0%, but states it rather than arriving there by accident. PLAN.md §3's
    // fallback chain (a sibling scenario, the sub-category, the rank cohort) is the better
    // answer and is not built yet.
    const value = baseline.runCount > 0 ? baseline.value : Number(run.score);

    playerRounds.push({
      scenarioId,
      scenarioName: run.scenario_name,
      score: Number(run.score),
      baseline: value,
      provisional: baseline.provisional,
      verificationTier: run.verification_tier as VerificationTier,
      // Left before the scenario finished. Not a bad score, an absent one: settleMatch
      // drops the round rather than scoring it, which leaves the sides uneven and voids
      // at zero rating weight. A crash costs nothing; only forfeiting on purpose does.
      //
      // Both sides of this can be null - an unreadable duration, or a scenario with no
      // fixed length - and isAbandonedRun answers false to either, so a check that
      // cannot be confident never voids anyone's match.
      abandoned: isAbandonedRun(
        run.duration_seconds != null ? Number(run.duration_seconds) : null,
        expectedSeconds.get(scenarioId) ?? null,
      ),
    });
  }

  // A seeding match has nothing to compare against, so it is scored on its own and
  // recorded without touching the ladder. Storing the deltas is the whole purpose: this
  // side is what the next player to queue will be matched against, and until it has a
  // match_score the candidate query in find-match cannot see it.
  if (seeding) {
    // Rounds, the format whoever draws these rounds will be settled in.
    const side = settleSide(playerRounds, "rounds");
    const receipt = await commitMatchResult(admin, matchId, "settled", [{
      player_id: caller.playerId,
      run_ids: playerRounds.map((_, i) => firstByScenario.get(scenarioIds[i])!.id),
      deltas: side.rounds.map((r) => r.delta ?? 0), match_score: side.matchScore,
      scores: playerRounds.map((r) => r.score),
      result: null, provisional: side.provisional,
    }]);
    if (!receipt.committed) return settleRequest(req, admin);

    // The first leg of a tournament fixture. Same scoring, same storage, but it is not
    // going to the pool (find-match reads `rated`), so the sentence about the pool below
    // would be untrue.
    const tournament = rated ? null : await afterLegSettled(admin, matchId);
    const firstLeg = tournament
      ? `Your three are in for ${tournament.label}. Your opponent plays the same three next, ` +
        "and the fixture is decided when they have. Nothing is rated."
      : null;

    return json({
      matchId,
      seeding: true,
      rated: false,
      tournament,
      verdict: null,
      yourMatchScore: side.matchScore,
      theirMatchScore: null,
      countedRounds: side.countedRounds,
      // Same shape the contested path returns. Handing back the raw rounds instead put
      // `scenarioName` where the client reads `scenario`, and every row in the result
      // table said "undefined".
      rounds: side.rounds.map((r) => ({
        scenario: r.scenarioName,
        score: r.score,
        baseline: Math.round(r.baseline),
        delta: r.delta,
        // No opponent to compare against, and null says that. Zero would read as an
        // opponent who scored exactly their baseline, which is a claim about somebody
        // who does not exist.
        opponentDelta: null,
        counted: r.counted,
        excludedReason: r.excludedReason ?? null,
        verificationTier: r.verificationTier,
      })),
      ratingChange: 0,
      // The client reads `explanation` for the line under the verdict, so a seeding
      // result has to fill it or that line renders "undefined".
      explanation:
        firstLeg ??
        (side.countedRounds === scenarioIds.length
          ? "Nothing was rated: there was no opponent to play against. Your run set is " +
            "now in the pool, and the next player to queue this category plays against it."
          : "Recorded, but not every scenario counted, so this run set is not in the " +
            "pool yet."),
      message:
        firstLeg ??
        (side.countedRounds === scenarioIds.length
          ? "Your run set is in the pool. The next player to queue this category plays against it."
          : "Recorded, but not every scenario counted, so this run set is not in the pool yet."),
    });
  }

  // The opponent's rounds were frozen when they played. Reconstruct their side from what
  // was stored rather than re-deriving, which is what makes an async match reproducible.
  const opponentDeltas: number[] = (theirs!.deltas ?? []).map(Number);
  const opponentScores = await frozenScores(admin, theirs!, scenarioIds.length);

  // Rounds when the raw scores are there, which is every match created since they were
  // stored. A copy that predates them and whose original cannot be found either is still
  // settled, by the mean-delta rule it was created under, rather than voided for a gap
  // that is nobody's doing.
  const format = opponentScores ? "rounds" : "mean-delta";

  const opponentRounds: RoundSubmission[] = scenarioIds.map((scenarioId, i) => {
    const delta = opponentDeltas[i] ?? 0;
    const score = opponentScores ? opponentScores[i] : 1 + delta;
    return {
      scenarioId,
      scenarioName: playerRounds[i].scenarioName,
      // The baseline that reproduces the frozen delta exactly from the stored score.
      score,
      baseline: 1 + delta > 0 ? score / (1 + delta) : score,
      provisional: !!theirs!.provisional,
      verificationTier: "consistent",
    };
  });

  const settlement = settleMatch({ playerRounds, opponentRounds, format });
  const tally = roundTally(settlement);

  // ---- rating ---------------------------------------------------------------------
  const { data: myRatingRow, error: ratingError } = await admin
    .from("ratings")
    .select("rating, rd, volatility, matches_played")
    .eq("player_id", caller.playerId)
    .maybeSingle();

  if (ratingError) throw new HttpError(500, ratingError.message);

  const before: Rating = {
    rating: Number(myRatingRow?.rating ?? 1500),
    rd: Number(myRatingRow?.rd ?? 350),
    volatility: Number(myRatingRow?.volatility ?? 0.06),
  };

  const opponentRating: Rating = {
    rating: Number(theirs!.rating_before ?? 1500),
    rd: Number(theirs!.rd_before ?? 350),
    volatility: 0.06,
  };

  let after = before;
  if (settlement.verdict !== "void" && rated) {
    const raw = updateRating(before, [
      { opponent: opponentRating, score: verdictToScore(settlement.verdict) },
    ]);

    // Provisional baselines make a noisy result, so the change is damped rather than
    // discarded: the match still counts, it just moves the ladder less.
    const w = settlement.ratingWeight;
    after = {
      rating: before.rating + (raw.rating - before.rating) * w,
      rd: before.rd + (raw.rd - before.rd) * w,
      volatility: raw.volatility,
    };
  }

  const sidePlans: Record<string, unknown>[] = [{
    player_id: caller.playerId,
    run_ids: playerRounds.map((_, i) => firstByScenario.get(scenarioIds[i])!.id),
    deltas: settlement.player.rounds.map((r) => r.delta ?? 0),
    scores: playerRounds.map((r) => r.score),
    match_score: settlement.player.matchScore,
    result: settlement.verdict === "void" ? null : settlement.verdict,
    provisional: settlement.player.provisional,
    rating_before: before.rating, rating_after: after.rating,
    rd_before: before.rd, rd_after: after.rd,
  }];
  const ratingPlans: RatingProposal[] = [];
  if (settlement.verdict !== "void" && rated) {
    ratingPlans.push({ player_id: caller.playerId, before, after,
      matches_played: Number(myRatingRow?.matches_played ?? 0),
      score: verdictToScore(settlement.verdict), weight: settlement.ratingWeight });
    const theirVerdict = settlement.verdict === "win" ? "loss" : settlement.verdict === "loss" ? "win" : "draw";
    const challenger = await prepareChallengerRating(admin, matchId, theirVerdict,
      settlement.ratingWeight, updateRating, before);
    if (challenger) { sidePlans.push(challenger.side); ratingPlans.push(challenger.rating); }
  }
  const receipt = await commitMatchResult(admin, matchId,
    settlement.verdict === "void" ? "void" : "settled", sidePlans, ratingPlans);
  if (!receipt.committed) return settleRequest(req, admin);

  // Who it was against, so the result screen can offer a rematch.
  //
  // The client learned this opponent's name when the match was handed out and then threw
  // it away on settlement, which is why the result screen has never been able to say who
  // you beat. The id comes with it because a duel has to be addressed and a display name
  // cannot address one - the same reason list-duels hands one over, and about somebody
  // you have just finished playing rather than about the population.
  //
  // Null on a void: there is nothing to rematch about a match that did not count.
  const { data: opponentPlayer } = theirs
    ? await admin
        .from("players")
        .select("id, display_name")
        .eq("id", theirs.player_id)
        .maybeSingle()
    : { data: null };

  // The second leg of a tournament fixture decides it. Folded in before answering, so the
  // result screen and the bracket agree the moment the player looks at either.
  const tournament = rated ? null : await afterLegSettled(admin, matchId);

  return json({
    matchId,
    verdict: settlement.verdict,
    rated,
    tournament,
    opponent:
      opponentPlayer && settlement.verdict !== "void"
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
    // Rounds won, lost and tied. Null outside the rounds format, so the client does not
    // print "0–0" over a match that was decided some other way.
    roundTally: settlement.format === "rounds" && settlement.verdict !== "void" ? tally : null,
    ratingBefore: Math.round(before.rating),
    ratingAfter: Math.round(after.rating),
    ratingChange: Math.round(after.rating - before.rating),
    rounds: settlement.player.rounds.map((r, i) => ({
      scenario: r.scenarioName,
      score: r.score,
      baseline: Math.round(r.baseline),
      delta: r.delta,
      opponentDelta: opponentDeltas[i] ?? null,
      opponentScore: opponentScores ? opponentScores[i] : null,
      // What decided this round. Null under mean delta, where no round is decided alone.
      result: settlement.format === "rounds" && r.counted && settlement.verdict !== "void"
        ? (r.score > opponentRounds[i].score ? "won" : r.score < opponentRounds[i].score ? "lost" : "tied")
        : null,
      counted: r.counted,
      excludedReason: r.excludedReason ?? null,
      verificationTier: r.verificationTier,
    })),
  });
}));

/**
 * The opponent's raw score per round, or null when it cannot be known.
 *
 * Read from the side itself when it has them. A side copied whole - a duel answer, a
 * tournament's second leg, or anything copied before scores were stored - keeps its
 * original's owner and submitted_at (runSetId), so the original is found that way. A
 * find-match copy assembled from several sittings always carries its own, because its
 * submitted_at names only the latest of them.
 */
async function frozenScores(
  admin: any,
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
