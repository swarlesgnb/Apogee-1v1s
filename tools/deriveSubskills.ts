/**
 * Derive the sub-skill taxonomy from what the benchmarks themselves call things.
 *
 *   npx tsx tools/deriveSubskills.ts
 *
 * WHY THIS EXISTS
 *
 * Season 1's pool used to be Voltaic's nine sub-categories, read from Voltaic's own
 * spreadsheet. That is the right answer for a pool made of Voltaic scenarios and the
 * wrong one for a pool drawn from forty benchmarks, because it can only classify the
 * eighteen families Voltaic published. Everything else arrives with no sub-skill and
 * quietly stops being findable by the weakness map and the sub-category queues.
 *
 * The alternative that looks reasonable and is not is inferring a sub-skill from a
 * scenario's description. PLAN.md §3 records what that costs: a hand-derived mapping
 * inferred that way was wrong on 6 of Voltaic's 18 - it swapped Precise with Reactive
 * wholesale - and was wrong *confidently*, because the nine names it guessed were right.
 *
 * So nothing here is inferred from a description. Every benchmark already publishes its
 * own category name for every scenario it contains, and forty of them agree far more than
 * they disagree. This tool normalises those names and counts the agreement.
 *
 * THE TWO THINGS IT COMBINES
 *
 *   the label   the benchmark author's own category name for that scenario, from
 *               `data/benchmarks/*.json`. "Static Clicking", "STATIC", "Clicking Static"
 *               and "1 Wall" are four authors saying the same word.
 *
 *   the aim type KovaaK's own Clicking / Tracking / Switching classification, from
 *               `data/scenario_taxonomy.json`. Not a judgement and not ours.
 *
 * The label alone is ambiguous - "Micro" is clicking in Lemon Static and tracking in Astro
 * - and the aim type alone is too coarse. Together they are not: the sub-skill is looked
 * up as (normalised label, aim type), so Lemon's Micro lands in Clicking/Micro and Astro's
 * in Tracking/Precise without either benchmark having to be special-cased.
 *
 * WHY ELEVEN AND NOT NINE
 *
 * Voltaic's nine come back out of the corpus unchanged, because most of the corpus is
 * describing the same nine things. Two more are named by benchmarks Voltaic's sheet cannot
 * see, by enough independent authors to be a sub-skill rather than one person's idea:
 *
 *   Clicking/Micro    Anima Micro v1 and v2 are built entirely around it; Lemon Static,
 *                     cA Static ("Microadjust"), Viscose and Viscose Entry name it too.
 *   Tracking/Reading  cA Ground Tracking, all three Jade Palace benchmarks, Viscose,
 *                     Viscose S2 and Viscose Entry.
 *
 * `namedBy` in the output is that count, so the claim is a number rather than a sentence.
 *
 * THE CHECK THAT MAKES IT TRUSTABLE
 *
 * Voltaic published its own mapping, and `data/subcategories.json` holds it. Voltaic's
 * scenarios are in the corpus like everybody else's, so this derivation classifies them
 * too - and it must land where Voltaic says they land, on every one. That is a real
 * check against an authority rather than a plausibility argument, and it is the reason to
 * believe the same normalisation applied to Jade Palace is not making things up. It runs
 * every time and the result is written into the output.
 *
 * Output: data/subskills.json, committed. Nothing here reaches the network.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BENCH_DIR = join(root, "data", "benchmarks");
const TAXONOMY = join(root, "data", "scenario_taxonomy.json");
const VOLTAIC = join(root, "data", "subcategories.json");
const OUT = join(root, "data", "subskills.json");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * The eleven, and the order they are reported in.
 *
 * Named the way the benchmarks that use two levels name them - "Static Clicking",
 * "Control Tracking", "Speed Switching" - rather than as the bare word. snakbox, Avasive,
 * wobin and Aimerz+ all publish them in that form, and it is the form that survives being
 * read on its own: "Micro" and "Speed" mean different things in different categories, and
 * a weakness map or a queue name showing one word cannot say which.
 *
 * Ordered easiest-to-name first inside each category rather than by frequency, because
 * this list is what the rank sheet and the weakness map read from.
 */
