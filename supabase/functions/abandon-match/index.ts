/**
 * End the caller's active match without playing it out.
 *
 * There was no way to do this, and the absence wedged people. find-match refuses to let
 * a player hold two matches at once, which is right - otherwise you could open several,
 * cherry-pick the one that went well and drop the rest - but nothing except settling
 * ever moved a match out of `awaiting_runs`. The client's "Abandon match" only cleared
 * its own state, so the row stayed open on the server and the player could never queue
 * again.
 *
 * What it costs is decided by forfeitMatch, which the expiry sweep in find-match also
 * uses. Pressing this button and letting the clock run out are the same act as far as
 * the ladder is concerned, and if only one of them cost anything then the free one
 * would be the only one anybody used.
 */

import { forfeitMatch, handler, isCopiedSide, json, requireCaller } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { afterLegSettled } from "../_shared/tournament.ts";
import { updateRating } from "../../../src/core/rating/glicko2.ts";

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "abandon-match");

  // Not `.limit(1)`: the first open side can be a copy of the caller's run set in someone
  // else's match, which forfeitMatch reports as "already played" while the caller's own
  // match stays open and they stay stuck in it.
  const { data: sides } = await admin
    .from("match_sides")
    .select("match_id, submitted_at, matches!inner(id, status, created_at)")
    .eq("player_id", caller.playerId)
    .in("matches.status", ["open", "awaiting_runs"]);

  const side = (sides ?? []).find((s: any) => !isCopiedSide(s, s.matches));

  if (!side) return json({ ok: true, nothingToAbandon: true });

  const matchId = (side as { match_id: string }).match_id;
  const outcome = await forfeitMatch(admin, matchId, caller.playerId, updateRating);

  // If that was a tournament leg, the bracket should know now rather than at the next look.
  const tournament = outcome.reason === "already-played" ? null : await afterLegSettled(admin, matchId);

  const message = tournament
    ? outcome.reason === "seeding"
      ? "First leg abandoned, so the fixture will be replayed. Nothing was rated."
      : `You forfeited ${tournament.label}. Nothing was rated.`
    : outcome.reason === "seeding"
      ? "Nothing was rated: there was no opponent to play against."
      : outcome.reason === "off-pool"
        ? "Nothing was rated: this match was on scenarios the season no longer has."
      : outcome.reason === "already-played"
        ? "Your runs are already in, so this match will settle on its own."
        : "Match forfeited. You can queue again now.";

  return json({ ok: true, ...outcome, tournament, message });
}));
