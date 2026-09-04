/**
 * Hold data/scenario_rationale.json to what it claims.
 *
 *   npx tsx src/core/season/validateRationale.ts
 *
 * A rationale file is documentation, and documentation rots in a way code does not: the
 * pool changes, a family is renamed, and the paragraph explaining why the old one was
 * chosen sits there reading perfectly well and describing nothing. So every joinable claim
 * in it is joined to the file that owns the fact:
 *
 *   the families         must be exactly the pool's families, no more and no fewer
 *   the sub-skills       must be the ones the pool assigns
 *   the cited scenarios  must be scenarios the pool actually names
 *   the audience numbers must equal data/scenario_taxonomy.json to the digit
 *
 * The last one is the point. "5,601,340 plays" is the kind of number that gets written
 * once and is never true again, and a rationale that quotes a stale number to justify a
 * scenario is worse than one that quotes none. Nothing here checks the prose, which is a
 * judgement and stays one - but a judgement resting on a wrong number is checkable, and
 * this is what checks it.
 */

import { readFileSync } from "node:fs";

import { dataFile } from "../dataDir.ts";
import { loadSeason } from "./season.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface Evidence {
  source: string;
  scenario?: string;
  says: string;
}

interface FamilyRationale {
  family: string;
  subCategory: string;
  isolates: string;
  why: string;
  evidence: Evidence[];
  /**
   * How many people this family's best-known scenario reaches.
   *
   * Two shapes, because there are two committed sources and they count different things.
   * `plays`/`entries` are KovaaK's own counters from the taxonomy. `boardEntries` is the
   * leaderboard's own total, and is the only figure available for a scenario the taxonomy
   * does not list - it is built from /scenario/popular, which is a curated list rather than
   * every scenario, and the Speed family's four are real boards that simply are not on it.
   * Exactly one shape per family, checked against the source it names.
   */
  audience:
    | { scenario: string; plays: number; entries: number; boardEntries?: never }
    | { scenario: string; boardEntries: number; plays?: never; entries?: never };
  thin?: string;
}

interface RationaleFile {
  sources: Record<string, { title: string; url: string; kind: string }>;
  families: FamilyRationale[];
}

const rationale = JSON.parse(
  readFileSync(dataFile("scenario_rationale.json"), "utf8"),
) as RationaleFile;

const taxonomy = JSON.parse(
  readFileSync(dataFile("scenario_taxonomy.json"), "utf8"),
) as { scenarios: { name: string; plays: number | null; entries: number | null }[] };

const percentiles = JSON.parse(
  readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"),
) as { distributions: { scenario: string; total: number }[] };

const season = loadSeason();

const tax = new Map(taxonomy.scenarios.map((s) => [s.name, s]));

