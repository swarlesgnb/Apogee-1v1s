/**
 * Local integrity checks on a parsed run.
 *
 * These catch the naive attack (opening the CSV and editing `Score:`) without any
 * network call. They are the first half of the verification model (PLAN.md §5); the
 * second half is cross-checking against KovaaK's servers.
 *
 * Design constraint that governs everything here: **a check that flags a legitimate run
 * is worse than no check at all.** A ladder cannot survive accusing honest players. So
 * every check is measured against a corpus of thousands of known-good runs before it is
 * allowed to reject anything, and checks that cannot clear that bar are demoted to
 * advisory rather than deleted. See `validateVerify.ts`.
 */

import type { ParsedRun } from "../stats/parseStatsFile.ts";

export type CheckStatus = "pass" | "fail" | "skip";

/**
 * `hard`     failing means the file is not internally coherent -> reject the run
 * `advisory` failing is suspicious but occurs in genuine runs -> record, never reject
 */
export type CheckSeverity = "hard" | "advisory";

export interface CheckResult {
  id: string;
  severity: CheckSeverity;
  status: CheckStatus;
  detail?: string;
}

export interface ConsistencyReport {
  checks: CheckResult[];
  /** True when no hard check failed. */
  coherent: boolean;
  hardFailures: string[];
  advisories: string[];
}

/** A learned relation `score = <stat> * k` for one scenario. */
export interface ScoreModel {
  stat: "kills" | "hitCount" | "damageDone";
  k: number;
}

export interface ConsistencyContext {
  /** Highest score ever recorded on KovaaK's for this scenario. */
  worldRecord?: number;
  /** Hash the scenario is known to have. */
  knownHash?: string;
  /** Match window, when the run is being submitted for a match. */
  window?: { start: Date; end: Date };
  /** Learned scoring relation, where one is known for this scenario. */
  scoreModel?: ScoreModel;
}

/**
 * Absolute bound on a score's magnitude, used only to catch nonsense. Deliberately
 * enormous: real scores range from double digits to five figures, and some scenarios
 * are legitimately negative.
 */
const MAX_ABS_SCORE = 10_000_000;

/** Tolerance when re-deriving a score from a learned per-scenario model. */
const SCORE_MODEL_TOLERANCE = 0.005;

/**
 * Tolerance on the world-record ceiling. Records move, and our cached copy lags, so
 * this is deliberately loose: it exists to catch `Score:,999999`, not to police
 * genuinely elite play.
 */
const WORLD_RECORD_TOLERANCE = 1.25;

function result(
  id: string,
  severity: CheckSeverity,
  status: CheckStatus,
  detail?: string,
): CheckResult {
  return { id, severity, status, detail };
}

/**
 * Kill rows must agree with the summary kill count.
 *
 * Advisory, not hard: measured at ~99% agreement across a real corpus, and the ~1%
 * that disagree are genuine runs. Some scenarios log kills that the summary counts
 * differently, so a hard rejection here would punish honest players.
 */
function checkKillCount(run: ParsedRun): CheckResult {
  if (run.killRows.length === 0 || run.kills == null) {
    return result("kills_match_rows", "advisory", "skip");
  }
  const ok = run.killRows.length === run.kills;
  return result(
    "kills_match_rows",
    "advisory",
    ok ? "pass" : "fail",
    ok ? undefined : `${run.killRows.length} rows vs Kills:${run.kills}`,
  );
}

/**
 * Hits plus misses must equal the shots the weapon block recorded.
 *
 * This is the strongest cheap check available: editing the score without also
 * rewriting a self-consistent weapon block and hit/miss pair is the common case.
 */
function checkShotBalance(run: ParsedRun): CheckResult {
  const shots = run.weapons.reduce(
    (sum, w) => (w.shots != null ? sum + w.shots : sum),
    0,
  );
  if (shots === 0 || run.hitCount == null || run.missCount == null) {
    return result("shots_balance", "hard", "skip");
  }
  const expected = run.hitCount + run.missCount;
  const ok = expected === shots;
  return result(
    "shots_balance",
    "hard",
    ok ? "pass" : "fail",
    ok ? undefined : `hits+misses=${expected} but shots=${shots}`,
  );
}

