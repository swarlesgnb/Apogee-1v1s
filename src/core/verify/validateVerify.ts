/**
 * Measure the verification checks against reality.
 *
 * Three questions, in order of importance:
 *
 *   1. FALSE POSITIVES: how often do the checks flag a genuine run? A ladder cannot
 *      survive accusing honest players, so any hard check with a non-zero rate here is
 *      wrong and must be demoted or fixed. This is the bar every check must clear.
 *
 *   2. SCORE PREDICTABILITY: can the summary score be re-derived from the per-kill
 *      and weapon data? If so, editing `Score:` alone becomes detectable locally,
 *      which is otherwise the one attack local checks miss entirely.
 *
 *   3. TRUE POSITIVES: do the checks actually catch tampering? A check that never
 *      fires proves nothing.
 *
 *   npx tsx src/core/verify/validateVerify.ts [statsFolder]
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseStatsFile, type ParsedRun } from "../stats/parseStatsFile.ts";
import {
  checkConsistency,
  type CheckSeverity,
  type ConsistencyContext,
  type ScoreModel,
  type WeaponScoreModel,
} from "./consistency.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

interface Tally {
  severity: CheckSeverity;
  pass: number;
  fail: number;
  skip: number;
  examples: string[];
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function loadRuns(dir: string): { run: ParsedRun; file: string }[] {
  const out: { run: ParsedRun; file: string }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith("Stats.csv"))) {
    try {
      const result = parseStatsFile(file, readFileSync(join(dir, file), "utf8"));
      if (result.ok) out.push({ run: result.run, file });
    } catch {
      /* the parser is validated separately */
    }
  }
  return out;
}

/**
 * Try to find a constant k such that score = stat * k across every run of a scenario.
 * A scenario whose score is a fixed multiple of a countable stat can have its score
 * verified locally.
 */