const SUB_SKILLS: Record<string, string[]> = {
  Clicking: ["Static Clicking", "Dynamic Clicking", "Linear Clicking", "Micro Clicking"],
  Tracking: ["Precise Tracking", "Reactive Tracking", "Control Tracking", "Reading Tracking"],
  Switching: ["Speed Switching", "Evasive Switching", "Stability Switching"],
};

/** Voltaic's sheet writes the bare word. Same eleven, one vocabulary. */
const LONG: Record<string, Record<string, string>> = {
  Clicking: {
    Static: "Static Clicking",
    Dynamic: "Dynamic Clicking",
    Linear: "Linear Clicking",
    Micro: "Micro Clicking",
  },
  Tracking: {
    Precise: "Precise Tracking",
    Reactive: "Reactive Tracking",
    Control: "Control Tracking",
    Reading: "Reading Tracking",
  },
  Switching: {
    Speed: "Speed Switching",
    Evasive: "Evasive Switching",
    Stability: "Stability Switching",
  },
};

/**
 * Normalised label -> sub-skill, per aim type.
 *
 * This is the judgement in the file, and it is a judgement about *words*, not about
 * scenarios: every key is a category name some benchmark in `data/benchmarks/` actually
 * publishes, and the value says which of the eleven that author's word means. Nothing is
 * read from a scenario's name or description.
 *
 * Read the three tables as three dialects of one vocabulary. The same word means
 * different things in different categories and that is not a collision to resolve - it is
 * why the aim type is part of the key:
 *
 *   "micro"      clicking: the sub-skill itself. tracking: holding a crosshair on a small
 *                target is precise tracking, which is what Astro and thundah file it as.
 *                switching: a small-angle switch is a stability problem.
 *   "control"    tracking: the sub-skill. switching: Revosect's Track TS and snakbox's
 *                Hybrid Switching are the same idea - hold, then switch - and that is
 *                stability.
 *   "stability"  switching: the sub-skill. clicking: Lemon Static means holding a static
 *                wall together, which is static clicking. tracking: holding a smooth line.
 *   "fundamentals" only Jade Palace uses it, for the intro tier of each of its three
 *                benchmarks. Each of the three is single-domain - Air and Ground are
 *                reading benchmarks, Dynamic is a dynamic-clicking one - so the word
 *                means whatever that benchmark is about, which is what the aim type says.
 *
 * A label that appears in no table is reported rather than guessed, and its scenarios are
 * left unclassified. There are always some: TSK files by target geometry ("Horizontal",
 * "Omni") and Viscose's harder difficulties by body part ("Arm", "Wrist", "Fingertip"),
 * neither of which is a sub-skill at all.
 */
