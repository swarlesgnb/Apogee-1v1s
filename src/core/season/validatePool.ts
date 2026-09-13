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
import { windowRankCount } from "./windows.ts";

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
  ladder: { ranks: number[]; overlap: number };
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
    /**
     * Why this family's rungs disagree with the order its sources publish them in.
     *
     * The ascent check reads the bands; this is how a family says the bands are wrong
     * about it. The usual cause is a size or speed modifier in the scenario name that no
     * sheet graded - a "30% Larger" cut carries its parent's band and is plainly easier.
     */
    $order?: { why: string };
    variants: {
      window: number;
      scenario: string;
      label: string;
      leaderboardId: number | null;
      /**
       * Why a scenario no named benchmark publishes is in the pool anyway.
       *
       * The pool used to admit a scenario only if one of the benchmarks in `sources`
       * published it, which made the 23 sheets the whole universe of what a season could
       * grade. Picking by hand from all of KovaaK's is the better method - it is what took
       * Static Clicking from six families to eleven - so the rule is now that an
       * unpublished pick needs a REASON rather than a citation, written here and checked
       * for by validate:pool.
       *
       * It is not a loophole for a scenario a sheet does publish: the check only looks at
       * this when nothing in `sources` names the scenario, so an admitted variant is always
       * one nobody else has graded. Such a variant also declares its window, since there is
       * no tier to derive it from.
       */
      admitted?: { why: string };
      /** Where the thresholds came from. Only the kind matters here; see thresholds.ts. */
      source?: { kind?: string };
      /**
       * Why this rung keeps a board too thin to separate the ranks it grades.
       *
       * The floor is derived from the ladder and is not negotiable arithmetic - a board
       * under it genuinely cannot tell two of its ranks apart. What this records is that
       * the alternative was worse: usually that the whole lineage is thinner still, so the
       * choice is this board or no family. It has to say which, and it is listed on every
       * run rather than disappearing into a pass.
       */
      thinBoard?: { why: string };
    }[];
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
    /** Viscose's Arm/Wrist/Fingertip/Blending, where an author publishes it. */
    mechanic: string | null;
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
  if (source.category !== aimTypeOf(v.category)) {
    miscategorised.push(
      `${v.scenario} is ${v.category} here, ${source.category} to ${source.who}`,
    );
  }
}

/**
 * The aim type a category belongs to.
 *
 * A category is a sub-skill now - "Dynamic Clicking", "Evasive Switching" - and the two-word
 * form carries its aim type as the second word, which is exactly why the sub-skill names are
 * two words (see `$subCategories`). So the aim type is the last word, and nothing else.
 *
 * Both halves of the comparison are already through `normaliseSkill`, which is where
 * KovaaK's "Target Switching" becomes "Switching". Mapping the word back to KovaaK's
 * spelling here made the check unsatisfiable for every switching scenario in the pool - 53
 * of them, all reported for agreeing.
 *
 * The check before that compared the category to the aim type directly, which was right
 * while a category WAS an aim type and reported all 216 variants once it was not.
 */
