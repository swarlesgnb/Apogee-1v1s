/**
 * Prove the abandonment check never rejects a run somebody actually played.
 *
 * The rule that governs every check in this project: one that flags a legitimate run is
 * worse than no check at all (PLAN.md §5). Three checks in the first verification draft
 * broke that rule and had to be corrected, and they were only caught by running them
 * against the whole corpus before letting them reject anything. This does the same for
 * the duration check before it is allowed to void a match.
 *
 *   npx tsx src/core/stats/validateDuration.ts [statsFolder]
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../dataDir.ts";
import { parseStatsFile } from "./parseStatsFile.ts";
import {
  challengeStartSeconds,
  isAbandonedRun,
  runDurationSeconds,
  MIN_COMPLETION_FRACTION,
} from "./duration.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function unit(): void {
  console.log("── parsing and arithmetic ───────────────────────");

  check("a normal start parses", challengeStartSeconds("17:31:49.055") === 17 * 3600 + 31 * 60 + 49.055);
  check("midnight parses", challengeStartSeconds("00:00:00.000") === 0);
  check("nonsense is rejected", challengeStartSeconds("not a time") === null);
  check("an out-of-range hour is rejected", challengeStartSeconds("25:00:00.000") === null);
  check("a missing value is rejected", challengeStartSeconds(null) === null);

  const end = new Date(2026, 6, 6, 17, 32, 49);
  const d = runDurationSeconds("17:31:49.055", end);
  check("a 60s run measures 60s", d !== null && Math.abs(d - 60) < 1.1, `${d?.toFixed(2)}s`);

  // 23:59:30 -> 00:00:30 is a wrap, not a negative run.
  const wrapEnd = new Date(2026, 6, 7, 0, 0, 30);
  const wrapped = runDurationSeconds("23:59:30.000", wrapEnd);
  check("a run across midnight measures 60s", wrapped !== null && Math.abs(wrapped - 60) < 1.1, `${wrapped?.toFixed(2)}s`);

  console.log("\n── the rule refuses to guess ────────────────────");
  check("unknown duration is not abandonment", isAbandonedRun(null, 60) === false);
  check("unknown scenario length is not abandonment", isAbandonedRun(5, null) === false);
  check("a zero scenario length is not abandonment", isAbandonedRun(5, 0) === false);
  check("a full run is not abandonment", isAbandonedRun(60, 60) === false);
  check("a run at exactly the threshold is not abandonment", isAbandonedRun(54, 60) === false);
  check("a run just under the threshold is abandonment", isAbandonedRun(53.9, 60) === true);
  check("an 8s run on a 60s scenario is abandonment", isAbandonedRun(8, 60) === true);
}

function corpus(dir: string): void {
  const raw = JSON.parse(readFileSync(dataFile("scenario_durations.json"), "utf8"));
  const expected = new Map<string, number | null>(
    raw.durations.map((d: { scenario: string; seconds: number | null }) => [d.scenario, d.seconds]),
  );

  const taxonomy = JSON.parse(readFileSync(dataFile("scenario_taxonomy.json"), "utf8"));
  const benchmark = new Set<string>(
    taxonomy.scenarios.map((s: { name: string }) => s.name),
  );

  let total = 0;
  let flagged = 0;
  let unknownDuration = 0;
  let unchecked = 0;
  let seenBenchmark = 0;
  const flaggedAll: { scenario: string; seconds: number | null; known: number }[] = [];
  const flaggedSamples: string[] = [];

  for (const file of readdirSync(dir).filter((f) => f.endsWith("Stats.csv"))) {
    let scenario: string;
    let seconds: number | null;
    try {
      const result = parseStatsFile(file, readFileSync(join(dir, file), "utf8"));
      if (!result.ok) continue;
      scenario = result.run.scenario;
      seconds = runDurationSeconds(result.run.challengeStart, result.run.playedAt);
    } catch {
      continue;
    }

    total++;
    if (seconds === null) unknownDuration++;
    if (benchmark.has(scenario)) seenBenchmark++;

    const known = expected.get(scenario);
    if (known == null) {
      unchecked++;
      continue;
    }

    if (isAbandonedRun(seconds, known)) {
      flagged++;
      flaggedAll.push({ scenario, seconds, known });
      if (flaggedSamples.length < 8) {
        flaggedSamples.push(`${seconds?.toFixed(0)}s of ${known}s  ${scenario.slice(0, 40)}`);
      }
    }
  }

  console.log("\n── against the whole corpus ─────────────────────");
  console.log(`  runs parsed              : ${total}`);
  console.log(`  duration underivable     : ${unknownDuration}`);
  console.log(`  scenario length unknown  : ${unchecked} (never checked)`);
  console.log(`  flagged as abandoned     : ${flagged} (${((flagged / total) * 100).toFixed(2)}%)`);

  if (flaggedSamples.length > 0) {
    console.log("\n  a sample of what it flags:");
    for (const s of flaggedSamples) console.log(`    ${s}`);
  }

  // These are real abandonments in a personal corpus, not false positives: nobody
  // plays 8 seconds of a 60-second scenario on purpose. What must not happen is the
  // rate climbing to where it would be catching ordinary play.
  check(
    "the flagged rate is consistent with real abandonment, not ordinary play",
    flagged / total < 0.03,
    `${((flagged / total) * 100).toFixed(2)}% flagged, threshold ${MIN_COMPLETION_FRACTION * 100}% completion`,
  );

  // A duration cannot always be derived, and that is fine: those runs are never
  // checked. What would not be fine is it happening often enough that abandonment
  // stopped being detectable at all.
  check(
    "a duration is derivable for effectively every run",
    unknownDuration / total < 0.01,
    `${unknownDuration} of ${total} underivable (${((unknownDuration / total) * 100).toFixed(2)}%), treated as unchecked`,
  );

  // The scenarios matches are actually played on. Any false positive here voids a real
  // match, so this is the one that has to be spotless.
  const benchmarkFlagged = flaggedAll.filter((f) => benchmark.has(f.scenario));

  check(
    "no benchmark run is ever called abandoned",
    benchmarkFlagged.length === 0,
    `${benchmarkFlagged.length} of ${seenBenchmark} benchmark runs flagged`,
  );
}

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;
  unit();
  corpus(dir);

  console.log(
    failures === 0
      ? "\nOK: abandonment detection validated"
      : `\n${failures} check(s) failed`,
  );
  if (failures > 0) process.exit(1);
}

main();
