/**
 * Server-side tournament plumbing shared by the three tournament functions and by the two
 * match functions that can finish a leg.
 *
 * Three jobs, and the rule for each:
 *
 *   LOAD AND COMMIT   the aggregate is read with its revision and written back through
 *                     `tournament_commit`, which refuses a stale revision. A refused write
 *                     reloads and re-runs the step against what is there now; it never
 *                     merges and never overwrites.
 *
 *   FOLD IN A LEG     a finished leg's match is read here and nowhere else, turned into a
 *                     receipt by `readLeg`, and applied by the engine. The verdict is the
 *                     one settle-match already wrote; this file never looks at a score.
 *
 *   BUILD A VIEW      what the client is told comes from `view.ts`, which carries no score
 *                     fields. Names and legs are fetched here under the service role
 *                     because `players` and `tournament_legs` are closed to clients.
 */

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { forfeitMatch, HttpError } from "./apogee.ts";

import { recordResult } from "../../../src/core/tournament/tournament.ts";
import type { Tournament } from "../../../src/core/tournament/types.ts";
import { readLeg, receiptFor } from "../../../src/core/tournament/policy.ts";
import {
  buildView,
  fixtureLabelFor,
  type LegSummary,
  type TournamentView,
} from "../../../src/core/tournament/view.ts";
import { updateRating } from "../../../src/core/rating/glicko2.ts";

export interface TournamentRow {
  id: string;
  host_id: string;
  name: string;
  category: string;
  window_index: number;
  window_name: string;
  phase: string;
  revision: number;
  state: Tournament;
  created_at: string;
  updated_at: string;
}

export const TOURNAMENT_COLUMNS =
  "id, host_id, name, category, window_index, window_name, phase, revision, state, created_at, updated_at";

export type LogKind =
  | "created" | "joined" | "left" | "checked-in" | "checked-out" | "removed"
  | "started" | "cancelled" | "result" | "replay";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new HttpError(400, `${label} must be an id`);
  return value.toLowerCase();
}

/**
 * Refuse any field the action does not take.
 *
 * Refused rather than ignored. A body carrying `winnerId`, `outcome`, `score` or `seed`
 * is a client trying to decide something it does not get to, and dropping the field
 * silently would make the request look like it had worked.
 */
export function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be an object");
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new HttpError(400, `unexpected field: ${extra.join(", ")}`);
}

export function normaliseRow(data: Record<string, unknown>): TournamentRow {
  return { ...(data as unknown as TournamentRow), revision: Number(data.revision) };
}

export async function loadTournament(admin: SupabaseClient, id: string): Promise<TournamentRow> {
  const { data, error } = await admin.from("tournaments").select(TOURNAMENT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "That tournament does not exist.");
  return normaliseRow(data);
}

function membersOf(state: Tournament) {
  return state.entrants.map((e) => ({ player_id: e.id, seed: e.seed, checked_in: e.checkedIn }));
}

interface CommitExtras {
  kind: LogKind;
  actor: string | null;
  detail?: Record<string, unknown>;
  receipt?: { id: string; fixtureId: string; attempt: number; outcome: unknown; matchId: string };
  ingest?: string;
}

/** The new revision, or null when somebody else wrote first. */
async function commit(admin: SupabaseClient, row: TournamentRow, next: Tournament, extras: CommitExtras): Promise<number | null> {
  const { data, error } = await admin.rpc("tournament_commit", {
    p_id: row.id,
    p_expected: row.revision,
    p_state: next,
    p_members: membersOf(next),
    p_receipt: extras.receipt ?? null,
    p_ingest: extras.ingest ?? null,
    p_kind: extras.kind,
    p_actor: extras.actor,
    p_detail: extras.detail ?? {},
  });
  if (error) throw new HttpError(500, error.message);
  return data == null ? null : Number(data);
}

const backoff = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, 30 * 2 ** attempt + Math.floor(Math.random() * 30)));

/**
 * The engine's refusals, said the way a player would want to hear them.
 *
 * The engine words its errors for whoever is reading a stack trace. Unmatched ones pass
 * through as they are: a slightly technical sentence beats a vague one.
 */
const REFUSALS: Array<[RegExp, (message: string) => string]> = [
  [/at capacity/, () => "This tournament is full."],
  [/not in registration/, () => "Entries have closed: this tournament has started."],
  [/entrant id already registered/, () => "You are already entered."],
  [/entrant is not registered/, () => "That player is not entered."],
  [/at least (\d+) checked-in/, (m) => `It needs at least ${/\d+/.exec(m)![0]} checked-in players to start.`],
  [/terminal tournament/, () => "This tournament has already finished."],
  [/balanced allocation/, () => "Those players cannot be split into groups this size. Check more players in."],
];

