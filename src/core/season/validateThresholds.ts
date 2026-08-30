/**
 * Hold every threshold to the source it claims.
 *
 *   npx tsx src/core/season/validateThresholds.ts
 *
 * A season used to derive its numbers from percentiles, which made them checkable by
 * construction: re-run the derivation and compare. Authored numbers have no such property,
 * and an authored number with no provenance is indistinguishable from a number somebody
 * made up. This is what replaces the guarantee.
 *
 *   adopted     must equal a run of what the named benchmark actually publishes, read from
 *               data/benchmarks/*.json. Re-derived here to the digit.
 *   reconciled  must be bracketed by the sources it claims to reconcile - a reconciliation
 *               landing outside every number it reconciled is not one.
 *   authored    must carry a reason long enough to be a reason.
 *   seeded      inherited from the percentile era with no source yet. Counted and printed on
 *               every run, because a debt nobody is reminded of is a debt nobody pays.
 *
 * The point is not that authored numbers are worse. A benchmark is a set of opinions about
 * what is worth achieving, and someone has to hold them. The point is that a reader can
 * always tell which kind of number they are looking at, and that the two kinds which claim
 * to be somebody else's are actually somebody else's.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../dataDir.ts";
import { checkAgainstSource, type ThresholdSource } from "./thresholds.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface Variant {
  window: number;
  scenario: string;
  rankMaxes?: number[];
  source?: ThresholdSource;
}

interface Pool {
  windowSize: number;
  windows: string[];
  families: { family: string; category: string; variants: Variant[] }[];
}

const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as Pool;

/** Every (benchmark, difficulty) tier that publishes scores for a scenario. */
const published = new Map<string, { benchmark: string; difficulty: string; rankMaxes: number[] }[]>();
for (const file of readdirSync(dataFile("benchmarks")).filter((f) => f.endsWith(".json"))) {
  const def = JSON.parse(readFileSync(join(dataFile("benchmarks"), file), "utf8")) as {
    benchmarkName: string;
    difficulties?: { name: string; categories?: { scenarios?: { name: string; rankMaxes?: number[] }[] }[] }[];
  };
  for (const diff of def.difficulties ?? []) {
    for (const cat of diff.categories ?? []) {
      for (const sc of cat.scenarios ?? []) {
        if (!sc.rankMaxes || sc.rankMaxes.length === 0) continue;
        const list = published.get(sc.name) ?? [];
        list.push({ benchmark: def.benchmarkName, difficulty: diff.name, rankMaxes: sc.rankMaxes });
        published.set(sc.name, list);
      }
    }
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

const variants = pool.families.flatMap((f) =>
  f.variants.map((v) => ({ ...v, family: f.family, category: f.category })),
);

console.log(
  `\n${BOLD}thresholds${RESET}  ${variants.length} variants, ${pool.windowSize} ranks each`,
);

// ---- shape --------------------------------------------------------------------------------

console.log(`\n${BOLD}shape${RESET}`);

const wrongWidth = variants.filter(
  (v) => !Array.isArray(v.rankMaxes) || v.rankMaxes.length !== pool.windowSize,
);
check(
  "every variant carries one score per rank in its window",
  wrongWidth.length === 0,
  wrongWidth.map((v) => `${v.scenario} has ${v.rankMaxes?.length ?? 0}`).join(", "),
);

const notAscending = variants.filter((v) =>
  (v.rankMaxes ?? []).some((n, i) => i > 0 && n <= (v.rankMaxes ?? [])[i - 1]),
);
check(
  "every variant's scores ascend",
  notAscending.length === 0,
  notAscending.map((v) => `${v.scenario} [${v.rankMaxes?.join(", ")}]`).join("; "),
);

const sourceless = variants.filter((v) => !v.source);
check("every variant says where its numbers came from", sourceless.length === 0,
  sourceless.map((v) => v.scenario).join(", "));

// ---- the claims -----------------------------------------------------------------------------

console.log(`\n${BOLD}provenance${RESET}  ${DIM}re-derived from data/benchmarks${RESET}`);

const byKind = new Map<string, number>();
const wrong: string[] = [];
const unreasoned: string[] = [];
const uncitable: string[] = [];

for (const v of variants) {
  const source = v.source;
  if (!source) continue;
  byKind.set(source.kind, (byKind.get(source.kind) ?? 0) + 1);

  if (source.kind === "authored") {
    if (!source.why || source.why.trim().length < 60) unreasoned.push(v.scenario);
    continue;
  }
  if (source.kind === "seeded") continue;

  // A cited tier has to be one that exists and actually publishes what the citation says.
  for (const cited of source.from) {
    const real = (published.get(v.scenario) ?? []).find(
      (t) => t.benchmark === cited.benchmark && t.difficulty === cited.difficulty,
    );
    if (!real) {
      uncitable.push(`${v.scenario} cites ${cited.benchmark} ${cited.difficulty}, which does not publish it`);
      continue;
    }
    if (real.rankMaxes.join(",") !== cited.rankMaxes.join(",")) {
      uncitable.push(
        `${v.scenario} quotes ${cited.benchmark} ${cited.difficulty} as ` +
          `[${cited.rankMaxes.join(", ")}], published is [${real.rankMaxes.join(", ")}]`,
      );
    }
  }

  const problem = checkAgainstSource(v.rankMaxes ?? [], source);
  if (problem) wrong.push(`${v.scenario} ${problem}`);
}

check(
  "every citation names a tier that publishes the scenario, and quotes it correctly",
  uncitable.length === 0,
  uncitable.length ? `\n       ${uncitable.slice(0, 6).join("\n       ")}` : "",
);
check(
  "every adopted or reconciled number matches its source",
  wrong.length === 0,
  wrong.length ? `\n       ${wrong.slice(0, 6).join("\n       ")}` : "",
);
check(
  "every authored number says why at length",
  unreasoned.length === 0,
  unreasoned.join(", "),
);

for (const [kind, n] of [...byKind].sort()) {
  console.log(`  ${DIM}${kind.padEnd(12)} ${n}${RESET}`);
}

// ---- the debt --------------------------------------------------------------------------------
//
// Not a failure. Seeded numbers are the honest state of a season mid-conversion, and calling
// them a failure would only teach somebody to relabel them.

const seeded = byKind.get("seeded") ?? 0;
if (seeded > 0) {
  const sourceable = variants.filter(
    (v) => v.source?.kind === "seeded" && (published.get(v.scenario) ?? []).length > 0,
  ).length;
  console.log(
    `\n  ${DIM}${seeded} threshold(s) still carry the percentile era's numbers with no source.` +
      `\n  ${sourceable} of them name a scenario some benchmark publishes, so they can be` +
      `\n  adopted rather than authored. npm run adopt:thresholds is what does that.${RESET}`,
  );
}

console.log(
  failures === 0 ? `\nOK: thresholds validated\n` : `\nFAILED: ${failures} check(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
