/**
 * Read a ghost card by its share code.
 *
 * Signed-in callers only for now: no `verify_jwt = false` in config.toml. That is enough
 * for viewing a card in the app and keeps a public scrape surface closed until there is
 * a web page for cards to be seen on (docs/design/mechanics.md, "Server layer").
 *
 * The code is the only handle a card has. It names the player by display name, which is
 * what a card shared on purpose is for, and hands out no player id, no Steam id and
 * nothing about rating.
 */

import { handler, json, readJson, requireCaller, HttpError } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { cardOf, GHOST_ROW_COLUMNS, serverStreak, type GhostResultRow } from "../_shared/ghost.ts";

/** ghost_code_shape, in the migration. Anything else is refused before a query. */
const CODE_SHAPE = /^[2-9A-HJKMNP-Z]{8}$/;

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "ghost-card");
  const body = await readJson<{ code?: unknown }>(req);

  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!CODE_SHAPE.test(code)) throw new HttpError(400, "that is not a ghost card code");

  const { data, error } = await admin.from("ghost_results").select(GHOST_ROW_COLUMNS).eq("code", code).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  // Worded so the client can tell it from a function that is not deployed (isNotDeployed).
  if (!data) throw new HttpError(404, "no ghost card with that code");
  const row = data as GhostResultRow;

  const { data: player } = await admin.from("players").select("display_name").eq("id", row.player_id).maybeSingle();
  return json(cardOf(row, player?.display_name ?? "A player", await serverStreak(admin, row)));
}));