/** Weapon-block hits must agree with the summary hit count. */
function checkHitCount(run: ParsedRun): CheckResult {
  const hits = run.weapons.reduce((sum, w) => (w.hits != null ? sum + w.hits : sum), 0);
  if (hits === 0 || run.hitCount == null) {
    return result("hits_match_weapon", "hard", "skip");
  }
  const ok = hits === run.hitCount;
  return result(
    "hits_match_weapon",
    "hard",
    ok ? "pass" : "fail",
    ok ? undefined : `weapon hits=${hits} vs Hit Count:${run.hitCount}`,
  );
}

/**
 * The "Kill #" column must be non-decreasing and never jump.
 *
 * Two corrections learned from a real corpus, both of which had produced false
 * positives:
 *
 *   1. Some scenarios number from 0, others from 1, so the starting value is no signal.
 *   2. "Kill #" is not a row index; it is a running kill COUNTER. Scenarios with
 *      penalty bots (`1w1ts flick pressure` has `Dumbbell` rows with zero hits) emit
 *      rows that repeat the current number without incrementing it. Requiring one row
 *      per kill flagged 0.74% of genuine runs.
 *
 *   3. The counter can also advance by MORE than one, when a single shot kills several
 *      targets: `BARDPILL 1w4t` jumps 36 -> 40. Requiring steps of 0 or 1 still
 *      flagged 0.13% of genuine runs.
 *
 * What survives all three corrections is the only property the format actually
 * guarantees: the counter never runs backwards. That is a weaker check than it first
 * appears, and it is the honest one.
 *
 * Row insertion and deletion are therefore advisory rather than fatal (see
 * `kills_match_rows`). That is an acceptable trade: neither can inflate a score, and
 * an attacker who edits rows AND the kill count to match is caught by
 * `score_matches_model` wherever a model exists.
 */
function checkKillSequence(run: ParsedRun): CheckResult {
  if (run.killRows.length === 0) return result("kill_sequence", "hard", "skip");

  const start = run.killRows[0].killNumber;
  if (start !== 0 && start !== 1) {
    return result("kill_sequence", "hard", "fail", `first kill numbered ${start}`);
  }

  for (let i = 1; i < run.killRows.length; i++) {
    if (run.killRows[i].killNumber < run.killRows[i - 1].killNumber) {
      return result(
        "kill_sequence",
        "hard",
        "fail",
        `counter runs backwards at row ${i + 1} ` +
          `(${run.killRows[i - 1].killNumber} -> ${run.killRows[i].killNumber})`,
      );
    }
  }
  return result("kill_sequence", "hard", "pass");
}

/** Kill timestamps must not travel backwards. */
function checkTimestampOrder(run: ParsedRun): CheckResult {
  if (run.killRows.length < 2) return result("timestamps_monotonic", "hard", "skip");

  let previous = -Infinity;
  for (const row of run.killRows) {
    const t = parseClock(row.timestamp);
    if (t == null) return result("timestamps_monotonic", "hard", "skip");
    // A run can cross midnight, which legitimately wraps the clock backwards.
    if (t < previous && previous - t > 12 * 3600) previous = t;
    else if (t < previous) {
      return result(
        "timestamps_monotonic",
        "hard",
        "fail",
        `${row.timestamp} follows an later timestamp`,
      );
    }
    previous = t;
  }
  return result("timestamps_monotonic", "hard", "pass");
}