const LABELS: Record<string, Record<string, string>> = {
  Clicking: {
    static: "Static Clicking",
    staticclicking: "Static Clicking",
    clickingstatic: "Static Clicking",
    "1wall": "Static Clicking",
    widewall: "Static Clicking",
    isolated: "Static Clicking",
    chaining: "Static Clicking",
    pressure: "Static Clicking",
    flicking: "Static Clicking",
    stability: "Static Clicking",

    dynamic: "Dynamic Clicking",
    dynamicclicking: "Dynamic Clicking",
    clickingdynamic: "Dynamic Clicking",
    kinetic: "Dynamic Clicking",
    arc: "Dynamic Clicking",
    predict: "Dynamic Clicking",
    reading: "Dynamic Clicking",

    linear: "Linear Clicking",
    linearclicking: "Linear Clicking",
    strafeclick: "Linear Clicking",
    evasive: "Linear Clicking",
    evasiveclicking: "Linear Clicking",
    strafing: "Linear Clicking",

    fundamentals: "Dynamic Clicking",

    micro: "Micro Clicking",
    microadjust: "Micro Clicking",
    microstatic: "Micro Clicking",
    microdynamic: "Micro Clicking",
    precise: "Micro Clicking",
    precision: "Micro Clicking",
    preciseclicking: "Micro Clicking",
    fluidity: "Micro Clicking",
  },
  Tracking: {
    precise: "Precise Tracking",
    precision: "Precise Tracking",
    precisetracking: "Precise Tracking",
    trackingprecise: "Precise Tracking",
    micro: "Precise Tracking",
    microtracking: "Precise Tracking",
    smoothbot: "Precise Tracking",
    postflick: "Precise Tracking",

    reactive: "Reactive Tracking",
    reactivetrackin: "Reactive Tracking",
    reactivetracking: "Reactive Tracking",
    trackingreactive: "Reactive Tracking",
    react: "Reactive Tracking",
    ground: "Reactive Tracking",
    air: "Reactive Tracking",

    control: "Control Tracking",
    controltracking: "Control Tracking",
    smooth: "Control Tracking",
    smoothtracking: "Control Tracking",
    centering: "Control Tracking",
    sphere: "Control Tracking",
    bouncesphere: "Control Tracking",
    stability: "Control Tracking",
    strafetrack: "Control Tracking",
    strafe: "Control Tracking",

    reading: "Reading Tracking",
    readingtrack: "Reading Tracking",
    fundamentals: "Reading Tracking",
    hybrid: "Reading Tracking",
    technique: "Reading Tracking",
    predictioncancelling: "Reading Tracking",
    underaim: "Reading Tracking",
    possession: "Reading Tracking",
  },
  Switching: {
    speed: "Speed Switching",
    speedswitching: "Speed Switching",
    speedts: "Speed Switching",
    switchingspeed: "Speed Switching",
    speedtrack: "Speed Switching",
    flickts: "Speed Switching",
    flick: "Speed Switching",
    voxts: "Speed Switching",
    patts: "Speed Switching",
    xents: "Speed Switching",
    kints: "Speed Switching",
    devts: "Speed Switching",
    floatts: "Speed Switching",
    pokeball: "Speed Switching",

    evasive: "Evasive Switching",
    evasiveswitch: "Evasive Switching",
    evasiveswitching: "Evasive Switching",
    evasivets: "Evasive Switching",
    switchingevasive: "Evasive Switching",
    dynamicts: "Evasive Switching",

    stability: "Stability Switching",
    stabilityswitching: "Stability Switching",
    trackts: "Stability Switching",
    track: "Stability Switching",
    hybridts: "Stability Switching",
    hybridswitching: "Stability Switching",
    hybrid: "Stability Switching",
    control: "Stability Switching",
    micro: "Stability Switching",
    microswitching: "Stability Switching",
  },
};

/** Strip case, spaces, punctuation. "Evasive Switch", "EvasiveTS" and "evasive_ts" differ by none of it. */
const normalise = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]/g, "");

/** KovaaK's says "Target Switching" on one endpoint and "Switching" on another. */
function aimTypeOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  if (key === "target switching") return "Switching";
  if (key === "clicking" || key === "tracking" || key === "switching") {
    return key[0].toUpperCase() + key.slice(1);
  }
  return null;
}

interface BenchmarkDef {
  benchmarkName: string;
  difficulties?: {
    name: string;
    categories?: { name: string; scenarios?: { name: string; leaderboardId: number | null }[] }[];
  }[];
}

interface TaxonomyEntry {
  name: string;
  aimType: string | null;
  entries: number | null;
  plays: number | null;
  leaderboardId: number | null;
}

/** One scenario, everything known about it. */
interface Scenario {
  scenario: string;
  leaderboardId: number | null;
  category: string | null;
  /** Where the aim type came from: KovaaK's own field, or the author's own grouping. */
  categoryFrom: "kovaaks" | "benchmark" | null;
  subSkill: string | null;
  /** How the sub-skill was reached: the authors' own labels, or Voltaic's sheet. */
  via: "label" | "voltaic" | null;
  entries: number | null;
  plays: number | null;
  /** Every benchmark tier that names it, and the label it carries there. */
  from: { benchmark: string; difficulty: string; label: string }[];
}

