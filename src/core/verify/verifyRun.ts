/**
 * Assign a verification tier to a run (PLAN.md §5).
 *
 * Two independent sources of truth:
 *
 *   LOCAL   the file must be internally coherent (see consistency.ts). Catches naive
 *           edits with zero network cost and, measured across 11,058 genuine runs,
 *           zero false positives.
 *
 *   REMOTE  KovaaK's own servers hold a record of the player's personal best, keyed by
 *           SteamID, with the same `hash` and `challengeStart` fields the local CSV
 *           carries. A forged local file cannot produce a matching server record.
 *
 * The honest limitation, measured rather than assumed: KovaaK's stores only the
 * personal best, and ~1 in 9 genuine PBs never reach their servers at all (offline
 * play, a crash, a failed submit). So "above your verified PB with no server record"
 * cannot mean "forged"; it means *look closer*. That is the Suspect tier, and it is
 * why this module never auto-voids on that basis alone.
 */

import type { ParsedRun } from "../stats/parseStatsFile.ts";
import {
  checkConsistency,
  type ConsistencyContext,
  type ConsistencyReport,
} from "./consistency.ts";

export type VerificationTier = "verified" | "consistent" | "suspect" | "rejected";

export interface ServerRecord {
  score: number;
  hash: string | null;
  challengeStart: string | null;
  /** KovaaK's submission time, ms since epoch. */
  epoch: number | null;
}

export interface VerifyInput {
  run: ParsedRun;
  /** KovaaK's record for this player and scenario, if one exists. */
  serverRecord?: ServerRecord | null;
  consistency?: ConsistencyContext;
}

export interface VerifyOutcome {
  tier: VerificationTier;
  reasons: string[];
  advisories: string[];
  report: ConsistencyReport;
}

/**
 * How far above the verified personal best a run may sit before it stops being merely
 * unremarkable. Small, because a sub-PB run is the normal case and this bound only has
 * to absorb rounding and a stale cache.
 */
const PB_TOLERANCE = 1.02;

/** Scores agree if they are within this fraction; the API reports fixed-point. */
const SCORE_EPSILON = 0.001;

function scoresMatch(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= SCORE_EPSILON;
}

export function verifyRun(input: VerifyInput): VerifyOutcome {
  const { run, serverRecord } = input;
  const report = checkConsistency(run, input.consistency ?? {});
  const advisories = [...report.advisories];

  // An incoherent file is rejected regardless of what any server says. This is the
  // only path that voids a match outright.
  if (!report.coherent) {
    return {
      tier: "rejected",
      reasons: report.hardFailures,
      advisories,
      report,
    };
  }

  if (serverRecord) {
    // The strongest possible evidence: KovaaK's saw this exact run.
    const sameScore = scoresMatch(run.score, serverRecord.score);
    const sameHash =
      !run.hash || !serverRecord.hash || run.hash === serverRecord.hash;
    const sameStart =
      !run.challengeStart ||
      !serverRecord.challengeStart ||
      run.challengeStart === serverRecord.challengeStart;

    if (sameScore && sameHash && sameStart) {
      return { tier: "verified", reasons: ["matches KovaaK's server record"], advisories, report };
    }

    if (sameScore && !sameHash) {
      advisories.push(
        `scenario hash differs from server record (${run.hash} vs ${serverRecord.hash})`,
      );
    }

    // Below the player's demonstrated ability: unremarkable, and the common case,
    // since KovaaK's only ever stores the best.
    if (run.score <= serverRecord.score * PB_TOLERANCE) {
      return {
        tier: "consistent",
        reasons: ["internally consistent and at or below the verified personal best"],
        advisories,
        report,
      };
    }

    // Above the verified PB with no matching server record. Genuine ~1 time in 9, so
    // this is flagged for review and still counts; escalation is a matter of
    // repetition and magnitude, decided elsewhere.
    return {
      tier: "suspect",
      reasons: [
        `score ${run.score} exceeds verified PB ${serverRecord.score} ` +
          "with no matching server record",
      ],
      advisories,
      report,
    };
  }

  // No server record at all: a scenario the player has never submitted, or a first
  // run. Nothing to contradict, nothing to confirm.
  return {
    tier: "consistent",
    reasons: ["internally consistent; no server record to compare against"],
    advisories,
    report,
  };
}

/** Does this tier permit the run to count toward a match result? */
export function countsTowardMatch(tier: VerificationTier): boolean {
  return tier !== "rejected";
}

/** Should a human look at this run? */
export function needsReview(tier: VerificationTier): boolean {
  return tier === "suspect";
}
