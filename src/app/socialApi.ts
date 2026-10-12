/**
 * The social functions as the app calls them: the Daily board and open challenges.
 *
 * Beside api.ts rather than inside it, so the calls stay next to the feature and api.ts,
 * which every screen's calls live in, takes one exported helper and nothing else.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { callFunction, matchClockOffset, type FoundMatch } from "./api.ts";
import type { DailyBoard } from "../core/social/daily.ts";

async function upload(statsDir: string, filename: string) {
  // Only a bare file name, which the caller took from the watcher or the folder scan; a
  // path here would read outside the stats folder.
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) throw new Error("not a stats file name");
  const csv = readFileSync(join(statsDir, filename), "utf8");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(csv));
  const csvSha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { filename, csv, csvSha256 };
}

/**
 * Post a finished Daily. The raw files go up, never the local result: the server draws the
 * day again, re-verifies each run and rebuilds each baseline (daily-submit).
 */
export async function submitDaily(statsDir: string, filenames: string[], dailyNumber: number, window: number): Promise<{ board: DailyBoard; alreadyPosted: boolean }> {
  const runs = await Promise.all(filenames.map((f) => upload(statsDir, f)));
  // Only this machine knows what instant a filename's digits mean (see postGhost).
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return callFunction("daily-submit", { dailyNumber, window, runs, timeZone });
}

export function fetchDailyBoard(dailyNumber: number, window: number): Promise<{ board: DailyBoard }> {
  return callFunction("daily-board", { dailyNumber, window });
}

/** Post an open challenge: your own three first, then a code anybody can answer, unrated. */
export function createOpenDuel(category: string, window: number): Promise<FoundMatch> {
  return callFunction<FoundMatch>("open-duel", { action: "create", category, window, tzOffsetMinutes: matchClockOffset() });
}

/** What a code is for. Typed `unknown`: the caller checks it with isOpenDuelView. */
export function viewOpenDuel(code: string): Promise<unknown> {
  return callFunction<unknown>("open-duel", { action: "view", code });
}

export function acceptOpenDuel(code: string): Promise<FoundMatch> {
  return callFunction<FoundMatch>("open-duel", { action: "accept", code, tzOffsetMinutes: matchClockOffset() });
}

export function cancelOpenDuel(code: string): Promise<{ ok: boolean; status: string; matchVoided?: string }> {
  return callFunction("open-duel", { action: "cancel", code });
}

export interface OpenChallengeSummary {
  code: string;
  status: string;
  category: string;
  band: string;
  played: boolean;
  createdAt: string;
  expiresAt: string;
  answers: number;
  beatYou: number;
  youBeat: number;
  drawn: number;
}

export function fetchOpenDuels(): Promise<{ challenges: OpenChallengeSummary[] }> {
  return callFunction("open-duel", { action: "mine" });
}