const taxonomy = new Map<string, TaxonomyEntry>(
  (
    JSON.parse(readFileSync(TAXONOMY, "utf8")) as { scenarios: TaxonomyEntry[] }
  ).scenarios.map((s) => [s.name, s]),
);

// ---- read the corpus ------------------------------------------------------------------
const scenarios = new Map<string, Scenario>();
const benchmarks: string[] = [];

for (const file of readdirSync(BENCH_DIR).filter((f) => f.endsWith(".json"))) {
  const def = JSON.parse(readFileSync(join(BENCH_DIR, file), "utf8")) as BenchmarkDef;
  benchmarks.push(def.benchmarkName);

  for (const difficulty of def.difficulties ?? []) {
    for (const category of difficulty.categories ?? []) {
      for (const s of category.scenarios ?? []) {
        const meta = taxonomy.get(s.name);
        const entry = scenarios.get(s.name) ?? {
          scenario: s.name,
          leaderboardId: s.leaderboardId ?? meta?.leaderboardId ?? null,
          category: aimTypeOf(meta?.aimType),
          categoryFrom: aimTypeOf(meta?.aimType) ? "kovaaks" : null,
          subSkill: null,
          via: null,
          entries: meta?.entries ?? null,
          plays: meta?.plays ?? null,
          from: [],
        };
        entry.from.push({
          benchmark: def.benchmarkName,
          difficulty: difficulty.name,
          label: category.name.trim(),
        });
        scenarios.set(s.name, entry);
      }
    }
  }
}

// ---- the aim type, where KovaaK's does not give one -----------------------------------
//
// KovaaK's `/scenario/popular` returns a null aimType for about a hundred scenarios in the
// corpus, and dropping those cost more than it looked like it would: `tamTargetSwitch
// Control Hard` and `tamTargetSwitch Smooth Hard` carry 60,313 and 46,005 leaderboard
// entries, sit in Aimerz+'s own Evasive Switching tier next to scenarios KovaaK's *does*
// type as Switching, and were being thrown away for want of one field. Evasive Switching
// looked as though it had one usable Expert scenario in the whole corpus. It has three.
//
// The fallback is the author's own grouping, narrowest first: a benchmark's category slot
// inside one difficulty is homogeneous by construction, because that is what putting three
// scenarios under "Evasive Switching" means. Falling back to the whole benchmark is the
// last resort and only settles single-domain benchmarks - Jade Palace Ground is tracking
// throughout, and its intro tier is two untyped strafe scenarios.
//
// This still reads nothing from a scenario's name or description. It reads which box its
// author put it in, which is the same evidence the sub-skill itself comes from. Where
// KovaaK's does give an aim type, KovaaK's wins and this is not consulted.
function inferAimTypes(): { fromWord: number; fromGroup: number; refused: number } {
  /**
   * Which categories a benchmark's own word could belong to.
   *
   * "Evasive Switch" is a key in the Switching table and nowhere else, so an author using
   * it has said Switching whatever else is in the box. "Evasive" is a key in Clicking and
   * in Switching, so it has said nothing about the category at all.
   */
  const categoriesFor = (label: string): string[] => {
    const key = normalise(label);
    return Object.keys(LABELS).filter((category) => LABELS[category][key] !== undefined);
  };

  const tally = (key: (source: { benchmark: string; difficulty: string; label: string }) => string) => {
    const counts = new Map<string, Map<string, number>>();
    for (const s of scenarios.values()) {
      if (!s.category) continue;
      for (const source of s.from) {
        const bucket = counts.get(key(source)) ?? new Map<string, number>();
        bucket.set(s.category, (bucket.get(s.category) ?? 0) + 1);
        counts.set(key(source), bucket);
      }
    }
    return counts;
  };

  const slot = tally((f) => `${f.benchmark} :: ${f.difficulty} :: ${f.label}`);
  const label = tally((f) => `${f.benchmark} :: ${f.label}`);
  const whole = tally((f) => f.benchmark);

  /** The one category a group agrees on, or null where it does not agree. */
  const settled = (counts: Map<string, Map<string, number>>, key: string): string | null => {
    const bucket = counts.get(key);
    if (!bucket || bucket.size !== 1) return null;
    return [...bucket.keys()][0];
  };

  let fromWord = 0;
  let fromGroup = 0;
  let refused = 0;

  for (const s of scenarios.values()) {
    if (s.category) continue;

    // 1. The author's own word, where the word can only mean one category.
    const implied = new Set(s.from.flatMap((f) => categoriesFor(f.label)));
    if (implied.size === 1) {
      s.category = [...implied][0];
      s.categoryFrom = "benchmark";
      fromWord++;
      continue;
    }

    // 2. An ambiguous word is a refusal, not a licence to guess from the neighbours.
    //
    // This is the rule that had to be added, and it was added because the version without
    // it was confidently wrong. Viscose's Hard tier files `domiSwitch` and
    // `tamTargetSwitch Smooth` both under "Evasive" - one is clicking and one is target
    // switching - so the slot is not homogeneous however much it looks like a slot, and
    // taking a vote in it put a target-switching scenario into Linear Clicking. A label
    // that two of the three tables claim has told us nothing about the category, and the
    // neighbours in its box cannot be asked to make up the difference.
    if (implied.size > 1) {
      refused++;
      continue;
    }

    // 3. No word at all - "Varied", "Other", "Horizontal". Now the box is the only
    //    evidence there is, and it is good evidence: a benchmark's category slot inside
    //    one difficulty is homogeneous by construction when its label is not doing double
    //    duty. Narrowest group first.
    for (const f of s.from) {
      const guess =
        settled(slot, `${f.benchmark} :: ${f.difficulty} :: ${f.label}`) ??
        settled(label, `${f.benchmark} :: ${f.label}`) ??
        settled(whole, f.benchmark);
      if (guess) {
        s.category = guess;
        s.categoryFrom = "benchmark";
        fromGroup++;
        break;
      }
    }
  }

  return { fromWord, fromGroup, refused };
}

