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
  handler,
  json,
  readJson,
  requireCaller,
  HttpError,
} from "../_shared/apogee.ts";

import { baselineFromScores } from "../../../src/core/history/baseline.ts";
import { isAbandonedRun } from "../../../src/core/stats/duration.ts";
import { updateRating, type Rating } from "../../../src/core/rating/glicko2.ts";
import {
  explainVerdict,
  settleMatch,
  settleSide,
  verdictToScore,
  type RoundSubmission,
} from "../../../src/core/match/settle.ts";
import type { VerificationTier } from "../../../src/core/verify/verifyRun.ts";

interface Body {
  matchId: string;
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  const { matchId } = await readJson<Body>(req);
  if (!matchId) throw new HttpError(400, "matchId is required");

  const { data: match } = await admin
    .from("matches")
    .select("id, status, category, difficulty, scenario_ids, created_at, expires_at, settled_at")
    .eq("id", matchId)
    .maybeSingle();

  if (!match) throw new HttpError(404, "no such match");

  const { data: sides } = await admin
    .from("match_sides")
    .select("match_id, player_id, run_ids, deltas, match_score, result, provisional, rating_before, rd_before, rating_after, rd_after")
    .eq("match_id", matchId);

  const mine = (sides ?? []).find((s: any) => s.player_id === caller.playerId);
  const theirs = (sides ?? []).find((s: any) => s.player_id !== caller.playerId);

  if (!mine) throw new HttpError(403, "you are not in that match");

