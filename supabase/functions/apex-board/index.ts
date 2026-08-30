/**
 * Serve the apex leaderboard: the top of one category, and where the caller sits.
 *
 * WHY THIS IS A FUNCTION AND NOT A SELECT
 *
 * `apex_standing` is read-self only (20260830000015). A leaderboard is public, but the
 * table is not, and the difference is the whole rule 20260817000004 established: player
 * profiles were world-readable once, which let any caller enumerate the population, and
 * what replaced it is that anything a client sees about another player is a decision the
 * server makes. `find-match` already works this way - it joins `players` with the service
 * role and returns an opponent's display name in its response rather than granting the
 * client a read.
 *
 * So this returns exactly three things about anybody else: a display name, a standing, and
 * a position. Not steam_id, not the moderation flags, not even the player_id - the caller's
 * own row is marked with a flag instead, so there is no identifier here to correlate
 * against anything.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not recompute. `refresh-apex` writes a player's row when they ask, and this reads
 * what is stored - so a player who has never refreshed is absent from the board rather than
 * present with a stale zero, which is the honest state and the one that makes "refresh"
 * mean something.
 */

import { handler, json, requireCaller, HttpError } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import type {
  ApexBoardEntry,
  ApexBoardPage,
  ApexBoardSelf,
} from "../../../src/core/season/apexWire.ts";

/** Rows returned. Enough to be a leaderboard, few enough to stay one request. */
const PAGE = 50;

/** The category name the derived total is stored under. See refresh-apex. */
const OVERALL = "Overall";

interface Body {
  category?: string;
}

interface StandingRow {
  player_id: string;
  points: number;
  graded: number;
  family_count: number;
  updated_at: string;
  players: { display_name: string } | { display_name: string }[] | null;
}

/** PostgREST embeds a to-one relationship as an object or a one-element array. */
function displayName(row: StandingRow): string {
  const p = row.players;
  if (!p) return "unknown";
  return (Array.isArray(p) ? p[0]?.display_name : p.display_name) ?? "unknown";
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "apex-board");

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // An empty body is a request for the overall board, which is the sensible default
    // rather than an error.
  }

  const category = (body.category ?? OVERALL).trim() || OVERALL;

  // ---- the top of the board --------------------------------------------------------
  const { data: top, error } = await admin
    .from("apex_standing")
    .select("player_id, points, graded, family_count, updated_at, players!inner(display_name)")
    .eq("category", category)
    .order("points", { ascending: false })
    .limit(PAGE);

  if (error) throw new HttpError(500, error.message);

  const rows = (top ?? []) as StandingRow[];

  // ---- where the caller sits -------------------------------------------------------
  //
  // Read separately rather than searched for in `rows`: a player outside the top 50 is
  // the normal case and the one that most needs an answer.
  const { data: mine } = await admin
    .from("apex_standing")
    .select("points, graded, family_count, updated_at")
    .eq("player_id", caller.playerId)
    .eq("category", category)
    .maybeSingle();

  let you: ApexBoardSelf | null = null;

  if (mine) {
    // Rank is "how many are strictly above me, plus one". Counted rather than derived
    // from the page, because the page stops at 50.
    const { count } = await admin
      .from("apex_standing")
      .select("player_id", { count: "exact", head: true })
      .eq("category", category)
      .gt("points", Number(mine.points));

    you = {
      rank: (count ?? 0) + 1,
      points: Number(mine.points),
      graded: Number(mine.graded),
      families: Number(mine.family_count),
      updatedAt: String(mine.updated_at),
    };
  }

  const { count: population } = await admin
    .from("apex_standing")
    .select("player_id", { count: "exact", head: true })
    .eq("category", category);

  // Typed as the shared shape so a field added here without adding it there - or the
  // reverse - is a compile error in the core rather than an undefined on a screen.
  const page: ApexBoardPage = {
    category,
    population: population ?? 0,
    entries: rows.map((r, i): ApexBoardEntry => ({
      rank: i + 1,
      displayName: displayName(r),
      points: Number(r.points),
      graded: Number(r.graded),
      families: Number(r.family_count),
      // No player_id: the caller does not need one, and an ordered list of them is the
      // enumeration this function exists to avoid handing out.
      you: r.player_id === caller.playerId,
    })),
    you,
  };

  return json(page);
}));