function findScoreModel(runs: ParsedRun[]): { stat: string; k: number } | null {
  const stats: Record<string, (r: ParsedRun) => number | null> = {
    kills: (r) => r.kills,
    hitCount: (r) => r.hitCount,
    damageDone: (r) => r.damageDone,
  };

  for (const [name, get] of Object.entries(stats)) {
    const ratios: number[] = [];
    let usable = true;

    for (const run of runs) {
      const value = get(run);
      if (value == null || value === 0) {
        // A zero stat carries no information about k; skip rather than disqualify.
        if (run.score !== 0) continue;
        continue;
      }
      ratios.push(run.score / value);
    }

    if (ratios.length < 5) continue;

    const first = ratios[0];
    if (first === 0) continue;
    for (const r of ratios) {
      // Relative tolerance absorbs float noise in damage-based scoring.
      if (Math.abs(r - first) / first > 0.001) {
        usable = false;
        break;
      }
    }
    if (usable) return { stat: name, k: first };
  }
  return null;
}

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;
  const loaded = loadRuns(dir);

  console.log(`stats folder : ${dir}`);
  console.log(`runs         : ${loaded.length}\n`);

  if (loaded.length === 0) {
    console.error("No runs to validate against.");
    process.exit(1);
  }

  // Cache world records from the taxonomy so the ceiling check gets exercised.
  const taxonomy = JSON.parse(
    readFileSync(new URL("../../../data/scenario_taxonomy.json", import.meta.url), "utf8"),
  ) as { scenarios: { name: string; topScore: number | null }[] };
  const worldRecords = new Map(
    taxonomy.scenarios.filter((s) => s.topScore).map((s) => [s.name, s.topScore!]),
  );

  const learned = JSON.parse(
    readFileSync(new URL("../../../data/score_models.json", import.meta.url), "utf8"),
  ) as {
    models: Record<string, ScoreModel>;
    weaponModels: Record<string, WeaponScoreModel>;
    shotRates: Record<string, number>;
  };
  const scoreModels = learned.models;
  const weaponModels = learned.weaponModels;
  const shotRates = learned.shotRates;

  // Scenario lengths, so the firing-rate ceiling has a length to be a rate over.
  const durations = new Map<string, number>();
  const durationFile = JSON.parse(
    readFileSync(new URL("../../../data/scenario_durations.json", import.meta.url), "utf8"),
  ) as { durations: { scenario: string; seconds: number | null }[] };
  for (const d of durationFile.durations) {
    if (d.seconds != null) durations.set(d.scenario, d.seconds);
  }

  // Accuracy ceilings, fitted per scenario and LEAVE-ONE-OUT, so a run is never measured
  // against a bar it set itself. Keeping the top two is all that needs storing for that:
  // the best run is judged against the second, everything else against the best. Without
  // the leave-one-out every scenario's record holder would flag itself, which is a check
  // marking its own homework rather than a measurement.
  const topTwoAccuracy = new Map<string, [number, number]>();
  for (const { run } of loaded) {
    if (run.accuracy == null) continue;
    const pair = topTwoAccuracy.get(run.scenario) ?? [-Infinity, -Infinity];
    if (run.accuracy > pair[0]) topTwoAccuracy.set(run.scenario, [run.accuracy, pair[0]]);
    else if (run.accuracy > pair[1]) topTwoAccuracy.set(run.scenario, [pair[0], run.accuracy]);
  }

  // +10% headroom, the same shape of tolerance the score models carry. It is what keeps
  // an ordinary improvement from reading as a forgery; it is also why this stays
  // advisory, since no headroom fitted from history can tell a great run from a faked one.
  const accuracyCeilingFor = (run: ParsedRun): number | undefined => {
    const pair = topTwoAccuracy.get(run.scenario);
    if (!pair || run.accuracy == null) return undefined;
    const others = run.accuracy >= pair[0] ? pair[1] : pair[0];
    return Number.isFinite(others) ? others * 1.1 : undefined;
  };

  const contextFor = (run: ParsedRun): ConsistencyContext => ({
    worldRecord: worldRecords.get(run.scenario),
    scoreModel: scoreModels[run.scenario],
    weaponScoreModel: weaponModels[run.scenario],
    shotsPerSecond: shotRates[run.scenario],
    scenarioSeconds: durations.get(run.scenario),
    accuracyCeiling: accuracyCeilingFor(run),
  });

  // ---- 1. false positives -----------------------------------------------------
  console.log("── false positives on genuine runs ──────────────");

  const tallies = new Map<string, Tally>();

  for (const { run, file } of loaded) {
    const report = checkConsistency(run, contextFor(run));
    for (const c of report.checks) {
      let t = tallies.get(c.id);
      if (!t) {
        t = { severity: c.severity, pass: 0, fail: 0, skip: 0, examples: [] };
        tallies.set(c.id, t);
      }
      t[c.status]++;
      if (c.status === "fail" && t.examples.length < 3) {
        t.examples.push(`${file} (${c.detail ?? "no detail"})`);
      }
    }
  }

  console.log("check                      sev       pass    fail    skip   fail%");
  for (const [id, t] of tallies) {
    const evaluated = t.pass + t.fail;
    const rate = evaluated > 0 ? (t.fail / evaluated) * 100 : 0;
    console.log(
      `${id.padEnd(26)} ${t.severity.padEnd(9)} ${String(t.pass).padStart(6)}` +
        ` ${String(t.fail).padStart(7)} ${String(t.skip).padStart(7)} ${rate.toFixed(2).padStart(7)}%`,
    );
  }

  console.log();
  for (const [id, t] of tallies) {
    if (t.severity === "hard" && t.fail > 0) {
      console.log(`  hard check "${id}" flagged genuine runs:`);
      for (const e of t.examples) console.log(`     ${e}`);
    }
  }

  const hardFalsePositives = [...tallies].filter(
    ([, t]) => t.severity === "hard" && t.fail > 0,
  );
  check(
    "no hard check flags a genuine run",
    hardFalsePositives.length === 0,
    hardFalsePositives.map(([id, t]) => `${id} (${t.fail})`).join(", "),
  );

  const coherent = loaded.filter(({ run }) => checkConsistency(run, contextFor(run)).coherent)
    .length;
  check(
    "every genuine run is judged coherent",
    coherent === loaded.length,
    `${loaded.length - coherent} rejected`,
  );

  // ---- 2. score predictability ------------------------------------------------
  console.log("\n── can the score be re-derived locally? ─────────");

  const byScenario = new Map<string, ParsedRun[]>();
  for (const { run } of loaded) {
    const list = byScenario.get(run.scenario) ?? [];
    list.push(run);
    byScenario.set(run.scenario, list);
  }

  let modelled = 0;
  let unmodelled = 0;
  let runsCovered = 0;
  let runsUncovered = 0;
  const byStat = new Map<string, number>();

  for (const [, runs] of byScenario) {
    if (runs.length < 5) continue;
    const model = findScoreModel(runs);
    if (model) {
      modelled++;
      runsCovered += runs.length;
      byStat.set(model.stat, (byStat.get(model.stat) ?? 0) + 1);
    } else {
      unmodelled++;
      runsUncovered += runs.length;
    }
  }

  const totalScenarios = modelled + unmodelled;
  console.log(
    `scenarios with >=5 runs : ${totalScenarios}\n` +
      `  score is a fixed multiple of a stat : ${modelled} ` +
      `(${((modelled / totalScenarios) * 100).toFixed(1)}%)\n` +
      `  no constant relation found          : ${unmodelled}`,
  );
  console.log(`runs covered by a model : ${runsCovered} of ${runsCovered + runsUncovered}`);
  console.log(`  by stat: ${[...byStat].map(([s, n]) => `${s}=${n}`).join("  ")}`);

  // The runs the kill-row checks cannot reach at all: tracking against an invincible
  // target scores at a rate and never registers a kill, so there is nothing to
  // reconstruct from except the weapon block.
  const noRows = loaded.filter(({ run }) => run.killRows.length === 0);
  const noRowsWithWeapons = noRows.filter(({ run }) => run.weapons.length > 0);
  const noRowsModelled = noRows.filter(({ run }) => weaponModels[run.scenario] != null);
  console.log(
    `\nruns with no kill rows  : ${noRows.length} of ${loaded.length}\n` +
      `  carrying a weapon block             : ${noRowsWithWeapons.length}\n` +
      `  with a learned weapon model         : ${noRowsModelled.length} ` +
      `(${((noRowsModelled.length / noRows.length) * 100).toFixed(1)}%)`,
  );
  check(
    "every kill-row-less run still has a weapon block to check",
    noRowsWithWeapons.length === noRows.length,
    `${noRows.length - noRowsWithWeapons.length} have neither`,
  );

  // ---- 3. true positives ------------------------------------------------------
  console.log("\n── does tampering get caught? ───────────────────");

  // A run with kill rows AND a known score model: the richest case to attack, and
  // the one where every check is actually in play.
  const victim = loaded.find(
    ({ run }) =>
      run.killRows.length > 20 &&
      run.weapons.length > 0 &&
      run.hitCount != null &&
      run.missCount != null &&
      scoreModels[run.scenario] != null,
  );

  // A scenario with no learned model, to prove the score check degrades safely rather
  // than rejecting what it cannot model.
  const noModelRun = loaded.find(
    ({ run }) =>
      run.killRows.length > 20 &&
      scoreModels[run.scenario] == null &&
      weaponModels[run.scenario] == null,
  );

  // An invincible-target tracking run: no kill rows at all, so the weapon block is the
  // only thing the score can be reconstructed from. A real one, not a scenario quit
  // after one shot - a run that scored nothing has no relation left to break.
  const tracked = loaded.find(
    ({ run }) =>
      run.killRows.length === 0 &&
      run.weapons.length > 0 &&
      run.hitCount != null &&
      run.missCount != null &&
      run.score > 0 &&
      run.weapons.reduce((n, w) => n + (w.shots ?? 0), 0) > 1000 &&
      // Pinned to a hit-count model so the forgery below can be built coherently.
      scoreModels[run.scenario]?.stat === "hitCount" &&
      weaponModels[run.scenario] != null,
  );

  /** Mutate a copy of a genuine run and assert whether the checks reject it. */
  const attempt = (
    subject: { run: ParsedRun; file: string },
    label: string,
    mutate: (r: ParsedRun) => void,
    expectCaught: boolean,
    ctx: ConsistencyContext = contextFor(subject.run),
  ) => {
    const clone = structuredClone(subject.run) as ParsedRun;
    // structuredClone drops the Date prototype through JSON-ish paths; restore it.
    clone.playedAt = subject.run.playedAt;
    mutate(clone);
    const report = checkConsistency(clone, ctx);
    const caught = !report.coherent;
    check(
      `${label} -> ${caught ? "caught" : "not caught"}`,
      caught === expectCaught,
      caught ? report.hardFailures.join("; ") : "expected to be caught",
    );
  };

  if (!victim) {
    check("a suitable run was available to tamper with", false);
  } else {
    const model = scoreModels[victim.run.scenario];
    console.log(
      `  target: ${victim.run.scenario} (score ${victim.run.score}, ` +
        `model score = ${model.stat} * ${model.k})\n`,
    );

    const tamper = (
      label: string,
      mutate: (r: ParsedRun) => void,
      expectCaught: boolean,
      subject = victim,
    ) => attempt(subject, label, mutate, expectCaught);

    tamper("absurd score (999999)", (r) => { r.score = 999999; }, true);
    tamper("modest score edit (+8%)", (r) => { r.score = Math.round(r.score * 1.08); }, true);
    tamper("tiny score edit (+1%)", (r) => { r.score = Math.round(r.score * 1.01); }, true);
    tamper("inflated hit count", (r) => { r.hitCount = (r.hitCount ?? 0) + 40; }, true);
    // Row insertion and deletion leave a legal counter sequence, because scenarios
    // legitimately repeat and skip kill numbers. Both raise an advisory rather than a
    // rejection, and neither can inflate a score, which is what the hard checks are
    // there to stop.
    tamper("deleted a kill row (advisory only)", (r) => { r.killRows.splice(5, 1); }, false);
    tamper("duplicated a kill row (advisory only)", (r) => {
      r.killRows.splice(5, 0, structuredClone(r.killRows[5]));
    }, false);
    // ...but editing rows AND the kill count to match is caught, wherever the scenario
    // has a learned scoring model.
    tamper("kill count edited to match forged rows", (r) => {
      r.killRows.splice(5, 1);
      if (r.kills != null) r.kills -= 1;
    }, true);
    tamper("reordered kill timestamps", (r) => {
      const t = r.killRows[3].timestamp;
      r.killRows[3].timestamp = r.killRows[20].timestamp;
      r.killRows[20].timestamp = t;
    }, true);
    tamper("negative TTK", (r) => { r.killRows[7].ttk = -0.5; }, true);
    tamper("weapon shots edited", (r) => {
      if (r.weapons[0].shots != null) r.weapons[0].shots += 30;
    }, true);

    // Legitimate cases that must NOT be flagged.
    tamper("an unmodified run", () => {}, false);
    tamper("a legitimately negative score", (r) => {
      r.score = -160;
      // Keep every learned relation consistent, since a penalty scenario would have
      // them too. What is on trial here is the minus sign, not an incoherent file.
      if (model.stat === "kills") r.kills = -160 / model.k;
      else if (model.stat === "hitCount") r.hitCount = -160 / model.k;
      else r.damageDone = -160 / model.k;

      const weaponModel = weaponModels[victim.run.scenario];
      if (weaponModel) {
        // The checks sum the block, so where the total sits across two weapons does
        // not matter; putting it all on the first is the simplest way to set it.
        const total = -160 / weaponModel.scorePerDamage;
        r.weapons = r.weapons.map((w, i) => ({ ...w, damageDone: i === 0 ? total : 0 }));
      }
    }, false);

    if (noModelRun) {
      tamper(
        `score edit on an unmodelled scenario degrades safely`,
        (r) => { r.score = Math.round(r.score * 1.08); },
        false,
        noModelRun,
      );
    }
  }

  // ---- 4. the invincible-target case ------------------------------------------
  console.log("\n── tampering with a run that has no kill rows ───");

  if (!tracked) {
    check("an invincible-target run was available to tamper with", false);
  } else {
    const weaponModel = weaponModels[tracked.run.scenario]!;
    const shots = tracked.run.weapons.reduce((n, w) => n + (w.shots ?? 0), 0);
    console.log(
      `  target: ${tracked.run.scenario} (score ${tracked.run.score}, ` +
        `${tracked.run.killRows.length} kill rows, ${shots} shots, ` +
        `score = damage * ${weaponModel.scorePerDamage})\n`,
    );

    // The same context minus the weapon models, to prove each case below is actually
    // caught by the new checks and not by one that was already there.
    const withoutWeaponModel: ConsistencyContext = {
      ...contextFor(tracked.run),
      weaponScoreModel: undefined,
    };

    attempt(tracked, "unmodified", () => {}, false);
    attempt(tracked, "tiny score edit (+1%)", (r) => {
      r.score = Math.round(r.score * 1.01);
    }, true);

    /**
     * The attack the weapon block exists to stop: raise the hits, raise the shots to
     * keep them balanced, and move the score, `Hit Count:` and the weapon block's own
     * hits along with them. Every check that reads the summary tail is satisfied,
     * because every counter it knows about was updated together.
     *
     * What is left behind is the damage. `Damage Done` no longer matches the score and
     * `Damage Possible` no longer matches the shot count, and nothing else in the file
     * records either.
     */
    const inflate = (r: ParsedRun) => {
      const added = 100;
      r.hitCount = (r.hitCount ?? 0) + added;
      r.score += added * scoreModels[tracked.run.scenario].k;
      r.weapons = r.weapons.map((w, i) =>
        i === 0
          ? { ...w, hits: (w.hits ?? 0) + added, shots: (w.shots ?? 0) + added }
          : w,
      );
    };
    attempt(tracked, "hits, shots and score all raised together", inflate, true);
    attempt(
      tracked,
      "  ...and it survives every check that came before",
      inflate,
      false,
      withoutWeaponModel,
    );

    attempt(tracked, "weapon damage done edited", (r) => {
      r.weapons = r.weapons.map((w, i) =>
        i === 0 ? { ...w, damageDone: (w.damageDone ?? 0) + 50 } : w,
      );
    }, true);
    attempt(tracked, "weapon damage possible edited", (r) => {
      r.weapons = r.weapons.map((w, i) =>
        i === 0 ? { ...w, damagePossible: (w.damagePossible ?? 0) + 50 } : w,
      );
    }, true);

    /**
     * Every relation above is a ratio, and a ratio cannot see a uniform scale: multiply
     * the score, the counts and both damage columns by the same factor and all of them
     * still hold. Only `shots_per_second` has an absolute anchor, and only where the
     * scenario's shots are engine ticks.
     */
    const scaleBy = (factor: number) => (r: ParsedRun) => {
      r.score *= factor;
      r.hitCount = Math.round((r.hitCount ?? 0) * factor);
      r.missCount = Math.round((r.missCount ?? 0) * factor);
      r.damageDone = (r.damageDone ?? 0) * factor;
      r.weapons = r.weapons.map((w) => ({
        ...w,
        shots: Math.round((w.shots ?? 0) * factor),
        hits: Math.round((w.hits ?? 0) * factor),
        damageDone: (w.damageDone ?? 0) * factor,
        damagePossible: (w.damagePossible ?? 0) * factor,
      }));
    };
    if (shotRates[tracked.run.scenario] != null) {
      attempt(tracked, "every counter in the file scaled x3", scaleBy(3), true);
      attempt(
        tracked,
        "  ...and every ratio relation is blind to it",
        scaleBy(3),
        false,
        { ...contextFor(tracked.run), shotsPerSecond: undefined },
      );
      // A run cut short by a crash has far too FEW shots, which is a duration question
      // and must never be mistaken for a forgery.
      attempt(tracked, "a run cut short fires fewer shots, not more", scaleBy(0.4), false);
    }

    // The weapon block is only checked where a rate was learned, so an invincible-target
    // scenario with too little history skips rather than fails.
    const unmodelledTracking = loaded.find(
      ({ run }) =>
        run.killRows.length === 0 &&
        run.weapons.length > 0 &&
        scoreModels[run.scenario] == null &&
        weaponModels[run.scenario] == null,
    );
    if (unmodelledTracking) {
      attempt(
        unmodelledTracking,
        "score edit on an unmodelled tracking scenario degrades safely",
        (r) => { r.score = Math.round(r.score * 1.08); },
        false,
      );
    }
  }

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK: verification checks validated");
}

main();
