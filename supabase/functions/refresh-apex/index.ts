/**
 * Recompute the caller's apex standing, and store it.
 *
 * The season ladder caps at its top rank on purpose, so it cannot tell two maxed
 * players apart. This is the standing that can: for each family, where the caller's
 * verified best sits on the KovaaK's board of that family's hardest scenario,
 * expressed as -log10 of the fraction from the top so a whole point always means ten
 * times fewer players above them. See `src/core/season/apex.ts`.
 *
 * WHY VERIFIED PBS AND NOT RUNS
 *
 * `runs` is what the client uploaded; `verified_pbs` is what KovaaK's own servers say
 * the player can do (PLAN.md §5). A public leaderboard is exactly the surface where the
 * difference matters, because it is the one people would forge a score to reach. The
 * ladder can afford to read runs - it is bounded by thresholds and settled against a
 * baseline - and a board with no ceiling cannot.
 *
 * WHY IT IS STORED RATHER THAN COMPUTED ON READ
 *
 * Ranking the population needs every graded board and every player's PB on it. Doing
 * that per request would be a full scan to render one page. So each player refreshes
 * their own row and readers just sort `apex_standing`, which is what the index on
 * (category, points desc) is for.
 *
 * A player refreshes only themselves. There is no path here to write another player's
 * standing, which keeps the "clients compute nothing that matters" rule intact even
 * though the caller is the one asking for the recompute: the scores are the server's,
 * the boards are the server's, and the arithmetic is the server's.
 */

import { handler, json, requireCaller, HttpError } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { apexPoints, apexTopFraction, type ApexBoard } from "../../../src/core/season/apex.ts";
import { topOfEachFamily } from "../../../src/core/season/standing.ts";
import type { Distribution } from "../../../src/core/season/percentiles.ts";

/**
 * The category name the derived total is stored under. Not a real category.
 *
 * It shares a primary key with the real ones, so a season that named a category this
 * would have one row silently overwrite the other - a public standing quietly wrong for
 * everybody, with nothing failing. Refused below rather than escaped, because a category
 * called Overall is a season worth rejecting, not one worth working around.
 */
const OVERALL = "Overall";

