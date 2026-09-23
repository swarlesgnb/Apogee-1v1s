/**
 * Calls from the desktop client to Apogee's backend.
 *
 * Everything here runs in the main process, never the renderer, so the access token
 * stays out of a context the page could reach. The renderer asks for an action by name
 * over IPC and receives a settled result.
 *
 * Two transports, for two different jobs:
 *
 *   DIRECT TABLE WRITE  historical backfill. Thousands of rows that decide nothing on
 *                       their own, inserted under RLS with `player_id` pinned to the
 *                       caller. Cheap, and a forged row here only pollutes the
 *                       forger's own baseline.
 *
 *   EDGE FUNCTION       anything that decides something: a match run, an opponent, a
 *                       rating. The server re-derives every value from the raw file
 *                       and stored rows (PLAN.md §7).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFilename } from "../core/stats/parseStatsFile.ts";
import { collectRuns, type RunPayload } from "../core/sync/uploadRuns.ts";
import { accessToken, supabase, SUPABASE_URL } from "./session.ts";

const FUNCTIONS_BASE = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1`;

/** Rows per insert during backfill. */
const BATCH_SIZE = 500;

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** What a player reads when the server cannot be reached at all. */
export const OFFLINE_MESSAGE =
  "Can't reach the Apogee server. Check your connection and try again; your runs are saved on this PC.";
const EXPIRED_MESSAGE = "Your session expired. Sign in with Steam again.";

/**
 * How long a function call may take. fetch's own default is about five minutes, which
 * left "Searching" spinning with nothing to press.
 */
const CALL_TIMEOUT_MS = 20_000;

let onUnauthorized: (() => void) | null = null;
/** Called when the server says the session is no longer valid, so the UI can say so. */
export function setOnUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

/**
 * Turn any failure into a sentence a player can act on. "fetch failed" and "HTTP 503"
 * are true, and they are what reached the banner.
 */
export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const name = (err as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return "The Apogee server did not answer in time. Try again.";
  if (err instanceof TypeError) return OFFLINE_MESSAGE;
  return err instanceof Error ? err.message : String(err);
}

