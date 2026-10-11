/**
 * Settle a match and move the ladder.
 *
 * The work is in _shared/rankedV2.ts (settleForPlayer), because the expiry sweep settles a
 * finished match nobody settled with the same code, and two copies of the rules for what a
 * result is worth would drift. A match keeps the rules of the engine that created it, so a
 * match from before ranked v2 settles exactly as it would have then.
 */

import { handler, json, readJson, requireCaller, HttpError } from "../_shared/apogee.ts";
import { settleForPlayer } from "../_shared/rankedV2.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

interface Body {
  matchId: string;
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "settle-match");
  const { matchId } = await readJson<Body>(req);
  if (!matchId) throw new HttpError(400, "matchId is required");

  const { status, body } = await settleForPlayer(admin, matchId, caller.playerId);
  return json(body, status);
}));
