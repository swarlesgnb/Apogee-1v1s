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
 *   predicted   read off the board the difficulty model predicts for an Apogee scenario
 *               with none of its own yet. Re-derived to the digit by validate:season-files,
 *               which has the model; here it only has to say so.
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
import { thresholdsFrom, type Distribution } from "./percentiles.ts";
import { windowRankCount, windowRankIndices } from "./windows.ts";

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
  ladder: { ranks: number[]; overlap: number };
  families: { family: string; category: string; variants: Variant[] }[];
}

const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as Pool;
const sampled = new Map(
  (
    JSON.parse(readFileSync(dataFile("leaderboard_percentiles.json"), "utf8")) as {
      distributions: Distribution[];
    }
  ).distributions.map((d) => [d.scenario, d]),
);

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

const totalRanks = pool.windowSize * pool.windows.length;
const overlap = pool.ladder.overlap ?? 0;
/** How many scores a variant in this window carries. Wider than the stride by the overlap. */
const widthOf = (window: number): number =>
  windowRankCount(window, pool.windowSize, totalRanks, overlap);

console.log(
  `\n${BOLD}thresholds${RESET}  ${variants.length} variants, ` +
    `${pool.windowSize}-rank windows overlapping by ${overlap}`,
);

// ---- shape --------------------------------------------------------------------------------

console.log(`\n${BOLD}shape${RESET}`);

const wrongWidth = variants.filter(
  (v) => !Array.isArray(v.rankMaxes) || v.rankMaxes.length !== widthOf(v.window),
);
check(
  "every variant carries one score per rank in its window",
  wrongWidth.length === 0,
  wrongWidth
    .map((v) => `${v.scenario} has ${v.rankMaxes?.length ?? 0}, not ${widthOf(v.window)}`)
    .join(", "),
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
const miscut: string[] = [];

for (const v of variants) {
  const source = v.source;
  if (!source) continue;
  byKind.set(source.kind, (byKind.get(source.kind) ?? 0) + 1);

  if (source.kind === "authored") {
    if (!source.why || source.why.trim().length < 60) unreasoned.push(v.scenario);
    continue;
  }
  if (source.kind === "seeded") continue;
  if (source.kind === "predicted") {
    if (!source.why || source.why.trim().length < 60) unreasoned.push(v.scenario);
    continue;
  }

  // A percentile cut carries the board, the ranks and the shares it used, so the whole
  // thing is redone here rather than taken on the word of its `why`. Two ways it can be
  // wrong and both matter: the numbers no longer being what those shares give, and the
  // shares no longer being what the pool's ladder asks for at those ranks - the second is
  // what a half-applied ladder change looks like.
  if (source.kind === "percentile") {
    const dist = sampled.get(v.scenario);
    if (!dist) {
      miscut.push(`${v.scenario} cites a board that is no longer sampled`);
      continue;
    }
    const wanted = source.cut.ranks.map((r) => pool.ladder.ranks[r]);
    if (wanted.join(",") !== source.cut.topFractions.join(",")) {
      miscut.push(
        `${v.scenario} was cut at ${source.cut.topFractions.join(", ")}, but the ladder ` +
          `now asks ${wanted.join(", ")} at ranks ` +
          `${source.cut.ranks.map((r) => r + 1).join(", ")}`,
      );
      continue;
    }
    const redone = thresholdsFrom(dist, source.cut.topFractions);
    if (!redone || redone.join(",") !== (v.rankMaxes ?? []).join(",")) {
      miscut.push(
        `${v.scenario} is [${(v.rankMaxes ?? []).join(", ")}], its own cut re-derives ` +
          `[${redone?.join(", ") ?? "nothing"}]`,
      );
    }
    continue;
  }

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

  // The tail an adoption was extended by is re-derived, not believed: the ratio has to be
  // the one the cited tier's own numbers give, and the numbers have to be that ratio applied.
  if (source.extended && source.extended.ranks.length > 0) {
    const all = v.rankMaxes ?? [];
    const tail = all.slice(all.length - source.extended.ranks.length);
    const head = all.slice(0, all.length - source.extended.ranks.length);
    const first = head[0];
    const top = head[head.length - 1];
    const ratio =
      head.length >= 2 && first > 0 && top > first
        ? Math.pow(top / first, 1 / (head.length - 1))
        : null;

    if (ratio === null) {
      miscut.push(`${v.scenario} is extended from a tier with no step to continue`);
    } else if (Math.abs(ratio - source.extended.ratio) > 1e-4) {
      miscut.push(
        `${v.scenario} records a step of ${source.extended.ratio}, its own tier gives ` +
          `${ratio.toFixed(6)}`,
      );
    } else {
      const redone = tail.map((_, i) => Math.round(top * Math.pow(ratio, i + 1)));
      for (let i = 0; i < redone.length; i++) {
        const under = i === 0 ? top : redone[i - 1];
        if (redone[i] <= under) redone[i] = under + 1;
      }
      if (redone.join(",") !== tail.join(",")) {
        miscut.push(
          `${v.scenario} is extended to [${tail.join(", ")}], its own step re-derives ` +
            `[${redone.join(", ")}]`,
        );
      }
    }
  }

  const problem = checkAgainstSource(v.rankMaxes ?? [], source);
  if (problem) wrong.push(`${v.scenario} ${problem}`);
}

check(
  "every percentile cut re-derives from the board it names, at the ladder's shares",
  miscut.length === 0,
  miscut.length ? `\n       ${miscut.slice(0, 6).join("\n       ")}` : "",
);
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

// ---- every rank can be earned ----------------------------------------------------------------
//
// A threshold above the board's world record is a rank that scenario cannot give out. On an
// Advanced variant reaching into the Expert window that is expected - those ranks are the
// Expert variant's to award, and a family takes the best of its variants - so the question is
// asked of the family: is every rank it grades awarded by at least one variant? Two Expert
// thresholds adopted verbatim from Aimerz+ failed this (darkPressure 10400 against a record of
// 10300, 1w4ts HF Hard 250 against 244), leaving Static Clicking's top two ranks and its
// positional rank out of reach. Nothing checked it, although PLAN.md said something did.

const records = new Map(
  (
    JSON.parse(readFileSync(dataFile("leaderboard_apex.json"), "utf8")) as {
      boards: { scenario: string; points: { score: number }[] }[];
    }
  ).boards.map((b) => [b.scenario, b.points[0]?.score]),
);
const unearnable: string[] = [];
let unmeasured = 0;
for (const family of pool.families) {
  const graded = new Set<number>();
  const awarded = new Set<number>();
  for (const v of family.variants) {
    const covers = windowRankIndices(v.window, pool.windowSize, totalRanks, overlap);
    const record = records.get(v.scenario);
    covers.forEach((rank, i) => {
      if (v.rankMaxes?.[i] === undefined) return;
      graded.add(rank);
      if (record === undefined) { unmeasured++; awarded.add(rank); }
      else if (v.rankMaxes[i] <= record) awarded.add(rank);
    });
  }
  const missing = [...graded].filter((r) => !awarded.has(r));
  if (missing.length) unearnable.push(`${family.family}: rank(s) ${missing.map((r) => r + 1).join(", ")}`);
}
check(
  "every rank a family grades is at or below some variant's world record",
  unearnable.length === 0,
  unearnable.length ? `\n       ${unearnable.slice(0, 6).join("\n       ")}` : "",
);
if (unmeasured > 0) console.log(`  ${DIM}${unmeasured} threshold(s) on scenarios with no sampled record, not checked${RESET}`);

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
