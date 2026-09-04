/**
 * What could a family be, for each sub-skill the pool grades?
 *
 * A family is one scenario lineage measured at four difficulties, and choosing 66 of them
 * by reading 1,481 scenario names is not a thing anybody does well. So this groups the
 * corpus into lineages, says which windows each one can actually fill, and ranks them on
 * whether their leaderboards are big enough to cut a rank from. It proposes; it does not
 * choose. Nothing here writes to the pool.
 *
 *   npx tsx tools/proposeFamilies.ts [--sub "Precise Tracking"] [--top 20] [--all]
 *
 * WHAT A LINEAGE IS HERE
 *
 * The same scenario is published under a dozen names that differ only in who graded it and
 * how hard they made it: `VT Smoothbot Novice`, `Smoothbot Voltaic Easy`, `SmoothBot
 * Invincible Goated`, `Smoothbot rAim`. Stripping the author's prefix and the difficulty
 * and size modifiers leaves `smoothbot`, and that is the lineage. The strip list is
 * `AUTHORS` and `MODIFIERS` below, printed with --all so a bad grouping is visible rather
 * than buried. It is a heuristic and it is meant to be curated afterwards, which is why
 * this prints candidates instead of writing families.
 *
 * WHERE THE SCENARIOS COME FROM
 *
 * Both `data/subskills.json` and `data/scenario_taxonomy.json`, unioned. The first holds
 * the 1,073 scenarios some benchmark sheet named a sub-skill for; the second holds all
 * 1,481 KovaaK's publishes, most of which no sheet has ever graded. Restricting this to
 * the first was the obvious thing and it was wrong: the easy rung of a lineage is almost
 * always somebody's community variant rather than a benchmark tier, so `Precise Tracking`
 * came back with four complete families out of sixty-seven lineages. A lineage takes its
 * sub-skill from whichever of its own members a sheet did classify - same lineage, same
 * sub-skill, which is the assumption `Odd-Angleshot Avasive Easier` already rests on.
 *
 * WHERE A WINDOW COMES FROM
 *
 * Measured first: the hardest tier any committed benchmark publishes the scenario in,
 * through `pool.bands` - the same rule `validate:pool` holds the pool to. Where no
 * committed benchmark names it, the window is *inferred* from its modifiers relative to
 * the lineage's measured members, and printed with a `~` so an inferred rung is never
 * mistaken for a graded one.
 *
 * WHY THE NOVICE RUNG IS NEARLY ALWAYS AUTHORED
 *
 * Window 0 is reachable through `pool.bands` from two tiers in the whole source list -
 * Voltaic S5's Novice and Jade Palace's Fundamentals. Everyone else's easiest tier bands
 * into window 1. So a family that wants a genuine beginner rung has to take a community
 * variant nobody graded, which is what the hand-built Clicking section does eleven times
 * over. `--members` lists every member of a lineage in difficulty order for exactly this:
 * the four rungs get picked by eye, and the reason gets written down.
 *
 * WHY BOARD SIZE LEADS THE RANKING
 *
 * A rank is a percentile of a KovaaK's board, so a board of 50 entries makes the top 3%
 * mean "beat one person". `pool.json` already refuses Avasive S2 as a source for exactly
 * this reason. The score below is therefore driven by the *smallest* board in the lineage
 * rather than the total: a family is only as trustworthy as its thinnest rung.
 */

import { readFileSync } from "node:fs";

import { dataFile } from "../src/core/dataDir.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const args = process.argv.slice(2);
function flag(name: string): string | null {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1] ?? null;
}
const onlySub = flag("--sub");
const top = Number(flag("--top") ?? 14);
const showAll = args.includes("--all");
const showMembers = args.includes("--members");
/** Boards under this cannot carry a percentile cut. `pool.json` says why. */
const FLOOR = Number(flag("--floor") ?? 1_000);

/**
 * Name fragments that say who graded a scenario rather than what it is.
 *
 * Removed from both ends. `VT` and the trailing `S5`/`S1` are Voltaic's and Aimerz+'s
 * season markers; the rest are benchmark authors who prefix or suffix their own cuts.
 */
