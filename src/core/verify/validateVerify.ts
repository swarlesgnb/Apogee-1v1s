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

  const scoreModels = (
    JSON.parse(
      readFileSync(new URL("../../../data/score_models.json", import.meta.url), "utf8"),
    ) as { models: Record<string, ScoreModel> }
  ).models;

  const contextFor = (run: ParsedRun): ConsistencyContext => ({
    worldRecord: worldRecords.get(run.scenario),
    scoreModel: scoreModels[run.scenario],
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

  console.log("check                 sev       pass    fail    skip   fail%");
  for (const [id, t] of tallies) {
    const evaluated = t.pass + t.fail;
    const rate = evaluated > 0 ? (t.fail / evaluated) * 100 : 0;
    console.log(
      `${id.padEnd(21)} ${t.severity.padEnd(9)} ${String(t.pass).padStart(6)}` +
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
    ({ run }) => run.killRows.length > 20 && scoreModels[run.scenario] == null,
  );

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
    ) => {
      const clone = structuredClone(subject.run) as ParsedRun;
      // structuredClone drops the Date prototype through JSON-ish paths; restore it.
      clone.playedAt = subject.run.playedAt;
      mutate(clone);
      const report = checkConsistency(clone, contextFor(subject.run));
      const caught = !report.coherent;
      check(
        `${label} -> ${caught ? "caught" : "not caught"}`,
        caught === expectCaught,
        caught ? report.hardFailures.join("; ") : "expected to be caught",
      );
    };

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
      // Keep the model consistent, since a penalty scenario would have one too.
      if (model.stat === "kills") r.kills = -160 / model.k;
      else if (model.stat === "hitCount") r.hitCount = -160 / model.k;
      else r.damageDone = -160 / model.k;
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

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK: verification checks validated");
}

main();
