/**
 * Send a duel: a match addressed at one named player.
 *
 * The caller plays first. This creates the same seeding match `find-match` creates when
 * the pool has nobody suitable - one side, three scenarios from a server-generated seed -
 * and a `duels` row pointing at it. When the caller has played their three, the recipient
 * can accept, and `answer-duel` builds the contested match from the side they left behind.
 *
 * So the caller does not wait for anybody, and a duel nobody answers is not wasted: the
 * seeding match settles the way seeding matches always have and the run set joins the
 * pool, where the ordinary queue can draw it.
 *
 * WHAT IS DECIDED HERE AND NEVER BY THE CLIENT
 *
 *   the scenarios   from a server-generated seed, so they cannot be rerolled
 *   the sender      from the verified token, so nobody sends a duel as somebody else
 *
 * The recipient IS named by the client, which is the whole feature and the one thing a
 * duel gives up next to a queued match. See `list-duels` for what that costs.
 */

import {
  handler,
  json,
  loadSeasonPool,
  readJson,
  requireCaller,
  requireEligible,
  sweepStaleMatches,
  HttpError,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

import { selectScenarios } from "../../../src/core/match/scenarioSelection.ts";
import { ANY_CATEGORY } from "../../../src/core/match/matchmaking.ts";
import { canSendDuel, DUEL_TTL_MS } from "../../../src/core/match/duels.ts";
import { updateRating } from "../../../src/core/rating/glicko2.ts";

interface Body {
  /** The player id from the roster `list-duels` serves. */
  to: string;
  category: string;
  window: number;
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "send-duel");
  const body = await readJson<Body>(req);

  if (!body.to || !body.category || typeof body.window !== "number" || body.window < 0) {
    throw new HttpError(400, "to, category and window are required");
  }

  const pairing = canSendDuel(caller.playerId, body.to);
  if (!pairing.ok) throw new HttpError(400, pairing.reason);

  // "Any" is not a duel.
  //
  // It is a statement about what you will accept from a pool, and a duel has no pool -
  // there is one opponent and they were chosen. Worse, the match would be filed under a
  // category only another "Any" queue can draw from, so an unanswered one would sit in
  // the bucket the wildcard exists to drain rather than deepening a real one.
  if (body.category === ANY_CATEGORY) {
    throw new HttpError(400, "pick a category to duel in");
  }

  const { data: target } = await admin
    .from("players")
    .select("id, display_name")
    .eq("id", body.to)
    .maybeSingle();

  if (!target) throw new HttpError(404, "no such player");

  // One match at a time, the same rule the queue holds to, and here it refuses rather
  // than resuming: the match they already have is not this duel, and handing it back
  // would answer a question they did not ask.
  const live = await sweepStaleMatches(admin, caller.playerId, updateRating);
  if (live) {
    throw new HttpError(409, "finish or abandon your current match before sending a duel");
  }

  // Both ends of a duel are rated, so both ends meet the same bar as the queue.
  await requireEligible(admin, caller.playerId);

  const { season, windowName, selectable } = await loadSeasonPool(admin, body.window);

  const seed = crypto.randomUUID();
  const scenarioIds = selectScenarios(selectable, seed, { category: body.category }).map(
    (s) => s.id,
  );

  const { data: match, error: matchError } = await admin
    .from("matches")
    .insert({
      mode: "async",
      category: body.category,
      benchmark_name: season.name,
      difficulty: windowName,
      window_index: body.window,
      seed,
      scenario_ids: scenarioIds,
      status: "awaiting_runs",
      expires_at: new Date(Date.now() + INITIAL_TTL_MS).toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (matchError || !match) {
    throw new HttpError(500, matchError?.message ?? "could not create the duel's match");
  }

  const { data: rating } = await admin
    .from("ratings")
    .select("rating, rd")
    .eq("player_id", caller.playerId)
    .maybeSingle();

  const { error: sideError } = await admin.from("match_sides").insert({
    match_id: match.id,
    player_id: caller.playerId,
    rating_before: Number(rating?.rating ?? 1500),
    rd_before: Number(rating?.rd ?? 350),
  });

  if (sideError) throw new HttpError(500, sideError.message);

  const { data: duel, error: duelError } = await admin
    .from("duels")
    .insert({
      challenger_id: caller.playerId,
      challenged_id: body.to,
      match_id: match.id,
      expires_at: new Date(Date.now() + DUEL_TTL_MS).toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (duelError || !duel) {
    // The partial unique index refuses a second open duel to the same person. That is a
    // 409 about a decision, not a 500 about a database - and the match just created is
    // left alone deliberately: the caller can still play it, and it becomes an ordinary
    // pool run set exactly as an unanswered duel does.
    const already = duelError?.code === "23505";
    throw new HttpError(
      already ? 409 : 500,
      already
        ? `you already have a duel out to ${target.display_name}`
        : duelError?.message ?? "could not send the duel",
    );
  }

  const byId = new Map(selectable.map((s) => [s.id, s.name]));

  // The same shape find-match returns, so the client stores it, writes the playlist and
  // paints the match panel with no new path. `duel` is the only addition.
  return json({
    matchId: match.id,
    category: body.category,
    difficulty: windowName,
    expiresAt: new Date(Date.now() + INITIAL_TTL_MS).toISOString(),
    scenarios: scenarioIds.map((id) => ({ id, name: byId.get(id) ?? `scenario ${id}` })),
    opponent: null,
    seeding: true,
    winProbability: null,
    poolSize: null,
    duel: { id: duel.id, to: target.display_name },
  });
}));
