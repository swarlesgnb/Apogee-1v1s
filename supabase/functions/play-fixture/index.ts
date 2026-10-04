/**
 * Play your leg of a tournament fixture.
 *
 * Hands back a match in the shape find-match returns, so the client stores it, writes the
 * playlist and paints the match panel through the path that already exists. `tournament`
 * is the only addition, as `duel` was.
 *
 * WHAT THE REQUEST MAY NAME
 *
 * The tournament, the fixture and the attempt the player was looking at. Not the
 * opponent, the scenarios, the seed, a baseline or anything about a result: the fixture
 * says who the opponent is, the first leg's seed says what the three are, and the second
 * leg is copied off the first in SQL (`tournament_open_leg`). The attempt is there so a
 * stale screen - a fixture that was replayed since - is refused rather than served the
 * next attempt without knowing it moved.
 */

import {
  handler,
  HttpError,
  INITIAL_TTL_MS,
  json,
  loadSeasonPool,
  readJson,
  requireCaller,
  sweepStaleMatches,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { loadTournament, onlyFields, reconcile, requireUuid } from "../_shared/tournament.ts";
import { matchClock, recordMatchClock } from "../_shared/timeIntegrity.ts";

import { getReadyFixtures } from "../../../src/core/tournament/tournament.ts";
import { fixtureLabelFor } from "../../../src/core/tournament/view.ts";
import { selectScenarios } from "../../../src/core/match/scenarioSelection.ts";
import { updateRating } from "../../../src/core/rating/glicko2.ts";

/** What the SQL refusals map to. Their messages are already worded for the player. */
const STATUS_FOR: Record<string, number> = { TN403: 403, TN404: 404, TN409: 409 };

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "play-fixture");

  const body = await readJson<Record<string, unknown>>(req);
  onlyFields(body, ["tournamentId", "fixtureId", "attempt", "tzOffsetMinutes"]);
  const tournamentId = requireUuid(body.tournamentId, "tournamentId");
  if (typeof body.fixtureId !== "string" || body.fixtureId.length === 0 || body.fixtureId.length > 128) {
    throw new HttpError(400, "fixtureId is required");
  }
  if (typeof body.attempt !== "number" || !Number.isSafeInteger(body.attempt) || body.attempt < 1) {
    throw new HttpError(400, "attempt is required");
  }
  const fixtureId = body.fixtureId;
  const attempt = body.attempt;

  // Anything that finished since the screen was drawn is folded in first, so readiness is
  // judged on the tournament as it is and not as it was.
  await reconcile(admin, tournamentId);
  const row = await loadTournament(admin, tournamentId);

  const fixture = getReadyFixtures(row.state).find((f) => f.id === fixtureId);
  if (!fixture) throw new HttpError(409, "That fixture is not ready to play yet.");
  if (fixture.attempt !== attempt) throw new HttpError(409, "That fixture has moved on since you looked. Refresh and try again.");
  if (fixture.playerA !== caller.playerId && fixture.playerB !== caller.playerId) {
    throw new HttpError(403, "You are not playing in that fixture.");
  }
  const opponentId = fixture.playerA === caller.playerId ? fixture.playerB : fixture.playerA;
  const opponentName = row.state.entrants.find((e) => e.id === opponentId)?.name ?? "your opponent";

  // Retire this player's expired matches first, charged by the ordinary rule. The live
  // one, if any, is judged inside tournament_open_leg: it may be this very leg.
  await sweepStaleMatches(admin, caller.playerId, updateRating);
  const clock = await matchClock(admin, caller.playerId, body);

  const { season, windowName, selectable } = await loadSeasonPool(admin, row.window_index);
  const seed = crypto.randomUUID();
  const scenarioIds = selectScenarios(selectable, seed, { category: row.category }).map((s) => s.id);
  if (scenarioIds.length !== 3) {
    throw new HttpError(409, `${windowName} no longer has scenarios in ${row.category}.`);
  }

  const { data: opened, error } = await admin.rpc("tournament_open_leg", {
    p_tournament: tournamentId,
    p_fixture: fixtureId,
    p_attempt: attempt,
    p_player: caller.playerId,
    p_seed: seed,
    p_scenarios: scenarioIds,
    p_category: row.category,
    p_benchmark: season.name,
    p_difficulty: row.window_name,
    p_window: row.window_index,
    p_ttl_seconds: Math.round(INITIAL_TTL_MS / 1000),
  });

  if (error) {
    const status = STATUS_FOR[error.code ?? ""];
    throw new HttpError(status ?? 500, error.message);
  }

  const { matchId, leg, created } = opened as { matchId: string; leg: 1 | 2; created: boolean };
  // tournament_open_leg writes the side in SQL; the clock goes on afterwards, and only
  // onto a side that has none, so pressing Play again cannot change it.
  await recordMatchClock(admin, matchId, caller.playerId, clock);

  const { data: match } = await admin
    .from("matches")
    .select("id, status, category, difficulty, scenario_ids, expires_at")
    .eq("id", matchId)
    .maybeSingle();
  if (!match) throw new HttpError(500, "the fixture's match is missing");

  if (!created && match.status !== "open" && match.status !== "awaiting_runs") {
    throw new HttpError(409, `You have played your three for this fixture. It is ${opponentName}'s turn.`);
  }

  const ids: number[] = match.scenario_ids ?? [];
  const { data: names } = await admin.from("scenarios").select("id, name").in("id", ids);
  const nameById = new Map((names ?? []).map((s: any) => [s.id, s.name]));

  // The frozen side on a second leg: enough to name who played it and when, the same
  // fields find-match hands over for a stored run set, and nothing about how it went.
  const { data: theirSide } = leg === 2
    ? await admin
        .from("match_sides")
        .select("rating_before, provisional, submitted_at")
        .eq("match_id", matchId)
        .eq("player_id", opponentId)
        .maybeSingle()
    : { data: null };

  return json({
    matchId,
    category: match.category,
    difficulty: match.difficulty,
    expiresAt: match.expires_at,
    scenarios: ids.map((id) => ({ id, name: nameById.get(id) ?? `scenario ${id}` })),
    opponent: theirSide
      ? {
          displayName: opponentName,
          rating: Math.round(Number(theirSide.rating_before ?? 1500)),
          playedAt: theirSide.submitted_at,
          provisional: !!theirSide.provisional,
        }
      : null,
    seeding: leg === 1,
    resumed: !created,
    winProbability: null,
    poolSize: null,
    tournament: {
      id: row.id,
      name: row.name,
      fixtureId,
      attempt,
      label: fixtureLabelFor(row.state, fixtureId),
      leg,
      opponentName,
    },
  });
}));
