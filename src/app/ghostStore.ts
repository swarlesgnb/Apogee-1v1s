/**
 * Persist Ghost Mode between launches: the match in progress, recent results, the streak.
 *
 * Plain JSON in the app's user-data directory, the same stance as questStore.ts: nothing
 * here is a secret and nothing here decides anything anybody else sees. Editing it fakes
 * a local streak, which cheats only the editor; a shared card is rebuilt by the server
 * from verified runs (post-ghost), never from this file.
 *
 * Writes are atomic (temp file, then rename), and the last good file is kept as `.bak`
 * before each write, the way the Expedition's store does it: a match in progress is
 * written on every run that lands, and a crash between two writes should cost at most
 * that run, not the streak.
 */

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isMatchKind, type GhostMatch, type GhostResult, type MatchKind } from "../core/ghost/ghost.ts";

/** Results kept for the screen. The streak does not depend on them; see `winDays`. */
export const GHOST_RESULTS_KEPT = 30;

/** Win days kept: over a year, so no streak anybody plays is cut short by the store. */
const WIN_DAYS_KEPT = 400;

export interface StoredGhostResult extends GhostResult {
  id: string;
  kind: MatchKind;
  /** The streak once this result was counted, for the result screen. */
  streak: number;
}

export interface GhostStoreState {
  version: 1;
  active: GhostMatch | null;
  /** Newest last. */
  results: StoredGhostResult[];
  /**
   * Local days (YYYY-MM-DD) with a win over a past self, sorted. The streak is read from
   * these. A friend's-ghost win is not one: the card's streak is rebuilt by the server
   * from ghost_results, which holds past-self matches only, and a local streak that
   * counted friend races would disagree with the card it is shared on.
   */
  winDays: string[];
  /** Matches started on `day`: the draw's ordinal, so a new three costs finishing this one. */
  started: { day: string; count: number };
  /** Past-self matches this install has finished, for the chooser's first-match default. */
  finished: number;
  /**
   * The stats file behind each counted round of `active`, by scenario. Kept for Share,
   * which sends the raw files up for the server to re-verify; the match itself stores
   * only scores, which is all the local verdict needs.
   */
  files: Record<string, string>;
}

export function emptyGhostState(): GhostStoreState {
  return { version: 1, active: null, results: [], winDays: [], started: { day: "", count: 0 }, finished: 0, files: {} };
}

function storePath(): string {
  return join(app.getPath("userData"), "ghost.json");
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Shape only. A hand-edited file that passes this can lie about itself and nobody else. */
function valid(v: unknown): v is GhostStoreState {
  if (!isObject(v) || v.version !== 1) return false;
  if (!Array.isArray(v.results) || !Array.isArray(v.winDays) || !v.winDays.every((d) => typeof d === "string")) return false;
  if (!isObject(v.started) || typeof v.started.day !== "string" || typeof v.started.count !== "number") return false;
  if (typeof v.finished !== "number") return false;
  if (v.active !== null) {
    const a = v.active;
    if (!isObject(a) || typeof a.id !== "string" || !isMatchKind(a.kind) || !Array.isArray(a.rounds) || a.rounds.length !== 3) return false;
  }
  return true;
}

export function loadGhostState(): GhostStoreState {
  const path = storePath();
  for (const candidate of [path, `${path}.bak`]) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (valid(parsed)) return { ...parsed, files: isObject(parsed.files) ? parsed.files : {} };
    } catch {
      // Try the previous good write next.
    }
  }
  return emptyGhostState();
}

export function saveGhostState(state: GhostStoreState): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    try {
      const original = readFileSync(path, "utf8");
      if (valid(JSON.parse(original))) {
        writeFileSync(`${path}.bak.tmp`, original, "utf8");
        renameSync(`${path}.bak.tmp`, `${path}.bak`);
      }
    } catch {
      // An unreadable current file is not worth keeping as the backup.
    }
  }

  const trimmed: GhostStoreState = {
    ...state,
    results: state.results.slice(-GHOST_RESULTS_KEPT),
    winDays: [...new Set(state.winDays)].sort().slice(-WIN_DAYS_KEPT),
  };
  writeFileSync(`${path}.tmp`, JSON.stringify(trimmed, null, 2), "utf8");
  renameSync(`${path}.tmp`, path);
}
