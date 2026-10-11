/**
 * find-match under ranked v2. Admin-only while v2 is tested from development builds.
 *
 * The same contract as find-match - same body, same response, a match the same client
 * code plays - with four things changed:
 *
 *   the pool       read nearest-rating-first and originals-only by ranked_pool_rounds,
 *                  instead of the newest 600 sides of any rating, half of them copies
 *   the opponent   judged, and later rated, at the rating they played those rounds at
 *                  (strength "at-play", src/core/rating/ranked.ts)
 *   the match      created with its sides in one transaction that also holds the
 *                  one-open-match rule (open_ranked_match), so a double click cannot
 *                  open two and a failed insert cannot leave a match with no sides
 *   the stakes     what every result would do to the caller's rating, computed by the
 *                  function settlement uses, so the match screen can show it up front
 *
 * And it sweeps with sweepStaleMatchesV2, which settles a finished match nobody settled
 * rather than leaving it open for ever.
 */

import {
  handler,
  INITIAL_TTL_MS,
  isCopiedSide,
  json,
  loadSeasonPool,
  readJson,
  requireCaller,
  requireEligible,
  runSetId,
  seedRatingRow,
  HttpError,
} from "../_shared/apogee.ts";
import { RANKED_V2_ENGINE, requireRankedV2, sweepStaleMatchesV2 } from "../_shared/rankedV2.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

import { selectScenarios } from "../../../src/core/match/scenarioSelection.ts";
import {
  findOpponent,
  RECENT_MATCHES_FOR_VARIETY,
  shouldPlantFresh,
  type MatchmakingCriteria,
  type OpponentBank,
} from "../../../src/core/match/matchmaking.ts";
import type { Rating } from "../../../src/core/rating/glicko2.ts";
import { matchWinProbability, stakes } from "../../../src/core/rating/ranked.ts";

interface Body {
  category: string;
  window: number;
}

const RECENT_OPPONENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Opponents considered per queue, nearest the caller's rating first, and how many of each
 * one's newest sides are read: up to 800 originals, all near the caller. v1 reads 600
 * sides of any rating and discards the copies among them, up to half, since a contested
 * match writes one copy beside the caller's original.
 */
const POOL_PLAYERS = 40;
const SIDES_PER_PLAYER = 20;

