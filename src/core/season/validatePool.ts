/**
 * Hold the season pool to the claims made about it.
 *
 *   npx tsx src/core/season/validatePool.ts
 *
 * `data/pool.json` is hand-maintained, which is right - deciding that Frogtagon is the
 * Linear family's Easy variant is a judgement, and judgements belong in a file somebody
 * edits. But a hand-maintained file makes claims that a hand cannot keep true:
 *
 *   PROVENANCE   every scenario comes from a benchmark the pool names in `sources`, and
 *                every one of those is a real benchmark on evxl's registry with a
 *                committed definition. Without a check this is a sentence in a comment
 *                that stops being true the first time a nice scenario from somewhere
 *                else gets added.
 *
 *   BANDS        a scenario's window is the band the pool assigns the hardest tier it is
 *                published in. Placing one by hand is how a family ends up with two
 *                variants of the same difficulty and a ladder that skips a rank.
 *
 *   SUB-SKILLS   a family's sub-skill agrees with what the benchmarks themselves call
 *                its scenarios, as derived in `data/subskills.json`.
 *
 *   IDENTITY     the leaderboard id belongs to the scenario named. Get one wrong and
 *                nothing fails: thresholds are sampled, they ascend, the season builds,
 *                and a whole family is graded against another scenario's board forever.
 *                This is the check that cannot be skipped.
 *
 *   POPULATION   a threshold is a percentile, and a percentile of two hundred scores is
 *                noise. A board too thin to cut ranks from is not a usable scenario
 *                however good it is.
 *
 *   SHAPE        one scenario per family per window, no scenario in two families, every
 *                family classified into a category and a sub-category.
 *
 * The no-scenario-in-two-families rule earns its keep: category energy is the *sum* of
 * its families, so the same scenario in two of them pays twice for one run, and the only
 * symptom is a category that ranks slightly too easily.
 *
 * Nothing here reaches the network. It reads the committed benchmark definitions, the
 * committed popularity measurement and the committed leaderboard sample, so it runs in
 * the suite alongside everything else.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../dataDir.ts";
import type { Distribution } from "./percentiles.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Where the season's benchmarks come from, for the check that they are real.
 *
 * The pool used to be held to "the fifteen most-played benchmarks on evxl", which was the
 * right rule while the pool was a Voltaic ladder with a few borrowings and the wrong one
 * now. A rank cut off the top fifteen cannot reach Viscose, Jade Palace, Lemon Static,
 * snakbox or Avasive - benchmarks people asked for by name and which cover sub-skills
 * Voltaic never published a scenario for - and it lets in nothing from outside the list
 * however good it is.
 *
 * So the pool names its own sources and this checks the naming: every source is a
 * benchmark evxl actually lists, every source has a committed definition to read, and no
 * scenario comes from anywhere else. Popularity stays in the report - it is worth seeing
 * that a source has 60,000 players or 83 - but it no longer decides.
 */
const REGISTRY = "evxl_registry.json";

/**
 * How many players must sit above a window's hardest rank for its board to be usable.
 *
 * A rank is the score at a percentile of a board, so what makes a board too thin is not
 * its size but how few people end up on the far side of the cut. This used to be one
 * number for the whole pool - 5,000 entries, chosen because 5,000 puts seventy players
 * above the top 1.4% that window 3's hardest rank asks for - and applying that same 5,000
 * to window 0 asks something completely different, because window 0's hardest rank is the
 * top 70%: on a 5,000-entry board that is 3,500 players, fifty times the evidence the same
 * rule settles for at the top of the ladder.
 *
 * The cost of that was not theoretical. It ruled out Clicking/Micro and Tracking/Reading
 * entirely - the whole 43-benchmark corpus has exactly one novice-tier scenario for each,
 * and their boards are 2,382 and 2,836 - on the strength of a standard neither of them
 * needed to meet.
 *
 * So the requirement is stated as what it was always trying to say, and derived per window
 * from that window's own hardest percentile. Window 3 is unchanged at 5,000; the others
 * fall out of the same arithmetic.
 */
const MIN_ABOVE_HARDEST_RANK = 70;

/**
 * And no board under this, whatever the arithmetic says.
 *
 * Window 0's hardest rank is the top 70%, which the rule above would satisfy with a
 * hundred entries. A hundred-entry board is one clan's scenario rather than a population,
 * and a percentile of it is a fact about them.
 */
const ENTRIES_FLOOR = 1_000;

interface Pool {
  windowSize: number;
  windows: string[];
  /** Percentiles from the top of each board, one array per window. See ladder.$comment. */
  ladder: { perWindow: number[][] };
  categories: string[];
  /** The sub-skills each category is cut into. Apogee's own, derived in data/subskills.json. */
  subCategories: Record<string, string[]>;
  /** Scenarios whose derived sub-skill the pool deliberately disagrees with, and why. */
  subCategoryOverrides?: Record<string, { subCategory: string; why: string }>;
  /** Every benchmark the pool is allowed to draw a scenario from. */
  sources: string[];
  /** benchmark -> difficulty tier -> which window that tier belongs to. */
  bands: Record<string, Record<string, number>>;
  families: {
    family: string;
    category: string;
    /**
     * Which sub-skill of its category this family trains.
     *
     * Declared in the pool rather than looked up: the pool's families are Apogee's own and
     * most of them are not Voltaic's. `data/subskills.json` says what the benchmarks
     * themselves call each scenario, and the declaration is checked against it below.
     */
    subCategory?: string;
    variants: { window: number; scenario: string; label: string; leaderboardId: number | null }[];
  }[];
}