export function refusal(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  for (const [pattern, say] of REFUSALS) if (pattern.test(message)) return new HttpError(409, say(message));
  return new HttpError(409, message);
}

/**
 * Load, apply one step, commit, and start over if somebody else wrote first.
 *
 * The step runs again against the fresh row each time rather than having its first
 * output rebased onto it. A step can refuse (a full field, a started tournament), and the
 * only way to know whether it still would is to ask it again about what is there now.
 */
export async function mutate(
  admin: SupabaseClient,
  tournamentId: string,
  actor: string,
  step: (row: TournamentRow) => { next: Tournament; kind: LogKind; detail?: Record<string, unknown> },
): Promise<TournamentRow> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await loadTournament(admin, tournamentId);
    let planned: ReturnType<typeof step>;
    try {
      planned = step(row);
    } catch (err) {
      throw refusal(err);
    }
    const revision = await commit(admin, row, planned.next, {
      kind: planned.kind,
      actor,
      detail: planned.detail,
    });
    if (revision !== null) {
      return { ...row, state: planned.next, revision, phase: planned.next.phase, updated_at: new Date().toISOString() };
    }
    await backoff(attempt);
  }
  throw new HttpError(409, "The tournament changed while that was being saved. Try again.");
}

/* ------------------------------------------------------------- settled legs ---- */

interface PendingLeg {
  fixture_id: string;
  attempt: number;
  leg: 1 | 2;
  player_id: string;
  match_id: string;
}

async function markIngested(admin: SupabaseClient, matchId: string): Promise<void> {
  await admin
    .from("tournament_legs")
    .update({ ingested_at: new Date().toISOString() })
    .eq("match_id", matchId)
    .is("ingested_at", null);
}

/**
 * Fold one finished leg into its tournament.
 *
 * Retried on a stale revision, like every other write. Left un-ingested if the retries run
 * out, which is safe: the leg is still marked outstanding, and the next request to touch
 * the tournament tries again.
 */
async function ingestLeg(admin: SupabaseClient, tournamentId: string, leg: PendingLeg): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await loadTournament(admin, tournamentId);
    const fixture = row.state.fixtures.find((f) => f.id === leg.fixture_id);

    // Nothing left to fold it into: the tournament ended, or this attempt was already
    // decided by something else. The leg's own match stands as an unrated match either way.
    if (
      !fixture || row.state.phase === "cancelled" || row.state.phase === "completed" ||
      fixture.status !== "pending" || fixture.attempt !== leg.attempt ||
      (leg.player_id !== fixture.playerA && leg.player_id !== fixture.playerB)
    ) {
      await markIngested(admin, leg.match_id);
      return;
    }

    const opponentId = leg.player_id === fixture.playerA ? fixture.playerB : fixture.playerA;

    const [{ data: match }, { data: side }] = await Promise.all([
      admin.from("matches").select("status").eq("id", leg.match_id).maybeSingle(),
      admin
        .from("match_sides")
        .select("match_score, result")
        .eq("match_id", leg.match_id)
        .eq("player_id", leg.player_id)
        .maybeSingle(),
    ]);
    if (!match) {
      await markIngested(admin, leg.match_id);
      return;
    }

    const reading = readLeg({
      leg: leg.leg,
      status: match.status,
      playerId: leg.player_id,
      opponentId,
      side: side
        ? { matchScore: side.match_score == null ? null : Number(side.match_score), result: side.result ?? null }
        : null,
    });

    if (reading.kind === "pending") return;
    if (reading.kind === "first-leg-played") {
      await markIngested(admin, leg.match_id);
      return;
    }

    const receipt = receiptFor(fixture.id, fixture.attempt, leg.match_id, reading.outcome);
    let next: Tournament;
    try {
      next = recordResult(row.state, receipt);
    } catch (err) {
      // The engine refused a receipt the server built. Nothing here should produce one it
      // refuses, so this is a bug to find rather than a result to retry forever.
      console.error(`tournament ${tournamentId}: could not apply ${receipt.id}:`, err);
      await markIngested(admin, leg.match_id);
      return;
    }
    if (next === row.state) {
      await markIngested(admin, leg.match_id);
      return;
    }

    const replays = reading.outcome.kind === "void" || (fixture.stage === "playoff" && reading.outcome.kind === "draw");
    const revision = await commit(admin, row, next, {
      kind: replays ? "replay" : "result",
      actor: null,
      detail: { fixtureId: fixture.id, attempt: fixture.attempt, matchId: leg.match_id, outcome: reading.outcome.kind },
      receipt: { ...receipt, matchId: leg.match_id },
      ingest: leg.match_id,
    });
    if (revision !== null) return;
    await backoff(attempt);
  }
}

