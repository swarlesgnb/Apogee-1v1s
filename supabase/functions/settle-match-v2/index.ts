/**
 * settle-match under ranked v2. Admin-only while v2 is tested from development builds.
 *
 * Same contract as settle-match. The work is in _shared/rankedV2.ts (settleForPlayer),
 * because the expiry sweep settles a finished match nobody settled with the same code.
 * A match keeps the rules of the engine that created it, so settling a v1 match here is
 * settling it exactly as settle-match would.
 */

import { handler, json, readJson, requireCaller, HttpError } from "../_shared/apogee.ts";
import { requireRankedV2, settleForPlayer } from "../_shared/rankedV2.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

interface Body {
  matchId: string;
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await requireRankedV2(admin, caller.playerId);
  await enforceRateLimit(admin, caller.playerId, "settle-match-v2");
  const { matchId } = await readJson<Body>(req);
  if (!matchId) throw new HttpError(400, "matchId is required");

  const { status, body } = await settleForPlayer(admin, matchId, caller.playerId);
  return json(body, status);
}));
