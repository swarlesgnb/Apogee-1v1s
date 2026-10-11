/**
 * Server plumbing shared by the Crown and race functions, and by settle-match, which asks
 * here what to say about a match that was played for a Crown or a race.
 *
 * Three jobs:
 *
 *   SEASON CELLS  which (category, band) pairs can hold a Crown, read from the season pool
 *                 through loadSeasonPool, the same reader find-match uses.
 *   LIVE SIDES    one side of a match as the live view needs it, round by round. A side
 *                 still being played is measured the way settle-match will measure it:
 *                 first run per scenario in server receipt order, the baseline as it stood
 *                 when the match began, an abandoned run not counted.
 *   NOTES         the sentence a result screen shows about a Crown challenge or a race, built
 *                 from the rows the database decided, never from the client.
 *
 * Nothing here writes a result. The decisions are taken in SQL (crown_resolve and
 * race_resolve, migration 20261003000025) inside the transaction that ends the match.
 */

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { baselineFor, HttpError, loadSeasonPool } from "./apogee.ts";

import { baselineFromScores } from "../../../src/core/history/baseline.ts";
import { isAbandonedRun } from "../../../src/core/stats/duration.ts";
import { computeDelta } from "../../../src/core/match/settle.ts";
import { matchesCategory, type SelectableScenario } from "../../../src/core/match/scenarioSelection.ts";
import type { RunTier } from "../../../src/core/crowns/crowns.ts";
import { crownResultNote, type CrownResultNote } from "../../../src/core/crowns/view.ts";
import type { LiveRound, LiveSide } from "../../../src/core/race/race.ts";
import { verdictFor, type RaceResult } from "../../../src/core/race/race.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new HttpError(400, `${label} must be an id`);
  return value.toLowerCase();
}

/**
 * Refuse any field the action does not take, rather than ignoring it. A body that carries
 * `score`, `winner` or `holder` is a client trying to decide something it does not get to.
 */
export function onlyFields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be an object");
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new HttpError(400, `unexpected field: ${extra.join(", ")}`);
  return body as Record<string, unknown>;
}

export function requireCategory(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 40) {
    throw new HttpError(400, "category is required");
  }
  return value;
}

export function requireWindow(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 31) {
    throw new HttpError(400, "window is required");
  }
  return value;
}

/** Map a refusal raised by the arena SQL to a status, keeping its message for the player. */
export function sqlRefusal(error: { code?: string; message: string }): HttpError {
  const status = ({ CR400: 400, CR403: 403, CR404: 404, CR409: 409, CR429: 429, RC403: 403, RC404: 404, RC409: 409 } as Record<string, number>)[
    error.code ?? ""
  ];
  return new HttpError(status ?? (error.code === "23505" ? 409 : 500), error.message);
}

/* ------------------------------------------------------------------ season cells ---- */

export interface SeasonCells {
  season: string;
  bands: string[];
  pools: Map<number, SelectableScenario[]>;
  /** Every (category, band) with at least three scenarios to draw from. */
  cells: { category: string; window: number }[];
}

/** Distinct categories a pool files its scenarios under, in first-seen order. */
function categoriesOf(pool: SelectableScenario[]): string[] {
  return [...new Set(pool.map((s) => s.subCategory).filter((c): c is string => !!c))];
}

/** Every band of the live season, and which categories can hold a Crown in each. */
export async function seasonCells(admin: SupabaseClient): Promise<SeasonCells> {
  const first = await loadSeasonPool(admin, 0);
  const bandCount = Math.max(1, first.season.windows?.length ?? 1);
  const bands: string[] = [];
  const pools = new Map<number, SelectableScenario[]>();
  pools.set(0, first.selectable);
  bands[0] = first.windowName;
  for (let w = 1; w < bandCount; w++) {
    try {
      const next = await loadSeasonPool(admin, w);
      pools.set(w, next.selectable);
      bands[w] = next.windowName;
    } catch {
      // A band with no scenarios holds no Crowns; the others still do.
      bands[w] = first.season.windows?.[w] ?? `Band ${w + 1}`;
    }
  }
  const cells: { category: string; window: number }[] = [];
  const order: string[] = [];
  for (const pool of pools.values()) for (const c of categoriesOf(pool)) if (!order.includes(c)) order.push(c);
  for (const category of order) {
    for (const [w, pool] of [...pools.entries()].sort((a, b) => a[0] - b[0])) {
      const distinct = new Set(pool.filter((s) => matchesCategory(s, category)).map((s) => s.id));
      if (distinct.size >= 3) cells.push({ category, window: w });
    }
  }
  return { season: first.season.name, bands, pools, cells };
}

/* -------------------------------------------------------------------- live sides ---- */

export interface MatchRow {
  id: string;
  status: string;
  created_at: string;
  scenario_ids: number[];
}

