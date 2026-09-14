/**
 * Upload parsed runs to Supabase.
 *
 * The client's whole job is: parse the file, hash it, send the facts. It computes no
 * baseline, no delta, no verification tier and no rating; those are server-side
 * (PLAN.md §7), because anything the client computes is something the client can lie
 * about.
 *
 * Two properties matter here:
 *
 *   Idempotence: first-run backfill sends ~11k rows, and it must be safe to run
 *   again after a crash, a restart, or a folder re-scan. `csv_sha256` is unique per
 *   player, so re-sending is a no-op rather than a duplicate.
 *
 *   Replay protection: the same consequence, from the other direction. A good run
 *   cannot be submitted a second time to win a second match.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseStatsFile, type ParsedRun } from "../stats/parseStatsFile.ts";

/** Rows per insert. Large enough to be fast, small enough to stay well under limits. */
export const BATCH_SIZE = 500;

export interface RunPayload {
  scenario_name: string;
  score: number;
  accuracy: number | null;
  avg_ttk: number | null;
  kills: number | null;
  hit_count: number | null;
  miss_count: number | null;
  played_at: string;
  challenge_start: string | null;
  hash: string | null;
  game_version: string | null;
  avg_fps: number | null;
  resolution: string | null;
  cm360: number | null;
  dpi: number | null;
  fov: number | null;
  csv_sha256: string;
  kill_rows: unknown[] | null;
}

export function hashCsv(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Convert a parsed run into the row shape the server expects.
 *
 * @param includeKillRows Retain per-kill detail. Only worth doing for runs attached to
 *   a match, where anti-cheat may need to re-derive the score; storing it for a full
 *   backfill would be enormous and buys nothing.
 */
export function toPayload(
  run: ParsedRun,
  csvSha256: string,
  includeKillRows = false,
): RunPayload | null {
  // Without a timestamp a run cannot be ordered, so it cannot contribute to a
  // baseline or be matched to a match window. Drop it rather than guess.
  if (!run.playedAt) return null;

  return {
    scenario_name: run.scenario,
    score: run.score,
    accuracy: run.accuracy,
    avg_ttk: run.avgTtk,
    kills: run.kills,
    hit_count: run.hitCount,
    miss_count: run.missCount,
    played_at: run.playedAt.toISOString(),
    challenge_start: run.challengeStart,
    hash: run.hash,
    game_version: run.gameVersion,
    avg_fps: run.avgFps,
    resolution: run.resolution,
    cm360: run.cm360,
    dpi: run.dpi,
    fov: run.fov,
    csv_sha256: csvSha256,
    kill_rows: includeKillRows ? run.killRows : null,
  };
}

export interface CollectResult {
  payloads: RunPayload[];
  scanned: number;
  skipped: number;
}

/**
 * Parse and hash every stats file in a folder, ready for upload.
 *
 * @param include Read only the files it accepts, by name, before anything is opened.
 */
export function collectRuns(dir: string, include?: (file: string) => boolean): CollectResult {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith("Stats.csv") && (!include || include(f)));
  } catch {
    return { payloads: [], scanned: 0, skipped: 0 };
  }

  const payloads: RunPayload[] = [];
  let skipped = 0;

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf8");
    } catch {
      skipped++;
      continue;
    }

    const result = parseStatsFile(file, content);
    if (!result.ok) {
      skipped++;
      continue;
    }

    const payload = toPayload(result.run, hashCsv(content));
    if (!payload) {
      skipped++;
      continue;
    }
    payloads.push(payload);
  }

  return { payloads, scanned: files.length, skipped };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Minimal surface of the Supabase client this module needs, so it stays testable. */
export interface RunUploader {
  from(table: string): {
    upsert(
      rows: unknown[],
      options: { onConflict: string; ignoreDuplicates: boolean },
    ): Promise<{ error: { message: string } | null }>;
  };
}

export interface UploadProgress {
  uploaded: number;
  total: number;
  batch: number;
  batches: number;
}

export interface UploadResult {
  uploaded: number;
  batches: number;
  errors: string[];
}

/**
 * Upload runs in batches.
 *
 * `player_id` is deliberately not set here: RLS derives it from the caller's JWT, so a
 * client cannot file runs against someone else's account even if it tries.
 */
export async function uploadRuns(
  client: RunUploader,
  payloads: RunPayload[],
  onProgress?: (p: UploadProgress) => void,
): Promise<UploadResult> {
  const batches = chunk(payloads, BATCH_SIZE);
  const errors: string[] = [];
  let uploaded = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { error } = await client
      .from("runs")
      .upsert(batch, { onConflict: "player_id,csv_sha256", ignoreDuplicates: true });

    if (error) {
      // One bad batch should not abandon the other ten thousand rows.
      errors.push(`batch ${i + 1}: ${error.message}`);
    } else {
      uploaded += batch.length;
    }

    onProgress?.({ uploaded, total: payloads.length, batch: i + 1, batches: batches.length });
  }

  return { uploaded, batches: batches.length, errors };
}
