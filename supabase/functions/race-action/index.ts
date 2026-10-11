/**
 * Invite somebody to a race, accept one, decline one, or take one back.
 *
 * A race is for now: two players who are both at their PCs play the same three scenarios
 * at the same time, and each sees the other's rounds as their own land (race-status). An
 * invitation waits three minutes. Accepting creates both matches in one transaction
 * (`race_start`) with the same three and the same start, so neither player can begin
 * before the other has the match.
 *
 * WHAT THE REQUEST MAY NAME
 *
 * Who to invite, in which category and band. The three scenarios are drawn here from a
 * server seed and shown to both players before anybody plays. Nothing about a result is
 * ever accepted: each side is an ordinary unrated match that settles through settle-match,
 * and the race is decided in SQL from what settlement stored.
 *
 * Unrated by construction (`matches.rated = false`), so there is no eligibility gate: a
 * friend who installed the app five minutes ago can race. Their rounds read 0% on scenarios
 * they have no history on, which the live view says; that is the baseline rule, not a
 * special case.
 */

import { handler, HttpError, INITIAL_TTL_MS, json, readJson, requireCaller, sweepStaleMatches } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import {
  namesFor,
  onlyFields,
  requireCategory,
  requireId,
  requireWindow,
  scenarioNamesFor,
  seasonCells,
  sqlRefusal,
} from "../_shared/arena.ts";