  // Already settled: return what was stored rather than recomputing and re-applying.
  if (match.status === "settled") {
    return json({
      matchId,
      alreadySettled: true,
      seeding: !theirs,
      verdict: mine.result,
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
  const { data: runs } = await admin
    .from("runs")
    .select("id, scenario_id, scenario_name, score, verification_tier, played_at, duration_seconds")
    .eq("player_id", caller.playerId)
    .eq("match_id", matchId)
    .order("played_at", { ascending: true });

  // How long each of these scenarios is supposed to last, so a run that stopped early
  // can be told from one that went badly.
  const { data: scenarioRows } = await admin
    .from("scenarios")
    .select("id, duration_seconds")
    .in("id", scenarioIds);

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
    const settledAt = new Date().toISOString();

    await admin
      .from("match_sides")
      .update({ result: null, submitted_at: settledAt })
      .eq("match_id", matchId)
      .eq("player_id", caller.playerId);

    await admin
      .from("matches")
      .update({ status: "void", settled_at: settledAt })
      .eq("id", matchId);

    return json({
      matchId,
      verdict: "void",
      rated: false,
      voidReason: "a scenario was left before it finished",
      scenario: abandonedRun.scenario_name,
      playedSeconds: abandonedRun.duration_seconds != null ? Number(abandonedRun.duration_seconds) : null,
      expectedSeconds: expectedSeconds.get(abandonedRun.scenario_id) ?? null,
      ratingChange: 0,
      message:
        `${abandonedRun.scenario_name} ended early, so this match is void. ` +
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

  // ---- baselines, recomputed rather than trusted ---------------------------------
  const { data: baselineRows } = await admin
    .from("baselines")
    .select("scenario_id, value, provisional")
    .eq("player_id", caller.playerId)
    .in("scenario_id", scenarioIds);

  const baselineById = new Map(
    (baselineRows ?? []).map((b: any) => [b.scenario_id, b]),
  );

  const playerRounds: RoundSubmission[] = [];

  for (const scenarioId of scenarioIds) {
    const run = firstByScenario.get(scenarioId)!;
    let baseline = baselineById.get(scenarioId);

    // No stored baseline yet: derive one from history now, and mark it provisional so
    // the match carries reduced weight.
    if (!baseline) {
      const { data: history } = await admin
        .from("runs")
        .select("score")
        .eq("player_id", caller.playerId)
        .eq("scenario_id", scenarioId)
        .neq("verification_tier", "rejected")
        .order("played_at", { ascending: true })
        .limit(200);

      const derived = baselineFromScores(
        run.scenario_name,
        (history ?? []).map((h: any) => Number(h.score)),
      );
      baseline = { scenario_id: scenarioId, value: derived.value, provisional: true };
    }

    playerRounds.push({
      scenarioId,
      scenarioName: run.scenario_name,
      score: Number(run.score),
      baseline: Number(baseline.value),
      provisional: !!baseline.provisional,
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
    const side = settleSide(playerRounds);
    const settledAt = new Date().toISOString();

    const { error: seedSideError } = await admin
      .from("match_sides")
      .update({
        run_ids: playerRounds.map((_, i) => firstByScenario.get(scenarioIds[i])!.id),
        deltas: side.rounds.map((r) => r.delta ?? 0),
        match_score: side.matchScore,
        result: null,
        provisional: side.provisional,
        submitted_at: settledAt,
      })
      .eq("match_id", matchId)
      .eq("player_id", caller.playerId);

    if (seedSideError) throw new HttpError(500, seedSideError.message);

    await admin
      .from("matches")
      .update({ status: "settled", settled_at: settledAt })
      .eq("id", matchId);

    return json({
      matchId,
      seeding: true,
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
        side.countedRounds === scenarioIds.length
          ? "Nothing was rated: there was no opponent to play against. Your run set is " +
            "now in the pool, and the next player to queue this category plays against it."
          : "Recorded, but not every scenario counted, so this run set is not in the " +
            "pool yet.",
      message:
        side.countedRounds === scenarioIds.length
          ? "Your run set is in the pool. The next player to queue this category plays against it."
          : "Recorded, but not every scenario counted, so this run set is not in the pool yet.",
    });
  }

  // The opponent's deltas were frozen when they played. Reconstruct their side from
  // those rather than re-deriving, which is what makes an async match reproducible.
  const opponentDeltas: number[] = (theirs!.deltas ?? []).map(Number);
  const opponentRounds: RoundSubmission[] = scenarioIds.map((scenarioId, i) => ({
    scenarioId,
    scenarioName: playerRounds[i].scenarioName,
    // A synthetic score/baseline pair reproducing the frozen delta exactly.
    score: 1 + (opponentDeltas[i] ?? 0),
    baseline: 1,
    provisional: !!theirs!.provisional,
    verificationTier: "consistent",
  }));

  const settlement = settleMatch({ playerRounds, opponentRounds });

  // ---- rating ---------------------------------------------------------------------
  const { data: myRatingRow } = await admin
    .from("ratings")
    .select("rating, rd, volatility, matches_played")
    .eq("player_id", caller.playerId)
    .maybeSingle();

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
  if (settlement.verdict !== "void") {
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

  const settledAt = new Date().toISOString();

  // ---- persist --------------------------------------------------------------------
  const { error: sideError } = await admin
    .from("match_sides")
    .update({
      run_ids: playerRounds.map((_, i) => firstByScenario.get(scenarioIds[i])!.id),
      deltas: settlement.player.rounds.map((r) => r.delta ?? 0),
      match_score: settlement.player.matchScore,
      result: settlement.verdict === "void" ? null : settlement.verdict,
      provisional: settlement.player.provisional,
      rating_before: before.rating,
      rating_after: after.rating,
      rd_before: before.rd,
      rd_after: after.rd,
      submitted_at: settledAt,
    })
    .eq("match_id", matchId)
    .eq("player_id", caller.playerId);

  if (sideError) throw new HttpError(500, sideError.message);

  if (settlement.verdict !== "void") {
    await admin.from("ratings").upsert(
      {
        player_id: caller.playerId,
        rating: after.rating,
        rd: after.rd,
        volatility: after.volatility,
        matches_played: (myRatingRow?.matches_played ?? 0) + 1,
        updated_at: settledAt,
      },
      { onConflict: "player_id" },
    );

    await admin.from("rating_history").insert({
      player_id: caller.playerId,
      match_id: matchId,
      rating_before: before.rating,
      rating_after: after.rating,
      rd_before: before.rd,
      rd_after: after.rd,
      result: verdictToScore(settlement.verdict),
      weight: settlement.ratingWeight,
    });
  }

  await admin
    .from("matches")
    .update({
      status: settlement.verdict === "void" ? "void" : "settled",
      settled_at: settledAt,
    })
    .eq("id", matchId);

  return json({
    matchId,
    verdict: settlement.verdict,
    explanation: explainVerdict(settlement),
    voidReason: settlement.voidReason ?? null,
    ratingWeight: settlement.ratingWeight,
    yourMatchScore: settlement.player.matchScore,
    theirMatchScore: settlement.opponent.matchScore,
    ratingBefore: Math.round(before.rating),
    ratingAfter: Math.round(after.rating),
    ratingChange: Math.round(after.rating - before.rating),
    rounds: settlement.player.rounds.map((r, i) => ({
      scenario: r.scenarioName,
      score: r.score,
      baseline: Math.round(r.baseline),
      delta: r.delta,
      opponentDelta: opponentDeltas[i] ?? null,
      counted: r.counted,
      excludedReason: r.excludedReason ?? null,
      verificationTier: r.verificationTier,
    })),
  });
}));