const inferred = inferAimTypes();

// ---- Voltaic's published mapping ------------------------------------------------------
//
// Used twice below, for two different jobs. As a FALLBACK it classifies Voltaic scenarios
// whose own tier names no sub-skill: Voltaic S5's Novice, Intermediate and Advanced
// difficulties file everything under "Clicking", "Tracking" and "Switching", so the
// labels alone leave three quarters of the ladder's easiest scenarios unclassified. As a
// CHECK it holds the normalisation to an authority - but only over the scenarios the
// labels classified on their own, or the check would be grading itself.
const voltaic = JSON.parse(readFileSync(VOLTAIC, "utf8")) as {
  families: Record<string, { skill: string; subCategory: string }>;
};

/** "VT Pasu Advanced S5" -> "Pasu", which is the key Voltaic's sheet uses. */
function voltaicFamily(name: string): string | null {
  const match = /^VT (.+?)(?: (?:Novice|Intermediate|Advanced|Elite))?(?: S[45](?:\.5)?)?$/.exec(
    name,
  );
  return match ? match[1] : null;
}

// ---- classify -------------------------------------------------------------------------
//
// A scenario carries a label from every benchmark that names it, and those can disagree.
// The majority wins, and a tie goes to the first in listing order - which is stable
// because the benchmark files are read in name order. Disagreements are reported: they
// are rare, and where they happen they are usually two authors drawing the Precise /
// Reactive line in different places, which is worth seeing rather than averaging away.
const unmappedLabels = new Map<string, { benchmarks: Set<string>; scenarios: number }>();
const split: { scenario: string; between: string[] }[] = [];

