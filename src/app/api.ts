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

async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError("you are not signed in", 401);

  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

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
  winProbability: number | null;
  /** Null when the pool was not searched, which is the case for a resumed match. */
  poolSize: number | null;
}

export function findMatch(category: string, difficulty: string): Promise<FoundMatch> {
  return callFunction<FoundMatch>("find-match", { category, difficulty });
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

  const { data: sides } = await client
    .from("match_sides")
    .select("match_id, player_id, rating_before, provisional, submitted_at, matches!inner(id, status, category, difficulty, scenario_ids, expires_at)")
    .in("matches.status", ["open", "awaiting_runs"]);

  const now = Date.now();
  const mine = (sides ?? []).find((row: any) => {
    const m = row.matches;
    if (!m) return false;
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

  return {
    matchId: match.id,
    category: match.category,
    difficulty: match.difficulty,
    expiresAt: match.expires_at,
    scenarios: scenarioIds.map((id) => ({ id, name: nameById.get(id) ?? `scenario ${id}` })),
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
      .select("*", { count: "exact", head: true })
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
