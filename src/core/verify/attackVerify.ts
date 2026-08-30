/**
 * Attack the local verification checks, and price what it costs to stop the attack.
 *
 * `validateVerify.ts` asks whether the checks hold. This asks the adversarial half of
 * the same question: what does a forgery actually have to do to get through, and how
 * many honest players does the check that stops it accuse?
 *
 * Three differences from `validateVerify.ts`, all deliberate:
 *
 *   1. Forgeries are written as CSV TEXT and fed back through the real parser, not
 *      built by mutating a `ParsedRun`. An object-level mutation only tests what the
 *      checks read; a text-level one tests what the parser reads too, which is where
 *      a forger actually works.
 *
 *   2. False positives are measured OUT OF SAMPLE as well as in. Every learned model
 *      is fitted to this same corpus, so a check derived from it cannot flag it, and
 *      an in-sample 0.00% is partly guaranteed by construction. Training on each
 *      scenario's earlier runs and measuring on its later ones is the question that
 *      actually matters: models built today, runs arriving tomorrow.
 *
 *   3. Nothing here can weaken a check. It only measures, forges, and reports.
 *
 *   npx tsx src/core/verify/attackVerify.ts [statsFolder]
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseStatsFile, type ParsedRun } from "../stats/parseStatsFile.ts";
import {
  checkConsistency,
  type ConsistencyContext,
  type ScoreModel,
  type WeaponScoreModel,
} from "./consistency.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

/** Both match the builder: a scenario below this yields no model at all. */
const MIN_RUNS = 8;
const FIT_TOLERANCE = 0.001;
/** Matches the builder: how close fastest must sit to median to count as a tick rate. */
const TICK_RATE_GATE = 1.02;

interface Loaded {
  file: string;
  text: string;
  run: ParsedRun;
}

function loadRuns(dir: string): Loaded[] {
  const out: Loaded[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith("Stats.csv"))) {
    try {
      const text = readFileSync(join(dir, file), "utf8");
      const result = parseStatsFile(file, text);
      if (result.ok) out.push({ file, text, run: result.run });
    } catch {
      /* the parser is validated separately */
    }
  }
  return out;
}

function groupByScenario(loaded: Loaded[]): Map<string, Loaded[]> {
  const byScenario = new Map<string, Loaded[]>();
  for (const item of loaded) {
    const list = byScenario.get(item.run.scenario) ?? [];
    list.push(item);
    byScenario.set(item.run.scenario, list);
  }
  return byScenario;
}

interface Models {
  score: Map<string, ScoreModel>;
  weapon: Map<string, WeaponScoreModel>;
  /** Fitted firing rate, for the scenarios whose shots are engine ticks. */
  shotRate: Map<string, number>;
}

/**
 * Fit both model kinds over the runs given.
 *
 * Re-derived here rather than imported from `buildScoreModels.ts`, for two reasons.
 * The builder calls `main()` at module scope, so importing it rewrites `data/` as a
 * side effect of measuring. And an attacker checking someone else's arithmetic should
 * do the arithmetic themselves: if this disagrees with the shipped models, that
 * disagreement is a finding, not a nuisance.
 */
function fitModels(
  byScenario: Map<string, Loaded[]>,
  seconds: Map<string, number>,
): Models {
  const score = new Map<string, ScoreModel>();
  const weapon = new Map<string, WeaponScoreModel>();
  const shotRate = new Map<string, number>();

  for (const [scenario, items] of byScenario) {
    if (items.length < MIN_RUNS) continue;
    const runs = items.map((i) => i.run);

    const stats: [ScoreModel["stat"], (r: ParsedRun) => number | null][] = [
      ["kills", (r) => r.kills],
      ["hitCount", (r) => r.hitCount],
      ["damageDone", (r) => r.damageDone],
    ];
    for (const [stat, get] of stats) {
      const k = constantRatio(runs, (r) => r.score, (r) => get(r) ?? 0);
      if (k != null) {
        score.set(scenario, { stat, k });
        break;
      }
    }

    const scorePerDamage = constantRatio(
      runs,
      (r) => r.score,
      (r) => weaponSum(r, "damageDone"),
    );
    const damagePerShot = constantRatio(
      runs,
      (r) => weaponSum(r, "damagePossible"),
      (r) => weaponSum(r, "shots"),
    );
    if (scorePerDamage != null && damagePerShot != null) {
      weapon.set(scenario, { scorePerDamage, damagePerShot });
    }

    // Only where the shots are engine ticks rather than clicks: the fastest run must
    // sit within TICK_RATE_GATE of the median, or the rate is the player's clicking
    // speed and bounding anyone by it is a false positive waiting to happen.
    const sec = seconds.get(scenario);
    if (sec) {
      const rates = runs
        .map((r) => weaponSum(r, "shots") / sec)
        .filter((rate) => rate > 0)
        .sort((a, b) => a - b);
      if (rates.length >= MIN_RUNS) {
        const median = rates[Math.floor(rates.length / 2)];
        const fastest = rates[rates.length - 1];
        if (median > 0 && fastest / median <= TICK_RATE_GATE) shotRate.set(scenario, median);
      }
    }
  }
  return { score, weapon, shotRate };
}

