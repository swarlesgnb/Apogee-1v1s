/**
 * Challenge a Crown, or claim a vacant one.
 *
 * Hands back a match in the shape find-match returns, so the client stores it, writes the
 * playlist and paints the match panel through the path that already exists. `crown` is the
 * only addition, as `duel` and `tournament` were.
 *
 * WHAT THE REQUEST MAY NAME
 *
 * The Crown: a category and a band. Not the scenarios, the seed, the holder, a score or
 * anything about a result. The Crown's cycle says what the three are (drawn here only when
 * a cycle has none yet), the Crown's live reign says who the opponent is, and the holder's
 * run set is copied into the match in SQL (`crown_open_challenge`). Nothing about the
 * holder's result passes through this function on its way in.
 *
 * Unrated, and never drawn into the ranked pool: the match is created with
 * `rated = false`, the path tournaments already use.
 */

import {
  handler,
  HttpError,
  INITIAL_TTL_MS,
  json,
  readJson,
  requireCaller,
  requireEligible,
  sweepStaleMatches,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { matchClock, recordMatchClock } from "../_shared/timeIntegrity.ts";
import {
  namesFor,
  onlyFields,
  requireCategory,
  requireWindow,
  scenarioNamesFor,
  seasonCells,
  sqlRefusal,
} from "../_shared/arena.ts";

import { selectScenarios } from "../../../src/core/match/scenarioSelection.ts";
import { updateRating } from "../../../src/core/rating/glicko2.ts";
import {
  CHALLENGE_COOLDOWN_MS,
  canChallenge,
  crownName,
  REIGN_CAP_MS,
  type CrownState,
} from "../../../src/core/crowns/crowns.ts";

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "challenge-crown");

  const body = onlyFields(await readJson<unknown>(req), ["category", "window", "tzOffsetMinutes"]);
  const category = requireCategory(body.category);
  const window = requireWindow(body.window);

  const { season, bands, pools, cells } = await seasonCells(admin);
  if (!cells.some((c) => c.category === category && c.window === window)) {
    throw new HttpError(404, `${season} has no ${category} Crown in that band.`);
  }
  const band = bands[window] ?? `Band ${window + 1}`;
  const pool = pools.get(window) ?? [];

  // Retire this player's expired matches by the ordinary rule. A live one is either this
  // very challenge (handed back by crown_open_challenge) or something else, which blocks.
  await sweepStaleMatches(admin, caller.playerId, updateRating);

  await requireEligible(admin, caller.playerId);

  // A Crown whose scenarios the season no longer has cannot be played. Reset it first, so
  // the challenge below opens a new cycle instead of a match nobody can launch.
  const { data: crownRow, error: crownError } = await admin
    .from("crowns")
    .select("cycle, scenario_ids, reign_id")
    .eq("category", category)
    .eq("window_index", window)
    .maybeSingle();
  if (crownError) throw new HttpError(500, crownError.message);
  if (crownRow?.scenario_ids) {
    const inPool = new Set(pool.map((s) => s.id));
    if (!(crownRow.scenario_ids as number[]).every((id) => inPool.has(Number(id)))) {
      await admin.rpc("crown_reset_off_pool", { p_category: category, p_window: window, p_cycle: crownRow.cycle });
    }
  }

  // The friendly refusal, asked before the SQL asks again under the lock. The two say the
  // same thing; this one can say when the cooldown ends in the player's own words.
  // A reign past the cap is about to lapse inside crown_open_challenge, and its holder may
  // claim the new cycle like anybody else, so it is not counted as held here.
  let holderId: string | null = null;
  if (crownRow?.reign_id) {
    const { data: reign } = await admin
      .from("crown_reigns")
      .select("holder_id, started_at")
      .eq("id", crownRow.reign_id)
      .maybeSingle();
    if (reign && Date.now() - Date.parse(reign.started_at) < REIGN_CAP_MS) holderId = reign.holder_id;
  }
  const { data: recent } = await admin
    .from("crown_challenges")
    .select("created_at, decided_at")
    .eq("challenger_id", caller.playerId)
    .eq("category", category)
    .eq("window_index", window)
    .order("created_at", { ascending: false })
    .limit(1);
  const last = (recent ?? [])[0];
  const state: CrownState = {
    category, window, cycle: Number(crownRow?.cycle ?? 0), scenarioIds: null,
    reign: holderId
      ? { id: crownRow!.reign_id, holderId, matchId: "", matchScore: 0, startedAt: 0, defences: 0, challenges: 0, defeated: [], lowestTier: "consistent", provisional: false }
      : null,
  };
  // Only a decided challenge is counted here. An undecided one may be the match this request
  // is about to hand back; the SQL tells a resume from a spent cooldown under the lock.
  const pre = canChallenge(state, caller.playerId, last && last.decided_at ? Date.parse(last.created_at) : null, Date.now(), false);
  if (!pre.ok) throw new HttpError(pre.code === "cooldown" ? 429 : 409, pre.reason);

  const seed = crypto.randomUUID();
  const drawn = selectScenarios(pool, seed, { category }).map((s) => s.id);
  // The caller's UTC offset, checked against their recent uploads before a match exists, and
  // pinned to the side crown_open_challenge writes (see _shared/timeIntegrity.ts).
  const clock = await matchClock(admin, caller.playerId, body);

  const { data: opened, error } = await admin.rpc("crown_open_challenge", {
    p_category: category,
    p_window: window,
    p_player: caller.playerId,
    p_seed: seed,
    p_scenarios: drawn,
    p_benchmark: season,
    p_difficulty: band,
    p_ttl_seconds: Math.round(INITIAL_TTL_MS / 1000),
    p_cooldown_seconds: Math.round(CHALLENGE_COOLDOWN_MS / 1000),
    p_reign_cap_seconds: Math.round(REIGN_CAP_MS / 1000),
  });
  if (error) throw sqlRefusal(error);
  const { matchId, created, claim } = opened as { matchId: string; created: boolean; claim: boolean };
  await recordMatchClock(admin, matchId, caller.playerId, clock);

  const { data: match } = await admin
    .from("matches")
    .select("id, status, category, difficulty, scenario_ids, expires_at")
    .eq("id", matchId)
    .maybeSingle();
  if (!match) throw new HttpError(500, "the challenge's match is missing");

  const ids: number[] = (match.scenario_ids ?? []).map(Number);
  const names = await scenarioNamesFor(admin, ids);

  // The holder's copied side: who played it and when, the fields find-match hands over for
  // a stored run set, plus the bar the board already shows publicly. Not their rounds.
  const { data: sides } = await admin
    .from("match_sides")
    .select("player_id, match_score, rating_before, provisional, submitted_at")
    .eq("match_id", matchId);
  const theirs = (sides ?? []).find((s: any) => s.player_id !== caller.playerId) ?? null;
  const holderName = theirs ? (await namesFor(admin, [theirs.player_id])).get(theirs.player_id) ?? "the holder" : null;

  return json({
    matchId,
    category: match.category,
    difficulty: match.difficulty,
    expiresAt: match.expires_at,
    scenarios: ids.map((id) => ({ id, name: names.get(id) ?? `scenario ${id}` })),
    opponent: theirs
      ? {
          displayName: holderName,
          rating: Math.round(Number(theirs.rating_before ?? 1500)),
          playedAt: theirs.submitted_at,
          provisional: !!theirs.provisional,
        }
      : null,
    seeding: claim,
    resumed: !created,
    winProbability: null,
    poolSize: null,
    crown: {
      category,
      window,
      band,
      name: crownName(category, band),
      claim,
      holderName,
      bar: theirs?.match_score == null ? null : Number(theirs.match_score),
    },
  });
}));
