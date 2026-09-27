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
import { ANY_CATEGORY, findOpponent, type StoredRunSet } from "../../../src/core/match/matchmaking.ts";
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

  // ---- candidate opponents: settled sides that could be this match ---------------
  //
  // Narrowed to the caller's category unless they asked for Any, which is a wildcard: the
  // match is played on the opponent's own three scenarios, so Any really can be answered
  // by any of them. Filtering it to matches literally recorded as "Any" split the pool
  // seven ways and left the option most people pick with the fewest opponents in it.
  // `findOpponent` applies the same rule again on what comes back, which is where it is
  // stated and tested; this is only the narrowing that keeps the query cheap.
  let candidateQuery = admin
    .from("match_sides")
    .select(
      "match_id, player_id, deltas, match_score, provisional, submitted_at, " +
        "players!inner(display_name), " +
        "matches!inner(category, difficulty, window_index, scenario_ids, benchmark_name, created_at), " +
        "ratings:players!inner(id)",
    )
    .not("match_score", "is", null)
    .neq("player_id", caller.playerId)
    .eq("matches.window_index", body.window)
    // Never a tournament leg. Those run sets were played for one fixture against one named
    // person, and drawing them into the pool would hand a stranger a rated match against a
    // performance its owner agreed to only as unrated.
    .eq("matches.rated", true);

  if (body.category !== ANY_CATEGORY) {
    candidateQuery = candidateQuery.eq("matches.category", body.category);
  }

  const { data: candidates } = await candidateQuery
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

  // Who the caller has faced, and which exact run sets they have already played.
  //
  // Two different questions off one pair of queries. "Faced them lately" is a person and
  // decays - it costs 25 and expires after a week, so a small pool still works. "Played
  // this run set" is not a person and does not decay: a stored side is never consumed, it
  // answers as many callers as draw it, and drawing it twice is the same three scenarios
  // against the same frozen deltas. That is a match whose answer is already known, so it
  // is excluded outright rather than priced.
  //
  // The exclusion is therefore read over the caller's whole history rather than the last
  // week, bounded only to keep the query flat. The candidates above are the 200 most
  // recent sides in this category, so 500 of the caller's own matches covers everything
  // that could be offered several times over.
  const FACED_SCAN = 500;
  const { data: myGames } = await admin
    .from("match_sides")
    .select("match_id, submitted_at, matches!inner(created_at)")
    .eq("player_id", caller.playerId)
    .not("submitted_at", "is", null)
    .order("submitted_at", { ascending: false })
    .limit(FACED_SCAN);

  const playedAtByMatch = new Map<string, number>(
    // Only matches the caller played, not ones a copy of their own run set was drawn into.
    (myGames ?? [])
      .filter((m: any) => !isCopiedSide(m, m.matches))
      .map((m: any) => [m.match_id, new Date(m.submitted_at).getTime()]),
  );

  const { data: theirSides } = playedAtByMatch.size
    ? await admin
        .from("match_sides")
        .select("match_id, player_id, submitted_at")
        .in("match_id", [...playedAtByMatch.keys()])
        .neq("player_id", caller.playerId)
    : { data: [] as { match_id: string; player_id: string; submitted_at: string | null }[] };

  const recentSince = Date.now() - RECENT_OPPONENT_WINDOW_MS;
  const recentOpponentIds = new Set<string>();
  const facedRunSetIds = new Set<string>();

  for (const side of (theirSides ?? []) as { match_id: string; player_id: string; submitted_at: string | null }[]) {
    // What the caller faced was a copy; runSetId names the original it was copied from.
    if (side.submitted_at) facedRunSetIds.add(runSetId({ player_id: side.player_id, submitted_at: side.submitted_at }));
    if ((playedAtByMatch.get(side.match_id) ?? 0) >= recentSince) {
      recentOpponentIds.add(side.player_id);
    }
  }

  // Only run sets played on this pool. The candidate query narrows by window index and
  // category but not by season, so a side banked before the pool was rebuilt was still
  // drawn: its scenario ids were not in `selectable`, the match went out naming them
  // "scenario 947" and the like, and the player was asked to play three scenarios the
  // season no longer has. Membership rather than the season's name, because a rebuilt
  // pool keeps the name.
  const inPool = new Set(selectable.map((s) => s.id));

  const runSets: StoredRunSet[] = (candidates ?? [])
    .filter((c: any) => ratingByPlayer.has(c.player_id))
    .filter((c: any) => {
      const ids: number[] = c.matches.scenario_ids ?? [];
      return ids.length > 0 && ids.every((id) => inPool.has(id));
    })
    // Originals only. Every match answered from the pool holds a copy of the side it drew,
    // and each copy has a match_score, so without this one afternoon's run set multiplied
    // into as many candidates as it had opponents.
    .filter((c: any) => !isCopiedSide(c, c.matches))
    .map((c: any) => ({
      id: runSetId(c),
      playerId: c.player_id,
      displayName: c.players?.display_name ?? "player",
      category: c.matches.category,
      difficulty: c.matches.difficulty ?? windowName,
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
      difficulty: windowName,
      recentOpponentIds,
      facedRunSetIds,
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
      winProbability: null,
      poolSize: runSets.length,
    });
  }

  // ---- create the match ---------------------------------------------------------
  const opponent = result.opponent;
  const seed = crypto.randomUUID();

  // What was actually drawn, which is not always what was asked for.
  //
  // Queueing Any and drawing a Tracking run set is a Tracking match: those are the three
  // scenarios both sides play. Recording it as "Any" would file the caller's own side in
  // a bucket describing nothing, where only another Any queue could ever find it - so the
  // wildcard would keep refilling the bucket it exists to drain. A seeding match stays
  // "Any", because with no opponent its three scenarios genuinely can span categories.
  const playedCategory = opponent.category;

  // Reuse the opponent's scenarios so both sides genuinely played the same three.
  //
  // The fallback draws from the category the match is being recorded as, not the one that
  // was asked for: an Any queue that lands here would otherwise get three scenarios from
  // across the pool while the match claims to be the opponent's single category.
  const scenarioIds: number[] =
    opponent.scenarioIds.length === 3
      ? opponent.scenarioIds
      : selectScenarios(selectable, seed, { category: playedCategory }).map((s) => s.id);

  const expiresAt = new Date(Date.now() + INITIAL_TTL_MS).toISOString();

  const { data: match, error: matchError } = await admin
    .from("matches")
    .insert({
      mode: "async",
      category: playedCategory,
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

  // The caller's side is empty until they play. The opponent's side carries their
  // frozen deltas, which is what makes this an async match rather than a wait.
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
      deltas: opponent.deltas,
      match_score: opponent.matchScore,
      provisional: opponent.provisional,
      rating_before: opponent.rating.rating,
      rd_before: opponent.rating.rd,
      submitted_at: opponent.createdAt.toISOString(),
    },
  ], { defaultToNull: false });

  if (sidesError) throw new HttpError(500, sidesError.message);

  const byId = new Map(selectable.map((s) => [s.id, s]));

  return json({
    matchId: match.id,
    category: playedCategory,
    difficulty: windowName,
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