/** The constant `num/den` across a scenario's runs, or null where it is not constant. */
function constantRatio(
  runs: ParsedRun[],
  num: (r: ParsedRun) => number,
  den: (r: ParsedRun) => number,
): number | null {
  const ratios: number[] = [];
  for (const run of runs) {
    const d = den(run);
    if (d === 0) continue;
    const ratio = num(run) / d;
    if (Number.isFinite(ratio)) ratios.push(ratio);
  }
  if (ratios.length < MIN_RUNS) return null;

  const first = ratios[0];
  if (first === 0) return null;
  if (!ratios.every((r) => Math.abs(r - first) / Math.abs(first) <= FIT_TOLERANCE)) {
    return null;
  }

  // Snap to a clean value only where snapping does not move the number: weapon damage
  // rates run as small as 0.001 per shot, and three decimals cannot hold those.
  const rounded = Math.round(first * 1000) / 1000;
  if (Math.abs(rounded - first) / Math.abs(first) > 1e-9) return first;
  const integer = Math.round(rounded);
  return Math.abs(rounded - integer) < 1e-6 ? integer : rounded;
}

// ---- CSV surgery ---------------------------------------------------------------
// A forger edits text, so these do too. Each throws when the field it was told to edit
// is absent: a silent no-op would score as "the check caught it" when in fact nothing
// was ever forged, which is the one way this harness could lie in the reassuring
// direction.

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setTail(text: string, key: string, value: string | number): string {
  const re = new RegExp(`^${escapeRe(key)}:,.*$`, "m");
  if (!re.test(text)) throw new Error(`no tail field "${key}:"`);
  return text.replace(re, `${key}:,${value}`);
}

/** Rewrite the weapon row, column by column, addressed by header name. */
function editWeaponRow(text: string, edits: Record<string, string | number>): string {
  const lines = text.split(/\r?\n/);
  const headerAt = lines.findIndex((l) => l.startsWith("Weapon,"));
  if (headerAt < 0) throw new Error("no weapon block");

  const header = lines[headerAt].split(",").map((c) => c.trim());
  const rowAt = headerAt + 1;
  if (!lines[rowAt] || lines[rowAt].trim() === "") throw new Error("no weapon row");
  if (lines[rowAt + 1] && lines[rowAt + 1].trim() !== "") {
    throw new Error("more than one weapon row");
  }

  const cells = lines[rowAt].split(",");
  for (const [name, value] of Object.entries(edits)) {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`weapon block has no "${name}" column`);
    cells[i] = String(value);
  }
  lines[rowAt] = cells.join(",");
  return lines.join("\n");
}

/**
 * Append `count` kill rows, copied from a genuine row and re-timed to follow the last
 * one. The counter keeps climbing and the clock keeps moving forward, which is all
 * `kill_sequence` and `timestamps_monotonic` actually require of them.
 */
function appendKillRows(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  let last = 0;
  while (last + 1 < lines.length && lines[last + 1].trim() !== "") last++;
  if (last === 0) throw new Error("no kill rows to copy");

  const template = lines[last].split(",");
  const lastNumber = Number(template[0]);
  const lastClock = parseClock(template[1]);
  if (!Number.isFinite(lastNumber) || lastClock == null) {
    throw new Error("unreadable final kill row");
  }

  const added: string[] = [];
  for (let i = 1; i <= count; i++) {
    const cells = [...template];
    cells[0] = String(lastNumber + i);
    cells[1] = formatClock(lastClock + i * 0.35);
    added.push(cells.join(","));
  }
  lines.splice(last + 1, 0, ...added);
  return lines.join("\n");
}

