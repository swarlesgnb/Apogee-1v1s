/**
 * Create a match for the caller.
 *
 * Asynchronous by design (PLAN.md §6): the opponent is **stored rounds** from someone
 * near the caller's rating, each one an attempt whose delta was computed and frozen when
 * they played it. This is what makes the ladder playable with one person online, which is the
 * difference between a launch that survives week one and a queue nobody ever sees fill.
 *
 * Two things are decided here and never by the client:
 *
 *   the opponent    chosen by rating proximity, so a client cannot shop for a weak one
 *   the scenarios   drawn from the opponent's rounds by a server-generated seed, so
 *                   they cannot be rerolled
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
  sweepStaleMatches,
  HttpError,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

import { selectScenarios } from "../../../src/core/match/scenarioSelection.ts";
import {
  findOpponent,
  RECENT_MATCHES_FOR_VARIETY,
  shouldPlantFresh,
  type OpponentBank,
} from "../../../src/core/match/matchmaking.ts";
import { defaultRating, updateRating, winProbability, type Rating } from "../../../src/core/rating/glicko2.ts";

interface Body {
  /** A skill, a sub-category, or "Any". */
  category: string;
  /**
   * Which window of the season pool to draw from, 0-based.
   *
   * An index rather than a name: windows are renameable from the season editor, and
   * partitioning matchmaking on a name would silently stop new matches pairing with every
   * run set already banked under the old one.
   */
  window: number;
}