for (const s of scenarios.values()) {
  if (!s.category) continue;
  const table = LABELS[s.category] ?? {};

  const votes = new Map<string, number>();
  for (const source of s.from) {
    const subSkill = table[normalise(source.label)];
    if (!subSkill) {
      const key = `${s.category} :: ${source.label}`;
      const seen = unmappedLabels.get(key) ?? { benchmarks: new Set<string>(), scenarios: 0 };
      seen.benchmarks.add(source.benchmark);
      seen.scenarios++;
      unmappedLabels.set(key, seen);
      continue;
    }
    votes.set(subSkill, (votes.get(subSkill) ?? 0) + 1);
  }

  if (votes.size === 0) {
    const family = voltaicFamily(s.scenario);
    const published = family ? voltaic.families[family] : undefined;
    const skill = aimTypeOf(published?.skill ?? null);
    if (published && skill === s.category) {
      s.subSkill = LONG[skill]?.[published.subCategory] ?? published.subCategory;
      s.via = "voltaic";
    }
    continue;
  }

  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  s.subSkill = ranked[0][0];
  s.via = "label";
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    split.push({ scenario: s.scenario, between: ranked.map(([name]) => name) });
  }
}

// ---- check ----------------------------------------------------------------------------
const agreed: string[] = [];
const disagreed: { scenario: string; derived: string; voltaic: string }[] = [];

for (const s of scenarios.values()) {
  if (s.via !== "label" || !s.subSkill || !s.category) continue;
  const family = voltaicFamily(s.scenario);
  const published = family ? voltaic.families[family] : undefined;
  if (!published) continue;

  const theirs = `${published.skill}/${
    LONG[aimTypeOf(published.skill) ?? ""]?.[published.subCategory] ?? published.subCategory
  }`;
  const ours = `${s.category}/${s.subSkill}`;
  if (ours === theirs) agreed.push(s.scenario);
  else disagreed.push({ scenario: s.scenario, derived: ours, voltaic: theirs });
}

// ---- tally ----------------------------------------------------------------------------
const tally: {
  category: string;
  subSkill: string;
  /** How many benchmarks name this sub-skill at all. The reason there are eleven. */
  namedBy: number;
  scenarios: number;
  /** Which benchmarks, and the words each uses for it. */
  benchmarks: { benchmark: string; labels: string[]; scenarios: number }[];
}[] = [];

for (const [category, names] of Object.entries(SUB_SKILLS)) {
  for (const subSkill of names) {
    const members = [...scenarios.values()].filter(
      (s) => s.category === category && s.subSkill === subSkill,
    );

    const byBenchmark = new Map<string, { labels: Set<string>; scenarios: number }>();
    for (const s of members) {
      for (const source of s.from) {
        if (LABELS[category]?.[normalise(source.label)] !== subSkill) continue;
        const seen = byBenchmark.get(source.benchmark) ?? {
          labels: new Set<string>(),
          scenarios: 0,
        };
        seen.labels.add(source.label);
        seen.scenarios++;
        byBenchmark.set(source.benchmark, seen);
      }
    }

    tally.push({
      category,
      subSkill,
      namedBy: byBenchmark.size,
      scenarios: members.length,
      benchmarks: [...byBenchmark]
        .sort((a, b) => b[1].scenarios - a[1].scenarios)
        .map(([benchmark, seen]) => ({
          benchmark,
          labels: [...seen.labels].sort(),
          scenarios: seen.scenarios,
        })),
    });
  }
}

// ---- write ----------------------------------------------------------------------------
const classified = [...scenarios.values()].filter((s) => s.subSkill !== null);
const untyped = [...scenarios.values()].filter((s) => !s.category);