function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] ?? 0}`);
}

function formatClock(seconds: number): string {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  const ms = String(Math.round((s % 1) * 1000)).padStart(3, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${ms}`;
}

// ---- attacks --------------------------------------------------------------------

interface Attack {
  name: string;
  /** Which victim shape the attack needs. */
  needs: "killRows" | "noKillRows" | "unmodelled";
  /** What the player would have gained. Printed so a catch can be weighed. */
  gain: (before: ParsedRun, after: ParsedRun) => string;
  forge: (victim: Loaded, models: Models) => string;
  /** Set when getting through is a documented gap rather than a live failure. */
  knownGap?: string;
}

const ATTACKS: Attack[] = [
  {
    name: "score line edited, nothing else (+8%)",
    needs: "killRows",
    gain: (b, a) => `${b.score} -> ${a.score}`,
    forge: (v) => setTail(v.text, "Score", Math.round(v.run.score * 1.08)),
  },
  {
    name: "score +1%, the smallest edit worth making",
    needs: "killRows",
    gain: (b, a) => `${b.score} -> ${a.score}`,
    forge: (v) => setTail(v.text, "Score", Math.round(v.run.score * 1.01)),
  },
  {
    // The forgery a patient attacker writes against a kill-row scenario: every counter
    // the checks cross-reference is moved together, so nothing inside the file is left
    // to disagree with anything else.
    name: "coherent kill inflation (+15%: rows, counts and weapon block all moved)",
    needs: "killRows",
    gain: (b, a) => `${b.score} -> ${a.score} (${b.kills} -> ${a.kills} kills)`,
    forge: (v, models) => {
      const r = v.run;
      const model = models.score.get(r.scenario)!;
      const extra = Math.max(1, Math.round((r.kills ?? 0) * 0.15));
      const hitsPerKill = (r.hitCount ?? 0) / Math.max(1, r.kills ?? 1);
      const addedHits = Math.min(r.missCount ?? 0, Math.round(extra * hitsPerKill));

      let text = appendKillRows(v.text, extra);
      text = setTail(text, "Kills", (r.kills ?? 0) + extra);
      text = setTail(text, "Hit Count", (r.hitCount ?? 0) + addedHits);
      text = setTail(text, "Miss Count", (r.missCount ?? 0) - addedHits);
      text = editWeaponRow(text, { Hits: (r.weapons[0].hits ?? 0) + addedHits });
      return setTail(text, "Score", ((r.kills ?? 0) + extra) * model.k);
    },
  },
  {
    // The gap PLAN.md §5 names outright, and what the two weapon-block checks were
    // added to close: an invincible-target tracking run has no kill rows to contradict
    // its summary, so the weapon block is the whole file.
    //
    // Shots are left alone and misses are converted into hits. Hits plus misses still
    // equals Shots, the weapon block still mirrors the tail, `Damage Possible` is
    // untouched so its learned rate still holds, and the score is re-derived from the
    // inflated damage so both score models still agree with it.
    name: "misses converted to hits on an invincible-target run (+20%)",
    needs: "noKillRows",
    gain: (b, a) =>
      `${b.score} -> ${a.score}, accuracy ` +
      `${(100 * (b.accuracy ?? 0)).toFixed(1)}% -> ${(100 * (a.accuracy ?? 0)).toFixed(1)}%`,
    forge: (v, models) => forgeHitConversion(v, models, 0.2),
  },
  {
    // The same attack pushed to where the file itself stops it: every miss becomes a
    // hit. Nothing local bounds accuracy, so the ceiling here is 100%, not a check.
    name: "the same, pushed to 100% accuracy",
    needs: "noKillRows",
    gain: (b, a) =>
      `${b.score} -> ${a.score} ` +
      `(x${(a.score / Math.max(b.score, 1)).toFixed(2)}), accuracy ` +
      `${(100 * (b.accuracy ?? 0)).toFixed(1)}% -> ${(100 * (a.accuracy ?? 0)).toFixed(1)}%`,
    forge: (v, models) => forgeHitConversion(v, models, 1),
  },
  {
    // Every check in the battery is a ratio or a sum identity, and both survive
    // multiplication. Nothing ties any counter to elapsed time, so the shot count is
    // free: multiply the whole weapon block and the summary by the same factor and the
    // file stays exactly as coherent as it started, at any score.
    name: "uniform x3 scale-up of every counter in the file",
    needs: "noKillRows",
    gain: (b, a) => `${b.score} -> ${a.score} (x${(a.score / Math.max(b.score, 1)).toFixed(2)})`,
    forge: (v) => forgeUniformScale(v, 3),
  },
  {
    name: "score edit on a scenario with no learned model (+8%)",
    needs: "unmodelled",
    gain: (b, a) => `${b.score} -> ${a.score}`,
    forge: (v) => setTail(v.text, "Score", Math.round(v.run.score * 1.08)),
    knownGap:
      "stated in PLAN.md §5: an unmodelled scenario skips the score checks rather " +
      "than failing them, and the gap closes as history accumulates",
  },
];