interface BoardRow {
  scenario_id: number;
  board_total: number;
  apex_points: { rank: number; score: number }[];
  percentile_points: { topFraction: number; score: number }[];
  sampled_at: string;
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "refresh-apex");

  // ---- the season, and the scenario that grades each family ----------------------
  //
  // Published wins over draft, same rule as find-match: a published season is frozen,
  // which is the whole reason to publish one.
  const { data: seasons, error: seasonError } = await admin
    .from("seasons")
    .select("id, name, status, windows, window_size")
    .in("status", ["published", "draft"])
    .order("created_at", { ascending: false })
    .limit(10);

  if (seasonError) throw new HttpError(500, seasonError.message);

  const season =
    (seasons ?? []).find((s: any) => s.status === "published") ?? (seasons ?? [])[0];

  if (!season) {
    throw new HttpError(503, "no season is loaded: push one with npm run push:season");
  }

  const { data: pool, error: poolError } = await admin
    .from("season_scenarios")
    .select("scenario_id, category, family, window_index")
    .eq("season_id", season.id);

  if (poolError) throw new HttpError(500, poolError.message);

  // One scenario per family: the hardest, and only the hardest.
  //
  // The ladder grades a family on the *best* of its variants, which is right for a
  // rank. Up here it would pay for playing down: a percentile is a percentile of
  // whoever played that scenario, and an easy board is enormous and mostly people who
  // opened it once. Measured on the corpus, the same player reads better on the easier
  // scenario in 26 of 43 variant pairs. Fixing the graded variant removes the choice.
  // Same rule as the local board, from the same function - see topOfEachFamily.
  const gradedByFamily = topOfEachFamily(
    ((pool ?? []) as {
      scenario_id: number;
      category: string;
      family: string | null;
      window_index: number | null;
    }[]).map((row) => ({
      family: row.family ?? String(row.scenario_id),
      window: row.window_index ?? 0,
      value: { scenarioId: row.scenario_id, category: row.category },
    })),
  );

  if (gradedByFamily.size === 0) {
    throw new HttpError(503, `${season.name} has no scenarios to grade`);
  }

  if ([...gradedByFamily.values()].some((g) => g.category === OVERALL)) {
    throw new HttpError(
      500,
      `${season.name} has a category named ${OVERALL}, which collides with the derived ` +
        "total this board stores under that name",
    );
  }

  const gradedIds = [...gradedByFamily.values()].map((g) => g.scenarioId);

  // ---- the boards, and the caller's verified bests --------------------------------

  const { data: boards, error: boardError } = await admin
    .from("scenario_boards")
    .select("scenario_id, board_total, apex_points, percentile_points, sampled_at")
    .in("scenario_id", gradedIds);

  if (boardError) throw new HttpError(500, boardError.message);

  if ((boards ?? []).length === 0) {
    // Explicit rather than writing a standing of zero for everybody. An absent board is
    // a deployment that has not run `npm run sync:reference`, not a player who cannot aim.
    throw new HttpError(
      503,
      "no sampled leaderboards: run npm run sync:reference against this project",
    );
  }

  const boardById = new Map<number, BoardRow>(
    (boards ?? []).map((b: BoardRow) => [b.scenario_id, b]),
  );

  const { data: pbs, error: pbError } = await admin
    .from("verified_pbs")
    .select("scenario_id, score")
    .eq("player_id", caller.playerId)
    .in("scenario_id", gradedIds);

  if (pbError) throw new HttpError(500, pbError.message);

  const pbById = new Map(
    (pbs ?? []).map((p: { scenario_id: number; score: number }) => [
      p.scenario_id,
      Number(p.score),
    ]),
  );

  // ---- the standing ---------------------------------------------------------------

  const perCategory = new Map<string, { points: number; graded: number; families: number }>();

  for (const [, graded] of gradedByFamily) {
    const bucket = perCategory.get(graded.category) ?? { points: 0, graded: 0, families: 0 };
    bucket.families++;

    const score = pbById.get(graded.scenarioId);
    const row = boardById.get(graded.scenarioId);

    if (score !== undefined && score > 0 && row) {
      const board: ApexBoard = {
        scenario: String(graded.scenarioId),
        leaderboardId: 0,
        total: row.board_total,
        points: row.apex_points ?? [],
        sampledAt: row.sampled_at,
      };
      const dist: Distribution = {
        scenario: String(graded.scenarioId),
        leaderboardId: 0,
        total: row.board_total,
        points: row.percentile_points ?? [],
        sampledAt: row.sampled_at,
      };

      const fraction = apexTopFraction(
        board.points.length > 0 ? board : null,
        dist.points.length > 0 ? dist : null,
        score,
      );

      if (fraction !== null) {
        bucket.points += apexPoints(fraction);
        bucket.graded++;
      }
    }

    perCategory.set(graded.category, bucket);
  }

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];

  let overall = { points: 0, graded: 0, families: 0 };

  for (const [category, bucket] of perCategory) {
    rows.push({
      player_id: caller.playerId,
      category,
      points: bucket.points,
      graded: bucket.graded,
      family_count: bucket.families,
      updated_at: now,
    });
    overall = {
      points: overall.points + bucket.points,
      graded: overall.graded + bucket.graded,
      families: overall.families + bucket.families,
    };
  }

  // The overall is a row like any other so the board can be sorted by one query
  // whichever tab is showing, rather than summing three rows per player on read.
  rows.push({
    player_id: caller.playerId,
    category: OVERALL,
    points: overall.points,
    graded: overall.graded,
    family_count: overall.families,
    updated_at: now,
  });

  const { error: writeError } = await admin
    .from("apex_standing")
    .upsert(rows, { onConflict: "player_id,category" });

  if (writeError) return json({ error: writeError.message }, 500);

  return json({
    season: season.name,
    categories: rows
      .filter((r) => r.category !== OVERALL)
      .map((r) => ({
        category: r.category,
        points: Number((r.points as number).toFixed(4)),
        graded: r.graded,
        families: r.family_count,
      })),
    overall: {
      points: Number(overall.points.toFixed(4)),
      graded: overall.graded,
      families: overall.families,
    },
  });
}));