const terminal = (status: string) => status === "settled" || status === "void";

/**
 * One side of one match, round by round.
 *
 * A finished side is read from what settle-match stored, which is the authority. A side
 * still being played is computed here the way settle-match will compute it, so the bar a
 * player watches is the number their result will show, unless a verified best changes the
 * baseline floor between now and settlement.
 */
export async function liveSide(
  admin: SupabaseClient,
  match: MatchRow,
  playerId: string,
  name: string,
  scenarioNames: Map<number, string>,
): Promise<LiveSide> {
  const ids: number[] = (match.scenario_ids ?? []).map(Number);
  const { data: runs, error } = await admin
    .from("runs")
    .select("id, scenario_id, scenario_name, score, verification_tier, duration_seconds")
    .eq("player_id", playerId)
    .eq("match_id", match.id)
    .order("match_submitted_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new HttpError(500, error.message);

  const first = new Map<number, any>();
  for (const r of runs ?? []) {
    const sid = Number(r.scenario_id);
    if (r.scenario_id != null && !first.has(sid)) first.set(sid, r);
  }

  const done = terminal(match.status);
  let stored: { deltas: number[]; match_score: number | null } | null = null;
  if (done) {
    const { data: side, error: sideError } = await admin
      .from("match_sides")
      .select("deltas, match_score")
      .eq("match_id", match.id)
      .eq("player_id", playerId)
      .maybeSingle();
    if (sideError) throw new HttpError(500, sideError.message);
    stored = side ? { deltas: (side.deltas ?? []).map(Number), match_score: side.match_score == null ? null : Number(side.match_score) } : null;
  }

  let expected = new Map<number, number | null>();
  if (!done && first.size > 0) {
    const { data: scen } = await admin.from("scenarios").select("id, duration_seconds").in("id", ids);
    expected = new Map((scen ?? []).map((s: any) => [Number(s.id), s.duration_seconds == null ? null : Number(s.duration_seconds)]));
  }

  const rounds: LiveRound[] = await Promise.all(
    ids.map(async (sid, i): Promise<LiveRound> => {
      const run = first.get(sid);
      const scenario = scenarioNames.get(sid) ?? run?.scenario_name ?? `scenario ${sid}`;
      if (!run) return { scenarioId: sid, scenario, landed: false, delta: null, counted: false, provisional: false, tier: null };
      const tier = run.verification_tier as RunTier;
      if (done) {
        const counted = match.status === "settled" && tier !== "rejected" && stored != null;
        return { scenarioId: sid, scenario, landed: true, delta: counted ? stored!.deltas[i] ?? null : null, counted, provisional: false, tier };
      }
      const abandoned = isAbandonedRun(
        run.duration_seconds == null ? null : Number(run.duration_seconds),
        expected.get(sid) ?? null,
      );
      if (tier === "rejected" || abandoned) {
        return { scenarioId: sid, scenario, landed: true, delta: null, counted: false, provisional: false, tier };
      }
      const baseline = await baselineFor(admin, playerId, sid, run.scenario_name, baselineFromScores, {
        at: match.created_at,
        matchId: match.id,
      });
      const value = baseline.runCount > 0 ? baseline.value : Number(run.score);
      const delta = computeDelta(Number(run.score), value);
      return { scenarioId: sid, scenario, landed: true, delta, counted: delta != null, provisional: baseline.provisional, tier };
    }),
  );

  return { name, rounds, terminal: done, void: match.status === "void", matchScore: stored?.match_score ?? null };
}

/** A stored run set copied into a match: every round landed long ago, deltas frozen. */
export function frozenSide(
  side: { deltas: number[] | null; match_score: number | null },
  scenarioIds: number[],
  name: string,
  scenarioNames: Map<number, string>,
): LiveSide {
  const deltas = (side.deltas ?? []).map(Number);
  return {
    name,
    terminal: true,
    void: false,
    matchScore: side.match_score == null ? null : Number(side.match_score),
    rounds: scenarioIds.map((sid, i) => ({
      scenarioId: Number(sid),
      scenario: scenarioNames.get(Number(sid)) ?? `scenario ${sid}`,
      landed: true,
      delta: Number.isFinite(deltas[i]) ? deltas[i] : null,
      counted: Number.isFinite(deltas[i]),
      provisional: false,
      tier: null,
    })),
  };
}

export async function scenarioNamesFor(admin: SupabaseClient, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await admin.from("scenarios").select("id, name").in("id", [...new Set(ids.map(Number))]);
  return new Map((data ?? []).map((s: any) => [Number(s.id), s.name as string]));
}

export async function namesFor(admin: SupabaseClient, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const { data } = await admin.from("players").select("id, display_name").in("id", wanted);
  return new Map((data ?? []).map((p: any) => [p.id as string, (p.display_name as string) ?? "player"]));
}

/* ------------------------------------------------------------------------- notes ---- */

/** What the result screen says about a Crown challenge, from the decided challenge row. */
export async function crownNote(admin: SupabaseClient, matchId: string): Promise<CrownResultNote | null> {
  const { data: ch, error } = await admin
    .from("crown_challenges")
    .select("match_id, category, window_index, reign_id, judged_reign_id, outcome, challenger_score, holder_score, reason")
    .eq("match_id", matchId)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!ch) return null;

  const { data: match } = await admin.from("matches").select("difficulty").eq("id", matchId).maybeSingle();
  let holderName: string | null = null;
  let defences: number | null = null;
  if (ch.judged_reign_id) {
    const { data: reign } = await admin
      .from("crown_reigns")
      .select("holder_id, defences")
      .eq("id", ch.judged_reign_id)
      .maybeSingle();
    if (reign) {
      holderName = (await namesFor(admin, [reign.holder_id])).get(reign.holder_id) ?? null;
      defences = Number(reign.defences);
    }
  }
  return crownResultNote({
    outcome: (ch.outcome ?? "pending") as CrownResultNote["outcome"],
    category: ch.category,
    window: Number(ch.window_index),
    band: match?.difficulty ?? `Band ${Number(ch.window_index) + 1}`,
    claim: ch.reign_id == null,
    holderName,
    judgedAgainstNewHolder: ch.judged_reign_id != null && ch.judged_reign_id !== ch.reign_id,
    challengerScore: ch.challenger_score == null ? null : Number(ch.challenger_score),
    holderScore: ch.holder_score == null ? null : Number(ch.holder_score),
    defences,
    reason: ch.reason ?? null,
  });
}