/** Move `share` of the misses into the hit column, and re-derive everything from it. */
function forgeHitConversion(v: Loaded, models: Models, share: number): string {
  const r = v.run;
  const weapon = models.weapon.get(r.scenario)!;
  const moved = Math.floor((r.missCount ?? 0) * share);
  if (moved === 0) throw new Error("no misses to convert");

  const hits = (r.hitCount ?? 0) + moved;
  // Damage tracks hits at whatever rate this scenario pays per hit, so the two move
  // together; taking the rate from the run itself keeps it exact.
  const damagePerHit = (r.weapons[0].damageDone ?? 0) / Math.max(1, r.hitCount ?? 1);
  const damage = round3(hits * damagePerHit);

  let text = setTail(v.text, "Hit Count", hits);
  text = setTail(text, "Miss Count", (r.missCount ?? 0) - moved);
  text = setTail(text, "Damage Done", damage.toFixed(1));
  text = editWeaponRow(text, { Hits: hits, "Damage Done": damage.toFixed(1) });
  return setTail(text, "Score", round3(damage * weapon.scorePerDamage).toFixed(1));
}

/** Multiply every counter, in the weapon block and the tail alike, by `factor`. */
function forgeUniformScale(v: Loaded, factor: number): string {
  const r = v.run;
  const w = r.weapons[0];
  const scale = (n: number | null | undefined) => round3((n ?? 0) * factor);

  let text = editWeaponRow(v.text, {
    Shots: scale(w.shots),
    Hits: scale(w.hits),
    "Damage Done": scale(w.damageDone).toFixed(1),
    "Damage Possible": scale(w.damagePossible).toFixed(1),
  });
  text = setTail(text, "Hit Count", scale(r.hitCount));
  text = setTail(text, "Miss Count", scale(r.missCount));
  text = setTail(text, "Damage Done", scale(r.damageDone).toFixed(1));
  return setTail(text, "Score", scale(r.score).toFixed(1));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---- candidate strengthenings ---------------------------------------------------
// Proposals only. Nothing below is wired into `checkConsistency`; each is measured
// against the corpus here so its false-positive rate is known BEFORE anyone considers
// letting it reject a run, which is the order PLAN.md §5 insists on.

interface Candidate {
  id: string;
  what: string;
  /** null when the run carries nothing to judge, exactly like a `skip`. */
  holds: (run: ParsedRun, ctx: CandidateContext) => boolean | null;
}

interface CandidateContext {
  duration: number | null;
  /** Both fitted per scenario from the corpus, not asserted. */
  rateCeiling?: number;
  accuracyCeiling?: number;
}

const CANDIDATES: Candidate[] = [
  {
    id: "damage_done_le_possible",
    what: "weapon-block Damage Done must not exceed Damage Possible",
    holds: (run) => {
      const done = weaponSum(run, "damageDone");
      const possible = weaponSum(run, "damagePossible");
      if (done === 0 || possible === 0) return null;
      return done <= possible * 1.001;
    },
  },
  {
    id: "hits_le_shots",
    what: "hits must not exceed shots, and misses must not be negative",
    holds: (run) => {
      const shots = weaponSum(run, "shots");
      if (shots === 0 || run.hitCount == null || run.missCount == null) return null;
      return run.hitCount <= shots && run.missCount >= 0;
    },
  },
  {
    // Included to be measured and REJECTED, which is the useful result. It is the only
    // shape of check that could stop a miss-to-hit conversion locally, and its ceiling
    // has to come from history, fitted leave-one-out so a run never sets its own bar.
    // Two things then go wrong at once: it flags genuine personal bests, and its
    // ceiling is one player's history, so on a real ladder a better player clears it by
    // playing well. The rate printed below is therefore a floor on its true cost, not
    // an estimate of it.
    id: "accuracy_within_history",
    what: "accuracy must not exceed the scenario's own history (leave-one-out, +10%)",
    holds: (run, ctx) => {
      if (run.accuracy == null || ctx.accuracyCeiling == null) return null;
      return run.accuracy <= ctx.accuracyCeiling;
    },
  },
];

function weaponSum(run: ParsedRun, field: "shots" | "damageDone" | "damagePossible"): number {
  return run.weapons.reduce((sum, w) => (w[field] != null ? sum + w[field]! : sum), 0);
}

// ---- report ---------------------------------------------------------------------

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;
  const loaded = loadRuns(dir);

  console.log(`stats folder : ${dir}`);
  console.log(`runs         : ${loaded.length}\n`);
  if (loaded.length === 0) {
    console.error("No runs to attack.");
    process.exit(1);
  }

  const byScenario = groupByScenario(loaded);

  // Scenario lengths, learned reference data rather than anything a run claims about
  // itself. The firing-rate bound is a rate over this, so a forger who could choose it
  // could clear the bound by declaring a longer run.
  const durationSeconds = new Map<string, number>();
  const durationFile = JSON.parse(
    readFileSync(new URL("../../../data/scenario_durations.json", import.meta.url), "utf8"),
  ) as { durations: Record<string, { scenario: string; seconds: number | null }> };
  for (const d of Object.values(durationFile.durations)) {
    if (d.seconds != null) durationSeconds.set(d.scenario, d.seconds);
  }

  const models = fitModels(byScenario, durationSeconds);

  const taxonomy = JSON.parse(
    readFileSync(new URL("../../../data/scenario_taxonomy.json", import.meta.url), "utf8"),
  ) as { scenarios: { name: string; topScore: number | null }[] };
  const worldRecords = new Map(
    taxonomy.scenarios.filter((s) => s.topScore).map((s) => [s.name, s.topScore!]),
  );

  // Accuracy ceilings, leave-one-out: for each scenario, the best accuracy any OTHER
  // run of it reached. Taking the top two is enough to answer "excluding this run" for
  // every run at once.
  //
  // Fitted here rather than inside the candidate block it started in, because
  // accuracy_within_history is a shipped advisory now and `contextFor` has to supply it
  // the same way the Edge Function will - otherwise this file reports on a set of checks
  // the server does not actually run.
  const topTwoAccuracy = new Map<string, [number, number]>();
  for (const [scenario, items] of byScenario) {
    let best = -Infinity;
    let second = -Infinity;
    for (const { run } of items) {
      if (run.accuracy == null) continue;
      if (run.accuracy > best) {
        second = best;
        best = run.accuracy;
      } else if (run.accuracy > second) second = run.accuracy;
    }
    if (Number.isFinite(second)) topTwoAccuracy.set(scenario, [best, second]);
  }
  const accuracyCeilingFor = (run: ParsedRun): number | undefined => {
    const pair = topTwoAccuracy.get(run.scenario);
    if (!pair || run.accuracy == null) return undefined;
    const others = run.accuracy >= pair[0] ? pair[1] : pair[0];
    return others * 1.1;
  };

  const contextFor = (run: ParsedRun, m: Models = models): ConsistencyContext => {
    const rate = m.shotRate.get(run.scenario);
    const sec = durationSeconds.get(run.scenario);
    return {
      worldRecord: worldRecords.get(run.scenario),
      scoreModel: m.score.get(run.scenario),
      weaponScoreModel: m.weapon.get(run.scenario),
      // Both or neither, exactly as the Edge Function supplies them.
      shotsPerSecond: rate != null && sec != null ? rate : undefined,
      scenarioSeconds: rate != null && sec != null ? sec : undefined,
      accuracyCeiling: accuracyCeilingFor(run),
    };
  };

  console.log(
    `models fitted from this corpus : ${models.score.size} score, ` +
      `${models.weapon.size} weapon-block\n`,
  );

  // ---- 1. false positives, in sample -------------------------------------------
  console.log("── false positives, models fitted on all runs ───");
  reportFalsePositives(loaded, (run) => contextFor(run));

  // ---- 2. false positives, out of sample ---------------------------------------
  // The number that decides whether the checks survive contact with tomorrow's runs.
  // Fit each scenario's models on its earlier half, then measure on its later half:
  // a model cannot flag the very runs it was fitted to, so an in-sample rate flatters
  // every learned check by construction.
  console.log("\n── false positives, fitted on each scenario's earlier half ──");

  const trainByScenario = new Map<string, Loaded[]>();
  const held: Loaded[] = [];
  for (const [scenario, items] of byScenario) {
    const ordered = [...items].sort(
      (a, b) => (a.run.playedAt?.getTime() ?? 0) - (b.run.playedAt?.getTime() ?? 0),
    );
    const cut = Math.ceil(ordered.length / 2);
    trainByScenario.set(scenario, ordered.slice(0, cut));
    held.push(...ordered.slice(cut));
  }
  const heldOutModels = fitModels(trainByScenario, durationSeconds);
  console.log(
    `held-out runs : ${held.length}   models : ${heldOutModels.score.size} score, ` +
      `${heldOutModels.weapon.size} weapon-block\n`,
  );
  reportFalsePositives(held, (run) => contextFor(run, heldOutModels));

  // ---- 3. forgeries ------------------------------------------------------------
  console.log("\n── forgeries, written as CSV and re-parsed ──────");

  // Victim selection is where this harness could most easily fool itself. A run that
  // scores 0 with no misses satisfies every structural predicate below and yields a
  // forgery that gains nothing, which then reports as "SLIPPED" while proving nothing
  // — the same shape of vacuous pass PLAN.md §5 records already having hidden a real
  // bug. So every victim must have something to inflate, and the richest qualifying
  // run is taken rather than the first.
  const richest = (ok: (l: Loaded) => boolean) =>
    loaded.filter(ok).sort((a, b) => b.run.score - a.run.score)[0];

  const victims: Record<Attack["needs"], Loaded | undefined> = {
    killRows: richest(
      ({ run }) =>
        run.killRows.length > 20 &&
        run.weapons.length === 1 &&
        run.score > 0 &&
        (run.hitCount ?? 0) > 0 &&
        (run.missCount ?? 0) > 0 &&
        models.score.get(run.scenario)?.stat === "kills" &&
        models.weapon.has(run.scenario),
    ),
    // The case the two new weapon-block checks exist for.
    noKillRows: richest(
      ({ run }) =>
        run.killRows.length === 0 &&
        run.weapons.length === 1 &&
        run.score > 0 &&
        (run.hitCount ?? 0) > 0 &&
        (run.missCount ?? 0) > 0 &&
        models.weapon.has(run.scenario),
    ),
    unmodelled: richest(
      ({ run }) =>
        run.weapons.length === 1 &&
        run.score > 0 &&
        !models.score.has(run.scenario) &&
        !models.weapon.has(run.scenario),
    ),
  };

  for (const [need, victim] of Object.entries(victims)) {
    console.log(
      victim
        ? `  victim (${need}) : ${victim.run.scenario}, score ${victim.run.score}, ` +
            `${victim.run.hitCount}/${(victim.run.hitCount ?? 0) + (victim.run.missCount ?? 0)} hits`
        : `  victim (${need}) : none found`,
    );
  }
  console.log();

  const survivors: { attack: Attack; victim: Loaded; forged: ParsedRun }[] = [];
  let slipped = 0;

  for (const attack of ATTACKS) {
    const victim = victims[attack.needs];
    if (!victim) {
      console.log(`  SKIP    ${attack.name}: no victim of the required shape`);
      continue;
    }

    let forged: string;
    try {
      forged = attack.forge(victim, models);
    } catch (e) {
      console.log(`  SKIP    ${attack.name}: ${(e as Error).message}`);
      continue;
    }
    if (forged === victim.text) {
      console.log(`  SKIP    ${attack.name}: the forgery was a no-op`);
      continue;
    }

    const reparsed = parseStatsFile(victim.file, forged);
    if (!reparsed.ok) {
      console.log(`  SKIP    ${attack.name}: no longer parses (${reparsed.reason})`);
      continue;
    }

    const report = checkConsistency(reparsed.run, contextFor(victim.run));
    const caught = !report.coherent;
    if (!caught) {
      if (!attack.knownGap) slipped++;
      survivors.push({ attack, victim, forged: reparsed.run });
    }

    console.log(`  ${caught ? "caught " : attack.knownGap ? "GAP    " : "SLIPPED"} ${attack.name}`);
    console.log(
      `          ${victim.run.scenario}: ${attack.gain(victim.run, reparsed.run)}`,
    );
    if (caught) {
      console.log(`          stopped by ${report.hardFailures.map((f) => f.split(":")[0]).join(", ")}`);
    } else if (attack.knownGap) {
      console.log(`          known: ${attack.knownGap}`);
    } else {
      const advisory = report.advisories.length ? report.advisories.join("; ") : "none";
      console.log(`          every hard check passed; advisories: ${advisory}`);
    }
  }

  console.log(`\n  forgeries through, not already documented : ${slipped}`);

  // ---- 4. what would stop the survivors, and what it would cost -----------------
  if (survivors.length > 0) {
    console.log("\n── candidate checks, measured before being believed ──");

    const durations = durationSeconds;

    // Fit the firing-rate ceiling from the corpus rather than guessing one: the fastest
    // rate any genuine run of that scenario reached, with headroom.
    const rateCeiling = new Map<string, number>();
    for (const [scenario, items] of byScenario) {
      const seconds = durations.get(scenario);
      if (!seconds) continue;
      let fastest = 0;
      for (const { run } of items) {
        const shots = weaponSum(run, "shots");
        if (shots > 0) fastest = Math.max(fastest, shots / seconds);
      }
      if (fastest > 0) rateCeiling.set(scenario, fastest * 1.25);
    }

    console.log("candidate                what it would cost");
    for (const c of CANDIDATES) {
      let evaluated = 0;
      let flagged = 0;
      for (const { run } of loaded) {
        const verdict = c.holds(run, {
          duration: durations.get(run.scenario) ?? null,
          rateCeiling: rateCeiling.get(run.scenario),
          accuracyCeiling: accuracyCeilingFor(run),
        });
        if (verdict == null) continue;
        evaluated++;
        if (!verdict) flagged++;
      }
      const rate = evaluated > 0 ? (flagged / evaluated) * 100 : 0;
      const stops = survivors
        .filter(
          ({ forged, victim }) =>
            c.holds(forged, {
              duration: durations.get(victim.run.scenario) ?? null,
              rateCeiling: rateCeiling.get(victim.run.scenario),
              accuracyCeiling: accuracyCeilingFor(victim.run),
            }) === false,
        )
        .map(({ attack }) => attack.name);

      console.log(`\n  ${c.id}`);
      console.log(`    ${c.what}`);
      console.log(
        `    genuine runs judged : ${evaluated}, flagged ${flagged} (${rate.toFixed(2)}%)`,
      );
      console.log(
        `    stops               : ${stops.length ? stops.join("; ") : "none of the survivors"}`,
      );
    }
    console.log(
      "\n  None of these are enabled. They are candidates with a measured price, " +
        "which is what PLAN.md §5 requires before a check may reject anything.",
    );
  }
}