import { selectScenarios } from "../../../src/core/match/scenarioSelection.ts";
import { updateRating } from "../../../src/core/rating/glicko2.ts";
import { DECLINE_QUIET_MS, RACE_INVITE_TTL_MS } from "../../../src/core/race/race.ts";
import { RACE_COLUMNS, raceRowFromDb as raceRow, summarise } from "../../../src/core/race/view.ts";

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "race-action");
  const raw = await readJson<Record<string, unknown>>(req);
  const action = raw?.action;

  const view = async (row: any) => {
    const r = raceRow(row);
    const names = await namesFor(admin, [r.inviterId, r.inviteeId]);
    return summarise(r, caller.playerId, names, await scenarioNamesFor(admin, r.scenarioIds), Date.now());
  };

  if (action === "invite") {
    const body = onlyFields(raw, ["action", "to", "category", "window"]);
    const to = requireId(body.to, "to");
    const category = requireCategory(body.category);
    const window = requireWindow(body.window);
    if (to === caller.playerId) throw new HttpError(400, "You cannot race yourself. Ghost Mode races your past runs.");

    const { data: them } = await admin.from("players").select("id").eq("id", to).maybeSingle();
    if (!them) throw new HttpError(404, "No such player.");

    // A decline is an answer. Asking again at once is pestering, and with a toast on the
    // other end it is pestering that interrupts whatever they are doing.
    const { data: declined } = await admin
      .from("races")
      .select("id")
      .eq("inviter_id", caller.playerId)
      .eq("invitee_id", to)
      .eq("status", "declined")
      .gte("created_at", new Date(Date.now() - DECLINE_QUIET_MS).toISOString())
      .limit(1);
    if ((declined ?? []).length > 0) {
      throw new HttpError(429, "They declined a race from you a few minutes ago. Try again later.");
    }

    // A race is played now, so an inviter already in a match has nothing to start.
    const live = await sweepStaleMatches(admin, caller.playerId, updateRating);
    if (live) throw new HttpError(409, "Finish or abandon your current match before inviting somebody to race.");

    const { season, bands, pools, cells } = await seasonCells(admin);
    if (!cells.some((c) => c.category === category && c.window === window)) {
      throw new HttpError(404, `${season} has no ${category} scenarios in that band.`);
    }
    const seed = crypto.randomUUID();
    const scenarioIds = selectScenarios(pools.get(window) ?? [], seed, { category }).map((s) => s.id);
    if (scenarioIds.length !== 3) throw new HttpError(409, "That band has no three scenarios for that category.");

    // An invitation past its time no longer blocks the next one.
    await admin
      .from("races")
      .update({ status: "expired" })
      .eq("inviter_id", caller.playerId)
      .eq("status", "invited")
      .lte("expires_at", new Date().toISOString());

    const { data: row, error } = await admin
      .from("races")
      .insert({
        inviter_id: caller.playerId,
        invitee_id: to,
        category,
        window_index: window,
        benchmark_name: season,
        difficulty: bands[window] ?? `Band ${window + 1}`,
        seed,
        scenario_ids: scenarioIds,
        expires_at: new Date(Date.now() + RACE_INVITE_TTL_MS).toISOString(),
      })
      .select(RACE_COLUMNS)
      .maybeSingle();
    if (error) {
      throw error.code === "23505"
        ? new HttpError(409, "You already have an invitation out. Take it back or wait for an answer.")
        : new HttpError(500, error.message);
    }
    return json({ ok: true, race: await view(row) });
  }

  const body = onlyFields(raw, ["action", "raceId"]);
  const raceId = requireId(body.raceId, "raceId");
  const { data: row, error: readError } = await admin.from("races").select(RACE_COLUMNS).eq("id", raceId).maybeSingle();
  if (readError) throw new HttpError(500, readError.message);
  if (!row || (row.inviter_id !== caller.playerId && row.invitee_id !== caller.playerId)) {
    throw new HttpError(404, "That race does not exist.");
  }

  if (action === "decline" || action === "cancel") {
    const mine = action === "decline" ? row.invitee_id : row.inviter_id;
    if (mine !== caller.playerId) {
      throw new HttpError(403, action === "decline" ? "Only the player invited can decline." : "Only the player who sent it can take it back.");
    }
    const { data: changed } = await admin
      .from("races")
      .update({ status: action === "decline" ? "declined" : "cancelled" })
      .eq("id", raceId)
      .eq("status", "invited")
      .select(RACE_COLUMNS)
      .maybeSingle();
    if (!changed) throw new HttpError(409, "That invitation has already been answered.");
    return json({ ok: true, race: await view(changed) });
  }

  if (action !== "accept") throw new HttpError(400, "action must be invite, accept, decline or cancel");

  // Retire the caller's own expired matches by the ordinary rule before race_start asks
  // whether both players are free.
  await sweepStaleMatches(admin, caller.playerId, updateRating);

  const { data: started, error } = await admin.rpc("race_start", {
    p_race: raceId,
    p_player: caller.playerId,
    p_ttl_seconds: Math.round(INITIAL_TTL_MS / 1000),
  });
  if (error) throw sqlRefusal(error);
  const { inviteeMatchId, created } = started as { inviterMatchId: string; inviteeMatchId: string; created: boolean };

  const { data: fresh } = await admin.from("races").select(RACE_COLUMNS).eq("id", raceId).maybeSingle();
  const { data: match } = await admin
    .from("matches")
    .select("id, category, difficulty, scenario_ids, expires_at")
    .eq("id", inviteeMatchId)
    .maybeSingle();
  if (!match || !fresh) throw new HttpError(500, "the race's match is missing");
  const ids: number[] = (match.scenario_ids ?? []).map(Number);
  const names = await scenarioNamesFor(admin, ids);
  const summary = await view(fresh);

  // Shaped like find-match's answer so the client adopts it through the path that exists.
  // `opponent` is null: the other side is a person playing now, not a stored run set, and
  // the race panel draws them from race-status.
  return json({
    matchId: match.id,
    category: match.category,
    difficulty: match.difficulty,
    expiresAt: match.expires_at,
    scenarios: ids.map((id) => ({ id, name: names.get(id) ?? `scenario ${id}` })),
    opponent: null,
    seeding: true,
    resumed: !created,
    winProbability: null,
    poolSize: null,
    race: { id: raceId, opponentName: summary.opponent.name, role: "invitee", band: summary.band },
  });
}));
