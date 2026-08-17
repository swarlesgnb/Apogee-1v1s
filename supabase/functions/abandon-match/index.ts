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

import { forfeitMatch, handler, json, requireCaller } from "../_shared/apogee.ts";
import { updateRating } from "../../../src/core/rating/glicko2.ts";

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);

  const { data: side } = await admin
    .from("match_sides")
    .select("match_id, matches!inner(id, status)")
    .eq("player_id", caller.playerId)
    .in("matches.status", ["open", "awaiting_runs"])
    .limit(1)
    .maybeSingle();

  if (!side) return json({ ok: true, nothingToAbandon: true });

  const outcome = await forfeitMatch(
    admin,
    (side as { match_id: string }).match_id,
    caller.playerId,
    updateRating,
  );

  const message =
    outcome.reason === "seeding"
      ? "Nothing was rated: there was no opponent to play against."
      : outcome.reason === "already-played"
        ? "Your runs are already in, so this match will settle on its own."
        : "Match forfeited. You can queue again now.";

  return json({ ok: true, ...outcome, message });
}));
