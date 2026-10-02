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

import type { ParsedRun, WeaponSummary } from "../stats/parseStatsFile.ts";

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

/**
 * The weapon block's own learned relations, for one scenario.
 *
 * These exist because 3,159 of 11,427 parsed runs carry no kill rows at all: tracking
 * scenarios built around an invincible target (`Controlsphere`, `Raw Control`,
 * `Snake Track`) score at a rate and never register a kill. Every one of those runs
 * does carry a weapon block (measured, all 3,159, always exactly one weapon row), so that
 * block is what the score has to be reconstructed from instead.
 */
export interface WeaponScoreModel {
  /** `score = Damage Done * scorePerDamage` */
  scorePerDamage: number;
  /** `Damage Possible = Shots * damagePerShot` */
  damagePerShot: number;
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
  /** Learned weapon-block relations, where they are known for this scenario. */
  weaponScoreModel?: WeaponScoreModel;
  /**
   * The scenario's own firing rate, in shots per second, where its shots are engine
   * ticks rather than human clicks. See `checkShotRate`.
   */
  shotsPerSecond?: number;
  /** The scenario's normal length, which the rate above is a rate over. */
  scenarioSeconds?: number;
  /**
   * Highest accuracy the scenario has been seen to produce, plus headroom. Learned per
   * scenario like the score models are, never asserted by the run being checked.
   */
  accuracyCeiling?: number;
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
 * Tolerance on the weapon-block relations. Same 5x headroom over the 0.001 the builder
 * demands before it will call a relation constant, so a run can sit at the far edge of
 * the spread the model was learned from without being called a forgery.
 */
const WEAPON_MODEL_TOLERANCE = 0.005;

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

/** Sum one column of the weapon block. Runs with two weapons exist, so never take [0]. */
function weaponTotal(run: ParsedRun, field: keyof WeaponSummary): number {
  return run.weapons.reduce((sum, w) => {
    const value = w[field];
    return typeof value === "number" ? sum + value : sum;
  }, 0);
}

/** Relative agreement, with an absolute floor so a near-zero expectation is not strict. */
function agrees(actual: number, expected: number): boolean {
  const scale = Math.max(Math.abs(expected), 1);
  return Math.abs(actual - expected) / scale <= WEAPON_MODEL_TOLERANCE;
}

/**
 * Re-derive the score from the weapon block, for runs that have no kill rows.
 *
 * This is the invincible-target counterpart to `score_matches_model`. That check reads
 * the summary tail; on a tracking run against a target that cannot die, `Kills:` is 0
 * and there are no rows to reconstruct from, so the weapon block's `Damage Done` is the
 * only counter left that moves with the score.
 *
 * Measured: `score / Damage Done` is constant for **85 of 85** kill-row-less scenarios
 * with enough history, a better fit than `score / Hits`, which loses
 * `UnderTrack - THE FINALS` to a varying rate. Together with the rate below that covers
 * 2,776 of the 3,159 runs with no kill rows; the rest are scenarios with too little
 * history to learn from, and they skip.
 *
 * It is not merely `score_matches_model` restated. The weapon block mirrors the tail
 * exactly (`Hits` = `Hit Count:` in 11,416 of 11,416 runs, `Damage Done` = `Damage
 * Done:` in 11,415 of 11,415), so this check is worth little alone. Its work is done
 * alongside `damage_possible_rate`, which pins the one column the tail has no copy of.
 *
 * Skipped when no model is known, so an unmodelled scenario is never punished.
 */
function checkWeaponBlockScore(run: ParsedRun, ctx: ConsistencyContext): CheckResult {
  const model = ctx.weaponScoreModel;
  if (!model) return result("score_matches_weapon_block", "hard", "skip");

  const damage = weaponTotal(run, "damageDone");
  // A run that did no damage says nothing about the rate, and dividing into it would
  // make every score look valid.
  if (damage === 0) return result("score_matches_weapon_block", "hard", "skip");

  const expected = damage * model.scorePerDamage;
  const ok = agrees(run.score, expected);
  return result(
    "score_matches_weapon_block",
    "hard",
    ok ? "pass" : "fail",
    ok
      ? undefined
      : `score ${run.score} but damage ${damage} * ${model.scorePerDamage} = ${expected.toFixed(2)}`,
  );
}

/**
 * `Damage Possible` must equal `Shots` times the scenario's damage-per-shot rate.
 *
 * This is the only weapon-block column with no copy in the summary tail, which makes it
 * the one an edit leaves behind. Every other counter in the file is already tied to
 * another: hits to `Hit Count:`, shots to hits plus misses, damage done to
 * `Damage Done:`. So an attacker who moves misses into hits and rewrites the score, the
 * hit and miss counts, the weapon hits and the damage to match is caught here and
 * nowhere else, because raising the shot count raises the damage that was possible.
 *
 * Measured: constant for **287 of 287** scenarios with enough history, across all 9,962
 * runs that have a weapon block, the cleanest relation in the corpus.
 *
 * A model-free version was tried first and rejected. `Damage Done / Hits` should equal
 * `Damage Possible / Shots` if a shot and a hit were worth the same, which would have
 * needed no learned rate at all, but **37.2%** of weapon rows disagree, because a
 * weapon with a headshot multiplier counts what was possible at the higher rate
 * (`pistol`: 25 damage per hit, 50 per shot). A learned per-scenario rate is what
 * survives.
 */
function checkDamagePossible(run: ParsedRun, ctx: ConsistencyContext): CheckResult {
  const model = ctx.weaponScoreModel;
  if (!model) return result("damage_possible_rate", "hard", "skip");

  const shots = weaponTotal(run, "shots");
  const possible = weaponTotal(run, "damagePossible");
  if (shots === 0 || possible === 0) return result("damage_possible_rate", "hard", "skip");

  const expected = shots * model.damagePerShot;
  const ok = agrees(possible, expected);
  return result(
    "damage_possible_rate",
    "hard",
    ok ? "pass" : "fail",
    ok
      ? undefined
      : `damage possible ${possible} but shots ${shots} * ${model.damagePerShot} = ${expected.toFixed(2)}`,
  );
}

/**
 * Headroom over the scenario's fitted firing rate before a shot count is called
 * impossible. Wide on purpose, and priced below: it is the difference between catching
 * a forgery and accusing a player who improved.
 */
const SHOT_RATE_HEADROOM = 1.1;

/**
 * Shots must fit the scenario's own firing rate over its own length.
 *
 * Every other relation here is a RATIO, and a ratio is blind to a uniform scale: an
 * attacker who multiplies the score, the hits, the misses, the shots and both damage
 * columns by the same factor leaves every one of them intact. This is the only check
 * with an absolute anchor, so it is the only one that sees such a forgery at all.
 *
 * It applies where a scenario's shots are engine TICKS rather than human clicks, which
 * is most of the invincible-target tracking set: the weapon fires continuously, so the
 * shot count is a property of the scenario and the clock, not of the player. That is
 * gated by the corpus rather than assumed - a scenario qualifies only where the fastest
 * run is within 2% of the median one - and 102 scenarios do, 83 of them kill-row-less.
 *
 * A per-player CEILING was measured first and rejected, though it looked fine: the
 * fastest rate the player ever reached, plus 25%, flags nothing in this corpus. But at
 * any tighter headroom every run it flags is a *clicking* scenario where the player
 * simply got faster (`10 Sphere Hipfire Extra Small`, `skyClick Goated Medium`). The
 * bound was one player's clicking speed, and on a real ladder a better player clears it
 * by playing well. A tick rate is a fact about the scenario and cannot be outgrown.
 *
 * Measured at this headroom: 0.00% of 3,274 runs in sample, and 0.00% of 1,559 out of
 * sample - each scenario's rate fitted on its earlier runs and tested on its later
 * ones, which is the question that matters, since a rate fitted to a corpus cannot flag
 * that corpus. The median rather than the fastest run sets the rate, so one bad
 * training run cannot raise the bar for everyone.
 *
 * A ceiling, never a floor: a run cut short by a crash has far too FEW shots, and that
 * is `runDurationSeconds`'s business, not this one.
 *
 * The gap left is stated rather than hidden: a uniform scale-up of under 10% still fits
 * underneath, and no local check sees it.
 */
function checkShotRate(run: ParsedRun, ctx: ConsistencyContext): CheckResult {
  const { shotsPerSecond, scenarioSeconds } = ctx;
  if (!shotsPerSecond || !scenarioSeconds) return result("shots_per_second", "hard", "skip");

  const shots = weaponTotal(run, "shots");
  if (shots === 0) return result("shots_per_second", "hard", "skip");

  const ceiling = scenarioSeconds * shotsPerSecond * SHOT_RATE_HEADROOM;
  const ok = shots <= ceiling;
  return result(
    "shots_per_second",
    "hard",
    ok ? "pass" : "fail",
    ok
      ? undefined
      : `${shots} shots in ${scenarioSeconds}s is ${(shots / scenarioSeconds).toFixed(1)}/s, ` +
        `over the ${(shotsPerSecond * SHOT_RATE_HEADROOM).toFixed(1)}/s this scenario fires`,
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
 * KovaaK's writes the MD5 of the scenario file into the stats file, so this is the check
 * that the player ran the file the season ships and not an edited copy under the same
 * name - bigger targets, a slower timescale. Measured before it was allowed to reject
 * (validate:verify): all 13,890 stats files in the corpus carry a hash, and 25 of the 26
 * Season 1 playtest runs carry exactly the MD5 of a committed version of their file - the
 * other was played on a build installed before it was committed.
 *
 * HARD, and it can be, because `known_hash` is only ever set for Apogee's own scenarios,
 * from the committed file (sync:reference). The reason this used to be advisory - a
 * borrowed scenario's author can revise it, which is not the player's fault - does not
 * arise: Apogee is the only author, a revision ships the file and its hash together, and
 * the app rewrites any installed file that differs. A borrowed scenario has no known hash
 * and the check skips.
 */
function checkHash(run: ParsedRun, ctx: ConsistencyContext): CheckResult {
  if (!ctx.knownHash) return result("hash_known", "hard", "skip");
  const ok = run.hash === ctx.knownHash;
  return result("hash_known", "hard", ok ? "pass" : "fail", ok ? undefined : run.hash ?? "no hash in the file");
}

/**
 * Accuracy must not exceed what the scenario has actually been seen to produce.
 *
 * This is the only shape of check that catches a miss-to-hit conversion. A run on an
 * invincible target carries no kill rows, so the score models have no counter to read,
 * and moving misses into hits keeps every other counter internally consistent: the
 * forgery survives every hard check here. Two such conversions, one at +20% and one
 * pushed to 100% accuracy, are the only forgeries `attack:verify` still lets through
 * that PLAN.md does not already document as a known gap.
 *
 * ADVISORY, and it will not be promoted. Measured over the corpus it flags 0.52% of
 * genuine runs, and that number is a floor rather than an estimate: the ceiling is
 * fitted from history, so a player who improves clears their own bar by playing well,
 * and a genuine personal best is exactly the shape this fires on. A check that rejects
 * honest play is worse than no check (see the header), so this one records and never
 * rejects - which is enough, because the tier it feeds is what a reviewer reads.
 *
 * Skips rather than fails where no ceiling is known, like every other learned relation
 * here: a scenario with no history to fit against has nothing to say about this run.
 */
function checkAccuracyWithinHistory(run: ParsedRun, ctx: ConsistencyContext): CheckResult {
  if (run.accuracy == null || ctx.accuracyCeiling == null) {
    return result("accuracy_within_history", "advisory", "skip");
  }
  const ok = run.accuracy <= ctx.accuracyCeiling;
  return result(
    "accuracy_within_history",
    "advisory",
    ok ? "pass" : "fail",
    // Accuracy is a fraction on ParsedRun; the notes are read by a human, so they carry
    // the percentage everything else in the codebase prints.
    ok
      ? undefined
      : `${(100 * run.accuracy).toFixed(1)}% over a ceiling of ` +
        `${(100 * ctx.accuracyCeiling).toFixed(1)}%`,
  );
}

/** For match submissions: the run must have been played inside the match window. */
function checkWindow(run: ParsedRun, ctx: ConsistencyContext): CheckResult {
  if (!ctx.window) return result("in_match_window", "hard", "skip");
  if (!run.playedAt || !Number.isFinite(run.playedAt.getTime())) {
    return result("in_match_window", "hard", "fail", "run timestamp is missing or invalid");
  }
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
    checkWeaponBlockScore(run, ctx),
    checkDamagePossible(run, ctx),
    checkShotRate(run, ctx),
    checkShotBalance(run),
    checkHitCount(run),
    checkKillSequence(run),
    checkKillCount(run),
    checkTimestampOrder(run),
    checkTtkSane(run),
    checkWorldRecord(run, ctx),
    checkHash(run, ctx),
    checkAccuracyWithinHistory(run, ctx),
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
