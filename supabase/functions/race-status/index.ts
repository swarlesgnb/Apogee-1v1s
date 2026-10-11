/**
 * Races, as one player is allowed to see them.
 *
 *   {}            the caller's invitations in and out, the race being played, the last few
 *                 results. Polled by the client while it is open, which is how an
 *                 invitation arrives and how an inviter learns their race has started.
 *   { raceId }    the live view of one race: both sides round by round, sealed.
 *   { matchId }   the same for a race leg, or for a Crown challenge the caller is playing,
 *                 where the other side is the holder's frozen run set.
 *
 * THE RULE THIS FUNCTION EXISTS TO APPLY
 *
 * The other side's round is shown only once the caller's own run on that scenario has
 * landed (`sealView`, src/core/race/race.ts). For a race this is the only route to the other
 * player's numbers at all: their match has no side of the caller's in it, so RLS refuses it
 * outright, and this function is the gate.
 */

import { handler, HttpError, json, readJson, requireCaller } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import {
  frozenSide,
  liveSide,
  namesFor,
  onlyFields,
  requireId,
  scenarioNamesFor,
  type MatchRow,
} from "../_shared/arena.ts";

import { RACE_INVITE_TTL_MS, sealView, verdictFor, type LiveSide } from "../../../src/core/race/race.ts";
import { buildRaceBoard, liveStatus, RACE_COLUMNS, raceRowFromDb, type LiveView } from "../../../src/core/race/view.ts";
import { CROWN_DRAW_EPSILON, crownName } from "../../../src/core/crowns/crowns.ts";

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "race-status");
  const body = onlyFields(await readJson<unknown>(req).catch(() => ({})), ["raceId", "matchId"]);

  const readMatch = async (id: string): Promise<MatchRow & { difficulty: string; category: string }> => {
    const { data, error } = await admin
      .from("matches")
      .select("id, status, created_at, scenario_ids, category, difficulty")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!data) throw new HttpError(404, "That match does not exist.");
    return { ...data, scenario_ids: (data.scenario_ids ?? []).map(Number) };
  };

  // ---- one race, or one Crown challenge, live -------------------------------------
  if (body.raceId != null || body.matchId != null) {
    let raceRowRaw: any = null;
    if (body.raceId != null) {
      const raceId = requireId(body.raceId, "raceId");
      const { data } = await admin.from("races").select(RACE_COLUMNS).eq("id", raceId).maybeSingle();
      raceRowRaw = data;
      if (!raceRowRaw) throw new HttpError(404, "That race does not exist.");
    } else {
      const matchId = requireId(body.matchId, "matchId");
      const { data } = await admin
        .from("races")
        .select(RACE_COLUMNS)
        .or(`inviter_match_id.eq.${matchId},invitee_match_id.eq.${matchId}`)
        .limit(1);
      raceRowRaw = (data ?? [])[0] ?? null;
      if (!raceRowRaw) return json(await crownLive(matchId));
    }

    const race = raceRowFromDb(raceRowRaw);
    const inviter = race.inviterId === caller.playerId;
    if (!inviter && race.inviteeId !== caller.playerId) throw new HttpError(404, "That race does not exist.");
    const mineId = inviter ? race.inviterMatchId : race.inviteeMatchId;
    const theirsId = inviter ? race.inviteeMatchId : race.inviterMatchId;
    const otherId = inviter ? race.inviteeId : race.inviterId;
    if (!mineId || !theirsId) throw new HttpError(409, "That race has not started.");

    const names = await namesFor(admin, [caller.playerId, otherId]);
    const scenarioNames = await scenarioNamesFor(admin, race.scenarioIds);
    const [mineMatch, theirsMatch] = await Promise.all([readMatch(mineId), readMatch(theirsId)]);
    const [you, them] = await Promise.all([
      liveSide(admin, mineMatch, caller.playerId, names.get(caller.playerId) ?? "you", scenarioNames),
      liveSide(admin, theirsMatch, otherId, names.get(otherId) ?? "your opponent", scenarioNames),
    ]);
    const sealed = sealView(you, them);
    const verdict = race.status === "finished" ? verdictFor(race.result, inviter) : null;
    const view: LiveView = {
      ...sealed,
      kind: "race",
      matchId: mineId,
      raceId: race.id,
      title: `Race against ${them.name}`,
      verdict,
      byForfeit: race.byForfeit,
      status: liveStatus(sealed, verdict, "race"),
    };
    return json(view);
  }

  async function crownLive(matchId: string): Promise<LiveView> {
    const { data: ch } = await admin
      .from("crown_challenges")
      .select("match_id, category, window_index, challenger_id, outcome, challenger_score, holder_score")
      .eq("match_id", matchId)
      .maybeSingle();
    if (!ch || ch.challenger_id !== caller.playerId) throw new HttpError(404, "That is not a race or a challenge of yours.");
    const match = await readMatch(matchId);
    const scenarioNames = await scenarioNamesFor(admin, match.scenario_ids);
    const { data: sides } = await admin
      .from("match_sides")
      .select("player_id, deltas, match_score")
      .eq("match_id", matchId);
    const holderSide = (sides ?? []).find((s: any) => s.player_id !== caller.playerId) ?? null;
    const names = await namesFor(admin, [caller.playerId, holderSide?.player_id]);
    const you = await liveSide(admin, match, caller.playerId, names.get(caller.playerId) ?? "you", scenarioNames);
    const them: LiveSide = holderSide
      ? frozenSide(holderSide, match.scenario_ids, names.get(holderSide.player_id) ?? "the holder", scenarioNames)
      : {
          name: "Vacant",
          terminal: true,
          void: false,
          matchScore: null,
          rounds: match.scenario_ids.map((sid) => ({
            scenarioId: sid, scenario: scenarioNames.get(sid) ?? `scenario ${sid}`,
            landed: false, delta: null, counted: false, provisional: false, tier: null,
          })),
        };
    const sealed = sealView(you, them);
    let verdict: LiveView["verdict"] = null;
    if (ch.outcome === "took") verdict = "win";
    else if (ch.outcome === "defended") {
      verdict = Math.abs(Number(ch.challenger_score) - Number(ch.holder_score)) < CROWN_DRAW_EPSILON ? "draw" : "loss";
    } else if (ch.outcome) verdict = "void";
    return {
      ...sealed,
      kind: "crown",
      matchId,
      raceId: null,
      title: crownName(ch.category, match.difficulty),
      verdict,
      byForfeit: ch.outcome === "forfeit",
      status: holderSide || verdict ? liveStatus(sealed, verdict, "crown") : "Vacant: the first qualifying run set to settle takes it.",
    };
  }

  // ---- the caller's races ---------------------------------------------------------
  const now = Date.now();
  // An invitation past its time is written down as expired the next time anybody looks.
  for (const column of ["inviter_id", "invitee_id"]) {
    await admin
      .from("races")
      .update({ status: "expired" })
      .eq(column, caller.playerId)
      .eq("status", "invited")
      .lte("expires_at", new Date(now).toISOString());
  }
  const [sent, received] = await Promise.all([
    admin.from("races").select(RACE_COLUMNS).eq("inviter_id", caller.playerId).order("created_at", { ascending: false }).limit(10),
    admin.from("races").select(RACE_COLUMNS).eq("invitee_id", caller.playerId).order("created_at", { ascending: false }).limit(10),
  ]);
  if (sent.error) throw new HttpError(500, sent.error.message);
  if (received.error) throw new HttpError(500, received.error.message);
  const rows = [...(sent.data ?? []), ...(received.data ?? [])].map(raceRowFromDb);
  const names = await namesFor(admin, rows.flatMap((r) => [r.inviterId, r.inviteeId]));
  const scenarioNames = await scenarioNamesFor(admin, rows.flatMap((r) => r.scenarioIds));
  return json(buildRaceBoard(rows, caller.playerId, names, scenarioNames, now, RACE_INVITE_TTL_MS / 1000));
}));