/**
 * Fold every finished leg of a tournament into its aggregate.
 *
 * Called on the way into every tournament request, and by settle-match and abandon-match
 * right after they finish a leg. That is the whole delivery mechanism: a leg whose result
 * has not landed is marked by `ingested_at is null`, and the next request that looks at the
 * tournament picks it up. Nothing runs on a timer, so nothing can quietly stop running -
 * the same idiom list-duels uses to expire duels.
 *
 * A leg past its deadline is ended here the way find-match's sweep would end it the next
 * time its player queued, through `forfeitMatch`, which is the ordinary rule and not a
 * tournament one: an unfinished first leg voids, an unfinished answer is a loss.
 */
export async function reconcile(admin: SupabaseClient, tournamentId: string): Promise<void> {
  const { data: legs, error } = await admin
    .from("tournament_legs")
    .select("fixture_id, attempt, leg, player_id, match_id, created_at, matches!inner(status, expires_at)")
    .eq("tournament_id", tournamentId)
    .is("ingested_at", null)
    .order("created_at", { ascending: true });

  if (error) throw new HttpError(500, error.message);

  for (const raw of (legs ?? []) as any[]) {
    let status: string = raw.matches?.status;
    const expiresAt = raw.matches?.expires_at ? new Date(raw.matches.expires_at).getTime() : null;
    if ((status === "open" || status === "awaiting_runs") && expiresAt !== null && expiresAt < Date.now()) {
      await forfeitMatch(admin, raw.match_id, raw.player_id, updateRating);
      const { data: again } = await admin.from("matches").select("status").eq("id", raw.match_id).maybeSingle();
      status = again?.status ?? status;
    }
    if (status === "open" || status === "awaiting_runs") continue;
    await ingestLeg(admin, tournamentId, raw as PendingLeg);
  }
}

export interface LegNote {
  id: string;
  name: string;
  label: string;
  leg: 1 | 2;
}

/**
 * After a match finishes: if it was a tournament leg, fold it in and say which fixture it was.
 *
 * Never throws. The caller has already written and is about to return the player's own
 * result, and a tournament that could not be updated this instant is one the next request
 * updates instead - the leg stays marked until it is.
 */
export async function afterLegSettled(admin: SupabaseClient, matchId: string): Promise<LegNote | null> {
  try {
    const { data: leg } = await admin
      .from("tournament_legs")
      .select("tournament_id, fixture_id, leg")
      .eq("match_id", matchId)
      .maybeSingle();
    if (!leg) return null;

    await reconcile(admin, leg.tournament_id);
    const row = await loadTournament(admin, leg.tournament_id);
    return { id: row.id, name: row.name, label: fixtureLabelFor(row.state, leg.fixture_id), leg: leg.leg };
  } catch (err) {
    console.error(`could not fold match ${matchId} into its tournament:`, err);
    return null;
  }
}

/* -------------------------------------------------------------------- views ---- */

/** Current-attempt legs for these tournaments, with whether each one's match is still open. */
export async function legsFor(admin: SupabaseClient, ids: string[]): Promise<Map<string, LegSummary[]>> {
  const out = new Map<string, LegSummary[]>();
  if (ids.length === 0) return out;
  const { data, error } = await admin
    .from("tournament_legs")
    .select("tournament_id, fixture_id, attempt, leg, player_id, matches!inner(status)")
    .in("tournament_id", ids);
  if (error) throw new HttpError(500, error.message);
  for (const raw of (data ?? []) as any[]) {
    const list = out.get(raw.tournament_id) ?? [];
    list.push({
      fixtureId: raw.fixture_id,
      attempt: raw.attempt,
      leg: raw.leg,
      playerId: raw.player_id,
      live: raw.matches?.status === "open" || raw.matches?.status === "awaiting_runs",
    });
    out.set(raw.tournament_id, list);
  }
  return out;
}

export async function namesFor(admin: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await admin.from("players").select("id, display_name").in("id", [...new Set(ids)]);
  return new Map((data ?? []).map((p: any) => [p.id, p.display_name]));
}

export async function viewFor(admin: SupabaseClient, row: TournamentRow, viewerId: string): Promise<TournamentView> {
  const [legs, hosts] = await Promise.all([legsFor(admin, [row.id]), namesFor(admin, [row.host_id])]);
  return buildView({
    state: row.state,
    hostId: row.host_id,
    hostName: hosts.get(row.host_id) ?? "host",
    viewerId,
    category: row.category,
    windowName: row.window_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    legs: legs.get(row.id) ?? [],
  });
}