Deno.serve(handler(async function findMatchRequest(req, admin, attempt = 0): Promise<Response> {
  const caller = await requireCaller(req, admin);
  await requireRankedV2(admin, caller.playerId);
  await enforceRateLimit(admin, caller.playerId, "find-match-v2");
  const body = await readJson<Body>(req.clone());

  if (!body.category || typeof body.window !== "number" || body.window < 0) {
    throw new HttpError(400, "category and window are required");
  }

  const liveMatch = await sweepStaleMatchesV2(admin, caller.playerId);
  if (liveMatch) return json(await resume(admin, caller.playerId, liveMatch.matchId, liveMatch.match));

  await requireEligible(admin, caller.playerId);
  const { season, windowName, selectable } = await loadSeasonPool(admin, body.window);

  const { data: ratingRow, error: ratingError } = await admin
    .from("ratings")
    .select("rating, rd, volatility")
    .eq("player_id", caller.playerId)
    .maybeSingle();
  if (ratingError) throw new HttpError(500, ratingError.message);

  const rating: Rating = ratingRow
    ? { rating: Number(ratingRow.rating), rd: Number(ratingRow.rd), volatility: Number(ratingRow.volatility) }
    : await seedRatingRow(admin, season.id, season.window_size ?? null, caller.playerId);

  // ---- the pool: nearest players first, originals only -------------------------------
  const { data: candidates, error: poolError } = await admin.rpc("ranked_pool_rounds", {
    p_window: body.window,
    p_caller: caller.playerId,
    p_rating: rating.rating,
    p_players: POOL_PLAYERS,
    p_sides_per_player: SIDES_PER_PLAYER,
  });
  if (poolError) throw new HttpError(500, poolError.message);

  // ---- who and what the caller has already played (as find-match) -------------------
  const { data: myGames, error: gamesError } = await admin
    .from("match_sides")
    .select("match_id, submitted_at, matches!inner(created_at, scenario_ids)")
    .eq("player_id", caller.playerId)
    .not("submitted_at", "is", null)
    .order("submitted_at", { ascending: false })
    .limit(500);
  if (gamesError) throw new HttpError(500, gamesError.message);

  const myPlayed = (myGames ?? []).filter((m: any) => !isCopiedSide(m, m.matches));
  const playedAtByMatch = new Map<string, number>(
    myPlayed.map((m: any) => [m.match_id, new Date(m.submitted_at).getTime()]),
  );
  const playedRecently = new Set<number>(
    myPlayed.slice(0, RECENT_MATCHES_FOR_VARIETY).flatMap((m: any) => (m.matches.scenario_ids ?? []).map(Number)),
  );

  const { data: theirSides, error: theirError } = playedAtByMatch.size
    ? await admin
        .from("match_sides")
        .select("match_id, player_id, run_ids, submitted_at")
        .in("match_id", [...playedAtByMatch.keys()])
        .neq("player_id", caller.playerId)
    : { data: [] as any[], error: null };
  if (theirError) throw new HttpError(500, theirError.message);

  const recentSince = Date.now() - RECENT_OPPONENT_WINDOW_MS;
  const recentOpponentIds = new Set<string>();
  const facedRunIds = new Set<string>();
  const facedSideIds = new Set<string>();
  for (const side of (theirSides ?? []) as { match_id: string; player_id: string; run_ids: string[] | null; submitted_at: string | null }[]) {
    const runIds = side.run_ids ?? [];
    if (runIds.length > 0) for (const id of runIds) facedRunIds.add(id);
    else if (side.submitted_at) facedSideIds.add(runSetId({ player_id: side.player_id, submitted_at: side.submitted_at }));
    if ((playedAtByMatch.get(side.match_id) ?? 0) >= recentSince) recentOpponentIds.add(side.player_id);
  }

  // ---- banks, each round carrying the rating it was played at ------------------------
  const inPool = new Set(selectable.map((s) => s.id));
  const banks = new Map<string, OpponentBank>();
  for (const c of (candidates ?? []) as any[]) {
    let bank = banks.get(c.player_id);
    if (!bank) {
      bank = {
        playerId: c.player_id,
        displayName: c.display_name ?? "player",
        rating: { rating: Number(c.rating), rd: Number(c.rd), volatility: Number(c.volatility) },
        rounds: [],
      };
      banks.set(c.player_id, bank);
    }
    const scenarioIds: number[] = (c.scenario_ids ?? []).map(Number);
    const runIds: string[] = c.run_ids ?? [];
    const deltas: number[] = (c.deltas ?? []).map(Number);
    const scores: number[] = (c.scores ?? []).map(Number);
    for (const [i, scenarioId] of scenarioIds.entries()) {
      if (!inPool.has(scenarioId) || deltas[i] === undefined || scores[i] === undefined) continue;
      bank.rounds.push({
        runId: runIds[i] ?? null,
        scenarioId,
        score: scores[i],
        delta: deltas[i],
        provisional: !!c.provisional,
        difficulty: c.difficulty ?? windowName,
        playedAt: new Date(c.submitted_at),
        sideId: runSetId(c),
        strength: {
          rating: c.rating_before != null ? Number(c.rating_before) : null,
          rd: c.rd_before != null ? Number(c.rd_before) : null,
        },
      });
    }
  }

  const seed = crypto.randomUUID();
  const criteria: MatchmakingCriteria = {
    playerId: caller.playerId,
    rating,
    category: body.category,
    difficulty: windowName,
    pool: selectable,
    seed,
    recentOpponentIds,
    playedRecently,
    facedRunIds,
    facedSideIds,
    strength: "at-play",
  };

  // open_ranked_match refused: another request opened a match first. Once more, which
  // finds it through the sweep and hands it back. Not twice: a match the sweep cannot see
  // but the database still counts would otherwise send this round for ever.
  const retry = (matchId: string) => {
    if (attempt > 0) throw new HttpError(409, `you already have a match in progress (${matchId})`);
    return findMatchRequest(req, admin, attempt + 1);
  };

  const result = findOpponent(criteria, [...banks.values()]);
  const planting = shouldPlantFresh(criteria, result);
  const expiresAt = new Date(Date.now() + INITIAL_TTL_MS).toISOString();
  const byId = new Map(selectable.map((s) => [s.id, s]));
  const matchRow = (scenarioIds: number[]) => ({
    mode: "async",
    category: body.category,
    benchmark_name: season.name,
    difficulty: windowName,
    window_index: body.window,
    seed,
    scenario_ids: scenarioIds,
    expires_at: expiresAt,
    engine: RANKED_V2_ENGINE,
  });

  // ---- nobody suitable, or nothing new to play: a seeding match (find-match says why) ----
  if (!result.candidate || planting) {
    const recentNames = new Set(selectable.filter((s) => playedRecently.has(s.id)).map((s) => s.name));
    const scenarioIds = selectScenarios(selectable, seed, { category: body.category, playedRecently: recentNames })
      .map((s) => s.id);

    const opened = await open(admin, caller.playerId, matchRow(scenarioIds), [
      { player_id: caller.playerId, rating_before: rating.rating, rd_before: rating.rd },
    ]);
    if (!opened.created) return retry(opened.matchId);

    return json({
      matchId: opened.matchId,
      engine: RANKED_V2_ENGINE,
      category: body.category,
      difficulty: windowName,
      expiresAt,
      scenarios: scenarioIds.map((id) => ({ id, name: byId.get(id)?.name ?? `scenario ${id}` })),
      opponent: null,
      seeding: true,
      planting,
      winProbability: null,
      stakes: null,
      poolSize: banks.size,
    });
  }

  // ---- a contested match ----------------------------------------------------------
  const { bank: opponent, rounds, opponentRating } = result.candidate;
  const scenarioIds = rounds.map((r) => r.scenarioId);
  const opponentDeltas = rounds.map((r) => r.delta);
  const copiedAt = new Date(Math.max(...rounds.map((r) => r.playedAt.getTime())));

  const opened = await open(admin, caller.playerId, matchRow(scenarioIds), [
    { player_id: caller.playerId, rating_before: rating.rating, rd_before: rating.rd },
    {
      player_id: opponent.playerId,
      run_ids: rounds.map((r) => r.runId).filter((id): id is string => id !== null),
      deltas: opponentDeltas,
      scores: rounds.map((r) => r.score),
      match_score: opponentDeltas.reduce((sum, d) => sum + d, 0) / opponentDeltas.length,
      provisional: rounds.some((r) => r.provisional),
      // The rating these rounds were played at, which settlement rates the caller against.
      rating_before: opponentRating.rating,
      rd_before: opponentRating.rd,
      submitted_at: copiedAt.toISOString(),
    },
  ]);
  if (!opened.created) return retry(opened.matchId);

  return json({
    matchId: opened.matchId,
    engine: RANKED_V2_ENGINE,
    category: body.category,
    difficulty: windowName,
    expiresAt,
    scenarios: scenarioIds.map((id) => ({ id, name: byId.get(id)?.name ?? `scenario ${id}` })),
    opponent: {
      displayName: opponent.displayName,
      rating: Math.round(opponentRating.rating),
      playedAt: copiedAt.toISOString(),
      provisional: rounds.some((r) => r.provisional),
    },
    winProbability: matchWinProbability(rating, opponentRating),
    stakes: stakes({ before: rating, opponent: opponentRating, rounds: scenarioIds.length }),
    poolSize: banks.size,
  });
}));