function aimTypeOf(category: string): string {
  return category.trim().split(/\s+/).pop() ?? category;
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

// A scenario is admitted by a benchmark that graded it, or by a written reason. The
// second route is not a weakening: a citation says somebody else thought the scenario
// was worth grading, and a sentence says what THIS pool wants it for, which is the more
// useful claim and the harder one to fake. What it replaces was a rule that made the 23
// sheets the whole universe a season could be built from - and the sheets do not cover
// the easy end at all. Voltaic has four novice-band precise-tracking scenarios in the
// entire committed set, so every family's Novice rung had to come from outside or be a
// scenario nobody sane would put there.
//
// The floor is a real sentence rather than a non-empty string. `why` is free text and a
// field that accepts "authored" teaches everyone to write "authored".
const MIN_WHY = 60;

const offPool: string[] = [];
const shortWhy: string[] = [];
const admitted: string[] = [];

for (const v of variants) {
  const benchmarks = fromBenchmarks.get(v.scenario)?.benchmarks ?? new Set<string>();
  if ([...benchmarks].some((b) => sources.has(b))) continue;

  const why = v.admitted?.why?.trim() ?? "";
  if (why === "") {
    offPool.push(
      `${v.scenario}${
        benchmarks.size > 0
          ? ` (only in ${[...benchmarks].join(", ")})`
          : " (in no committed benchmark)"
      }`,
    );
  } else if (why.length < MIN_WHY) {
    shortWhy.push(`${v.scenario} (${why.length} characters)`);
  } else {
    admitted.push(v.scenario);
  }
}

check(
  "every scenario is published by a benchmark the pool names, or says why it is here",
  offPool.length === 0,
  offPool.join("; "),
);
check(
  `every admitted scenario's reason is a sentence (${MIN_WHY} characters)`,
  shortWhy.length === 0,
  shortWhy.join("; "),
);
if (admitted.length > 0) {
  console.log(
    `  ${DIM}${admitted.length} admitted on a written reason rather than a citation${RESET}`,
  );
}

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

// Being unbanded is a fact about the sheets, not a fault in the pool.
//
// Three of the sources carry no difficulty to band by - TSK Mixed names its tiers after
// categories, cA Static S1 has one tier called "All" - and the scenarios admitted on a
// written reason have no sheet at all. Refusing those was refusing the whole method that
// built this season. What replaces it is the ascent check below, which asks a question
// the sheets can actually answer.
if (unbanded.length > 0) {
  console.log(
    `  ${DIM}${unbanded.length} variant(s) no tier can place, so their window is ` +
      `declared and held by the ascent check${RESET}`,
  );
}

// ---- the order of a family's rungs ----------------------------------------------------
//
// WHAT THIS REPLACED, AND WHY
//
// The check here used to be "every scenario sits in the window its hardest tier bands it
// into" - each rung had to match a number somebody else published. That was right while
// the pool was assembled out of whole benchmark tiers. It stopped being right when the
// season was deliberately re-pitched about two ranks harder: the Advanced window now runs
// Expert-tier scenarios ON PURPOSE, and the old check reported 71 variants for it. A check
// that fires on the feature it is meant to protect teaches everybody to ignore it.
//
// What still has to hold is the thing that would actually break a ladder: a family's four
// rungs must get harder as the window rises. Shift a whole family up or down and every
// rung moves together, which is a re-pitch. Swap two of them and a player climbing the
// family meets an easier scenario at a higher rank, which is a hole nothing downstream can
// see - the family is graded on the best of its variants, so the ladder simply stops
// paying and no rank is ever reported as missing.
//
// Measured against published bands rather than against scores, because scores are not
// comparable across scenarios and bands are the one difficulty signal every source states
// outright. Only rungs a source actually bands take part; an unbanded rung is skipped
// rather than assumed, which is why the count is printed.
//
// Measured before it was allowed to reject anything: 130 adjacent banded pairs across the
// 53 families, 8 of which are out of order. Not vacuous, and not a check nothing can fail.
const outOfOrder: string[] = [];
let orderPairs = 0;

for (const f of pool.families) {
  const banded = [...f.variants]
    .sort((a, b) => a.window - b.window)
    .map((v) => ({
      v,
      band: derivedWindow(
        (fromBenchmarks.get(v.scenario)?.tiers ?? []).filter((t) => sources.has(t.benchmark)),
      ).window,
    }))
    .filter((r): r is { v: (typeof f.variants)[number]; band: number } => r.band !== null);

  for (let i = 0; i + 1 < banded.length; i++) {
    orderPairs++;
    const lower = banded[i];
    const upper = banded[i + 1];
    if (lower.band > upper.band) {
      outOfOrder.push(
        `${f.category}/${f.family}: ${lower.v.scenario} (banded ${lower.band}) sits at ` +
          `window ${lower.v.window}, below ${upper.v.scenario} (banded ${upper.band}) at ` +
          `window ${upper.v.window}`,
      );
    }
  }
}

// A family may say the published bands are wrong about it, and the commonest reason is
// real: two rungs from different sheets, where what sets the difficulty is a size or speed
// modifier in the scenario name that neither sheet graded. "DotTS 30% Larger" is banded by
// AimSpeed's Normal tier and is plainly easier than Voltaic's DotTS Novice. The exception
// has to be written per family, and it is listed on every run so it stays visible.
const excused = new Set(
  pool.families.filter((f) => (f.$order?.why ?? "").trim().length >= MIN_WHY).map((f) => f.family),
);
const unexcused = outOfOrder.filter((line) => !excused.has(line.split(": ")[0].split("/")[1]));

check(
  "every family's rungs get harder as the window rises",
  unexcused.length === 0,
  unexcused.length === 0 ? `${orderPairs} adjacent banded pairs` : unexcused.join("; "),
);
if (excused.size > 0) {
  console.log(
    `  ${DIM}${excused.size} family/families overrule their published bands, with a ` +
      `written reason${RESET}`,
  );
}

// Kept as a report: a rung far from where its own sheet graded it is not wrong, but it is
// worth seeing how far the season has moved from the benchmarks it was cut from.
if (misbanded.length > 0) {
  console.log(
    `  ${DIM}${misbanded.length} variant(s) sit in a different window from their hardest ` +
      `published tier - the season is re-pitched, see $bands${RESET}`,
  );
}

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
 * WHAT THE OLD FLOOR GOT WRONG
 *
 * A flat 1,000 for every window, which is a number about the board and not about what the
 * board is being asked. Measured against this pool it was wrong in both directions:
 *
 *   SCS 8xs Uniform    175 entries, refused - but it grades Novice, whose hardest rank is
 *                      the top 22%. That is 38 players. Coarse, and real.
 *   ClickTrack 5t    2,218 entries, passed - but it grades Expert, whose hardest rank is
 *                      the top 0.8%. That is 17 players deciding the top of a ladder.
 *
 * WHAT REPLACED IT
 *
 * The requirement is not "enough people" in the abstract, it is that this board can tell
 * two consecutive ranks apart. A rank is a position on the board, so the gap between rank
 * 15 and rank 16 is `total * (p15 - p16)` players - and on a 582-entry board that is 1.7
 * people. Those are not two ranks; they are one rank and a rounding error.
 *
 * So the floor is derived from the ladder rather than chosen: take the TIGHTEST gap
 * between consecutive ranks the window grades, and require at least MIN_PLAYERS_BETWEEN
 * players to sit in it. Falls out as roughly 55 / 250 / 714 / 1,666 for the four windows,
 * which is the shape the old constant was groping for - the Expert figure lands near 1,000
 * at three players, which is why a flat 1,000 looked reasonable while being far too strict
 * at the easy end.
 *
 * Five players, not three: three is close enough to a tie that a handful of new scores
 * reorders the rungs, and the pool has boards that move that much between samplings. At
 * five, 10 of the 123 percentile-cut variants are refused; at three, 6 - and the four the
 * difference turns on are all Advanced or Expert rungs on boards under 800.
 *
 * Only the ladder is consulted, so re-cutting the percentiles moves the floor with them
 * and nobody has to remember to update a constant.
 */
const MIN_PLAYERS_BETWEEN = 5;

function minEntriesFor(window: number): number {
  const first = window * pool.windowSize;
  const width = windowRankCount(window, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap);
  const slice = pool.ladder.ranks.slice(first, first + width);

  let tightest = Infinity;
  for (let i = 1; i < slice.length; i++) tightest = Math.min(tightest, slice[i - 1] - slice[i]);
  if (!Number.isFinite(tightest) || tightest <= 0) return ENTRIES_FLOOR;

  return Math.ceil(MIN_PLAYERS_BETWEEN / tightest);
}

// WHAT THE FLOOR IS ACTUALLY PROTECTING
//
// A thin board is only dangerous when the ladder's numbers were CUT from it. A percentile
// cut off 151 entries is a statement about 151 people, and rank 7 on it is wherever the
// eleventh of them happened to land. A threshold ADOPTED from a benchmark is a score its
// author published: the board is not in that arithmetic anywhere, and refusing it was
// refusing a number on the strength of a statistic it does not use.
//
// Measured on the pool as it stands: 27 boards under the floor, 7 of them adopted and 20
// cut. All 7 are Voltaic and Viscose Elite tiers - the hardest cut of a scenario is played
// by fewer people almost by definition, which is a fact about who plays Elite scenarios and
// not about whether Voltaic's Elite score is real. The 20 stay refused.
//
// The board is still used for the apex placement and for "what would the next rank be", so
// a thin one is worth seeing even when it is allowed. It is reported, not silent.
const thin: string[] = [];
const thinButAdopted: string[] = [];
const thinButExcused: string[] = [];
const unsampled: string[] = [];

/** A threshold cut from this scenario's own board, so the board's size is load-bearing. */
const cutFromOwnBoard = (kind: string | undefined): boolean =>
  kind === undefined || kind === "percentile" || kind === "seeded";

for (const v of variants) {
  const distribution = sampled.get(v.scenario);
  if (!distribution) {
    unsampled.push(v.scenario);
    continue;
  }
  const minimum = minEntriesFor(v.window);
  if (distribution.total >= minimum) continue;

  const line =
    `${v.scenario} has ${distribution.total.toLocaleString()} for ` +
    `${pool.windows[v.window]}, which needs ${minimum.toLocaleString()}`;

  if (!cutFromOwnBoard(v.source?.kind)) {
    thinButAdopted.push(`${v.scenario} (${v.source?.kind}, ${distribution.total.toLocaleString()})`);
    continue;
  }

  const excuse = v.thinBoard?.why?.trim() ?? "";
  if (excuse.length >= MIN_WHY) {
    thinButExcused.push(
      `${v.scenario} (${distribution.total.toLocaleString()} of ${minimum.toLocaleString()}, ` +
        `${Math.round((distribution.total / minimum) * 100)}%)`,
    );
  } else {
    thin.push(line);
  }
}

if (unsampled.length > 0) {
  warn(
    `${unsampled.length} scenario(s) not yet sampled - run npm run sample:leaderboards`,
    unsampled.slice(0, 8).join(", ") + (unsampled.length > 8 ? ", ..." : ""),
  );
}
check(
  `every board a threshold was CUT from is big enough for the window it grades ` +
    `(${pool.windows.map((w, i) => `${w} ${minEntriesFor(i).toLocaleString()}`).join(", ")})`,
  thin.length === 0,
  thin.join("; "),
);
if (thinButExcused.length > 0) {
  console.log(
    `  ${DIM}${thinButExcused.length} board(s) below the floor and kept on a written ` +
      `reason: ${thinButExcused.join(", ")}${RESET}`,
  );
}
if (thinButAdopted.length > 0) {
  console.log(
    `  ${DIM}${thinButAdopted.length} thin board(s) carry a threshold their author ` +
      `published rather than one cut from the board: ${thinButAdopted.join(", ")}${RESET}`,
  );
}

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
    // The guard here used to be `derived.category !== v.category`, comparing KovaaK's aim
    // type against the pool's category. That held while a category was Clicking, Tracking or
    // Switching. A category is a sub-skill now - "Dynamic Clicking" - so the comparison
    // matched nothing and the check silently fell to zero scenarios, which is the shape of a
    // check that cannot fail. The sub-skill name carries the aim type inside it, so
    // comparing the sub-skills directly is both sufficient and the thing actually claimed.
    if (!derived) continue;
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

// A category should train the sub-skills it declares, and no others.
//
// This used to warn when a category covered fewer than three sub-skills, which was the
// right shape while a category was an aim type holding several. Since the six-category
// rebuild a category IS a sub-skill, so that warning fired for all six on every run - a
// warning nothing can act on, which is the fastest way to teach everybody to skim past the
// ones that matter. What is worth knowing now is the opposite: a family whose sub-skill is
// not the one its category declares, which means the pool disagrees with itself about what
// the category measures.
for (const category of pool.categories) {
  const declared = new Set(pool.subCategories?.[category] ?? []);
  const stray = pool.families
    .filter((f) => f.category === category)
    .map((f) => ({ family: f.family, sub: subCategoryOf(f) }))
    .filter((f) => f.sub !== null && !declared.has(f.sub));
  if (stray.length > 0) {
    warn(
      `${category} holds ${stray.length} family/families training a sub-skill it does not ` +
        `declare`,
      stray.map((f) => `${f.family} trains ${f.sub}`).join(", "),
    );
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
  // Padded to the longest category name rather than a constant: 11 fitted "Clicking" and
  // ran "Static Clicking" straight into its own sub-skill on every line.
  const width = Math.max(...pool.categories.map((c) => c.length)) + 2;
  console.log(
    `  ${category.padEnd(width)}` +
      [...counts].map(([sub, n]) => `${sub} ${n}`).join(", "),
  );
}

// ---- the mechanic ---------------------------------------------------------------------
//
// A second axis where a benchmark publishes one, and only there. Viscose is the only
// author in the corpus who names what part of the arm a scenario asks for, and it names
// it for tracking alone - all 91 tagged scenarios in the corpus are Tracking, so this is
// not a dimension across the pool but a cut inside one category of it. Printed rather
// than asserted broadly, because the useful question is how far it reaches.
console.log(`
${BOLD}mechanic${RESET}`);
{
  const published = new Map<string, string>();
  for (const s of derivedSubSkills?.scenarios ?? []) {
    if (s.mechanic) published.set(s.scenario, s.mechanic);
  }

  const invented: string[] = [];
  const disagreeing: string[] = [];
  for (const f of pool.families) {
    const mech = (f as { mechanic?: string }).mechanic;
    if (!mech) continue;
    const said = new Set(f.variants.map((v) => published.get(v.scenario)).filter(Boolean));
    if (said.size === 0) invented.push(`${f.family}: ${mech}, which no benchmark publishes`);
    else if (!said.has(mech)) {
      disagreeing.push(`${f.family}: ${mech}, but its scenarios are ${[...said].join("/")}`);
    }
  }

  check(
    "every family's mechanic is one a benchmark published for its own scenarios",
    invented.length === 0 && disagreeing.length === 0,
    [...invented, ...disagreeing].join("; "),
  );

  const tracking = pool.families.filter((f) => f.category === "Tracking");
  const withMech = tracking.filter((f) => (f as { mechanic?: string }).mechanic);
  const others = pool.families.filter(
    (f) => f.category !== "Tracking" && (f as { mechanic?: string }).mechanic,
  );
  check(
    "no family outside Tracking claims a mechanic",
    others.length === 0,
    others.map((f) => f.family).join(", "),
  );

  const byMech = new Map<string, string[]>();
  for (const f of withMech) {
    const m = (f as { mechanic?: string }).mechanic!;
    byMech.set(m, (byMech.get(m) ?? []).concat(f.family));
  }
  console.log(
    `  ${DIM}${withMech.length} of ${tracking.length} Tracking families carry one; ` +
      `${pool.families.length - withMech.length} of ${pool.families.length} in the pool have none${RESET}`,
  );
  for (const [m, fams] of [...byMech].sort()) {
    console.log(`  ${DIM}${m.padEnd(10)} ${fams.join(", ")}${RESET}`);
  }

  // The tile tag. Unlike the mechanic it is on every scenario, so the claim that keeps it
  // honest is about provenance: a value labelled Viscose's must be Viscose's, and a
  // scenario Viscose does tag must never be shown as the season's own guess.
  const PARTS = new Set(["Arm", "Wrist", "Fingertip", "Blending"]);
  type ArmVariant = { scenario: string; arm?: string; armFrom?: string };
  const variants = pool.families.flatMap((f) => f.variants as ArmVariant[]);
  const untagged = variants.filter((v) => !PARTS.has(v.arm ?? "") || !["Viscose", "Apogee"].includes(v.armFrom ?? ""));
  const miscited = variants.filter((v) => v.armFrom === "Viscose" && published.get(v.scenario) !== v.arm);
  const uncited = variants.filter((v) => published.has(v.scenario) && v.armFrom !== "Viscose");
  check(
    "every scenario names one part of the arm and whose word it is",
    untagged.length === 0,
    untagged.map((v) => v.scenario).join(", "),
  );
  check(
    "every arm labelled Viscose's is the one Viscose publishes, and every published one is labelled so",
    miscited.length === 0 && uncited.length === 0,
    [...miscited, ...uncited].map((v) => `${v.scenario}: ${v.arm} (${v.armFrom}), published ${published.get(v.scenario) ?? "none"}`).join("; "),
  );
  const cited = variants.filter((v) => v.armFrom === "Viscose").length;
  console.log(`  ${DIM}arm on the tiles: ${cited} of ${variants.length} from Viscose, ${variants.length - cited} the season's own call${RESET}`);
}

// ---- verdict ------------------------------------------------------------------------
console.log(
  failures === 0
    ? `\nOK: pool validated${warnings > 0 ? `, ${warnings} warning(s)` : ""}\n`
    : `\n${failures} FAILURE(S)\n`,
);
process.exit(failures === 0 ? 0 : 1);