interface BenchmarkDef {
  benchmarkName: string;
  difficulties?: {
    name: string;
    categories?: { name: string; scenarios?: { name: string; leaderboardId: number | null }[] }[];
  }[];
}

interface Popularity {
  benchmarks: { benchmark: string; players: number | null; evxlListingRank: number }[];
}

interface Registry {
  benchmarks: { benchmarkName: string }[];
}

interface SubSkills {
  categories: Record<string, string[]>;
  scenarios: {
    scenario: string;
    category: string | null;
    subSkill: string | null;
    via: string | null;
  }[];
}

interface Taxonomy {
  scenarios: { name: string; aimType: string | null; entries: number | null }[];
}

interface SubCategories {
  families: Record<string, { skill: string; subCategory: string }>;
}

let failures = 0;
let warnings = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

function warn(label: string, detail = ""): void {
  console.log(`  ${DIM}warn${RESET} ${label}${detail ? `: ${detail}` : ""}`);
  warnings++;
}

/** KovaaK's says "Target Switching" on one endpoint and "Switching" on another. */
function normaliseSkill(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  if (key === "target switching") return "Switching";
  if (key === "clicking" || key === "tracking" || key === "switching") {
    return key[0].toUpperCase() + key.slice(1);
  }
  return null;
}

const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as Pool;

const taxonomy = new Map(
  (JSON.parse(readFileSync(dataFile("scenario_taxonomy.json"), "utf8")) as Taxonomy).scenarios.map(
    (s) => [s.name, s],
  ),
);

const voltaicSubCategories = (
  JSON.parse(readFileSync(dataFile("subcategories.json"), "utf8")) as SubCategories
).families;

const subskillsFile = dataFile("subskills.json");
const derivedSubSkills = existsSync(subskillsFile)
  ? (JSON.parse(readFileSync(subskillsFile, "utf8")) as SubSkills)
  : null;
const derivedFor = new Map(
  (derivedSubSkills?.scenarios ?? [])
    .filter((s) => s.subSkill !== null)
    .map((s) => [s.scenario, s]),
);

/**
 * The pool's own declaration wins.
 *
 * Voltaic's sheet is still consulted, but only for a family that is one of theirs and has
 * no declaration of its own - which after this season's rebuild is none of them. It stays
 * because dropping a fallback silently turns "no sub-skill" into a fresh failure the first
 * time somebody adds a Voltaic family back without declaring one.
 */
function subCategoryOf(family: { family: string; subCategory?: string }): string | null {
  return family.subCategory ?? voltaicSubCategories[family.family]?.subCategory ?? null;
}

function declaredSkillOf(family: { family: string; subCategory?: string }): string | null {
  if (family.subCategory) return null;
  return voltaicSubCategories[family.family]?.skill ?? null;
}

// scenario -> the benchmarks that name it, the leaderboard id each gives it, and the
// tiers it is published in. The tiers are what band a scenario into a window.
const fromBenchmarks = new Map<
  string,
  {
    benchmarks: Set<string>;
    leaderboardIds: Set<number>;
    tiers: { benchmark: string; difficulty: string }[];
  }
>();
const benchDir = dataFile("benchmarks");
const committed = new Set<string>();
for (const file of readdirSync(benchDir).filter((f) => f.endsWith(".json"))) {
  const def = JSON.parse(readFileSync(join(benchDir, file), "utf8")) as BenchmarkDef;
  committed.add(def.benchmarkName);
  for (const difficulty of def.difficulties ?? []) {
    for (const category of difficulty.categories ?? []) {
      for (const scenario of category.scenarios ?? []) {
        const entry = fromBenchmarks.get(scenario.name) ?? {
          benchmarks: new Set<string>(),
          leaderboardIds: new Set<number>(),
          tiers: [],
        };
        entry.benchmarks.add(def.benchmarkName);
        entry.tiers.push({ benchmark: def.benchmarkName, difficulty: difficulty.name });
        if (typeof scenario.leaderboardId === "number" && scenario.leaderboardId > 0) {
          entry.leaderboardIds.add(scenario.leaderboardId);
        }
        fromBenchmarks.set(scenario.name, entry);
      }
    }
  }
}

const popularityFile = dataFile("benchmark_popularity.json");
const popularity = existsSync(popularityFile)
  ? (JSON.parse(readFileSync(popularityFile, "utf8")) as Popularity)
  : null;
const reachOf = new Map(
  (popularity?.benchmarks ?? []).map((b) => [b.benchmark, b] as const),
);

