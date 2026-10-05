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
import { matchesServerEvidence, SERVER_TIME_SLOP_MS } from "./serverEvidence.ts";
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
  /**
   * KovaaK's record of this same run found by score, hash and challenge start alone,
   * without asking whether its timestamp agrees (`sameRunRecord`). Supplied so that a
   * record which identifies the run and disagrees about when it was played is read as a
   * contradiction rather than as no evidence. See `serverTimeContradiction`.
   */
  sameRunRecord?: ServerRecord | null;
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

/**
 * KovaaK's says this exact run was played outside the match it is being counted in.
 *
 * Missing evidence is not this. A player with no linked account, a run KovaaK's never
 * received, a record that has scrolled out of the last ten: all of those leave the run
 * where local checks put it, which is the documented policy. This is the opposite case,
 * a record that matches the run on score, hash and challenge start to the millisecond
 * and whose timestamp lies outside the match window. That is positive evidence the
 * run's corrected time is wrong, which makes it a match-window failure, and a
 * match-window failure is already a rejection (FAIR-PLAY.md, "How a run is graded").
 *
 * Measured against the match window, not against the corrected end time, on purpose.
 * KovaaK's timestamp and the window are both server clocks; the corrected time is the
 * player's PC clock plus the offset they declared. Comparing like with like means a PC
 * clock a few minutes out cannot be mistaken for a time shift, while a run played hours
 * before the match, or long after it, still lands far outside. The window is widened by
 * the same three minutes Verified allows for upload latency.
 *
 * Without a match window there is nothing to count the run in, so a disagreement is an
 * advisory and nothing more.
 */
function serverTimeContradiction(input: VerifyInput): { hard: string | null; advisory: string | null } {
  const record = input.sameRunRecord;
  const epoch = record?.epoch;
  if (!record || typeof epoch !== "number" || !Number.isFinite(epoch)) return { hard: null, advisory: null };

  const window = input.consistency?.window;
  if (window) {
    const lo = window.start.getTime() - SERVER_TIME_SLOP_MS;
    const hi = window.end.getTime() + SERVER_TIME_SLOP_MS;
    if (epoch >= lo && epoch <= hi) return { hard: null, advisory: null };
    return {
      hard: `KovaaK's recorded this run at ${new Date(epoch).toISOString()}, outside the match window ` +
        `(${window.start.toISOString()} to ${window.end.toISOString()})`,
      advisory: null,
    };
  }

  const ended = input.run.playedAt?.getTime();
  if (typeof ended === "number" && Number.isFinite(ended) && Math.abs(ended - epoch) > SERVER_TIME_SLOP_MS) {
    const minutes = Math.round((ended - epoch) / 60_000);
    return { hard: null, advisory: `corrected end time is ${minutes} min from KovaaK's record of this run` };
  }
  return { hard: null, advisory: null };
}

export function verifyRun(input: VerifyInput): VerifyOutcome {
  const { run, serverRecord } = input;
  const report = checkConsistency(run, input.consistency ?? {});
  const advisories = [...report.advisories];

  // One advisory escalates rather than only recording, and only this one.
  //
  // Accuracy above anything the scenario has ever produced is the single trace a
  // miss-to-hit conversion leaves: that forgery moves misses into hits, so every counter
  // stays internally consistent and every hard check passes by construction. Recording it
  // in the notes and grading the run `consistent` would file the one forgery we know
  // survives under "unremarkable".
  //
  // It escalates a `consistent` verdict and nothing else. It cannot reach `rejected` -
  // it flags 0.52% of genuine runs, and rejecting honest play is the one thing this
  // module will not do - and it must never touch `verified`, which means KovaaK's own
  // servers saw the run, evidence a locally fitted ceiling has no standing to overturn.
  const accuracyFlagged = report.checks.some(
    (c) => c.id === "accuracy_within_history" && c.status === "fail",
  );

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

  // KovaaK's own record of this run contradicts when it was played. Recorded as a failed
  // hard check beside in_match_window, so the stored notes say why, and rejected the way
  // an out-of-window run already is.
  const contradiction = serverTimeContradiction(input);
  if (contradiction.advisory) advisories.push(contradiction.advisory);
  if (contradiction.hard) {
    const check = { id: "server_time_in_window", severity: "hard" as const, status: "fail" as const, detail: contradiction.hard };
    const failure = `${check.id}: ${check.detail}`;
    return {
      tier: "rejected",
      reasons: [failure],
      advisories,
      report: { ...report, checks: [...report.checks, check], hardFailures: [...report.hardFailures, failure] },
    };
  }

  if (serverRecord) {
    // The strongest possible evidence: KovaaK's saw this exact run.
    const sameScore = scoresMatch(run.score, serverRecord.score);
    const sameHash = !!run.hash && run.hash === serverRecord.hash;
    const serverInWindow = !input.consistency?.window ||
      (serverRecord.epoch !== null &&
        serverRecord.epoch >= input.consistency.window.start.getTime() &&
        serverRecord.epoch <= input.consistency.window.end.getTime());

    if (matchesServerEvidence(run, serverRecord) && serverInWindow) {
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
        tier: accuracyFlagged ? "suspect" : "consistent",
        reasons: [
          accuracyFlagged
            ? "at or below the verified personal best, but accuracy exceeds anything " +
              "the scenario has produced"
            : "internally consistent and at or below the verified personal best",
        ],
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
    tier: accuracyFlagged ? "suspect" : "consistent",
    reasons: [
      accuracyFlagged
        ? "no server record to compare against, and accuracy exceeds anything the " +
          "scenario has produced"
        : "internally consistent; no server record to compare against",
    ],
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
