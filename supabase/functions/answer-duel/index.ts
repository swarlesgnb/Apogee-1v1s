/**
 * Answer a duel: accept it, decline it, or take back one you sent.
 *
 * Accepting builds the same two-sided contested match `find-match` builds when it finds an
 * opponent, with one difference: the opponent was chosen by a person instead of by rating
 * proximity. Everything downstream - submission, verification, settlement, forfeit - is
 * the path that already exists and is not touched.
 *
 * The scenarios, the category and the window are copied off the challenger's match rather
 * than selected again. That is what makes "both sides played the same three" structural
 * here instead of reconstructed: there is one row that says what the three were, and this
 * reads it.
 *
 * WHAT THE ANSWERER CANNOT SEE
 *
 * How the challenger did. Their score lives on their side of their own match, where the
 * answerer has no side and so no read, and `duels` never copies it. That is deliberate: an
 * answerer who could see the score before deciding would be cherry-picking, which is the
 * same thing the one-match-at-a-time rule exists to stop, pointed the other way.
 */

import {
  handler,
  INITIAL_TTL_MS,
  json,
  readJson,
  requireCaller,
  requireEligible,
  sweepStaleMatches,
  HttpError,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

import { answerDuel, type Duel, type DuelAnswer } from "../../../src/core/match/duels.ts";
import { updateRating, winProbability } from "../../../src/core/rating/glicko2.ts";

interface Body {
  duelId: string;
  action: DuelAnswer | "cancel";
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "answer-duel");
  const body = await readJson<Body>(req);

  if (!body.duelId || !body.action) throw new HttpError(400, "duelId and action are required");

  const { data: row } = await admin
    .from("duels")
    .select("id, challenger_id, challenged_id, match_id, status, expires_at")
    .eq("id", body.duelId)
    .maybeSingle();

  if (!row) throw new HttpError(404, "no such duel");

  // ---- taking back one you sent --------------------------------------------------
  //
  // Its own verb rather than a decline by the other name. Cancelling costs the sender
  // nothing - their match is already played and already in the pool - and refusing it
  // would leave a duel sent to somebody who has stopped playing sitting in their inbox
  // for a week with no way to withdraw it.
  if (body.action === "cancel") {
    if (caller.playerId !== row.challenger_id) {
      throw new HttpError(403, "only the player who sent a duel can take it back");
    }
    const { data: cancelled } = await admin
      .from("duels")
      .update({ status: "cancelled", answered_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();

    if (!cancelled) throw new HttpError(409, "that duel has already been answered");
    return json({ ok: true, status: "cancelled" });
  }

  // The challenger's side, which is both the thing that says whether they have finished
  // playing and, on accept, the frozen opponent this match is built from.
  const { data: theirSide } = await admin
    .from("match_sides")
    .select("player_id, deltas, match_score, provisional, rating_before, rd_before, submitted_at")
    .eq("match_id", row.match_id)
    .eq("player_id", row.challenger_id)
    .maybeSingle();

  const duel: Duel = {
    id: row.id,
    fromPlayer: row.challenger_id,
    toPlayer: row.challenged_id,
    status: row.status,
    expiresAt: new Date(row.expires_at),
    challengerMatchScore: theirSide?.match_score == null ? null : Number(theirSide.match_score),
  };

  const decision = answerDuel(duel, caller.playerId, body.action, new Date());
  if (!decision.ok) {
    // 403 when it is not theirs to answer, 409 when it is but the moment has passed.
    const theirs = caller.playerId === duel.toPlayer;
    throw new HttpError(theirs ? 409 : 403, decision.reason);
  }

  // ---- declining -----------------------------------------------------------------
  if (decision.status === "declined") {
    const { data: declined } = await admin
      .from("duels")
      .update({ status: "declined", answered_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();

    if (!declined) throw new HttpError(409, "that duel has already been answered");
    return json({ ok: true, status: "declined" });
  }

  // ---- accepting -----------------------------------------------------------------

  // Same rule as the queue and as sending: one match at a time. Checked before the claim
  // below, so a refusal here leaves the duel open for when they have finished.
  const live = await sweepStaleMatches(admin, caller.playerId, updateRating);
  if (live) {
    throw new HttpError(409, "finish or abandon your current match before accepting a duel");
  }

  await requireEligible(admin, caller.playerId);

  // Claim it in one statement.
  //
  // `status = 'open'` in the filter makes this a compare-and-swap: two clients racing the
  // same duel both read `open`, and exactly one gets a row back. No transaction and no
  // lock, and the loser is told the truth rather than being handed a second match.
  const { data: claimed } = await admin
    .from("duels")
    .update({ status: "accepted", claimed_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "open")
    .select("id")
    .maybeSingle();

  if (!claimed) throw new HttpError(409, "that duel has already been answered");

  /** Put the duel back, so a failure below is a retry rather than a dead row. */
  const release = async () => {
    await admin
      .from("duels")
      .update({ status: "open", claimed_at: null })
      .eq("id", row.id);
  };

  try {
    const { data: theirMatch } = await admin
      .from("matches")
      .select("category, benchmark_name, difficulty, window_index, seed, scenario_ids")
      .eq("id", row.match_id)
      .maybeSingle();

    if (!theirMatch || !theirSide) throw new HttpError(410, "that duel's match is gone");

    const { data: myRating } = await admin
      .from("ratings")
      .select("rating, rd")
      .eq("player_id", caller.playerId)
      .maybeSingle();

    const expiresAt = new Date(Date.now() + INITIAL_TTL_MS).toISOString();

    const { data: match, error: matchError } = await admin
      .from("matches")
      .insert({
        mode: "async",
        category: theirMatch.category,
        benchmark_name: theirMatch.benchmark_name,
        difficulty: theirMatch.difficulty,
        window_index: theirMatch.window_index,
        // A new seed for a new match. The scenarios are copied rather than re-derived, so
        // the seed is a record of this match's own creation and never a way to reproduce
        // the three - which the row beside it already states outright.
        seed: crypto.randomUUID(),
        scenario_ids: theirMatch.scenario_ids,
        status: "awaiting_runs",
        expires_at: expiresAt,
      })
      .select("id")
      .maybeSingle();

    if (matchError || !match) {
      throw new HttpError(500, matchError?.message ?? "could not create the match");
    }

    // The answerer's side is empty until they play. The challenger's carries the deltas
    // frozen when they played, which is what makes this asynchronous rather than a wait.
    const { error: sidesError } = await admin.from("match_sides").insert([
      {
        match_id: match.id,
        player_id: caller.playerId,
        rating_before: Number(myRating?.rating ?? 1500),
        rd_before: Number(myRating?.rd ?? 350),
      },
      {
        match_id: match.id,
        player_id: row.challenger_id,
        deltas: theirSide.deltas,
        match_score: theirSide.match_score,
        provisional: theirSide.provisional,
        rating_before: theirSide.rating_before,
        rd_before: theirSide.rd_before,
        submitted_at: theirSide.submitted_at,
      },
      // Rows with different keys: without this PostgREST fills the answerer's missing
      // deltas and provisional with NULL instead of their defaults. See find-match.
    ], { defaultToNull: false });

    if (sidesError) throw new HttpError(500, sidesError.message);

    // Written last, and it is what makes the accept complete: a duel marked accepted with
    // nothing here is a run of this function that died, and the row can be reopened.
    await admin.from("duels").update({ answer_match_id: match.id }).eq("id", row.id);

    const { data: names } = await admin
      .from("scenarios")
      .select("id, name")
      .in("id", theirMatch.scenario_ids ?? []);

    const nameById = new Map((names ?? []).map((s: any) => [s.id, s.name]));

    const { data: challenger } = await admin
      .from("players")
      .select("display_name")
      .eq("id", row.challenger_id)
      .maybeSingle();

    const mine = {
      rating: Number(myRating?.rating ?? 1500),
      rd: Number(myRating?.rd ?? 350),
      volatility: 0.06,
    };
    const theirs = {
      rating: Number(theirSide.rating_before ?? 1500),
      rd: Number(theirSide.rd_before ?? 350),
      volatility: 0.06,
    };

    return json({
      matchId: match.id,
      category: theirMatch.category,
      difficulty: theirMatch.difficulty,
      expiresAt,
      scenarios: (theirMatch.scenario_ids ?? []).map((id: number) => ({
        id,
        name: nameById.get(id) ?? `scenario ${id}`,
      })),
      opponent: {
        displayName: challenger?.display_name ?? "player",
        rating: Math.round(theirs.rating),
        playedAt: theirSide.submitted_at,
        provisional: !!theirSide.provisional,
      },
      seeding: false,
      winProbability: winProbability(mine, theirs),
      // Nothing was searched: this opponent was named, not found.
      poolSize: null,
      duel: { id: row.id, from: challenger?.display_name ?? "player" },
    });
  } catch (err) {
    await release();
    throw err;
  }
}));