const AUTHORS = [
  "vt", "voltaic", "vf", "raim", "aimerz+", "aimerz", "dm", "ca", "no23", "scs",
  "sparky", "pauer", "avasive", "viscose", "snakbox", "revosect", "anima", "astro",
  "e1se", "lemon", "jade", "tsk", "wobin", "mira", "pureg", "superbaim", "cartoon's",
  "cartoons", "invincible", "goated", "perfected", "s0", "s1", "s2", "s3", "s4", "s5",
  "s5.5", "v2", "v3",
];

/**
 * Modifiers that say how hard a cut is, with how far they move it.
 *
 * The deltas are in windows and are deliberately coarse - this only has to order the
 * members of one lineage against each other, and a half-window error inside a lineage is
 * visible in the printout as an out-of-order rung.
 */
const MODIFIERS: [RegExp, number][] = [
  [/\bsupereasy\b/, -2],
  [/\bfundamentals?\b/, -2],
  [/\bentry\b/, -2],
  [/\bnovice\b/, -1.5],
  [/\beasier\b/, -1.5],
  [/\bbeginner\b/, -1.5],
  [/\beasy\b/, -1],
  [/\bslow\b/, -1],
  [/\bjumbo\b/, -1.5],
  [/\bwide\b/, -0.5],
  [/\bbig\b/, -1],
  [/\b(\d+)%\s*(larger|large|size)\b/, -1],
  [/\blarger?\b/, -1],
  [/\bshort\b/, -0.5],
  [/\bintermediate\b/, 0],
  [/\bmed(ium)?\b/, 0],
  [/\bnormal\b/, 0],
  [/\badvanced\b/, 1],
  [/\bhard\b/, 1],
  [/\bexpert\b/, 1.5],
  [/\belite\b/, 2],
  [/\bsmaller?\b/, 1],
  [/\bmicro\b/, 1],
  [/\btiny\b/, 1.5],
  [/\bfast\b/, 1],
  [/\blong\b/, 0.5],
  [/\bthin\b/, 1],
];

/** Strip a name down to what the scenario *is*. */
function stem(name: string): string {
  let s = name.toLowerCase().trim();
  s = s.replace(/[_]/g, " ");
  // Percent and duration qualifiers carry difficulty, not identity.
  s = s.replace(/\b\d+%\s*/g, " ");
  s = s.replace(/\b\d+\s*s(ec(onds?)?)?\b/g, " ");
  for (const [re] of MODIFIERS) s = s.replace(new RegExp(re.source, "g"), " ");
  const words = s.split(/[\s\-]+/).filter((w) => w && !AUTHORS.includes(w));
  return words.join(" ").replace(/[^a-z0-9+ ]/g, "").trim();
}

/** How far a name's modifiers push it off its lineage's centre. */
function modifierOffset(name: string): number {
  const s = name.toLowerCase();
  let offset = 0;
  for (const [re, delta] of MODIFIERS) if (re.test(s)) offset += delta;
  return offset;
}

interface SubSkillScenario {
  scenario: string;
  leaderboardId: number | null;
  category: string | null;
  subSkill: string | null;
  entries: number;
  plays: number;
  from: { benchmark: string; difficulty: string; label: string }[];
}

interface Pool {
  windows: string[];
  sources: string[];
  bands: Record<string, Record<string, number>>;
}

interface TaxonomyScenario {
  name: string;
  leaderboardId: number | null;
  aimType: string | null;
  entries: number;
  plays: number;
}

const subskills = JSON.parse(readFileSync(dataFile("subskills.json"), "utf8")) as {
  scenarios: SubSkillScenario[];
};
const taxonomy = JSON.parse(readFileSync(dataFile("scenario_taxonomy.json"), "utf8")) as {
  scenarios: TaxonomyScenario[];
};
const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as Pool;
const sampled = new Set(
  (
    JSON.parse(readFileSync(dataFile("leaderboard_percentiles.json"), "utf8")) as {
      distributions: { scenario: string }[];
    }
  ).distributions.map((d) => d.scenario),
);
const sources = new Set(pool.sources);
const windowCount = pool.windows.length;

/** The hardest window any committed benchmark bands this scenario into, or null. */
function measuredWindow(s: SubSkillScenario): number | null {
  let band: number | null = null;
  for (const f of s.from ?? []) {
    if (!sources.has(f.benchmark)) continue;
    const b = pool.bands[f.benchmark]?.[f.difficulty];
    if (b == null) continue;
    band = band == null ? b : Math.max(band, b);
  }
  return band;
}