const registryFile = dataFile(REGISTRY);
const listed = new Set(
  existsSync(registryFile)
    ? (JSON.parse(readFileSync(registryFile, "utf8")) as Registry).benchmarks.map(
        (b) => b.benchmarkName,
      )
    : [],
);

const sources = new Set(pool.sources ?? []);

const percentileFile = dataFile("leaderboard_percentiles.json");
const sampled = new Map(
  existsSync(percentileFile)
    ? (
        JSON.parse(readFileSync(percentileFile, "utf8")) as { distributions: Distribution[] }
      ).distributions.map((d) => [d.scenario, d])
    : [],
);

const variants = pool.families.flatMap((f) =>
  f.variants.map((v) => ({ ...v, family: f.family, category: f.category })),
);

console.log(
  `\n${BOLD}season pool${RESET}  ${pool.families.length} families, ${variants.length} ` +
    `scenarios, ${pool.windows.length} windows of ${pool.windowSize}\n`,
);

// ---- shape --------------------------------------------------------------------------
console.log(`${BOLD}shape${RESET}`);

check(
  "every family is in a category the pool declares",
  pool.families.every((f) => pool.categories.includes(f.category)),
  pool.families
    .filter((f) => !pool.categories.includes(f.category))
    .map((f) => f.family)
    .join(", "),
);

const wrongWidth = pool.families.filter((f) => {
  const windows = new Set(f.variants.map((v) => v.window));
  return windows.size !== pool.windows.length || f.variants.length !== pool.windows.length;
});
check(
  "every family covers every window exactly once",
  wrongWidth.length === 0,
  wrongWidth.map((f) => f.family).join(", "),
);

const seen = new Map<string, string[]>();
for (const v of variants) {
  seen.set(v.scenario, [...(seen.get(v.scenario) ?? []), v.family]);
}
const shared = [...seen].filter(([, families]) => families.length > 1);
check(
  "no scenario appears in two families",
  shared.length === 0,
  shared.map(([name, families]) => `${name} in ${families.join(" and ")}`).join("; "),
);

const noId = variants.filter((v) => typeof v.leaderboardId !== "number" || v.leaderboardId <= 0);
check("every scenario carries a leaderboard id", noId.length === 0, noId.map((v) => v.scenario).join(", "));

const perCategory = pool.categories.map(
  (c) => `${c} ${pool.families.filter((f) => f.category === c).length}`,
);
console.log(`  ${DIM}families per category: ${perCategory.join(", ")}${RESET}`);

// ---- identity -----------------------------------------------------------------------
//
// The one that matters most. A wrong id grades a family against another scenario's board
// and nothing downstream can tell.
console.log(`\n${BOLD}identity${RESET}`);

const unknown: string[] = [];
const mismatched: string[] = [];

for (const v of variants) {
  const fromBench = fromBenchmarks.get(v.scenario);
  const fromTaxonomy = taxonomy.get(v.scenario);

  const ids = new Set<number>(fromBench?.leaderboardIds ?? []);
  const taxonomyId = (fromTaxonomy as { leaderboardId?: number | null } | undefined)?.leaderboardId;
  if (typeof taxonomyId === "number" && taxonomyId > 0) ids.add(taxonomyId);

  if (ids.size === 0) {
    unknown.push(v.scenario);
    continue;
  }
  if (v.leaderboardId != null && !ids.has(v.leaderboardId)) {
    mismatched.push(`${v.scenario} says ${v.leaderboardId}, KovaaK's says ${[...ids].join("/")}`);
  }
}

check(
  "every leaderboard id matches what KovaaK's publishes for that scenario",
  mismatched.length === 0,
  mismatched.join("; "),
);
if (unknown.length > 0) {
  warn(
    `${unknown.length} scenario(s) appear in no committed benchmark or taxonomy entry, so ` +
      `their id could not be checked`,
    unknown.join(", "),
  );
}

// The category, against whoever can speak to it.
//
// KovaaK's own aim type first, and where KovaaK's has none, the one the derivation read
// off the author's grouping - a benchmark's category slot inside one difficulty is
// homogeneous by construction, so a scenario sharing a slot with three Switching
// scenarios is a switching scenario. Nine of the pool's 88 have no aim type from
// KovaaK's, and this used to skip them with a warning; skipping them meant the pool
// could file `Bounce 180 Tracking` under Clicking and nothing would say so.
const untyped: string[] = [];
const miscategorised: string[] = [];

/**
 * Scenarios whose KovaaK's aim type has been measured to be wrong.
 *
 * KovaaK's is authoritative here and stays authoritative: this is the only mechanism that
 * can overrule it, it carries a measurement rather than an opinion, and validate:aimtypes
 * re-derives that measurement from the corpus. Read as data rather than reimplemented so
 * the pool, the seed and the sub-skill derivation cannot come to disagree about which
 * scenarios are corrected.
 */
