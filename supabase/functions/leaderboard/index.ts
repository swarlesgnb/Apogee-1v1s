/**
 * The boards: the rating ladder, this week's movers, and one scenario's best scores.
 *
 * WHY THIS IS A FUNCTION
 *
 * `players` is owner-only, and anything a client sees about another player is a decision
 * the server makes (list-duels states the rule). A board is a list of other players by
 * name, so the names are joined here under the service role. The ordering is decided in
 * core/leaderboard, which the validator runs too.
 *
 * WHO IS LISTED
 *
 * Only people who have played. The ladder and the movers come from settled rated matches,
 * so nobody is on them for having signed in. A scenario board comes from uploaded runs:
 * somebody who has played a scenario is a participant on that scenario whether or not
 * they have queued.
 *
 * Player ids are handed out with the names for the same reason list-duels hands them out:
 * the board offers a duel, and a duel has to be addressed. They identify nothing outside
 * this system and unlock nothing.
 *
 * WHAT A SCORE IS WORTH
 *
 * Verified and consistent runs only. Most Season 1 scenarios have no KovaaK's server
 * record to verify against, so most of a board is "consistent": internally consistent CSVs
 * the checks of PLAN.md §5 could not fault. The tier is shown beside every score so that is
 * visible rather than implied, and suspect and rejected runs are never ranked.
 */

import { handler, json, readJson, requireCaller, HttpError } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

import { ladder, movers, scenarioBoard } from "../../../src/core/leaderboard/leaderboard.ts";

interface Body {
  view: "ladder" | "movers" | "scenario";
  /** The scenario's name, for the scenario view. */
  scenario?: string;
}

/** How many ladder rows are sent. The caller's own row follows when it is further down. */
const LADDER_SHOWN = 100;
/** The movers' window. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows read per scenario before keeping each player's best; a scenario's top runs. */
const SCENARIO_SCAN = 3000;
/** `.in()` goes into the query string. */
const IN_CHUNK = 150;

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "leaderboard");
  const body = await readJson<Body>(req);

  if (body.view === "ladder") {
    const { data, error } = await admin
      .from("ratings")
      .select("player_id, rating, rd, volatility, matches_played")
      .gt("matches_played", 0)
      .limit(5000);
    if (error) throw new HttpError(500, error.message);

    const names = await displayNames(admin, (data ?? []).map((r: any) => r.player_id));
    const rows = ladder(
      (data ?? [])
        .filter((r: any) => names.has(r.player_id))
        .map((r: any) => ({
          playerId: r.player_id,
          displayName: names.get(r.player_id)!,
          rating: { rating: Number(r.rating), rd: Number(r.rd), volatility: Number(r.volatility) },
          matchesPlayed: Number(r.matches_played),
        })),
    );

    const shown = rows.slice(0, LADDER_SHOWN);
    const mine = rows.find((r) => r.playerId === caller.playerId) ?? null;
    return json({
      view: "ladder",
      rows: shown,
      you: mine && !shown.includes(mine) ? mine : null,
      players: rows.length,
    });
  }

  if (body.view === "movers") {
    const since = new Date(Date.now() - WEEK_MS).toISOString();
    const { data, error } = await admin
      .from("rating_history")
      .select("player_id, rating_before, rating_after, result, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(10000);
    if (error) throw new HttpError(500, error.message);

    const history: { playerId: string; ratingBefore: number; ratingAfter: number; result: number; createdAt: string }[] =
      (data ?? []).map((h: any) => ({
      playerId: h.player_id,
      ratingBefore: Number(h.rating_before),
      ratingAfter: Number(h.rating_after),
      result: Number(h.result),
      createdAt: h.created_at,
    }));
    const names = await displayNames(admin, history.map((h) => h.playerId));
    return json({ view: "movers", since, ...movers(history, names, since) });
  }

  if (body.view === "scenario") {
    if (!body.scenario || typeof body.scenario !== "string") throw new HttpError(400, "scenario is required");

    const { data: scenarios, error: scenarioError } = await admin
      .from("scenarios")
      .select("id")
      .eq("name", body.scenario);
    if (scenarioError) throw new HttpError(500, scenarioError.message);
    const ids = (scenarios ?? []).map((s: any) => s.id);
    if (ids.length === 0) return json({ view: "scenario", scenario: body.scenario, rows: [], you: null, players: 0 });

    const { data: runs, error: runsError } = await admin
      .from("runs")
      .select("player_id, score, verification_tier, played_at")
      .in("scenario_id", ids)
      .in("verification_tier", ["verified", "consistent"])
      .order("score", { ascending: false })
      .limit(SCENARIO_SCAN);
    if (runsError) throw new HttpError(500, runsError.message);

    const scored: { playerId: string; score: number; tier: string; playedAt: string }[] = (runs ?? []).map((r: any) => ({
      playerId: r.player_id,
      score: Number(r.score),
      tier: r.verification_tier,
      playedAt: r.played_at,
    }));
    const names = await displayNames(admin, scored.map((r) => r.playerId));
    const board = scenarioBoard(scored, names, caller.playerId);

    // The scan is the top runs, not every run, so a caller far down may have fallen out of
    // it. Their own best is read directly in that case, so they always see a position-less
    // "your best" rather than nothing.
    let you = board.you;
    let yourBest: number | null = null;
    if (!you && !board.rows.some((r) => r.playerId === caller.playerId)) {
      const { data: own } = await admin
        .from("runs")
        .select("score")
        .eq("player_id", caller.playerId)
        .in("scenario_id", ids)
        .in("verification_tier", ["verified", "consistent"])
        .order("score", { ascending: false })
        .limit(1);
      yourBest = own?.[0] ? Number(own[0].score) : null;
    }

    return json({ view: "scenario", scenario: body.scenario, rows: board.rows, you, yourBest, players: board.players });
  }

  throw new HttpError(400, "view must be ladder, movers or scenario");
}));

/** Display names for these players, read under the service role. */
async function displayNames(admin: any, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const { data, error } = await admin
      .from("players")
      .select("id, display_name")
      .in("id", unique.slice(i, i + IN_CHUNK));
    if (error) throw new HttpError(500, error.message);
    for (const p of data ?? []) names.set(p.id, p.display_name);
  }
  return names;
}