interface Member {
  scenario: string;
  entries: number;
  sampled: boolean;
  window: number;
  measured: boolean;
  /** Where the lineage's own evidence puts it, before rounding to a window. */
  difficulty: number;
  offset: number;
  sheets: number;
}

interface Lineage {
  stem: string;
  subSkill: string;
  members: Member[];
  /** One member per window, the biggest board available at each. */
  rungs: (Member | null)[];
  filled: number;
  smallestBoard: number;
  measuredRungs: number;
  /** Members whose board clears the floor, at any window. */
  usable: number;
  /** How far the lineage stretches, in windows, over its usable members. */
  span: number;
}

/**
 * Every scenario KovaaK's publishes, grouped by lineage, carrying whatever sub-skill its
 * classified members have.
 *
 * A lineage's sub-skill is the one the most of its own members were graded as. A tie, or a
 * lineage no sheet has ever touched, is dropped rather than guessed: a family whose
 * sub-skill nobody has stated is exactly the thing `validate:pool` refuses, and inventing
 * one here would only move the invention upstream.
 */
const byStem = new Map<string, Map<string, SubSkillScenario>>();

function add(s: SubSkillScenario): void {
  if (!s.leaderboardId) return;
  const key = stem(s.scenario);
  if (!key) return;
  const group = byStem.get(key) ?? new Map<string, SubSkillScenario>();
  const existing = group.get(s.scenario);
  // Whichever record knows more wins: the sub-skill file carries the sheets, the taxonomy
  // carries the entry count for scenarios no sheet has.
  group.set(s.scenario, {
    ...existing,
    ...s,
    subSkill: s.subSkill ?? existing?.subSkill ?? null,
    entries: Math.max(s.entries ?? 0, existing?.entries ?? 0),
    from: (s.from ?? []).length ? s.from : existing?.from ?? [],
  });
  byStem.set(key, group);
}

for (const s of subskills.scenarios) add(s);
for (const t of taxonomy.scenarios) {
  add({
    scenario: t.name,
    leaderboardId: t.leaderboardId,
    category: t.aimType,
    subSkill: null,
    entries: t.entries ?? 0,
    plays: t.plays ?? 0,
    from: [],
  });
}

const bySubSkill = new Map<string, Map<string, SubSkillScenario[]>>();
for (const [key, group] of byStem) {
  const members = [...group.values()];
  const votes = new Map<string, number>();
  for (const m of members) {
    if (!m.subSkill) continue;
    votes.set(m.subSkill, (votes.get(m.subSkill) ?? 0) + 1);
  }
  if (votes.size === 0) continue;
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) continue;
  const subSkill = ranked[0][0];
  const lineages = bySubSkill.get(subSkill) ?? new Map<string, SubSkillScenario[]>();
  lineages.set(key, members);
  bySubSkill.set(subSkill, lineages);
}

function buildLineage(subSkill: string, key: string, group: SubSkillScenario[]): Lineage {
  // Anchor: where the measured members sit, against where their own modifiers would have
  // put them. Everything unmeasured is then placed relative to that same anchor, so a
  // lineage whose only graded cut is an Advanced one does not put its Easier variant at
  // Novice merely because 'Easier' is worth a window and a half.
  const measured = group
    .map((s) => ({ s, w: measuredWindow(s) }))
    .filter((m): m is { s: SubSkillScenario; w: number } => m.w != null);

  const anchor =
    measured.length > 0
      ? measured.reduce((sum, m) => sum + (m.w - modifierOffset(m.s.scenario)), 0) /
        measured.length
      : 1.5;

  const members: Member[] = group.map((s) => {
    const w = measuredWindow(s);
    const offset = modifierOffset(s.scenario);
    const difficulty = w ?? anchor + offset;
    return {
      scenario: s.scenario,
      entries: s.entries ?? 0,
      sampled: sampled.has(s.scenario),
      window: Math.min(windowCount - 1, Math.max(0, Math.round(difficulty))),
      measured: w != null,
      difficulty,
      offset,
      sheets: (s.from ?? []).length,
    };
  });

  // One rung per window. The biggest board wins: it is the one whose percentiles describe
  // a population rather than a handful of people.
  const rungs: (Member | null)[] = Array.from({ length: windowCount }, (_, w) => {
    const here = members.filter((m) => m.window === w);
    if (here.length === 0) return null;
    return here.reduce((best, m) => (m.entries > best.entries ? m : best));
  });

  const filledRungs = rungs.filter((r): r is Member => r != null);
  const usable = members.filter((m) => m.entries >= FLOOR);
  return {
    stem: key,
    subSkill,
    members: members.sort((a, b) => a.difficulty - b.difficulty || b.entries - a.entries),
    rungs,
    filled: filledRungs.length,
    smallestBoard: filledRungs.length ? Math.min(...filledRungs.map((r) => r.entries)) : 0,
    measuredRungs: filledRungs.filter((r) => r.measured).length,
    usable: usable.length,
    span: usable.length
      ? Math.max(...usable.map((m) => m.difficulty)) - Math.min(...usable.map((m) => m.difficulty))
      : 0,
  };
}

