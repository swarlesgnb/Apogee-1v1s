/**
 * Look a ghost card's code up as an invitation: what somebody needs to race the sender's
 * three live runs as a ghost of their own (docs/design/mechanics.md, "Ghost links").
 *
 * The answer is `linkFromRow` in src/core/ghost/links.ts and nothing more: the three
 * scenarios, the sender's display name, and per scenario the sender's live score and the
 * sender's baseline. Each side of the race is measured against its own baseline (PLAN.md
 * §3), which is why the sender's baseline is sent; the recipient's never leaves their PC.
 * No player id, Steam id or run id is sent. The row's player_id is read, to refuse a
 * caller their own code, and goes no further; validate:ghost-links holds this file to
 * answering with the core's link and nothing built here.
 *
 * READ ONLY. Nothing is written: the race is played and judged on the recipient's PC, moves
 * no rating, and has no card (a recipient result posted back was cut; see the doc).
 *
 * Signed-in callers only, like ghost-card (no `verify_jwt = false` in config.toml): the
 * own-code refusal and the per-player rate limit both need to know who is asking.
 */

import { handler, json, readJson, requireCaller, HttpError } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

import {
  GHOST_LINK_COLUMNS,
  LINK_REFUSAL,
  linkFromRow,
  normaliseLinkCode,
  type GhostLinkRow,
} from "../../../src/core/ghost/links.ts";

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "ghost-link");
  const body = await readJson<{ code?: unknown }>(req);

  // Refused before any query: a malformed code cannot name a row.
  const code = normaliseLinkCode(body.code);
  if (!code) throw new HttpError(LINK_REFUSAL.malformed.status, LINK_REFUSAL.malformed.message);

  const { data, error } = await admin.from("ghost_results").select(GHOST_LINK_COLUMNS).eq("code", code).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  const row = data as GhostLinkRow | null;

  // The sender's name only for a row the caller may race; an own code is refused anyway.
  let senderName: string | null = null;
  if (row && row.player_id !== caller.playerId) {
    const { data: player } = await admin.from("players").select("display_name").eq("id", row.player_id).maybeSingle();
    senderName = player?.display_name ?? null;
  }

  const answer = linkFromRow(row, caller.playerId, senderName);
  if (!answer.ok) throw new HttpError(answer.status, answer.message);
  return json(answer.link);
}));
