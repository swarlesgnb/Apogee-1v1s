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
  winProbability: number | null;
  poolSize: number;
}

export function findMatch(category: string, difficulty: string): Promise<FoundMatch> {
  return callFunction<FoundMatch>("find-match", { category, difficulty });
}

export interface SubmittedRun {
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

  return callFunction<SubmittedRun>("submit-run", { filename, csv, csvSha256, matchId });
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