/**
 * Rank order: how many rungs with a usable board it can offer, then how far it stretches,
 * then how much of that is graded rather than inferred.
 *
 * `filled` is not the lead term any more. Requiring four *distinct* windows meant ranking a
 * lineage by how well the band map happened to cover it, and the band map cannot reach
 * window 0 from most sources - which put lineages with six good cuts below lineages with
 * four mediocre ones. Total plays are still deliberately absent: a lineage that is popular
 * at the top and empty at the bottom is not a family.
 */
function score(l: Lineage): number {
  return Math.min(l.usable, 8) * 1e9 + l.span * 1e6 + Math.min(l.smallestBoard, 1e5) * 10 +
    l.measuredRungs;
}

const TARGETS = onlySub
  ? [onlySub]
  : [
      "Static Clicking",
      "Dynamic Clicking",
      "Precise Tracking",
      "Reactive Tracking",
      "Speed Switching",
      "Stability Switching",
    ];

for (const subSkill of TARGETS) {
  const lineages = bySubSkill.get(subSkill);
  console.log(`\n${BOLD}${subSkill}${RESET}`);
  if (!lineages) {
    console.log("  nothing classified under this name");
    continue;
  }

  const ranked = [...lineages.entries()]
    .map(([key, group]) => buildLineage(subSkill, key, group))
    .filter((l) => l.usable >= 2)
    .sort((a, b) => score(b) - score(a));

  const fourRungs = ranked.filter((l) => l.usable >= windowCount);
  const fourWindows = ranked.filter(
    (l) => l.filled === windowCount && l.smallestBoard >= FLOOR,
  );
  console.log(
    `${DIM}  ${lineages.size} lineages; ${ranked.length} have two rungs over ` +
      `${FLOOR.toLocaleString()} entries, ${fourRungs.length} have ${windowCount} or more, ` +
      `${fourWindows.length} land one in every window unaided${RESET}`,
  );

  for (const l of ranked.slice(0, showAll ? ranked.length : top)) {
    const head = `  ${l.stem}`.padEnd(32);
    console.log(
      `${head}${String(l.usable).padStart(2)} rungs  span ${l.span.toFixed(1)}` +
        `${DIM}  ${l.filled}/${windowCount} windows placed${RESET}`,
    );
    const rows = showMembers
      ? l.members.map((m) => [m.difficulty.toFixed(1).padStart(5), m] as const)
      : l.rungs.flatMap((r, w) =>
          r ? [[pool.windows[w].slice(0, 4).padEnd(5), r] as const] : [],
        );
    for (const [label, m] of rows) {
      const mark = m.measured ? " " : "~";
      const board = m.entries.toLocaleString().padStart(8);
      const cut = m.sampled ? "" : `${DIM} unsampled${RESET}`;
      const thin = m.entries < FLOOR ? `${DIM} thin${RESET}` : "";
      console.log(`      ${label}${mark}${board}  ${m.scenario}${cut}${thin}`);
    }
  }
}

console.log(
  `\n${DIM}~ a window inferred from the name's modifiers rather than graded by a benchmark.` +
    `\n  'unsampled' - npm run sample:leaderboards has not fetched its board.` +
    `\n  'thin' - under ${FLOOR.toLocaleString()} entries, so a percentile cut off it ` +
    `describes very few people.` +
    `\n  --members lists every member in difficulty order, which is how the four rungs ` +
    `get picked.${RESET}`,
);
