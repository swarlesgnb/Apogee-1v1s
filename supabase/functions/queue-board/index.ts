/**
 * The queue screen's read: what queueing would do, the caller's Shadow ladder, and news
 * about their banked rounds (Flags).
 *
 * Polled by the client on launch, on focus and after every settled match, which is how a
 * player learns that somebody played their banked rounds while they were away. `ack`
 * (the newest settledAt the client has shown) marks that news read, so it is said once, on
 * whichever machine opens first.
 *
 * Everything returned is about the caller. Who played your rounds is named only after the
 * match settled, the way a result screen names an opponent; nothing here says how any
 * stored rounds in the pool scored before somebody plays them.
 *
 * The one write is the caller's own read marker.
 */

import { handler, json, readJson, requireCaller, HttpError } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { queueBoard, type BoardRequest } from "../_shared/queue.ts";

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "queue-board");
  const body = (await readJson<BoardRequest>(req)) ?? {};
  if (body.window != null && (typeof body.window !== "number" || body.window < 0)) {
    throw new HttpError(400, "window must be a window index");
  }
  if (body.ack != null && (typeof body.ack !== "string" || body.ack.length > 40)) {
    throw new HttpError(400, "ack must be a timestamp");
  }
  return json(await queueBoard(admin, caller.playerId, body));
}));