async function open(
  admin: any,
  playerId: string,
  match: Record<string, unknown>,
  sides: Record<string, unknown>[],
): Promise<{ created: boolean; matchId: string }> {
  const { data, error } = await admin.rpc("open_ranked_match", { p_player: playerId, p_match: match, p_sides: sides });
  if (error) throw new HttpError(500, error.message);
  if (typeof data?.created !== "boolean" || typeof data?.match_id !== "string") {
    throw new HttpError(500, "open_ranked_match returned no receipt");
  }
  return { created: data.created, matchId: data.match_id };
}

/** The open match handed back, as find-match does, with its stakes when it has an opponent. */
async function resume(admin: any, playerId: string, matchId: string, match: any): Promise<Record<string, unknown>> {
  const ids: number[] = (match.scenario_ids ?? []).map(Number);
  const { data: names } = await admin.from("scenarios").select("id, name").in("id", ids);
  const nameById = new Map((names ?? []).map((s: any) => [Number(s.id), s.name]));

  const { data: sides } = await admin
    .from("match_sides")
    .select("player_id, provisional, rating_before, rd_before, submitted_at, players!inner(display_name)")
    .eq("match_id", matchId);
  const mine = (sides ?? []).find((s: any) => s.player_id === playerId);
  const other = (sides ?? []).find((s: any) => s.player_id !== playerId);

  const { data: ratingRow } = await admin
    .from("ratings").select("rating, rd, volatility").eq("player_id", playerId).maybeSingle();
  const me: Rating = {
    rating: Number(ratingRow?.rating ?? mine?.rating_before ?? 1500),
    rd: Number(ratingRow?.rd ?? mine?.rd_before ?? 350),
    volatility: Number(ratingRow?.volatility ?? 0.06),
  };
  const them: Rating | null = other
    ? { rating: Number(other.rating_before ?? 1500), rd: Number(other.rd_before ?? 350), volatility: 0.06 }
    : null;
  const v2 = match.engine === RANKED_V2_ENGINE;

  return {
    matchId,
    engine: match.engine ?? 1,
    category: match.category,
    difficulty: match.difficulty,
    expiresAt: match.expires_at,
    scenarios: ids.map((id) => ({ id, name: nameById.get(id) ?? `scenario ${id}` })),
    opponent: other
      ? {
          displayName: other.players?.display_name ?? "player",
          rating: Math.round(Number(other.rating_before ?? 1500)),
          playedAt: other.submitted_at ?? match.expires_at,
          provisional: !!other.provisional,
        }
      : null,
    seeding: !other,
    resumed: true,
    winProbability: them && v2 ? matchWinProbability(me, them) : null,
    // Only for a v2 match: a v1 match is rated as one result, and these are per round.
    stakes: them && v2 ? stakes({ before: me, opponent: them, rounds: ids.length }) : null,
    poolSize: null,
  };
}
