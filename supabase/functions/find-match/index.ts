/**
 * Create a match for the caller.
 *
 * Asynchronous by design (PLAN.md §6): the opponent is a **stored run set** from
 * someone near the caller's rating, whose deltas were computed and frozen when they
 * played. This is what makes the ladder playable with one person online, which is the
 * difference between a launch that survives week one and a queue nobody ever sees fill.
 *
 * Two things are decided here and never by the client:
 *
 *   the opponent    chosen by rating proximity, so a client cannot shop for a weak one
 *   the scenarios   derived from a server-generated seed, so they cannot be rerolled
 */

import {
  handler,
  json,
  readJson,
  requireCaller,
  HttpError,
} from "../_shared/apogee.ts";

import { selectScenarios, type SelectableScenario } from "../../../src/core/match/scenarioSelection.ts";
import { findOpponent, type StoredRunSet } from "../../../src/core/match/matchmaking.ts";
import { defaultRating, winProbability, type Rating } from "../../../src/core/rating/glicko2.ts";

interface Body {
  /** A skill, a sub-category, or "Any". */
  category: string;
  difficulty: string;
  benchmarkName?: string;
}

/** How long a player has to complete a match before it expires. */
const MATCH_TTL_MS = 6 * 60 * 60 * 1000;

/** Opponents faced this recently are deprioritised, so the ladder feels bigger. */
const RECENT_OPPONENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  const body = await readJson<Body>(req);

  const benchmarkName = body.benchmarkName ?? "Voltaic S5";
  if (!body.category || !body.difficulty) {
    throw new HttpError(400, "category and difficulty are required");
  }

  // Refuse to stack matches. Without this a player could open several, cherry-pick the
  // one that went well, and abandon the rest.
  const { data: openMatches } = await admin
    .from("match_sides")
    .select("match_id, matches!inner(id, status, category, difficulty, scenario_ids, expires_at)")
    .eq("player_id", caller.playerId)
    .in("matches.status", ["open", "awaiting_runs"]);

  // Retire anything past its TTL first.
  //
  // Nothing else does this. Matches were given an expires_at and then nobody ever acted
  // on it, so a match the player walked away from blocked the queue permanently rather
  // than for six hours - the guard above asks only for the status, and the status never
  // changed on its own. Expiry is not a decision the player made, so it costs nothing.
  const now = Date.now();
  const stale = (openMatches ?? []).filter((row: any) => {
    const expiresAt = row.matches?.expires_at;
    return expiresAt != null && new Date(expiresAt).getTime() < now;
  });

  if (stale.length > 0) {
    await admin
      .from("matches")
      .update({ status: "void", settled_at: new Date().toISOString() })
      .in("id", stale.map((row: any) => row.match_id));
  }

  const staleIds = new Set(stale.map((row: any) => row.match_id));
  const liveMatch = (openMatches ?? []).find((row: any) => !staleIds.has(row.match_id));

  if (liveMatch) {
    return json(
      {
        error: "you already have a match in progress",
        matchId: liveMatch.match_id,
        canAbandon: true,
      },
      409,
    );
  }

  // ---- the scenario pool for this benchmark difficulty -------------------------
  const { data: pool, error: poolError } = await admin
    .from("benchmark_scenarios")
    .select("scenario_id, scenarios!inner(id, name, aim_type, sub_category)")
    .eq("benchmark_name", benchmarkName)
    .eq("difficulty", body.difficulty);

  if (poolError) throw new HttpError(500, poolError.message);

  const selectable: SelectableScenario[] = (pool ?? []).map((row: any) => ({
    id: row.scenarios.id,
    name: row.scenarios.name,
    aimType: row.scenarios.aim_type,
    subCategory: row.scenarios.sub_category,
  }));

  if (selectable.length === 0) {
    throw new HttpError(404, `no scenarios for ${benchmarkName} ${body.difficulty}`);
  }

  // ---- the caller's rating ------------------------------------------------------
  const { data: ratingRow } = await admin
    .from("ratings")
    .select("rating, rd, volatility")
    .eq("player_id", caller.playerId)
    .maybeSingle();

  const rating: Rating = ratingRow
    ? {
        rating: Number(ratingRow.rating),
        rd: Number(ratingRow.rd),
        volatility: Number(ratingRow.volatility),
      }
    : defaultRating();

  // ---- candidate opponents: settled sides in the same category ------------------
  const { data: candidates } = await admin
    .from("match_sides")
    .select(
      "match_id, player_id, deltas, match_score, provisional, submitted_at, " +
        "players!inner(display_name), " +
        "matches!inner(category, difficulty, scenario_ids, benchmark_name), " +
        "ratings:players!inner(id)",
    )
    .not("match_score", "is", null)
    .neq("player_id", caller.playerId)
    .eq("matches.category", body.category)
    .eq("matches.difficulty", body.difficulty)
    .order("submitted_at", { ascending: false })
    .limit(200);

  // Ratings for those opponents, fetched separately to keep the join simple.
  const opponentIds = [...new Set((candidates ?? []).map((c: any) => c.player_id))];
  const ratingByPlayer = new Map<string, Rating>();
  if (opponentIds.length > 0) {
    const { data: rs } = await admin
      .from("ratings")
      .select("player_id, rating, rd, volatility")
      .in("player_id", opponentIds);
    for (const r of rs ?? []) {
      ratingByPlayer.set(r.player_id, {
        rating: Number(r.rating),
        rd: Number(r.rd),
        volatility: Number(r.volatility),
      });
    }
  }

  // Who the caller has faced lately.
  const since = new Date(Date.now() - RECENT_OPPONENT_WINDOW_MS).toISOString();
  const { data: recentMine } = await admin
    .from("match_sides")
    .select("match_id")
    .eq("player_id", caller.playerId)
    .gte("submitted_at", since);

  const recentMatchIds = new Set((recentMine ?? []).map((m: any) => m.match_id));
  const { data: recentOpponents } = recentMatchIds.size
    ? await admin
        .from("match_sides")
        .select("player_id")
        .in("match_id", [...recentMatchIds])
        .neq("player_id", caller.playerId)
    : { data: [] as { player_id: string }[] };

  const recentOpponentIds = new Set((recentOpponents ?? []).map((r: any) => r.player_id));

  const runSets: StoredRunSet[] = (candidates ?? [])
    .filter((c: any) => ratingByPlayer.has(c.player_id))
    .map((c: any) => ({
      id: `${c.match_id}:${c.player_id}`,
      playerId: c.player_id,
      displayName: c.players?.display_name ?? "player",
      category: c.matches.category,
      difficulty: c.matches.difficulty,
      scenarioIds: c.matches.scenario_ids ?? [],
      deltas: (c.deltas ?? []).map(Number),
      matchScore: Number(c.match_score),
      rating: ratingByPlayer.get(c.player_id)!,
      createdAt: new Date(c.submitted_at),
      provisional: !!c.provisional,
    }));

  const result = findOpponent(
    {
      playerId: caller.playerId,
      rating,
      category: body.category,
      difficulty: body.difficulty,
      recentOpponentIds,
    },
    runSets,
  );

  // ---- nobody to play: hand out a seeding match ---------------------------------
  //
  // An empty pool used to return 404 and create nothing, which told the player to "play
  // this category once" without ever saying which three scenarios, and gave their runs
  // no match to attach to. The pool could therefore never receive its first entry, and
  // on a ladder that ships async-first (PLAN.md §6) that is the difference between a
  // cold start and no start.
  //
  // So a match is created with one side. The player plays the same three scenarios they
  // would have played against somebody, their deltas are computed and frozen the same
  // way, and that side becomes a candidate opponent for the next player: the candidate
  // query asks only for a side with a match_score, not for a settled match.
  //
  // Nothing is contested, so nothing is rated. Settlement sees a match with no opponent
  // side and records it without touching the ladder.
  if (!result.opponent) {
    const seed = crypto.randomUUID();
    const scenarioIds = selectScenarios(selectable, seed, {
      category: body.category,
    }).map((s) => s.id);

    const { data: seedMatch, error: seedError } = await admin
      .from("matches")
      .insert({
        mode: "async",
        category: body.category,
        benchmark_name: benchmarkName,
        difficulty: body.difficulty,
        seed,
        scenario_ids: scenarioIds,
        status: "awaiting_runs",
        expires_at: new Date(Date.now() + MATCH_TTL_MS).toISOString(),
      })
      .select("id")
      .maybeSingle();

    if (seedError || !seedMatch) {
      throw new HttpError(500, seedError?.message ?? "could not create a seeding match");
    }

    const { error: seedSideError } = await admin.from("match_sides").insert([
      {
        match_id: seedMatch.id,
        player_id: caller.playerId,
        rating_before: rating.rating,
        rd_before: rating.rd,
      },
    ]);

    if (seedSideError) throw new HttpError(500, seedSideError.message);

    const seedById = new Map(selectable.map((s) => [s.id, s]));

    return json({
      matchId: seedMatch.id,
      category: body.category,
      difficulty: body.difficulty,
      expiresAt: new Date(Date.now() + MATCH_TTL_MS).toISOString(),
      scenarios: scenarioIds.map((id) => ({
        id,
        name: seedById.get(id)?.name ?? `scenario ${id}`,
      })),
      opponent: null,
      seeding: true,
      winProbability: null,
      poolSize: runSets.length,
    });
  }

  // ---- create the match ---------------------------------------------------------
  const opponent = result.opponent;
  const seed = crypto.randomUUID();

  // Reuse the opponent's scenarios so both sides genuinely played the same three.
  const scenarioIds: number[] =
    opponent.scenarioIds.length === 3
      ? opponent.scenarioIds
      : selectScenarios(selectable, seed, { category: body.category }).map((s) => s.id);

  const expiresAt = new Date(Date.now() + MATCH_TTL_MS).toISOString();

  const { data: match, error: matchError } = await admin
    .from("matches")
    .insert({
      mode: "async",
      category: body.category,
      benchmark_name: benchmarkName,
      difficulty: body.difficulty,
      seed,
      scenario_ids: scenarioIds,
      status: "awaiting_runs",
      expires_at: expiresAt,
    })
    .select("id")
    .maybeSingle();

  if (matchError || !match) throw new HttpError(500, matchError?.message ?? "could not create match");

  // The caller's side is empty until they play. The opponent's side carries their
  // frozen deltas, which is what makes this an async match rather than a wait.
  const { error: sidesError } = await admin.from("match_sides").insert([
    { match_id: match.id, player_id: caller.playerId, rating_before: rating.rating, rd_before: rating.rd },
    {
      match_id: match.id,
      player_id: opponent.playerId,
      deltas: opponent.deltas,
      match_score: opponent.matchScore,
      provisional: opponent.provisional,
      rating_before: opponent.rating.rating,
      rd_before: opponent.rating.rd,
      submitted_at: opponent.createdAt.toISOString(),
    },
  ]);

  if (sidesError) throw new HttpError(500, sidesError.message);

  const byId = new Map(selectable.map((s) => [s.id, s]));

  return json({
    matchId: match.id,
    category: body.category,
    difficulty: body.difficulty,
    expiresAt,
    scenarios: scenarioIds.map((id) => ({ id, name: byId.get(id)?.name ?? `scenario ${id}` })),
    opponent: {
      displayName: opponent.displayName,
      rating: Math.round(opponent.rating.rating),
      playedAt: opponent.createdAt.toISOString(),
      provisional: opponent.provisional,
    },
    winProbability: winProbability(rating, opponent.rating),
    poolSize: runSets.length,
  });
}));