writeFileSync(
  OUT,
  JSON.stringify(
    {
      $comment: [
        "Apogee's sub-skill taxonomy, and the evidence for it. Generated by",
        "tools/deriveSubskills.ts from the category names data/benchmarks/*.json publish",
        "and KovaaK's own aim type per scenario. Do not hand-edit: the normalisation that",
        "produced it lives in the tool, where changing it is visible and re-runnable.",
        "",
        "Nothing here is inferred from a scenario's name or description. Every entry is a",
        "benchmark author's own word for their own scenario, normalised for case and",
        "spacing, keyed by KovaaK's aim type so that the same word can mean different",
        "things in different categories.",
        "",
        "`check` is what makes it trustable: Voltaic's scenarios go through the same",
        "normalisation as everybody else's, and Voltaic published where they belong.",
      ],
      source: "data/benchmarks/*.json category names + data/scenario_taxonomy.json aim types",
      derivedAt: new Date().toISOString(),
      benchmarks: benchmarks.length,
      categories: SUB_SKILLS,
      check: {
        against: "data/subcategories.json, generated from Voltaic's own published spreadsheet",
        scenarios: agreed.length + disagreed.length,
        agree: agreed.length,
        disagree: disagreed,
      },
      counts: {
        scenarios: scenarios.size,
        classified: classified.length,
        fromLabels: classified.filter((s) => s.via === "label").length,
        fromVoltaicSheet: classified.filter((s) => s.via === "voltaic").length,
        aimTypeFromKovaaks: [...scenarios.values()].filter((s) => s.categoryFrom === "kovaaks").length,
        aimTypeFromBenchmarkWord: inferred.fromWord,
        aimTypeFromBenchmarkGroup: inferred.fromGroup,
        aimTypeRefusedAsAmbiguous: inferred.refused,
        noAimType: untyped.length,
        splitVote: split.length,
      },
      subSkills: tally,
      unmappedLabels: [...unmappedLabels]
        .sort((a, b) => b[1].scenarios - a[1].scenarios)
        .map(([label, seen]) => ({
          label,
          scenarios: seen.scenarios,
          benchmarks: [...seen.benchmarks].sort(),
        })),
      splitVote: split,
      scenarios: [...scenarios.values()]
        .sort((a, b) => (a.scenario < b.scenario ? -1 : 1))
        .map((s) => ({
          scenario: s.scenario,
          leaderboardId: s.leaderboardId,
          category: s.category,
          categoryFrom: s.categoryFrom,
          subSkill: s.subSkill,
          via: s.via,
          entries: s.entries,
          plays: s.plays,
          from: s.from,
        })),
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

// ---- report ---------------------------------------------------------------------------
console.log(
  `\n${BOLD}sub-skills${RESET}  ${benchmarks.length} benchmarks, ${scenarios.size} ` +
    `scenarios, ${classified.length} classified\n`,
);
console.log(`    ${"sub-skill".padEnd(32)}${"named by".padStart(9)}${"scenarios".padStart(11)}`);
for (const row of tally) {
  console.log(
    `    ${`${row.category}/${row.subSkill}`.padEnd(32)}` +
      `${String(row.namedBy).padStart(9)}${String(row.scenarios).padStart(11)}  ` +
      `${DIM}${row.benchmarks
        .slice(0, 3)
        .map((b) => b.benchmark)
        .join(", ")}${row.benchmarks.length > 3 ? ", …" : ""}${RESET}`,
  );
}

console.log(`\n${BOLD}check against Voltaic's published mapping${RESET}`);
console.log(
  `  ${disagreed.length === 0 ? "ok  " : "FAIL"} ${agreed.length} of ` +
    `${agreed.length + disagreed.length} Voltaic scenarios land where Voltaic says they do`,
);
for (const d of disagreed) {
  console.log(`       ${d.scenario}: derived ${d.derived}, Voltaic ${d.voltaic}`);
}

if (unmappedLabels.size > 0) {
  const worst = [...unmappedLabels].sort((a, b) => b[1].scenarios - a[1].scenarios).slice(0, 10);
  console.log(
    `\n${BOLD}labels with no sub-skill${RESET}  ${DIM}(left unclassified rather than guessed)${RESET}`,
  );
  for (const [label, seen] of worst) {
    console.log(`  ${label.padEnd(44)}${String(seen.scenarios).padStart(5)} scenarios`);
  }
}

console.log(`\nwritten to ${OUT.replace(root, ".")}`);
process.exit(disagreed.length === 0 ? 0 : 1);
