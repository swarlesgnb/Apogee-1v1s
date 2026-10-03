/**
 * The queue screen's read: what queueing would do, the caller's Flags, and their Shadow ladder.
 *
 * Polled by the client on launch, on focus and after every settled match, which is how a
 * planter learns their Flag was answered while they were away. `ack` marks that news as
 * seen so it is announced once, on whichever machine opens first.
 *
 * Everything returned is about the caller. A flag's answerer is named only after the fact,
 * the way a result screen names an opponent; the planter's own score is theirs to see; and
 * nothing here says how any stored run set in the pool scored, because choosing what to queue
 * by that would be picking matches you expect to win.
 *
 * The one write is the caller's own: acknowledging news and closing their expired flags.
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
  return json(await queueBoard(admin, caller.playerId, body));
}));
