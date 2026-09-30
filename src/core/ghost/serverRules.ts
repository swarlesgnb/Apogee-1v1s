/**
 * The decisions post-ghost makes before it writes anything, as pure functions.
 *
 * They are here rather than inline in the Edge Function because the function cannot run
 * locally, and two of these guard tables that settle rated matches. validate:ghost runs
 * every branch; validate:schema runs the one UPDATE they allow against a real Postgres.
 */

import type { VerificationTier } from "../verify/verifyRun.ts";
import { GHOST_END_GRACE_MS, GHOST_IDLE_ALLOWANCE_MS, GHOST_ROUNDS } from "./ghost.ts";

const TIER_RANK: Record<string, number> = { verified: 3, consistent: 2, unverified: 1, suspect: 1, rejected: 0 };

/** The less trusted of two tiers. A card rests on the weaker claim, never the stronger. */
export function lowerTier(a: string, b: string): string {
  return (TIER_RANK[a] ?? 0) <= (TIER_RANK[b] ?? 0) ? a : b;
}

export interface StoredRunRow {
  id: string;
  match_id: string | null;
  verification_tier: string;
}

export type RunWrite =
  | { action: "insert" }
  /** A history row no match has claimed: rewritten from this parse, as submit-run claims one. */
  | { action: "update-unbound"; id: string }
  /**
   * A row a ranked match already counted. Never written: settle-match reads its played_at
   * and tier, and a ghost post that could rewrite them could reorder a rated match's
   * first runs or lift a rejected run. Its stored tier stands, lowered by this parse's
   * verdict if that is worse.
   */
  | { action: "keep"; id: string; tier: string };

export function planRunWrite(existing: StoredRunRow | null, freshTier: VerificationTier): RunWrite {
  if (!existing) return { action: "insert" };
  if (existing.match_id !== null) return { action: "keep", id: existing.id, tier: lowerTier(existing.verification_tier, freshTier) };
  return { action: "update-unbound", id: existing.id };
}

export interface SittingRun {
  scenario: string;
  sha: string;
  /** Instants, ms. `began` is `ended` less the duration where the duration is known. */
  began: number;
  ended: number;
}

/** Why three runs are not one ghost match, or null when they are. Reads nothing, writes nothing. */
export function sittingProblem(runs: SittingRun[]): string | null {
  if (runs.length !== GHOST_ROUNDS) return `a ghost match is ${GHOST_ROUNDS} runs`;
  if (new Set(runs.map((r) => r.scenario)).size !== GHOST_ROUNDS) return "a ghost match is three different scenarios";
  if (new Set(runs.map((r) => r.sha)).size !== GHOST_ROUNDS) return "the same file was posted twice";
  const sorted = [...runs].sort((a, b) => a.ended - b.ended);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].began > sorted[i - 1].ended + GHOST_IDLE_ALLOWANCE_MS + GHOST_END_GRACE_MS) {
      return "those three runs were not played as one match: too long between them";
    }
  }
  return null;
}

/**
 * The local day to freeze ghosts and baselines at: the day the client drew on, as long as
 * that is the first run's local day or the one before (a match started at 23:58 and
 * played after midnight). Anything earlier is refused, since freezing at an old day is a
 * way to pick an easier ghost.
 *
 * @param claimed YYYY-MM-DD from the client, or undefined.
 * @param firstRunDay YYYY-MM-DD of the sitting's first run, in the player's zone.
 */
export function freezeDay(claimed: unknown, firstRunDay: string): string | null {
  if (claimed === undefined || claimed === null) return firstRunDay;
  if (typeof claimed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(claimed)) return null;
  const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const gap = (day(firstRunDay) - day(claimed)) / 86_400_000;
  return gap === 0 || gap === 1 ? claimed : null;
}