const aimTypeCorrections = new Map<string, string>(
  Object.entries(
    (
      JSON.parse(readFileSync(dataFile("aim_type_corrections.json"), "utf8")) as {
        corrections: Record<string, { aimType: string }>;
      }
    ).corrections,
  ).map(([name, c]) => [name, c.aimType]),
);

const corrected: string[] = [];

for (const v of variants) {
  const correction = normaliseSkill(aimTypeCorrections.get(v.scenario));
  const fromKovaaks = normaliseSkill(taxonomy.get(v.scenario)?.aimType);
  const derived = derivedFor.get(v.scenario);
  const source = correction
    ? { category: correction, who: "a measured correction" }
    : fromKovaaks
      ? { category: fromKovaaks, who: "KovaaK's" }
      : derived?.category
        ? { category: derived.category, who: "the benchmarks that publish it" }
        : null;

  if (correction && fromKovaaks && correction !== fromKovaaks) {
    corrected.push(`${v.scenario}: ${fromKovaaks} to KovaaK's, ${correction} measured`);
  }

  if (!source) {
    untyped.push(v.scenario);
    continue;
  }
  if (source.category !== v.category) {
    miscategorised.push(
      `${v.scenario} is ${v.category} here, ${source.category} to ${source.who}`,
    );
  }
}

for (const line of corrected) {
  console.log(`  ${DIM}correction  ${line}${RESET}`);
}

check(
  "every scenario's category agrees with KovaaK's aim type, or with its own benchmark",
  miscategorised.length === 0,
  miscategorised.join("; "),
);
if (untyped.length > 0) {
  warn(
    `${untyped.length} scenario(s) have no aim type from KovaaK's and none their own ` +
      `benchmark can settle, so their category rests on the pool alone`,
    untyped.join(", "),
  );
}

// ---- provenance ---------------------------------------------------------------------
console.log(`
${BOLD}provenance${RESET}`);

check(
  "the pool names the benchmarks it draws from",
  sources.size > 0,
  sources.size > 0 ? "" : "pool.sources is empty",
);

const unlisted = [...sources].filter((b) => !listed.has(b));
check(
  "every source is a benchmark evxl lists",
  listed.size === 0 || unlisted.length === 0,
  unlisted.join(", "),
);
if (listed.size === 0) warn("no data/evxl_registry.json - run npm run fetch:evxl");

const uncommitted = [...sources].filter((b) => !committed.has(b));
check(
  "every source has a committed definition to read",
  uncommitted.length === 0,
  uncommitted.length === 0 ? "" : `${uncommitted.join(", ")} - run tools/fetch_benchmark_defs.py`,
);

const offPool: string[] = [];
for (const v of variants) {
  const benchmarks = fromBenchmarks.get(v.scenario)?.benchmarks ?? new Set<string>();
  if (![...benchmarks].some((b) => sources.has(b))) {
    offPool.push(
      `${v.scenario}${
        benchmarks.size > 0
          ? ` (only in ${[...benchmarks].join(", ")})`
          : " (in no committed benchmark)"
      }`,
    );
  }
}
check(
  "every scenario comes from a benchmark the pool names",
  offPool.length === 0,
  offPool.join("; "),
);

// A source nothing is drawn from is not an error - it is there to be drawn from next
// season, and dropping it would make the list a log of what happened rather than a
// statement of what is allowed. But it is worth seeing.
if (!popularity) {
  warn("no data/benchmark_popularity.json - run tools/benchmarkPopularity.ts");
}

const unused: string[] = [];
for (const b of [...sources].sort()) {
  const count = variants.filter((v) =>
    fromBenchmarks.get(v.scenario)?.benchmarks.has(b),
  ).length;
  if (count === 0) unused.push(b);

  const reach = reachOf.get(b);
  const players =
    reach == null
      ? "unmeasured"
      : reach.players === null
        ? "unmeasurable"
        : reach.players.toLocaleString();
  console.log(
    `  ${DIM}${b.slice(0, 40).padEnd(42)}${players.padStart(12)} players  ` +
      `${count > 0 ? `${count} scenario(s)` : "not used"}${RESET}`,
  );
}
if (unused.length > 0) {
  warn(`${unused.length} source(s) contribute nothing to the pool`, unused.join(", "));
}

// ---- bands ----------------------------------------------------------------------------
//
// A variant's window is not a free choice. It is the band the pool gives the hardest tier
// the scenario is published in, and the reason to check it is that nothing downstream can:
// a Novice scenario filed as Expert samples fine, builds fine, and produces four ranks at
// the top of the ladder that anyone who can play at all clears in one run.
console.log(`
${BOLD}bands${RESET}`);

/**
 * How alike two tiers of one benchmark are, as shared scenarios over the union.
 *
 * The number matters because it separates two things that look identical in the data: an
 * author whose tiers are different scenarios, and an author whose tiers are the SAME
 * scenarios with a higher score asked of them. See `derivedWindow`.
 */