/** Pool families, and the sub-skill and scenarios each carries. */
const poolFamilies = new Map<string, { subCategory: string | null; scenarios: Set<string> }>();
for (const s of season.scenarios) {
  const family = s.family ?? s.scenario;
  const entry = poolFamilies.get(family) ?? { subCategory: s.subCategory ?? null, scenarios: new Set<string>() };
  entry.scenarios.add(s.scenario);
  poolFamilies.set(family, entry);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

console.log(
  `\n${BOLD}scenario rationale${RESET}  ${rationale.families.length} families, ` +
    `${Object.keys(rationale.sources).length} sources`,
);

// ---- coverage ------------------------------------------------------------------------

console.log(`\n${BOLD}coverage${RESET}`);

const documented = new Set(rationale.families.map((f) => f.family));
const undocumented = [...poolFamilies.keys()].filter((f) => !documented.has(f));
check(
  "every family in the pool has a rationale",
  undocumented.length === 0,
  undocumented.length ? undocumented.join(", ") : `${poolFamilies.size} families`,
);

const orphaned = rationale.families.filter((f) => !poolFamilies.has(f.family));
check(
  "every rationale names a family the pool still has",
  orphaned.length === 0,
  orphaned.length ? orphaned.map((f) => f.family).join(", ") : "",
);

const dupes = rationale.families
  .map((f) => f.family)
  .filter((f, i, all) => all.indexOf(f) !== i);
check("no family is documented twice", dupes.length === 0, dupes.join(", "));

// ---- agreement with the pool ---------------------------------------------------------

console.log(`\n${BOLD}agreement with the pool${RESET}`);

const wrongSubSkill = rationale.families.filter((f) => {
  const pool = poolFamilies.get(f.family);
  return pool && pool.subCategory !== f.subCategory;
});
check(
  "every rationale's sub-skill is the one the pool assigns",
  wrongSubSkill.length === 0,
  wrongSubSkill.map((f) => `${f.family} says ${f.subCategory}, pool says ${poolFamilies.get(f.family)?.subCategory}`).join("; "),
);

const audienceOutsideFamily = rationale.families.filter((f) => {
  const pool = poolFamilies.get(f.family);
  return pool && !pool.scenarios.has(f.audience.scenario);
});
check(
  "every audience number is measured on a scenario in that family",
  audienceOutsideFamily.length === 0,
  audienceOutsideFamily.map((f) => `${f.family} cites ${f.audience.scenario}`).join("; "),
);

const poolScenarios = new Set(season.scenarios.map((s) => s.scenario));
const citedOutsidePool = rationale.families.flatMap((f) =>
  f.evidence
    .filter((e) => e.scenario && !poolScenarios.has(e.scenario))
    .map((e) => `${f.family} cites ${e.scenario}`),
);
check(
  "every cited scenario is one the pool names",
  citedOutsidePool.length === 0,
  citedOutsidePool.join("; "),
);

const unknownSource = rationale.families.flatMap((f) =>
  f.evidence.filter((e) => !rationale.sources[e.source]).map((e) => `${f.family} -> ${e.source}`),
);
check("every citation names a declared source", unknownSource.length === 0, unknownSource.join("; "));

const unusedSource = Object.keys(rationale.sources).filter(
  (id) => !rationale.families.some((f) => f.evidence.some((e) => e.source === id)),
);
check("every declared source is actually cited", unusedSource.length === 0, unusedSource.join(", "));

// ---- the numbers ---------------------------------------------------------------------
//
// The whole reason this validator exists.

console.log(`\n${BOLD}quoted numbers${RESET}  ${DIM}re-derived from scenario_taxonomy.json${RESET}`);

const boardTotals = new Map(percentiles.distributions.map((d) => [d.scenario, d.total]));

const wrongNumbers: string[] = [];
for (const f of rationale.families) {
  const a = f.audience;

  if (a.boardEntries !== undefined) {
    const total = boardTotals.get(a.scenario);
    if (total === undefined) {
      wrongNumbers.push(`${f.family}: ${a.scenario} has no sampled board to check against`);
    } else if (total !== a.boardEntries) {
      wrongNumbers.push(
        `${f.family}: ${a.scenario} board quoted ${a.boardEntries.toLocaleString()}, actual ${total.toLocaleString()}`,
      );
    }
    // Claiming the board only where the taxonomy has nothing to say, so this stays the
    // exception it is meant to be rather than the easy way past a stale figure.
    if (tax.has(a.scenario)) {
      wrongNumbers.push(
        `${f.family}: ${a.scenario} is in the taxonomy, so quote plays and entries rather than the board`,
      );
    }
    continue;
  }

  const t = tax.get(a.scenario);
  if (!t) {
    wrongNumbers.push(
      `${f.family}: ${a.scenario} is not in the taxonomy - quote boardEntries instead`,
    );
    continue;
  }
  if (t.plays !== a.plays) {
    wrongNumbers.push(
      `${f.family}: ${a.scenario} plays quoted ${a.plays.toLocaleString()}, actual ${(t.plays ?? 0).toLocaleString()}`,
    );
  }
  if (t.entries !== a.entries) {
    wrongNumbers.push(
      `${f.family}: ${a.scenario} entries quoted ${a.entries.toLocaleString()}, actual ${(t.entries ?? 0).toLocaleString()}`,
    );
  }
}

check(
  "every quoted play and entry count matches the taxonomy",
  wrongNumbers.length === 0,
  wrongNumbers.length ? `\n       ${wrongNumbers.join("\n       ")}` : `${rationale.families.length} checked`,
);

// Numbers written into the prose are checked too, since that is where a stale figure is
// least visible. Any group of digits long enough to be a play count has to be a real one.
//
// Three files can supply one. The taxonomy holds plays and entries; leaderboard_percentiles
// holds the board total, which is a different number from the taxonomy's entries for the
// same scenario and is the one a claim about board size has to use. Both are committed and
// re-derivable, which is the whole test - a number this cannot find is one nobody can check.
const proseNumbers: string[] = [];
const knownCounts = new Set<number>();
for (const s of taxonomy.scenarios) {
  if (s.plays !== null) knownCounts.add(s.plays);
  if (s.entries !== null) knownCounts.add(s.entries);
}
for (const d of percentiles.distributions) knownCounts.add(d.total);
for (const f of rationale.families) {
  const text = `${f.isolates} ${f.why} ${f.thin ?? ""}`;
  for (const match of text.matchAll(/\b\d{1,3}(?:,\d{3})+\b/g)) {
    const n = Number(match[0].replace(/,/g, ""));
    if (!knownCounts.has(n)) proseNumbers.push(`${f.family}: "${match[0]}"`);
  }
}
check(
  "every large number written into the prose is one the taxonomy holds",
  proseNumbers.length === 0,
  proseNumbers.length ? proseNumbers.join("; ") : "",
);

// ---- what the file says about itself -------------------------------------------------

console.log(`\n${BOLD}evidence${RESET}`);

const noEvidence = rationale.families.filter((f) => f.evidence.length === 0);
check("every family cites at least one source", noEvidence.length === 0, noEvidence.map((f) => f.family).join(", "));

const byKind = new Map<string, number>();
for (const f of rationale.families) {
  for (const e of f.evidence) {
    const kind = rationale.sources[e.source]?.kind ?? "unknown";
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
}
for (const [kind, n] of [...byKind].sort()) console.log(`  ${DIM}${kind.padEnd(14)} ${n} citation(s)${RESET}`);

const thin = rationale.families.filter((f) => f.thin);
console.log(`  ${DIM}${thin.length} family(ies) declare their evidence thin: ${thin.map((f) => f.family).join(", ")}${RESET}`);

console.log(
  failures === 0 ? `\nOK: rationale validated\n` : `\nFAILED: ${failures} check(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
