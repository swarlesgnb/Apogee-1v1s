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
} from "../_shared/arena.ts";

import { baselineFromScores } from "../../../src/core/history/baseline.ts";
import { updateRating, type Rating } from "../../../src/core/rating/glicko2.ts";
import {
  explainVerdict,
  settleMatch,
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
  if (!theirs) throw new HttpError(409, "this match has no opponent side");

  // Already settled: return what was stored rather than recomputing and re-applying.
  if (match.status === "settled") {
    return json({
      matchId,
      alreadySettled: true,
      verdict: mine.result,
      yourMatchScore: mine.match_score != null ? Number(mine.match_score) : null,
      theirMatchScore: theirs.match_score != null ? Number(theirs.match_score) : null,
      ratingBefore: mine.rating_before != null ? Number(mine.rating_before) : null,
      ratingAfter: mine.rating_after != null ? Number(mine.rating_after) : null,
    });
  }

  const scenarioIds: number[] = match.scenario_ids ?? [];

  // ---- the caller's runs for this match ------------------------------------------
  const { data: runs } = await admin
    .from("runs")
    .select("id, scenario_id, scenario_name, score, verification_tier, played_at")
    .eq("player_id", caller.playerId)
    .eq("match_id", matchId)
    .order("played_at", { ascending: true });

  // One run per scenario: the first submitted counts, so a player cannot keep
  // retrying a scenario until it goes well and then settle.
  const firstByScenario = new Map<number, any>();
  for (const r of runs ?? []) {
    if (r.scenario_id != null && !firstByScenario.has(r.scenario_id)) {
      firstByScenario.set(r.scenario_id, r);
    }
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
    });
  }

  // The opponent's deltas were frozen when they played. Reconstruct their side from
  // those rather than re-deriving, which is what makes an async match reproducible.
  const opponentDeltas: number[] = (theirs.deltas ?? []).map(Number);
  const opponentRounds: RoundSubmission[] = scenarioIds.map((scenarioId, i) => ({
    scenarioId,
    scenarioName: playerRounds[i].scenarioName,
    // A synthetic score/baseline pair reproducing the frozen delta exactly.
    score: 1 + (opponentDeltas[i] ?? 0),
    baseline: 1,
    provisional: !!theirs.provisional,
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
    rating: Number(theirs.rating_before ?? 1500),
    rd: Number(theirs.rd_before ?? 350),
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