function tierOverlap(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((n) => b.has(n)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

/**
 * Tier pairs alike enough that the difficulty is in the score, not the scenario.
 *
 * MEASURED across the corpus, and the separation is not close. Every tier pair in every
 * source that shares a scenario at all:
 *
 *   Aimerz+ SpeedTS          Easy/Hard          10 of 14 shared   0.71
 *   Aimerz+ Evasive          Easy/Hard           3 of 21           0.14
 *   Revosect S1              Easy/Advanced       5 of 43           0.12
 *   Voltaic S3               Inter/Advanced      3 of 33           0.09
 *   Viscose Benchmarks       Easier/Medium       4 of 68           0.06
 *   Aimerz+ Precise          Easy/Hard           1 of 23           0.04
 *
 * One pair sits at 0.71 and the next at 0.14, so 0.5 is a threshold with nothing near it
 * rather than a number chosen to get an answer. Aimerz+ SpeedTS runs the same twelve
 * scenarios at both difficulties; everyone else changes the scenarios.
 */
const SAME_SCENARIOS_OVERLAP = 0.5;

/** Scenario names per benchmark tier, for the overlap test. */
const tierMembers = new Map<string, Map<string, Set<string>>>();
for (const [scenario, entry] of fromBenchmarks) {
  for (const t of entry.tiers) {
    if (!sources.has(t.benchmark)) continue;
    const byTier = tierMembers.get(t.benchmark) ?? new Map<string, Set<string>>();
    const members = byTier.get(t.difficulty) ?? new Set<string>();
    members.add(scenario);
    byTier.set(t.difficulty, members);
    tierMembers.set(t.benchmark, byTier);
  }
}

/**
 * The window a scenario's tiers band it into, or null when none of them are banded.
 *
 * The rule is the HARDEST tier any source publishes it in - a scenario Voltaic calls
 * Intermediate and snakbox calls Hard is being asked for more by snakbox, and grading it
 * at the easier ask sets a rank everyone in the harder band already holds.
 *
 * With one correction, measured rather than assumed. Aimerz+ SpeedTS lists the same twelve
 * scenarios in both its Easy and its Hard tier - `voxTS Viscose Varied` and
 * `patCircleSwitch NR` among them. The author is not saying the scenario gets harder; they
 * are asking a higher score of the same scenario. Reading that Hard listing as scenario
 * difficulty turned a threshold difference into two whole windows of ladder, and put two
 * Intermediate switching scenarios in the Expert band.
 *
 * So where a benchmark's two tiers are substantially the same scenario set, that benchmark
 * speaks with its easiest listing. Where they are different sets - every other source, by a
 * wide margin - a scenario appearing in two of them is the author placing it twice, and the
 * harder listing stands. The hardest-tier rule then runs across benchmarks as before.
 */
function derivedWindow(
  tiers: { benchmark: string; difficulty: string }[],
): { window: number | null; perBenchmark: { benchmark: string; difficulty: string; band: number }[] } {
  const perBenchmarkMap = new Map<string, { benchmark: string; difficulty: string; band: number }>();

  for (const t of tiers) {
    const band = pool.bands?.[t.benchmark]?.[t.difficulty];
    if (typeof band !== "number") continue;

    const prior = perBenchmarkMap.get(t.benchmark);
    if (!prior) {
      perBenchmarkMap.set(t.benchmark, { benchmark: t.benchmark, difficulty: t.difficulty, band });
      continue;
    }

    const members = tierMembers.get(t.benchmark);
    const alike =
      members !== undefined &&
      tierOverlap(
        members.get(t.difficulty) ?? new Set<string>(),
        members.get(prior.difficulty) ?? new Set<string>(),
      ) >= SAME_SCENARIOS_OVERLAP;

    // Alike: the tiers differ by score, so the easier listing is what this benchmark
    // actually claims about the scenario. Not alike: two genuine placements, harder wins.
    const take = alike ? band < prior.band : band > prior.band;
    if (take) {
      perBenchmarkMap.set(t.benchmark, { benchmark: t.benchmark, difficulty: t.difficulty, band });
    }
  }

  const perBenchmark = [...perBenchmarkMap.values()];
  return {
    window: perBenchmark.length === 0 ? null : Math.max(...perBenchmark.map((t) => t.band)),
    perBenchmark,
  };
}
const unbanded: string[] = [];
const misbanded: string[] = [];

for (const v of variants) {
  // Only a source's tiers band a scenario. A benchmark the pool does not draw from has no
  // say in how hard the pool thinks a scenario is - which is the whole reason e1se's
  // Tracking Routine is not a source: it files Voltaic Novice scenarios under its own
  // "Intermediate" tier, and letting that band them would put VT Smoothbot Novice, the
  // easiest tracking scenario Voltaic publishes, in window 2.
  const tiers = (fromBenchmarks.get(v.scenario)?.tiers ?? []).filter((t) =>
    sources.has(t.benchmark),
  );
  const { window: hardest } = derivedWindow(tiers);

  if (hardest === null) {
    unbanded.push(
      `${v.scenario} (${tiers.map((t) => `${t.benchmark} ${t.difficulty}`).join(", ") || "no tier"})`,
    );
    continue;
  }

  if (v.window !== hardest) {
    misbanded.push(
      `${v.scenario} is window ${v.window} here, ${hardest} by its hardest tier ` +
        `(${tiers.map((t) => `${t.benchmark} ${t.difficulty}`).join(", ")})`,
    );
  }
}

check(
  "every scenario's tier is banded",
  unbanded.length === 0,
  unbanded.length === 0 ? "" : `${unbanded.join("; ")} - add the tier to pool.bands`,
);
check(
  "every scenario sits in the window its hardest tier bands it into",
  misbanded.length === 0,
  misbanded.join("; "),
);

// Which windows rest on one benchmark's opinion alone.
//
// The band rule takes the HARDEST tier any source publishes a scenario in, which is
// deliberate: a scenario Voltaic calls Intermediate and snakbox calls Hard is being asked
// for more by snakbox, and grading it at the easier ask sets a rank everyone in the harder
// band already holds. The cost of that rule is that a single source can raise a scenario a
// whole window on its own, and nothing downstream can tell that happened.
//
// This is a report rather than a check, because being raised by one source is not an
// error - it is the rule working. It is printed because the sources are not equally well
// evidenced: snakbox carries 83 measured players against Viscose's 60,536, and "the
// thinnest source in the pool is the only reason this scenario is Expert" is a sentence
// somebody should have to read before publishing a season, not discover afterwards.
//
// The gap is worth reading as well as the count, and the two-window jumps have a cause
// worth knowing: a benchmark's tiers are mapped onto four windows, so an author who
// publishes only Easy and Hard has their Hard land at window 3 by construction. Both
// scenarios currently raised by two windows come from such a benchmark. That is not
// obviously wrong - Aimerz+ Hard genuinely is the hardest tier its author publishes -
// but it means a two-tier benchmark's top tier outranks a four-tier benchmark's
// Advanced, on nothing more than how finely each author chose to slice their ladder.
// Season 2 can settle it with a population; until then it is stated rather than hidden.
const raisedByOne: { gap: number; line: string }[] = [];

for (const v of variants) {
  const tiers = (fromBenchmarks.get(v.scenario)?.tiers ?? []).filter((t) =>
    sources.has(t.benchmark),
  );
  // One opinion per benchmark, from the same derivation the check uses - otherwise this
  // report would count an author's two listings of one scenario as two sources agreeing.
  const banded = derivedWindow(tiers).perBenchmark;

  if (banded.length < 2) continue;

  const hardest = Math.max(...banded.map((t) => t.band));
  const atHardest = banded.filter((t) => t.band === hardest);
  if (atHardest.length !== 1) continue;

  const runnerUp = Math.max(...banded.filter((t) => t.band !== hardest).map((t) => t.band));
  const sole = atHardest[0];
  raisedByOne.push({
    gap: hardest - runnerUp,
    line:
      `${v.scenario}: window ${hardest} on ${sole.benchmark} ${sole.difficulty} alone, ` +
      `${runnerUp} by the other ${banded.length - 1}`,
  });
}

if (raisedByOne.length > 0) {
  // Widest gap first. One window is the rule doing its job; two means a scenario two
  // other benchmarks call Intermediate is being graded as Expert, which is a much
  // larger claim resting on the same single opinion.
  raisedByOne.sort((a, b) => b.gap - a.gap);
  const jumps = raisedByOne.filter((r) => r.gap > 1).length;

  console.log(
    `  ${DIM}${raisedByOne.length} scenario(s) sit higher than every other source puts them` +
      `${jumps > 0 ? `, ${jumps} by more than one window` : ""}:${RESET}`,
  );
  for (const r of raisedByOne) {
    console.log(`  ${DIM}  ${r.gap > 1 ? "!" : " "} ${r.line}${RESET}`);
  }
}
// Scenarios only one benchmark bands at all.
//
// The report above needs two opinions to have anything to compare, so it says nothing about
// a scenario only one source names - and that is the thinner position of the two, not the
// safer one. A disagreement between two sources is at least visible; a single source cannot
// be contradicted by anything.
//
// Not an error, and mostly not even a worry: over a third of these are Voltaic S4 novice
// scenarios that no other benchmark had reason to re-band. It matters most at window 3,
// where the percentile is thinnest and a misplacement costs the top of a ladder, so those
// are named and the rest are counted.
const soloBanded: { window: number; scenario: string; benchmark: string }[] = [];

for (const v of variants) {
  const tiers = (fromBenchmarks.get(v.scenario)?.tiers ?? []).filter((t) =>
    sources.has(t.benchmark),
  );
  const banded = derivedWindow(tiers).perBenchmark;
  if (banded.length === 1) {
    soloBanded.push({ window: v.window, scenario: v.scenario, benchmark: banded[0].benchmark });
  }
}

if (soloBanded.length > 0) {
  const top = soloBanded.filter((x) => x.window === pool.windows.length - 1);
  console.log(
    `  ${DIM}${soloBanded.length} scenario(s) are banded by one benchmark and nothing else` +
      `${top.length > 0 ? `, ${top.length} of them at the top window:` : ""}${RESET}`,
  );
  for (const x of top) {
    console.log(`  ${DIM}    ${x.scenario} (${x.benchmark})${RESET}`);
  }
}
const bandedTiers = Object.values(pool.bands ?? {}).reduce(
  (n, tiers) => n + Object.keys(tiers).length,
  0,
);
console.log(
  `  ${DIM}${bandedTiers} tiers banded across ${Object.keys(pool.bands ?? {}).length} ` +
    `benchmarks${RESET}`,
);

// ---- population ---------------------------------------------------------------------
console.log(`\n${BOLD}population${RESET}`);

/**
 * Fewest entries a board may carry to grade the given window.
 *
 * This used to derive from `ladder.perWindow`: seventy players above the hardest rank,
 * divided by that rank's percentile, which put Expert at 8,750. The arithmetic was right
 * for as long as a rank *was* a percentile of the board. It is not any more - every
 * threshold is a score an author published - so dividing by a percentile is dividing by a
 * number the ladder no longer uses, and it was rejecting boards for failing a standard
 * nothing measures against.
 *
 * What survives is the floor, and it survives for its own reason rather than that one: a
 * board under a thousand entries is one clan's scenario rather than a population, and the
 * sampled distribution read off it is a fact about them. That still rejects - VT bounceTS
 * Elite at 318 and VT DriftTS Elite at 619 are why Switching could not be widened at this
 * corpus - so this is a check that can still fail rather than one relaxed into silence.
 *
 * The positional top rank (PLAN.md, stage 4) will need its own requirement here, because
 * "top 3 on the board" is a claim about board depth again. It is not built, so it is not
 * asserted: `window` stays in the signature for it to key off, and MIN_ABOVE_HARDEST_RANK
 * stays documented above as the record of what the percentile era required.
 */
function minEntriesFor(_window: number): number {
  return ENTRIES_FLOOR;
}

const thin: string[] = [];
const unsampled: string[] = [];

for (const v of variants) {
  const distribution = sampled.get(v.scenario);
  if (!distribution) {
    unsampled.push(v.scenario);
    continue;
  }
  const minimum = minEntriesFor(v.window);
  if (distribution.total < minimum) {
    thin.push(
      `${v.scenario} has ${distribution.total.toLocaleString()} for ` +
        `${pool.windows[v.window]}, which needs ${minimum.toLocaleString()}`,
    );
  }
}

if (unsampled.length > 0) {
  warn(
    `${unsampled.length} scenario(s) not yet sampled - run npm run sample:leaderboards`,
    unsampled.slice(0, 8).join(", ") + (unsampled.length > 8 ? ", ..." : ""),
  );
}
check(
  `every board is big enough for the window it grades ` +
    `(${pool.windows.map((w, i) => `${w} ${minEntriesFor(i).toLocaleString()}`).join(", ")})`,
  thin.length === 0,
  thin.join("; "),
);

const totals = variants
  .map((v) => sampled.get(v.scenario)?.total)
  .filter((n): n is number => typeof n === "number")
  .sort((a, b) => a - b);
if (totals.length > 0) {
  console.log(
    `  ${DIM}board size: smallest ${totals[0].toLocaleString()}, median ` +
      `${totals[Math.floor(totals.length / 2)].toLocaleString()}, largest ` +
      `${totals[totals.length - 1].toLocaleString()}${RESET}`,
  );
}

// ---- sub-skills -----------------------------------------------------------------------
//
// The weakness map and the sub-category match queues are keyed on these, so a family with
// no entry does not break anything loudly - it just quietly stops being findable.
console.log(`
${BOLD}sub-skills${RESET}`);

const unmapped = pool.families.filter((f) => !subCategoryOf(f));
check(
  "every family has a sub-skill",
  unmapped.length === 0,
  unmapped.map((f) => f.family).join(", "),
);

const undeclared = pool.families.filter((f) => {
  const sub = subCategoryOf(f);
  return sub !== null && !(pool.subCategories?.[f.category] ?? []).includes(sub);
});
check(
  "every family's sub-skill is one the pool declares for its category",
  undeclared.length === 0,
  undeclared.map((f) => `${f.family}: ${subCategoryOf(f)} not in ${f.category}`).join("; "),
);

// Only checkable where the mapping carries a skill of its own - the pool's declaration is
// a sub-skill alone, and its category is already stated one level up.
const disagreeing = pool.families.filter((f) => {
  const skill = declaredSkillOf(f);
  return skill !== null && normaliseSkill(skill) !== f.category;
});
check(
  "every family's sub-skill sits in the same category the pool puts it in",
  disagreeing.length === 0,
  disagreeing.map((f) => `${f.family}: ${declaredSkillOf(f)} vs ${f.category}`).join("; "),
);

// The declaration held to what the benchmarks themselves say.
//
// This is the check that keeps the pool honest about its own families. A family is one
// sub-skill measured at four difficulties, and picking the four is a judgement - but
// calling a family Precise and then filling it with scenarios their own authors file
// under Reactive is not a judgement, it is a mistake that survives every other check
// here. `data/subskills.json` is derived from those authors' category names and agrees
// with Voltaic's published sheet on all 106 of Voltaic's scenarios, so it is the right
// thing to hold the declaration to.
//
// A variant the derivation could not classify is skipped rather than failed: plenty of
// good scenarios are published only under a top-level "Tracking", and refusing those
// would rule out the scenario for a reason that has nothing to do with the scenario.
//
// An override is the pool saying it disagrees with the derivation on one scenario, in
// writing. It is exempt from the check and reported instead - but only while it still
// disagrees. An override that has come to agree with the derivation is dead weight
// carrying a justification nobody is testing, so it fails.
const overrides = pool.subCategoryOverrides ?? {};

if (!derivedSubSkills) {
  warn("no data/subskills.json - run tools/deriveSubskills.ts");
} else {
  const contradicted: string[] = [];
  let checked = 0;

  for (const v of variants) {
    const derived = derivedFor.get(v.scenario);
    if (!derived || derived.category !== v.category) continue;
    const declared = subCategoryOf(
      pool.families.find((f) => f.family === v.family && f.category === v.category)!,
    );
    if (declared === null) continue;
    if (overrides[v.scenario]) continue;
    checked++;
    if (derived.subSkill !== declared) {
      contradicted.push(
        `${v.scenario} is ${declared} in family ${v.family}, ` +
          `${derived.subSkill} to the benchmarks that publish it`,
      );
    }
  }

  check(
    `every scenario's sub-skill agrees with the benchmarks that publish it (${checked} checked)`,
    contradicted.length === 0,
    contradicted.join("; "),
  );
}

// ---- overrides ------------------------------------------------------------------------
if (Object.keys(overrides).length > 0) {
  const orphaned: string[] = [];
  const unknownSub: string[] = [];
  const redundant: string[] = [];

  for (const [scenario, entry] of Object.entries(overrides)) {
    const variant = variants.find((v) => v.scenario === scenario);
    if (!variant) {
      orphaned.push(scenario);
      continue;
    }
    if (!(pool.subCategories?.[variant.category] ?? []).includes(entry.subCategory)) {
      unknownSub.push(`${scenario}: ${entry.subCategory} is not a ${variant.category} sub-skill`);
    }
    const derived = derivedFor.get(scenario);
    if (derived && derived.subSkill === entry.subCategory) {
      redundant.push(`${scenario} is already ${entry.subCategory} to the benchmarks`);
    }
    if (!entry.why || entry.why.trim().length < 40) {
      redundant.push(`${scenario} has no reason written down`);
    }
  }

  check("every override names a scenario in the pool", orphaned.length === 0, orphaned.join(", "));
  check(
    "every override names a sub-skill the pool declares",
    unknownSub.length === 0,
    unknownSub.join("; "),
  );
  check(
    "every override still disagrees with the derivation, and says why",
    redundant.length === 0,
    redundant.join("; "),
  );

  for (const [scenario, entry] of Object.entries(overrides)) {
    const derived = derivedFor.get(scenario);
    console.log(
      `  ${DIM}override  ${scenario} → ${entry.subCategory}` +
        `${derived ? ` (derived ${derived.subSkill})` : ""}${RESET}`,
    );
  }
}

// A category whose families all train one sub-skill is a category that measures one
// thing and calls it three. Reported rather than refused: it is a design smell, not a
// broken definition.
for (const category of pool.categories) {
  const subs = new Set(
    pool.families.filter((f) => f.category === category).map((f) => subCategoryOf(f)),
  );
  if (subs.size < 3) {
    warn(`${category} covers only ${subs.size} sub-skill${subs.size === 1 ? "" : "s"}`);
  }
}

// Every sub-skill the pool declares should have a family, or it is a name on a list that
// nothing measures - which is exactly how a weakness map ends up with an empty column.
for (const category of pool.categories) {
  const held = new Set(
    pool.families.filter((f) => f.category === category).map((f) => subCategoryOf(f)),
  );
  const empty = (pool.subCategories?.[category] ?? []).filter((sub) => !held.has(sub));
  if (empty.length > 0) {
    warn(`${category} declares ${empty.join(", ")} and no family trains ${empty.length === 1 ? "it" : "them"}`);
  }
}

for (const category of pool.categories) {
  const families = pool.families.filter((f) => f.category === category);
  const counts = new Map<string, number>();
  for (const f of families) {
    const sub = subCategoryOf(f) ?? "(none)";
    counts.set(sub, (counts.get(sub) ?? 0) + 1);
  }
  console.log(
    `  ${category.padEnd(11)}` +
      [...counts].map(([sub, n]) => `${sub} ${n}`).join(", "),
  );
}

// ---- verdict ------------------------------------------------------------------------
console.log(
  failures === 0
    ? `\nOK: pool validated${warnings > 0 ? `, ${warnings} warning(s)` : ""}\n`
    : `\n${failures} FAILURE(S)\n`,
);
process.exit(failures === 0 ? 0 : 1);