async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError("Sign in with Steam to play ranked.", 401);

  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(friendlyError(err), 0);
  }

  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError(EXPIRED_MESSAGE, 401);
  }
  if (res.status >= 500) {
    throw new ApiError("Apogee's server is having trouble. Try again in a minute.", res.status);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`${name} returned a non-JSON response`, res.status);
  }

  if (!res.ok) {
    const message =
      (parsed as { error?: string })?.error ?? `${name} failed with HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }

  return parsed as T;
}

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

export interface BackfillProgress {
  uploaded: number;
  total: number;
  batch: number;
  batches: number;
}

export interface BackfillResult {
  scanned: number;
  prepared: number;
  uploaded: number;
  skipped: number;
  errors: string[];
}

/**
 * Upload the whole stats folder.
 *
 * Safe to run repeatedly: `runs.csv_sha256` is unique per player, so re-running is a
 * no-op rather than a duplicate. That is the same constraint that stops a good run
 * being submitted twice to win two matches.
 */
export async function uploadBackfill(
  statsDir: string,
  playerId: string,
  onProgress?: (p: BackfillProgress) => void,
): Promise<BackfillResult> {
  const { payloads, scanned, skipped } = collectRuns(statsDir);

  const client = supabase();
  const errors: string[] = [];
  let uploaded = 0;

  const batches: RunPayload[][] = [];
  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    batches.push(payloads.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    // `player_id` is set here rather than trusted from anywhere else; the RLS policy
    // then refuses the row unless it matches the caller's own id.
    const rows = batches[i].map((p) => ({ ...p, player_id: playerId }));

    const { error } = await client
      .from("runs")
      .upsert(rows, { onConflict: "player_id,csv_sha256", ignoreDuplicates: true });

    if (error) {
      // One bad batch must not abandon the other ten thousand rows.
      errors.push(`batch ${i + 1}: ${error.message}`);
    } else {
      uploaded += rows.length;
    }

    onProgress?.({ uploaded, total: payloads.length, batch: i + 1, batches: batches.length });
  }

  return { scanned, prepared: payloads.length, uploaded, skipped, errors };
}

/** Reach back past the newest uploaded run, so one that failed just before it is retried. */
const HISTORY_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * Upload what has been played since the server last heard, without being asked.
 *
 * Backfill was the only way an ordinary run reached the server, and it runs when the
 * player presses Upload history. Everything played after that was missing, so a match was
 * measured against however stale that upload was, and a scenario first played since
 * against nothing at all.
 *
 * `only` names the files to send, which is how the watcher sends a run as it lands.
 * Without it, every file named after the newest history run the server holds is sent.
 * Match runs are kept out of that anchor: they arrive through submit-run on their own
 * schedule, and anchoring on one would skip everything played between the last upload and
 * the match. A player with nothing uploaded yet is left to Upload history, which shows its
 * progress; thirteen thousand rows is not something to send unannounced.
 *
 * The same upsert as backfill, so a file sent twice is ignored.
 */
export async function uploadRecentRuns(
  statsDir: string,
  playerId: string,
  only?: string[],
): Promise<{ uploaded: number; errors: string[] }> {
  const client = supabase();
  let include: (file: string) => boolean;

  if (only) {
    const wanted = new Set(only);
    include = (file) => wanted.has(file);
  } else {
    const { data, error } = await client
      .from("runs")
      .select("played_at")
      .eq("player_id", playerId)
      .is("match_id", null)
      .order("played_at", { ascending: false })
      .limit(1);
    if (error) throw new ApiError(error.message);

    const newest = data?.[0]?.played_at;
    if (!newest) return { uploaded: 0, errors: [] };

    const since = new Date(newest).getTime() - HISTORY_SLACK_MS;
    include = (file) => (parseFilename(file)?.playedAt.getTime() ?? -Infinity) >= since;
  }

  const { payloads } = collectRuns(statsDir, include);
  const errors: string[] = [];
  let uploaded = 0;

  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    const rows = payloads.slice(i, i + BATCH_SIZE).map((p) => ({ ...p, player_id: playerId }));
    const { error } = await client
      .from("runs")
      .upsert(rows, { onConflict: "player_id,csv_sha256", ignoreDuplicates: true });
    if (error) errors.push(error.message);
    else uploaded += rows.length;
  }

  return { uploaded, errors };
}

// ---------------------------------------------------------------------------
// matches
// ---------------------------------------------------------------------------

export interface MatchScenario {
  id: number;
  name: string;
}

export interface FoundMatch {
  matchId: string;
  category: string;
  difficulty: string;
  expiresAt: string;
  scenarios: MatchScenario[];
  /**
   * Null on a seeding match, which is what the server hands out when the pool is empty:
   * the same three scenarios, played against nobody, so the run set becomes the first
   * entry for whoever queues next.
   */
  opponent: {
    displayName: string;
    rating: number;
    playedAt: string;
    provisional: boolean;
  } | null;
  seeding?: boolean;
  /** True when this is a match the player already had, handed back rather than created. */
  resumed?: boolean;
  /**
   * Scenarios this player already has a run in for this match, known only for a match
   * recovered from the server. Without it a restart forgot which of the three were
   * played, asked for them again, and never settled a match that was already complete.
   */
  submittedScenarioIds?: number[];
  winProbability: number | null;
  /** Null when the pool was not searched, which is the case for a resumed match. */
  poolSize: number | null;
  /**
   * Set when this match came from a duel rather than the queue, naming whoever is on the
   * other end of it. find-match never sets it, so every existing caller sees undefined.
   */
  duel?: { id: string; to?: string; from?: string } | null;
  /**
   * Set when this match is one leg of a tournament fixture. Unrated. `leg` 1 is played
   * first against nobody, and `opponentName` answers it with the same three afterwards.
   */
  tournament?: TournamentLeg | null;
}

export interface TournamentLeg {
  id: string;
  name: string;
  fixtureId: string;
  attempt: number;
  label: string;
  leg: 1 | 2;
  opponentName: string;
}

/**
 * Queue for a match.
 *
 * `pool` names the window of the season's own pool the match is drawn from. It comes from
 * the snapshot rather than being assumed here, because the season decides it - and it is a
 * window index rather than a difficulty name so that renaming a window is a display change
 * and never a change to what the server resolves.
 */
export function findMatch(
  category: string,
  pool: { window: number },
): Promise<FoundMatch> {
  return callFunction<FoundMatch>("find-match", { category, window: pool.window });
}

/* ------------------------------------------------------------------------ duels ---- */

/**
 * Somebody else, as much of them as the server is willing to say.
 *
 * A name, a rating and when they last played. `playerId` is here because a duel has to be
 * addressed and nothing else can address one - see the header of `list-duels` for why that
 * is a narrowing of a rule this codebase otherwise holds to, and what it buys.
 */
export interface Person {
  playerId: string;
  displayName: string;
  rating: number;
  provisional: boolean;
  lastPlayedAt: string | null;
  friend: boolean;
}

export interface IncomingDuel {
  id: string;
  from: Person;
  status: "open";
  createdAt: string;
  expiresAt: string;
  /**
   * They have finished their three, so there is something to accept.
   *
   * Whether, never how well. The score is not in this payload and must not be: choosing
   * which duels to answer by how the sender did is picking the ones you expect to win.
   */
  ready: boolean;
}

export interface OutgoingDuel {
  id: string;
  to: Person;
  status: "open" | "accepted" | "declined" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
  /** Whether you have played your own three yet. Until you have, nobody can answer it. */
  played: boolean;
}

export interface DuelBoard {
  incoming: IncomingDuel[];
  outgoing: OutgoingDuel[];
  /** Everyone who has actually played, most recent first. */
  roster: Person[];
  friends: Person[];
}

/** The inbox, what you sent, who else plays, and your shortlist. */
export function fetchDuels(): Promise<DuelBoard> {
  return callFunction<DuelBoard>("list-duels", {});
}

/**
 * Challenge a named player.
 *
 * Creates your own match, which you play before they can answer. Comes back in the same
 * shape as `findMatch`, so the caller stores it, writes the playlist and paints the match
 * panel through the path that already exists.
 */
export function sendDuel(
  to: string,
  category: string,
  pool: { window: number },
): Promise<FoundMatch> {
  return callFunction<FoundMatch>("send-duel", { to, category, window: pool.window });
}

export interface DuelAnswer {
  ok: boolean;
  status: string;
  /** Present only on accept: the contested match this just created. */
  matchId?: string;
}

/**
 * Accept, decline, or take back one you sent.
 *
 * Accepting returns a whole match rather than an acknowledgement, for the same reason
 * find-match does: the client needs the scenarios and the opponent to show anything at
 * all, and a second round trip to fetch what the first one already knew is a screen that
 * flickers for no reason.
 */
export function answerDuel(
  duelId: string,
  action: "accept" | "decline" | "cancel",
): Promise<FoundMatch & DuelAnswer> {
  return callFunction<FoundMatch & DuelAnswer>("answer-duel", { duelId, action });
}

/* ------------------------------------------------------------------ tournaments ---- */

// Declared once, in the core, and read by both ends - see the header of view.ts.
export type { TournamentSummary, TournamentView } from "../core/tournament/view.ts";
import type { TournamentSummary, TournamentView } from "../core/tournament/view.ts";

export interface TournamentList {
  tournaments: TournamentSummary[];
  /** The one asked for, in full, or null when none was. */
  view: TournamentView | null;
}

/** Every tournament worth listing, and one in full if an id is given. */
export function fetchTournaments(tournamentId?: string): Promise<TournamentList> {
  return callFunction<TournamentList>("list-tournaments", tournamentId ? { tournamentId } : {});
}

/**
 * Everything short of playing: create, enter, leave, check in, and the host's three.
 *
 * A union rather than a loose object so the shape each action takes is written down here
 * as well as refused server-side. There is no member of it that carries a result.
 */
export type TournamentAction =
  | {
      action: "create";
      name: string;
      category: string;
      window: number;
      groupCount: 2 | 4 | 8;
      groupSize: number;
      qualifiers: 1 | 2;
      seeding: "seeded" | "shuffle";
    }
  | { action: "join" | "leave"; tournamentId: string }
  | { action: "check-in"; tournamentId: string; checkedIn: boolean }
  | { action: "remove"; tournamentId: string; playerId: string }
  | { action: "start"; tournamentId: string; revision: number }
  | { action: "cancel"; tournamentId: string; reason: string };

export function tournamentAction(request: TournamentAction): Promise<{ ok: boolean; view: TournamentView }> {
  return callFunction("tournament-action", request);
}

/**
 * Open your leg of a fixture. Comes back shaped like `findMatch`, so it is adopted through
 * the same path, with `tournament` saying which fixture it is.
 */
export function playFixture(tournamentId: string, fixtureId: string, attempt: number): Promise<FoundMatch> {
  return callFunction<FoundMatch>("play-fixture", { tournamentId, fixtureId, attempt });
}

/**
 * Add or remove somebody from your shortlist.
 *
 * A direct table write, which is rare here and deliberate. `friendships` decides nothing -
 * a forged row only clutters the forger's own picker - so RLS scopes it to the caller and
 * there is no Edge Function whose whole job would be to insert a row the player is already
 * allowed to insert. The rule that keeps clients out of `ratings` and `match_sides` has
 * nothing to protect here.
 */
export async function setFriend(playerId: string, friend: boolean): Promise<void> {
  const client = supabase();
  const token = await accessToken();
  if (!token) throw new ApiError("you are not signed in", 401);

  const me = (await client.auth.getUser()).data.user?.id;
  if (!me) throw new ApiError("you are not signed in", 401);

  const { error } = friend
    ? await client.from("friendships").upsert(
        { player_id: me, friend_id: playerId },
        { onConflict: "player_id,friend_id" },
      )
    : await client.from("friendships").delete().eq("player_id", me).eq("friend_id", playerId);

  if (error) throw new ApiError(error.message);
}

/**
 * How many runs this account has uploaded, ignoring rejected ones.
 *
 * Read straight from `runs` rather than through a function: RLS scopes the table to the
 * caller's own rows, so the count that comes back is theirs and nobody else's.
 *
 * This drives the readout only. find-match counts again server-side before it will hand
 * out a match, because a number the client reports about itself is a number the client
 * could lie about.
 */
export async function fetchUploadedRuns(): Promise<number | null> {
  const client = supabase();
  if (!(await accessToken())) return null;

  const { count, error } = await client
    .from("runs")
    .select("id", { count: "exact", head: true })
    .neq("verification_tier", "rejected");

  if (error) return null;
  return count ?? 0;
}

/**
 * The match this player is already in, if any.
 *
 * Without this, restarting the app mid-match loses the client's knowledge of it while
 * the server keeps it open, and the watcher then has nothing to attach runs to: the
 * player plays all three scenarios and not one of them counts. Nothing errors, the
 * runs upload as ordinary history, and the match sits at awaiting_runs forever.
 *
 * Read straight from the tables rather than through a function. RLS already lets a
 * participant read their own match and sides, so no new endpoint has to exist, and
 * nothing here decides anything - it only restores what the client had.
 */
export async function fetchActiveMatch(): Promise<FoundMatch | null> {
  const client = supabase();
  const token = await accessToken();
  if (!token) return null;

  const me = (await client.auth.getUser()).data.user?.id;
  if (!me) return null;

  // Participant RLS returns every side of every match the player can see, so the
  // opponent's side comes back too; and a copy of this player's own stored run set in a
  // stranger's match carries their id. Neither is the match they are playing. A copy is
  // recognisable by having been played before the match it sits in was created.
  const { data: sides } = await client
    .from("match_sides")
    .select("match_id, player_id, rating_before, provisional, submitted_at, matches!inner(id, status, category, difficulty, scenario_ids, expires_at, created_at)")
    .eq("player_id", me)
    .in("matches.status", ["open", "awaiting_runs"]);

  const now = Date.now();
  const mine = (sides ?? []).find((row: any) => {
    const m = row.matches;
    if (!m) return false;
    if (row.submitted_at && m.created_at && new Date(row.submitted_at).getTime() < new Date(m.created_at).getTime()) return false;
    return m.expires_at == null || new Date(m.expires_at).getTime() > now;
  });

  if (!mine) return null;

  const match = (mine as any).matches;
  const scenarioIds: number[] = match.scenario_ids ?? [];

  const { data: names } = await client
    .from("scenarios")
    .select("id, name")
    .in("id", scenarioIds);

  const nameById = new Map((names ?? []).map((s: any) => [s.id, s.name]));

  // The opponent's own side, if this is a contested match rather than a seeding one.
  const { data: allSides } = await client
    .from("match_sides")
    .select("player_id, rating_before, provisional, submitted_at")
    .eq("match_id", match.id);

  const other = (allSides ?? []).find((s: any) => s.player_id !== (mine as any).player_id);

  // Own runs already filed against this match. A rejected run never counted, so it does
  // not count here either.
  const { data: filed } = await client
    .from("runs")
    .select("scenario_id, verification_tier")
    .eq("match_id", match.id)
    .eq("player_id", me);
  const submittedScenarioIds = [...new Set((filed ?? [])
    .filter((r: any) => r.verification_tier !== "rejected" && scenarioIds.includes(Number(r.scenario_id)))
    .map((r: any) => Number(r.scenario_id)))];

  return {
    matchId: match.id,
    category: match.category,
    difficulty: match.difficulty,
    expiresAt: match.expires_at,
    scenarios: scenarioIds.map((id) => ({ id, name: nameById.get(id) ?? `scenario ${id}` })),
    submittedScenarioIds,
    opponent: other
      ? {
          // Display names are not readable from the client any more (players is
          // owner-only since the RLS fix), so the server names the opponent when it
          // hands out the match. On recovery we only know that there is one.
          displayName: "your opponent",
          rating: Math.round(Number(other.rating_before ?? 1500)),
          playedAt: other.submitted_at ?? match.expires_at,
          provisional: !!other.provisional,
        }
      : null,
    seeding: !other,
    resumed: true,
    winProbability: null,
    poolSize: null,
  };
}

export interface AbandonResult {
  ok: boolean;
  matchId?: string;
  nothingToAbandon?: boolean;
  verdict: "loss" | null;
  rated: boolean;
  reason?: "forfeit" | "seeding" | "expired";
  ratingBefore?: number;
  ratingAfter?: number;
  ratingChange?: number;
  message?: string;
  /** The fixture this was a leg of, when it was one. */
  tournament?: { id: string; name: string; label: string; leg: 1 | 2 } | null;
}

/**
 * End the active match server-side.
 *
 * Costs a loss when there was a real opponent, and nothing when there was not. Until
 * this existed the client's abandon button only cleared local state, leaving the match
 * open on the server and the player unable to queue at all.
 */
export function abandonMatch(): Promise<AbandonResult> {
  return callFunction<AbandonResult>("abandon-match", {});
}

export interface SubmittedRun {
  /** New match deadline: the clock restarts once a run is in. */
  expiresAt?: string | null;
  runId: string | null;
  scenario: string;
  score: number;
  verificationTier: string;
  reasons: string[];
  advisories: string[];
  counted: boolean;
}

/**
 * Send one run for verification.
 *
 * The whole CSV goes up, not a summary, so the integrity checks run over the file as
 * KovaaK's wrote it. A client cannot present tidy numbers that contradict rows it
 * never sent.
 */
export async function submitRun(
  statsDir: string,
  filename: string,
  matchId?: string,
): Promise<SubmittedRun> {
  const csv = readFileSync(join(statsDir, filename), "utf8");

  // The hash is recomputed server-side; sending it only catches a corrupted upload.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(csv));
  const csvSha256 = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // The filename carries a bare local wall clock and KovaaK's records no offset, so
  // only this machine can say what instant those digits mean. Without it the server
  // reads them in its own timezone and every run lands hours from where it belongs.
  //
  // Safe to take from the client: it shifts nothing but the sender's own match window,
  // and a wrong one puts their runs outside it, which is the check rejecting them
  // rather than being fooled.
  const tzOffsetMinutes = new Date().getTimezoneOffset();

  return callFunction<SubmittedRun>("submit-run", {
    filename,
    csv,
    csvSha256,
    matchId,
    tzOffsetMinutes,
  });
}

export interface SettledMatch {
  matchId: string;
  verdict: "win" | "loss" | "draw" | "void";
  /** A match with nobody on the other side yet: a seeding match, or a first leg. */
  seeding?: boolean;
  /** False for a tournament leg: decided the ordinary way, and moving no rating. */
  rated?: boolean;
  /** The fixture this was a leg of, when it was one. */
  tournament?: { id: string; name: string; label: string; leg: 1 | 2 } | null;
  /**
   * Who it was against, so the result can offer a rematch.
   *
   * Null on a seeding match, which had nobody, and on a void, which did not count. The
   * client knew this name when the match was handed out and threw it away on settlement,
   * which is why the result screen could never say who you had just beaten.
   */
  opponent?: { playerId: string; displayName: string } | null;
  /** The category it was played in, which is the one a rematch would be sent in. */
  category?: string;
  explanation: string;
  voidReason: string | null;
  ratingWeight: number;
  yourMatchScore: number | null;
  theirMatchScore: number | null;
  ratingBefore: number;
  ratingAfter: number;
  ratingChange: number;
  rounds: {
    scenario: string;
    score: number;
    baseline: number;
    delta: number | null;
    opponentDelta: number | null;
    counted: boolean;
    excludedReason: string | null;
    verificationTier: string;
  }[];
}

export function settleMatch(matchId: string): Promise<SettledMatch> {
  return callFunction<SettledMatch>("settle-match", { matchId });
}

// ---------------------------------------------------------------------------
// standing
// ---------------------------------------------------------------------------

export interface BaselineRefresh {
  baselines: number;
  scenarios: number;
  provisional: number;
  solid: number;
}

/**
 * Recompute every baseline from stored runs.
 *
 * Needed after a backfill: those rows are written straight to the table, so nothing
 * triggers the per-scenario refresh that `submit-run` performs.
 */
export function refreshBaselines(): Promise<BaselineRefresh> {
  return callFunction<BaselineRefresh>("refresh-baselines", {});
}

export interface Standing {
  rating: number;
  rd: number;
  matchesPlayed: number;
  runsUploaded: number;
}

/** The player's own rating and upload count, read under RLS. */
export async function fetchStanding(playerId: string): Promise<Standing | null> {
  const client = supabase();

  const [{ data: rating }, { count }] = await Promise.all([
    client
      .from("ratings")
      .select("rating, rd, matches_played")
      .eq("player_id", playerId)
      .maybeSingle(),
    client
      .from("runs")
      // `id`, not `*`: runs no longer grants every column to authenticated, and a
      // head-count that names `*` asks for privileges on all of them.
      .select("id", { count: "exact", head: true })
      .eq("player_id", playerId),
  ]);

  if (!rating) return null;

  return {
    rating: Number(rating.rating),
    rd: Number(rating.rd),
    matchesPlayed: Number(rating.matches_played),
    runsUploaded: count ?? 0,
  };
}

// The shape is declared once, in the core, and imported by both the Edge Function that
// builds it and this client that reads it - see src/core/season/apexWire.ts. Writing it
// out twice is how a renamed field compiles on both sides and arrives undefined.
export type {
  ApexBoardEntry,
  ApexBoardPage as ApexBoard,
  ApexRefresh,
} from "../core/season/apexWire.ts";
import type { ApexBoardPage, ApexRefresh } from "../core/season/apexWire.ts";

/**
 * The public apex board for one category.
 *
 * A function call rather than a select, because `apex_standing` is read-self: a
 * leaderboard is public and the table is not, and what a client sees about another
 * player is the server's decision (migration 20260817000004). What comes back carries a
 * display name and a standing and no identifier at all.
 */
export function fetchApexBoard(category: string): Promise<ApexBoardPage> {
  return callFunction<ApexBoardPage>("apex-board", { category });
}

/**
 * Recompute the caller's own apex standing so the board has something current to show.
 *
 * Separate from reading it: a player absent from the board has simply never refreshed,
 * which is honest, and makes the refresh mean something rather than being a no-op the
 * client fires on every render.
 */
export function refreshApex(): Promise<ApexRefresh> {
  return callFunction<ApexRefresh>("refresh-apex", {});
}

/**
 * Is the signed-in player an admin?
 *
 * The RLS policy on `admins` lets an account see its own row and nobody else's, so a
 * row coming back is itself the answer. There is no endpoint to ask about anyone else,
 * which is deliberate: the admin list is not a thing clients get to enumerate.
 */
export async function isAdmin(): Promise<boolean> {
  const token = await accessToken();
  if (!token) return false;

  const { data, error } = await supabase()
    .from("admins")
    .select("player_id")
    .maybeSingle();

  return !error && !!data;
}
