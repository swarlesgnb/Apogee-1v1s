/**
 * Run the parser across a real KovaaK's stats folder and report on what it found.
 *
 * The point is not to assert correctness on a handful of fixtures. It is to prove the
 * parser survives an entire real-world folder (11k+ files accumulated over years, across
 * several game versions, including truncated files from crashes) without throwing, and
 * that the fields anti-cheat depends on are actually present at a usable rate.
 *
 *   npm run validate:parser [-- <path to stats folder>]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseStatsFile, type ParsedRun } from "./parseStatsFile.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

function pct(n: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith("Stats.csv"));
  } catch (err) {
    console.error(`Cannot read stats folder: ${dir}`);
    console.error(String(err));
    process.exit(1);
  }

  console.log(`stats folder : ${dir}`);
  console.log(`csv files    : ${files.length}\n`);

  const started = Date.now();

  let parsed = 0;
  let bytes = 0;
  let threw = 0;
  const failures = new Map<string, number>();
  const scenarios = new Map<string, { runs: number; best: number }>();

  const have = { hash: 0, challengeStart: 0, playedAt: 0, killRows: 0, avgFps: 0 };
  let scoreReconstructable = 0;
  let scoreMatches = 0;

  for (const file of files) {
    const full = join(dir, file);

    let content: string;
    try {
      content = readFileSync(full, "utf8");
      bytes += statSync(full).size;
    } catch {
      threw++;
      continue;
    }

    let result;
    try {
      result = parseStatsFile(file, content);
    } catch (err) {
      // The parser is contractually not allowed to throw. Loudly surface it if it does.
      threw++;
      console.error(`THREW on ${file}: ${String(err)}`);
      continue;
    }

    if (!result.ok) {
      failures.set(result.reason, (failures.get(result.reason) ?? 0) + 1);
      continue;
    }

    parsed++;
    const run: ParsedRun = result.run;

    if (run.hash) have.hash++;
    if (run.challengeStart) have.challengeStart++;
    if (run.playedAt) have.playedAt++;
    if (run.killRows.length > 0) have.killRows++;
    if (run.avgFps != null) have.avgFps++;

    // Anti-cheat depends on being able to re-derive the summary score from the
    // per-kill rows. Measure how often that is actually possible.
    if (run.killRows.length > 0 && run.kills != null) {
      scoreReconstructable++;
      if (run.killRows.length === run.kills) scoreMatches++;
    }

    const entry = scenarios.get(run.scenario);
    if (entry) {
      entry.runs++;
      if (run.score > entry.best) entry.best = run.score;
    } else {
      scenarios.set(run.scenario, { runs: 1, best: run.score });
    }
  }

  const elapsed = Date.now() - started;
  const total = files.length;

  console.log("── parse results ─────────────────────────────────");
  console.log(`parsed ok        : ${parsed} (${pct(parsed, total)})`);
  console.log(`parser threw     : ${threw}`);
  console.log(`skipped          : ${total - parsed - threw}`);
  for (const [reason, count] of [...failures].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${count.toString().padStart(6)}  ${reason}`);
  }

  console.log("\n── field availability (of parsed runs) ───────────");
  console.log(`Hash             : ${have.hash} (${pct(have.hash, parsed)})`);
  console.log(`Challenge Start  : ${have.challengeStart} (${pct(have.challengeStart, parsed)})`);
  console.log(`playedAt         : ${have.playedAt} (${pct(have.playedAt, parsed)})`);
  console.log(`kill rows        : ${have.killRows} (${pct(have.killRows, parsed)})`);
  console.log(`Avg FPS          : ${have.avgFps} (${pct(have.avgFps, parsed)})`);
  console.log(
    `kills == rows    : ${scoreMatches}/${scoreReconstructable} (${pct(scoreMatches, scoreReconstructable)})`,
  );

  console.log("\n── coverage ─────────────────────────────────────");
  console.log(`distinct scenarios : ${scenarios.size}`);
  console.log(`data read          : ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`elapsed            : ${elapsed} ms  (${Math.round(total / (elapsed / 1000))} files/sec)`);

  const top = [...scenarios.entries()].sort((a, b) => b[1].runs - a[1].runs).slice(0, 12);
  console.log("\n── most played ──────────────────────────────────");
  for (const [name, s] of top) {
    console.log(`${s.runs.toString().padStart(5)} runs  best ${s.best.toFixed(1).padStart(9)}  ${name}`);
  }

  if (threw > 0) {
    console.error("\nFAIL: parser threw on at least one file");
    process.exit(1);
  }
  console.log("\nOK: no exceptions across the whole folder");
}

main();