export interface RaceNote {
  kind: "race";
  raceId: string;
  opponentName: string;
  status: string;
  verdict: "win" | "loss" | "draw" | "void" | null;
  byForfeit: boolean;
  headline: string;
  explanation: string;
}

export async function raceNote(admin: SupabaseClient, matchId: string, viewerId: string): Promise<RaceNote | null> {
  const { data: rows, error } = await admin
    .from("races")
    .select("id, inviter_id, invitee_id, status, result, by_forfeit, inviter_match_id, invitee_match_id")
    .or(`inviter_match_id.eq.${matchId},invitee_match_id.eq.${matchId}`)
    .limit(1);
  if (error) throw new HttpError(500, error.message);
  const race = (rows ?? [])[0];
  if (!race) return null;
  const inviter = race.inviter_id === viewerId;
  const otherId = inviter ? race.invitee_id : race.inviter_id;
  const opponentName = (await namesFor(admin, [otherId])).get(otherId) ?? "your opponent";
  const verdict = race.status === "finished" ? verdictFor(race.result as RaceResult, inviter) : null;
  const forfeit = !!race.by_forfeit;
  const headline =
    verdict === "win" ? `You won the race against ${opponentName}.`
    : verdict === "loss" ? `${opponentName} won the race.`
    : verdict === "draw" ? `Race drawn with ${opponentName}.`
    : verdict === "void" ? "The race did not count."
    : `Your three are in.`;
  const explanation =
    verdict === "win" ? (forfeit ? `${opponentName} did not finish all three. Nothing was rated.` : "Your match score against your own baselines was higher. Nothing was rated.")
    : verdict === "loss" ? (forfeit ? "You did not finish all three, and they did. Nothing was rated." : "Their match score against their own baselines was higher. Nothing was rated.")
    : verdict === "draw" ? "Level within the draw margin. Nothing was rated."
    : verdict === "void" ? "Neither side finished all three. Nothing was rated."
    : `${opponentName} is still playing. The race is decided when their third run lands or their clock runs out. Nothing is rated.`;
  return { kind: "race", raceId: race.id, opponentName, status: race.status, verdict, byForfeit: forfeit, headline, explanation };
}

export interface ArenaNote {
  kind: "crown" | "race";
  headline: string;
  explanation: string;
  crown: CrownResultNote | null;
  race: RaceNote | null;
}

/**
 * What settle-match should say about an unrated match that was played for a Crown or a
 * race, or null when it was neither. Never throws: the caller has already written the
 * result and is about to return it, and a sentence that could not be built this instant is
 * one the Crowns screen builds instead.
 */
export async function arenaNote(admin: SupabaseClient, matchId: string, viewerId: string): Promise<ArenaNote | null> {
  try {
    const crown = await crownNote(admin, matchId);
    if (crown) return { kind: "crown", headline: crown.headline, explanation: crown.explanation, crown, race: null };
    const race = await raceNote(admin, matchId, viewerId);
    if (race) return { kind: "race", headline: race.headline, explanation: race.explanation, crown: null, race };
    return null;
  } catch (err) {
    console.error(`could not describe match ${matchId} for the arena:`, err);
    return null;
  }
}
