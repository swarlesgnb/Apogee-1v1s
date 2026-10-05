/**
 * Read one band of one Apogee Daily: how many played, the spread, and where the caller
 * stands. Never another player's name, id or entry: the board is a distribution, and
 * `boardFromRows` (src/core/social/daily.ts) builds the answer without the rows' owners.
 *
 * A day that has not begun is refused rather than answered empty, so this cannot be used
 * to learn when a draw opens or to probe a future day. A finished day stays readable, so
 * yesterday's result keeps its percentile.
 *
 * READ ONLY. Signed-in callers only (no `verify_jwt = false`): the caller's own place and
 * the per-player rate limit both need to know who is asking.
 */

import { handler, json, readJson, requireCaller, HttpError } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { BOARD_ROWS, dailyPool, serverDailyStreak } from "../_shared/social.ts";

import { boardFromRows, dailyNumberAt, isDailyNumber, type BoardRow } from "../../../src/core/social/daily.ts";

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "daily-board");
  const body = await readJson<{ dailyNumber?: unknown; window?: unknown }>(req);

  if (!isDailyNumber(body.dailyNumber)) throw new HttpError(400, "dailyNumber must be a daily's number");
  if (typeof body.window !== "number" || !Number.isInteger(body.window) || body.window < 0 || body.window > 15) {
    throw new HttpError(400, "window must be a band index");
  }
  const today = dailyNumberAt(Date.now());
  if (body.dailyNumber > today) throw new HttpError(422, `Apogee Daily #${body.dailyNumber} has not started yet`);

  const { band } = await dailyPool(admin, body.window);
  const { data, error } = await admin
    .from("daily_results")
    .select("player_id, mean_delta, glyphs, provisional")
    .eq("daily_number", body.dailyNumber)
    .eq("window_index", body.window)
    .limit(BOARD_ROWS);
  if (error) throw new HttpError(500, error.message);

  const streak = await serverDailyStreak(admin, caller.playerId, today);
  return json({
    board: boardFromRows((data ?? []) as BoardRow[], caller.playerId, {
      dailyNumber: body.dailyNumber,
      window: body.window,
      band,
      streak,
    }),
  });
}));