/** "21:05:29.571" -> seconds since midnight. */
function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  return (
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] ?? 0}`)
  );
}

/**
 * Time-to-kill must not be negative.
 *
 * An earlier version of this check also rejected any TTK below 20ms as "faster than
 * human reaction". That was a misreading of the field and it flagged **62% of genuine
 * runs**: KovaaK's TTK measures first-hit to kill within a burst, not reaction time, so
 * sub-millisecond values are routine and correct. Only a negative duration is
 * impossible.
 */
function checkTtkSane(run: ParsedRun): CheckResult {
  if (run.killRows.length === 0) return result("ttk_sane", "hard", "skip");

  for (const row of run.killRows) {
    if (row.ttk != null && row.ttk < 0) {
      return result("ttk_sane", "hard", "fail", `negative ttk on kill ${row.killNumber}`);
    }
  }
  return result("ttk_sane", "hard", "pass");
}

/**
 * Score must be a finite number of sane magnitude.
 *
 * Note it may be NEGATIVE: pressure scenarios subtract for misses, and real runs in the
 * corpus score −160, −54 and −500. Requiring a non-negative score flagged them as
 * forgeries.
 */
function checkScoreSane(run: ParsedRun): CheckResult {
  const ok = Number.isFinite(run.score) && Math.abs(run.score) <= MAX_ABS_SCORE;
  return result("score_sane", "hard", ok ? "pass" : "fail", ok ? undefined : `${run.score}`);
}

/**
 * Re-derive the score from the run's own counters.
 *
 * Most scenarios score as a fixed multiple of a countable stat (kills, hits, or damage)
 * and that multiple is a property of the scenario. Where a model is known, this is
 * the check that closes the biggest hole in local verification: editing `Score:` alone,
 * which every other check here sails straight past.
 *
 * Skipped when no model is known, so it can never punish an unmodelled scenario.
 */
function checkScoreModel(run: ParsedRun, ctx: ConsistencyContext): CheckResult {
  const model = ctx.scoreModel;
  if (!model) return result("score_matches_model", "hard", "skip");

  const source =
    model.stat === "kills"
      ? run.kills
      : model.stat === "hitCount"
        ? run.hitCount
        : run.damageDone;

  if (source == null) return result("score_matches_model", "hard", "skip");

  const expected = source * model.k;
  const scale = Math.max(Math.abs(expected), 1);
  const ok = Math.abs(run.score - expected) / scale <= SCORE_MODEL_TOLERANCE;

  return result(
    "score_matches_model",
    "hard",
    ok ? "pass" : "fail",
    ok ? undefined : `score ${run.score} but ${model.stat}*${model.k} = ${expected.toFixed(2)}`,
  );
}

/**
 * Score must not exceed the world record by a wide margin.
 *
 * Universal and cheap: it needs no per-scenario scoring formula, just the ceiling
 * KovaaK's already publishes. It is the check that catches `Score:,999999` regardless
 * of how carefully the rest of the file was forged.
 */
function checkWorldRecord(run: ParsedRun, ctx: ConsistencyContext): CheckResult {
  if (!ctx.worldRecord || ctx.worldRecord <= 0) {
    return result("below_world_record", "hard", "skip");
  }
  const ceiling = ctx.worldRecord * WORLD_RECORD_TOLERANCE;
  const ok = run.score <= ceiling;
  return result(
    "below_world_record",
    "hard",
    ok ? "pass" : "fail",
    ok ? undefined : `${run.score} exceeds ${ceiling.toFixed(0)} (WR ${ctx.worldRecord})`,
  );
}

/**
 * Scenario hash must match the one we know.
 *
 * Hashes were measured to be stable over at least six months, so a mismatch means
 * either a modified scenario or a genuine upstream revision. Advisory, because the
 * latter is not the player's fault and would otherwise reject everyone at once the day
 * a scenario is updated.
 */
function checkHash(run: ParsedRun, ctx: ConsistencyContext): CheckResult {
  if (!ctx.knownHash || !run.hash) return result("hash_known", "advisory", "skip");
  const ok = run.hash === ctx.knownHash;
  return result("hash_known", "advisory", ok ? "pass" : "fail", ok ? undefined : run.hash);
}

/** For match submissions: the run must have been played inside the match window. */
function checkWindow(run: ParsedRun, ctx: ConsistencyContext): CheckResult {
  if (!ctx.window || !run.playedAt) return result("in_match_window", "hard", "skip");
  const t = run.playedAt.getTime();
  const ok = t >= ctx.window.start.getTime() && t <= ctx.window.end.getTime();
  return result(
    "in_match_window",
    "hard",
    ok ? "pass" : "fail",
    ok ? undefined : `played at ${run.playedAt.toISOString()}`,
  );
}

export function checkConsistency(
  run: ParsedRun,
  ctx: ConsistencyContext = {},
): ConsistencyReport {
  const checks = [
    checkScoreSane(run),
    checkScoreModel(run, ctx),
    checkShotBalance(run),
    checkHitCount(run),
    checkKillSequence(run),
    checkKillCount(run),
    checkTimestampOrder(run),
    checkTtkSane(run),
    checkWorldRecord(run, ctx),
    checkHash(run, ctx),
    checkWindow(run, ctx),
  ];

  const hardFailures = checks
    .filter((c) => c.severity === "hard" && c.status === "fail")
    .map((c) => `${c.id}${c.detail ? `: ${c.detail}` : ""}`);

  const advisories = checks
    .filter((c) => c.severity === "advisory" && c.status === "fail")
    .map((c) => `${c.id}${c.detail ? `: ${c.detail}` : ""}`);

  return {
    checks,
    coherent: hardFailures.length === 0,
    hardFailures,
    advisories,
  };
}