/** Opponents faced this recently are deprioritised, so the ladder feels bigger. */
const RECENT_OPPONENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "find-match");
  const body = await readJson<Body>(req);

  if (!body.category || typeof body.window !== "number" || body.window < 0) {
    throw new HttpError(400, "category and window are required");
  }

  // One match at a time, and anything past its deadline retired first. Both live in
  // sweepStaleMatches now, because duels start matches too and the rule has to be the
  // same rule in all three places.
  const liveMatch = await sweepStaleMatches(admin, caller.playerId, updateRating);

  // Already in a match: hand that one back rather than refusing.
  //
  // This used to be a 409 carrying an error string, and the client threw the payload
  // away, so a player whose app had restarted saw "you already have a match in
  // progress" with no way to see or leave it - the abandon button lives on the match
  // panel, and the panel only appears when the client knows about a match. Returning
  // the match is also just the honest answer: you asked for one, you have one.
  if (liveMatch) {
    const existing = liveMatch.match;
    const existingIds: number[] = existing.scenario_ids ?? [];

    const { data: names } = await admin
      .from("scenarios")
      .select("id, name")
      .in("id", existingIds);

    const nameById = new Map((names ?? []).map((s: any) => [s.id, s.name]));

    const { data: existingSides } = await admin
      .from("match_sides")
      .select("player_id, match_score, provisional, rating_before, submitted_at, players!inner(display_name)")
      .eq("match_id", liveMatch.matchId);

    const other = (existingSides ?? []).find((s: any) => s.player_id !== caller.playerId);

    return json({
      matchId: liveMatch.matchId,
      category: existing.category,
      difficulty: existing.difficulty,
      expiresAt: existing.expires_at,
      scenarios: existingIds.map((id) => ({ id, name: nameById.get(id) ?? `scenario ${id}` })),
      opponent: other
        ? {
            displayName: (other as any).players?.display_name ?? "player",
            rating: Math.round(Number(other.rating_before ?? 1500)),
            playedAt: other.submitted_at ?? existing.expires_at,
            provisional: !!other.provisional,
          }
        : null,
      seeding: !other,
      resumed: true,
      winProbability: null,
      // Not counted on this path: the pool is only searched when looking for a new
      // opponent, and reporting a number we did not measure would be worse than none.
      poolSize: null,
    });
  }

  // ---- may this account queue at all? --------------------------------------------
  //
  // Deliberately below the resume path: a player already in a match gets it back
  // whatever their history says, because refusing there would strand them in a match
  // they cannot see or abandon. What the bar is and why is in requireEligible.
  await requireEligible(admin, caller.playerId);

  const { season, windowName, selectable } = await loadSeasonPool(admin, body.window);

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

  // ---- candidate opponents: every ranked round somebody left behind ---------------
  //
  // Read as rounds, not as matches. A match used to be answered with one stored side
  // whole, scenarios and all, and the caller's own side then carried those scenarios
  // back into the pool, so a category's first set of three was what everybody in it
  // played from then on (matchmaking.ts). Now each stored side is split into its three
  // rounds, the rounds are pooled per player, and the three a match is played on are
  // drawn from that player's whole bank.
  //
  // Not narrowed by the category a match was recorded under: a round on a Static
  // Clicking scenario answers a Clicking queue whether it was first played from a
  // Clicking, Static Clicking or Any queue. Category is a property of the scenario, and
  // offerableRounds reads it from the season pool. The window still narrows here, and
  // the limit is wider than it was for that reason.
  const { data: candidates } = await admin
    .from("match_sides")
    .select(
      "match_id, player_id, run_ids, deltas, scores, provisional, submitted_at, " +
        "players!inner(display_name), " +
        "matches!inner(difficulty, window_index, scenario_ids, created_at)",
    )
    .not("match_score", "is", null)
    .neq("player_id", caller.playerId)
    .eq("matches.window_index", body.window)
    // Never a tournament leg. Those rounds were played for one fixture against one named
    // person, and drawing them into the pool would hand a stranger a rated match against a
    // performance its owner agreed to only as unrated.
    .eq("matches.rated", true)
    .order("submitted_at", { ascending: false })
    .limit(600);

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

  // Who the caller has faced, which rounds they have already played against, and which
  // scenarios they have just played.
  //
  // "Faced them lately" is a person and decays - it costs 25 and expires after a week, so
  // a small pool still works. "Played this round" is not a person and does not decay: a
  // stored round is never consumed, and drawing it twice is the same attempt against the
  // same frozen delta, a round whose answer is already known. So it is excluded outright,
  // read over the caller's whole history rather than the last week, bounded only to keep
  // the query flat.
  const FACED_SCAN = 500;
  const { data: myGames } = await admin
    .from("match_sides")
    .select("match_id, submitted_at, matches!inner(created_at, scenario_ids)")
    .eq("player_id", caller.playerId)
    .not("submitted_at", "is", null)
    .order("submitted_at", { ascending: false })
    .limit(FACED_SCAN);

  // Only matches the caller played, not ones a copy of their own rounds was drawn into.
  const myPlayed = (myGames ?? []).filter((m: any) => !isCopiedSide(m, m.matches));

  const playedAtByMatch = new Map<string, number>(
    myPlayed.map((m: any) => [m.match_id, new Date(m.submitted_at).getTime()]),
  );

  // What the caller just played. Already newest first, so the head of the list is it.
  const playedRecently = new Set<number>(
    myPlayed
      .slice(0, RECENT_MATCHES_FOR_VARIETY)
      .flatMap((m: any) => (m.matches.scenario_ids ?? []) as number[]),
  );

  const { data: theirSides } = playedAtByMatch.size
    ? await admin
        .from("match_sides")
        .select("match_id, player_id, run_ids, submitted_at")
        .in("match_id", [...playedAtByMatch.keys()])
        .neq("player_id", caller.playerId)
    : { data: [] as { match_id: string; player_id: string; run_ids: string[] | null; submitted_at: string | null }[] };

  const recentSince = Date.now() - RECENT_OPPONENT_WINDOW_MS;
  const recentOpponentIds = new Set<string>();
  const facedRunIds = new Set<string>();
  const facedSideIds = new Set<string>();

  for (const side of (theirSides ?? []) as { match_id: string; player_id: string; run_ids: string[] | null; submitted_at: string | null }[]) {
    const runIds = side.run_ids ?? [];
    if (runIds.length > 0) {
      for (const id of runIds) facedRunIds.add(id);
    } else if (side.submitted_at) {
      // A copy written before copies recorded their run ids. All that survives of what it
      // was copied from is the original's identity, so the whole original is excluded,
      // which is what the exclusion meant when it was written.
      facedSideIds.add(runSetId({ player_id: side.player_id, submitted_at: side.submitted_at }));
    }
    if ((playedAtByMatch.get(side.match_id) ?? 0) >= recentSince) {
      recentOpponentIds.add(side.player_id);
    }
  }

  // Only rounds played on this pool. The candidate query narrows by window index but not
  // by season, so a round banked before the pool was rebuilt could otherwise be drawn,
  // and the match would go out naming "scenario 947" and the like. Membership rather than
  // the season's name, because a rebuilt pool keeps the name.
  const inPool = new Set(selectable.map((s) => s.id));

  const banks = new Map<string, OpponentBank>();
  for (const c of (candidates ?? []) as any[]) {
    if (!ratingByPlayer.has(c.player_id)) continue;
    // Originals only. Every match answered from the pool holds a copy of the rounds it
    // drew, and each copy has a match_score, so without this one afternoon's rounds would
    // multiply into as many entries as they had opponents.
    if (isCopiedSide(c, c.matches)) continue;

    const scenarioIds: number[] = c.matches.scenario_ids ?? [];
    const runIds: string[] = c.run_ids ?? [];
    const deltas: number[] = (c.deltas ?? []).map(Number);
    // Empty for a side whose runs could not be found when scores were backfilled
    // (migration 20261005000023). Those rounds cannot be decided, so they are not offered.
    const scores: number[] = (c.scores ?? []).map(Number);

    let bank = banks.get(c.player_id);
    if (!bank) {
      bank = {
        playerId: c.player_id,
        displayName: c.players?.display_name ?? "player",
        rating: ratingByPlayer.get(c.player_id)!,
        rounds: [],
      };
      banks.set(c.player_id, bank);
    }

    for (const [i, scenarioId] of scenarioIds.entries()) {
      if (!inPool.has(scenarioId) || deltas[i] === undefined || scores[i] === undefined) continue;
      bank.rounds.push({
        runId: runIds[i] ?? null,
        scenarioId,
        score: scores[i],
        delta: deltas[i],
        provisional: !!c.provisional,
        difficulty: c.matches.difficulty ?? windowName,
        playedAt: new Date(c.submitted_at),
        sideId: runSetId(c),
      });
    }
  }

  const seed = crypto.randomUUID();
  const criteria = {
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
  };

  const result = findOpponent(criteria, [...banks.values()]);

  // ---- nobody to play, or nobody with anything new: hand out a seeding match ---------
  //
  // An empty pool used to return 404 and create nothing, which told the player to "play
  // this category once" without ever saying which three scenarios, and gave their runs
  // no match to attach to. The pool could therefore never receive its first entry, and
  // on a ladder that ships async-first (PLAN.md §6) that is the difference between a
  // cold start and no start.
  //
  // So a match is created with one side. The player plays the same three scenarios they
  // would have played against somebody, their deltas are computed and frozen the same
  // way, and those rounds become candidates for the next player: the candidate query asks
  // only for a side with a match_score, not for a settled match.
  //
  // The same path plants fresh scenarios. A bank only ever holds scenarios its owner was
  // handed, so without this the scenarios in circulation would be whatever the first
  // seeding matches happened to draw. When the best opponent could offer little but what
  // the caller just played, and the window has better, a seeding match drawn away from
  // the recent ones is the better answer (shouldPlantFresh).
  //
  // Nothing is contested, so nothing is rated. Settlement sees a match with no opponent
  // side and records it without touching the ladder.
  const planting = shouldPlantFresh(criteria, result);

  if (!result.candidate || planting) {
    const recentNames = new Set(selectable.filter((s) => playedRecently.has(s.id)).map((s) => s.name));
    const scenarioIds = selectScenarios(selectable, seed, {
      category: body.category,
      playedRecently: recentNames,
    }).map((s) => s.id);

    const { data: seedMatch, error: seedError } = await admin
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
      difficulty: windowName,
      expiresAt: new Date(Date.now() + INITIAL_TTL_MS).toISOString(),
      scenarios: scenarioIds.map((id) => ({
        id,
        name: seedById.get(id)?.name ?? `scenario ${id}`,
      })),
      opponent: null,
      seeding: true,
      // Says why there is no opponent when there could have been one, so the client is
      // not left to guess that the pool was empty.
      planting,
      winProbability: null,
      poolSize: banks.size,
    });
  }

  // ---- create the match ---------------------------------------------------------
  const { bank: opponent, rounds } = result.candidate;
  const scenarioIds = rounds.map((r) => r.scenarioId);
  const opponentDeltas = rounds.map((r) => r.delta);

  // The latest of the rounds it was assembled from. Every one was played before this
  // match exists, so isCopiedSide still recognises the side as a copy.
  const copiedAt = new Date(Math.max(...rounds.map((r) => r.playedAt.getTime())));

  const expiresAt = new Date(Date.now() + INITIAL_TTL_MS).toISOString();

  const { data: match, error: matchError } = await admin
    .from("matches")
    .insert({
      mode: "async",
      // What was asked for. The three scenarios are all in it by construction, and an
      // Any match may now genuinely span categories, as a seeding Any match always has.
      category: body.category,
      benchmark_name: season.name,
      difficulty: windowName,
      window_index: body.window,
      seed,
      scenario_ids: scenarioIds,
      status: "awaiting_runs",
      expires_at: expiresAt,
    })
    .select("id")
    .maybeSingle();

  if (matchError || !match) throw new HttpError(500, matchError?.message ?? "could not create match");

  // The caller's side is empty until they play. The opponent's side carries the frozen
  // rounds it was assembled from, which is what makes this an async match rather than a
  // wait. Their run ids travel with it, so the caller is never offered those runs again.
  //
  // `defaultToNull: false` because the two rows have different keys. PostgREST takes the
  // union of the columns for a bulk insert and, by default, fills a key a row lacks with
  // NULL rather than the column default, so the caller's side arrived with deltas and
  // provisional NULL against their NOT NULL constraints. Every seeding match is a
  // one-row insert, which is why this passed until the first two players met.
  const { error: sidesError } = await admin.from("match_sides").insert([
    { match_id: match.id, player_id: caller.playerId, rating_before: rating.rating, rd_before: rating.rd },
    {
      match_id: match.id,
      player_id: opponent.playerId,
      run_ids: rounds.map((r) => r.runId).filter((id): id is string => id !== null),
      deltas: opponentDeltas,
      scores: rounds.map((r) => r.score),
      match_score: opponentDeltas.reduce((sum, d) => sum + d, 0) / opponentDeltas.length,
      provisional: rounds.some((r) => r.provisional),
      rating_before: opponent.rating.rating,
      rd_before: opponent.rating.rd,
      submitted_at: copiedAt.toISOString(),
    },
  ], { defaultToNull: false });

  if (sidesError) throw new HttpError(500, sidesError.message);

  const byId = new Map(selectable.map((s) => [s.id, s]));

  return json({
    matchId: match.id,
    category: body.category,
    difficulty: windowName,
    expiresAt,
    scenarios: scenarioIds.map((id) => ({ id, name: byId.get(id)?.name ?? `scenario ${id}` })),
    opponent: {
      displayName: opponent.displayName,
      rating: Math.round(opponent.rating.rating),
      playedAt: copiedAt.toISOString(),
      provisional: rounds.some((r) => r.provisional),
    },
    winProbability: winProbability(rating, opponent.rating),
    poolSize: banks.size,
  });
}));
