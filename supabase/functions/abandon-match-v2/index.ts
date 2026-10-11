/**
 * abandon-match under ranked v2. Admin-only while v2 is tested from development builds.
 *
 * abandon-match with forfeitMatchV2: the same exits, and a forfeit costs what the match's
 * engine says a forfeit costs. Under v2 that is every round lost, so leaving is never
 * cheaper than playing on and losing all three.
 */

import { handler, isCopiedSide, json, requireCaller } from "../_shared/apogee.ts";
import { forfeitMatchV2, requireRankedV2 } from "../_shared/rankedV2.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { afterLegSettled } from "../_shared/tournament.ts";

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await requireRankedV2(admin, caller.playerId);
  await enforceRateLimit(admin, caller.playerId, "abandon-match-v2");

  // Not `.limit(1)`, for the reason abandon-match gives: the first open side can be a copy.
  const { data: sides } = await admin
    .from("match_sides")
    .select("match_id, submitted_at, matches!inner(id, status, created_at)")
    .eq("player_id", caller.playerId)
    .in("matches.status", ["open", "awaiting_runs"]);

  const side = (sides ?? []).find((s: any) => !isCopiedSide(s, s.matches));
  if (!side) return json({ ok: true, nothingToAbandon: true });

  const matchId = (side as { match_id: string }).match_id;
  const outcome = await forfeitMatchV2(admin, matchId, caller.playerId);
  const tournament = outcome.reason === "already-played" || outcome.reason === "already-settled"
    ? null
    : await afterLegSettled(admin, matchId);

  const message = tournament
    ? outcome.reason === "seeding"
      ? "First leg abandoned, so the fixture will be replayed. Nothing was rated."
      : `You forfeited ${tournament.label}. Nothing was rated.`
    : outcome.reason === "seeding"
      ? "Nothing was rated: there was no opponent to play against."
      : outcome.reason === "off-pool"
        ? "Nothing was rated: this match was on scenarios the season no longer has."
      : outcome.reason === "already-settled"
        ? "This match has already ended."
      : outcome.reason === "already-played"
        ? "Your runs are already in, so this match will settle on its own."
        : "Match forfeited. You can queue again now.";

  return json({ ok: true, ...outcome, tournament, message });
}));
