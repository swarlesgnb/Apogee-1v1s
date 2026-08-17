/**
 * End the caller's active match without playing it out.
 *
 * There was no way to do this, and the absence wedged people. find-match refuses to let
 * a player hold two matches at once, which is right - otherwise you could open several,
 * cherry-pick the one that went well and drop the rest - but nothing except settling
 * ever moved a match out of `awaiting_runs`. The client's "Abandon match" only cleared
 * its own state, so the row stayed open on the server and the player could never queue
 * again. Not for six hours, which was the TTL: forever, because expiry was never
 * applied either.
 *
 * What it costs depends on whether the player chose it, which is the same distinction
 * the crash rule draws (PLAN.md §3):
 *
 *   CONTESTED and chosen   a loss. There is a real opponent whose run set you declined
 *                          to play against, and free withdrawal is exactly the dodge
 *                          that makes a ladder meaningless: two bad rounds in, you
 *                          would always be better off quitting than finishing.
 *
 *   SEEDING                nothing. There is no opponent, so there is nobody to lose
 *                          to, and inventing a loss against nobody would let a player
 *                          tank their own rating for free.
 *
 *   EXPIRED                nothing. Time running out is not a decision.
 */

import { handler, json, requireCaller, HttpError } from "../_shared/apogee.ts";
import { updateRating, type Rating } from "../../../src/core/rating/glicko2.ts";

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);

  const { data: side } = await admin
    .from("match_sides")
    .select(
      "match_id, player_id, rating_before, rd_before, " +
        "matches!inner(id, status, category, difficulty, expires_at)",
    )
    .eq("player_id", caller.playerId)
    .in("matches.status", ["open", "awaiting_runs"])
    .limit(1)
    .maybeSingle();

  if (!side) return json({ ok: true, nothingToAbandon: true });

  const match = (side as any).matches;
  const matchId = match.id;
  const expired = match.expires_at != null && new Date(match.expires_at) < new Date();

  // Is there anyone on the other side? A seeding match has one side by design.
  const { data: sides } = await admin
    .from("match_sides")
    .select("player_id, rating_before, rd_before")
    .eq("match_id", matchId);

  const opponent = (sides ?? []).find((s: any) => s.player_id !== caller.playerId);
  const settledAt = new Date().toISOString();

  // ---- nothing was contested, or nothing was chosen -------------------------------
  if (!opponent || expired) {
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
      ok: true,
      matchId,
      verdict: null,
      rated: false,
      reason: expired ? "expired" : "seeding",
      message: expired
        ? "That match had already expired. Nothing was rated."
        : "Nothing was rated: there was no opponent to play against.",
    });
  }

  // ---- a real opponent was declined: record the loss --------------------------------
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
    rating: Number(opponent.rating_before ?? 1500),
    rd: Number(opponent.rd_before ?? 350),
    volatility: 0.06,
  };

  // A forfeit is a loss at full weight. The provisional damping in settle-match exists
  // because a shaky baseline makes a *result* noisy; there is no result here to be
  // uncertain about, only a decision.
  const after = updateRating(before, [{ opponent: opponentRating, score: 0 }]);

  const { error: sideError } = await admin
    .from("match_sides")
    .update({
      result: "loss",
      rating_before: before.rating,
      rating_after: after.rating,
      rd_before: before.rd,
      rd_after: after.rd,
      submitted_at: settledAt,
    })
    .eq("match_id", matchId)
    .eq("player_id", caller.playerId);

  if (sideError) throw new HttpError(500, sideError.message);

  await admin.from("ratings").upsert(
    {
      player_id: caller.playerId,
      rating: after.rating,
      rd: after.rd,
      volatility: after.volatility,
      matches_played: Number(myRatingRow?.matches_played ?? 0) + 1,
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
    result: 0,
    weight: 1,
  });

  await admin
    .from("matches")
    .update({ status: "settled", settled_at: settledAt })
    .eq("id", matchId);

  return json({
    ok: true,
    matchId,
    verdict: "loss",
    rated: true,
    reason: "forfeit",
    ratingBefore: Math.round(before.rating),
    ratingAfter: Math.round(after.rating),
    ratingChange: Math.round(after.rating - before.rating),
    message: "Match forfeited. You can queue again now.",
  });
}));