function reportFalsePositives(
  runs: Loaded[],
  ctxFor: (run: ParsedRun) => ConsistencyContext,
): void {
  const fp = new Map<string, { sev: string; pass: number; fail: number; skip: number }>();
  const examples = new Map<string, string[]>();

  for (const { run, file } of runs) {
    for (const c of checkConsistency(run, ctxFor(run)).checks) {
      const t = fp.get(c.id) ?? { sev: c.severity, pass: 0, fail: 0, skip: 0 };
      t[c.status]++;
      fp.set(c.id, t);
      if (c.status === "fail") {
        const list = examples.get(c.id) ?? [];
        if (list.length < 3) list.push(`${file} (${c.detail ?? "no detail"})`);
        examples.set(c.id, list);
      }
    }
  }

  console.log("check                      sev        judged    flagged     fp%");
  for (const [id, t] of fp) {
    const judged = t.pass + t.fail;
    const rate = judged > 0 ? (t.fail / judged) * 100 : 0;
    console.log(
      `${id.padEnd(26)} ${t.sev.padEnd(9)} ${String(judged).padStart(7)}` +
        ` ${String(t.fail).padStart(10)} ${rate.toFixed(2).padStart(7)}%`,
    );
  }

  const hardFp = [...fp].filter(([, t]) => t.sev === "hard" && t.fail > 0);
  if (hardFp.length === 0) {
    console.log("\n  hard checks flagging a genuine run : none");
  } else {
    console.log("\n  hard checks flagging a genuine run:");
    for (const [id, t] of hardFp) {
      console.log(`    ${id} (${t.fail})`);
      for (const e of examples.get(id) ?? []) console.log(`      ${e}`);
    }
  }
}

main();
