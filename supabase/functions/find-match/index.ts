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
  forfeitMatch,
  IDLE_ALLOWANCE_MS,
  LAUNCH_ALLOWANCE_MS,
  handler,
  json,
  readJson,
  requireCaller,
  HttpError,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

import { selectScenarios, type SelectableScenario } from "../../../src/core/match/scenarioSelection.ts";
import { ANY_CATEGORY, findOpponent, type StoredRunSet } from "../../../src/core/match/matchmaking.ts";
import {
  eligibilityMessage,
  MIN_RUNS_TO_QUEUE,
  queueEligibility,
} from "../../../src/core/match/eligibility.ts";
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

/**
 * How long a new match has before it expires, if nothing is ever played.
 *
 * Not a total for the match: submit-run pushes the deadline forward every time a run
 * lands, so this is only the allowance for getting the first one done, and it carries
 * the extra time a cold start of Steam and the game can need. See IDLE_ALLOWANCE_MS.
 */
const INITIAL_TTL_MS = IDLE_ALLOWANCE_MS + LAUNCH_ALLOWANCE_MS;

/** Opponents faced this recently are deprioritised, so the ladder feels bigger. */
const RECENT_OPPONENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "find-match");
  const body = await readJson<Body>(req);

  if (!body.category || typeof body.window !== "number" || body.window < 0) {
    throw new HttpError(400, "category and window are required");
  }

  // Refuse to stack matches. Without this a player could open several, cherry-pick the
  // one that went well, and abandon the rest.
  const { data: openMatches } = await admin
    .from("match_sides")
    .select("match_id, matches!inner(id, status, category, difficulty, scenario_ids, expires_at)")
    .eq("player_id", caller.playerId)
    .in("matches.status", ["open", "awaiting_runs"]);

  // Retire anything past its deadline first.
  //
  // Nothing else does this. Matches were given an expires_at and then nobody ever acted
  // on it, so a match the player walked away from blocked the queue permanently rather
  // than until it expired: the guard above reads only the status, and the status never
  // changed on its own.
  const now = Date.now();
  const stale = (openMatches ?? []).filter((row: any) => {
    const expiresAt = row.matches?.expires_at;
    return expiresAt != null && new Date(expiresAt).getTime() < now;
  });

  // Running out of time is a forfeit, not a free pass.
  //
  // It used to void, which was right when a match lasted six hours: expiry meant the
  // player had forgotten, not decided. At five minutes it means they did not finish,
  // and if that costs nothing then waiting out the clock is strictly cheaper than
  // pressing Abandon - so the button that costs a loss would never be used again.
  //
  // forfeitMatch is shared with abandon-match so the two cannot disagree, and it still
  // charges nothing for a seeding match or one whose runs are already in.
  for (const row of stale) {
    await forfeitMatch(admin, (row as any).match_id, caller.playerId, updateRating);
  }

  const staleIds = new Set(stale.map((row: any) => row.match_id));
  const liveMatch = (openMatches ?? []).find((row: any) => !staleIds.has(row.match_id));

  // Already in a match: hand that one back rather than refusing.
  //
  // This used to be a 409 carrying an error string, and the client threw the payload
  // away, so a player whose app had restarted saw "you already have a match in
  // progress" with no way to see or leave it - the abandon button lives on the match
  // panel, and the panel only appears when the client knows about a match. Returning
  // the match is also just the honest answer: you asked for one, you have one.
  if (liveMatch) {
    const existing = (liveMatch as any).matches;
    const existingIds: number[] = existing.scenario_ids ?? [];

    const { data: names } = await admin
      .from("scenarios")
      .select("id, name")
      .in("id", existingIds);

    const nameById = new Map((names ?? []).map((s: any) => [s.id, s.name]));

    const { data: existingSides } = await admin
      .from("match_sides")
      .select("player_id, match_score, provisional, rating_before, submitted_at, players!inner(display_name)")
      .eq("match_id", liveMatch.match_id);

    const other = (existingSides ?? []).find((s: any) => s.player_id !== caller.playerId);

    return json({
      matchId: liveMatch.match_id,
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
  // they cannot see or abandon.
  //
  // Counted here rather than trusted from the client, and rejected runs are left out of
  // the count - a rejection is the file failing local integrity, so uploading garbage
  // must not buy a ticket. See eligibility.ts for where the number comes from and, more
  // importantly, for what this check does not prove.
  const { count: uploadedRuns, error: countError } = await admin
    .from("runs")
    .select("id", { count: "exact", head: true })
    .eq("player_id", caller.playerId)
    .neq("verification_tier", "rejected");

  if (countError) throw new HttpError(500, countError.message);

  const eligibility = queueEligibility(uploadedRuns ?? 0, MIN_RUNS_TO_QUEUE);
  if (!eligibility.eligible) {
    throw new HttpError(403, eligibilityMessage(eligibility));
  }

  // ---- the season, and the pool for the requested window -------------------------
  //
  // The season owns the pool (PLAN.md §14), so this reads `season_scenarios` rather than a
  // benchmark's membership table. Published wins over draft: a published season is frozen,
  // which is the whole reason to publish one, and a draft is what is being worked on.
  const { data: seasons, error: seasonError } = await admin
    .from("seasons")
    .select("id, name, status, windows, window_size")
    .in("status", ["published", "draft"])
    .order("created_at", { ascending: false })
    .limit(10);

  if (seasonError) throw new HttpError(500, seasonError.message);

  // Published first, then the newest draft. Ordering by date alone would let a draft
  // somebody is still editing take over from the frozen season people are playing.
  const season =
    (seasons ?? []).find((s: any) => s.status === "published") ?? (seasons ?? [])[0];

  if (!season) {
    // Explicit rather than falling back to some other pool. A match drawn from scenarios
    // the season does not contain would be graded against thresholds that do not describe
    // it, and would be worse than no match at all.
    throw new HttpError(503, "no season is loaded: push one with npm run push:season");
  }

  const windowName: string = season.windows?.[body.window] ?? `window ${body.window + 1}`;

  const { data: pool, error: poolError } = await admin
    .from("season_scenarios")
    .select("scenario_id, window_index, scenarios!inner(id, name, aim_type, sub_category)")
    .eq("season_id", season.id)
    .eq("window_index", body.window);

  if (poolError) throw new HttpError(500, poolError.message);

  const selectable: SelectableScenario[] = (pool ?? []).map((row: any) => ({
    id: row.scenarios.id,
    name: row.scenarios.name,
    aimType: row.scenarios.aim_type,
    subCategory: row.scenarios.sub_category,
  }));

  if (selectable.length === 0) {
    throw new HttpError(
      404,
      `${season.name} has no scenarios in ${windowName}`,
    );
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
        "matches!inner(category, difficulty, window_index, scenario_ids, benchmark_name), " +
        "ratings:players!inner(id)",
    )
    .not("match_score", "is", null)
    .neq("player_id", caller.playerId)
    .eq("matches.window_index", body.window);

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
