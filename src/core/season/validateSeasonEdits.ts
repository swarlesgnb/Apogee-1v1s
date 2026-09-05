/**
 * The editor adds and removes ranks in the renderer, which cannot import core, so the
 * guarantee that a season stays coherent rests on validateSeason refusing a desynced
 * one before main writes it. This checks that net actually holds.
 */
import { readFileSync } from "node:fs";

import { loadSeason, validateSeason, type Season } from "./season.ts";
import { rebuildPool, type RebuildSeason } from "./rebuildPool.ts";
import { ENERGY_PER_RANK } from "../benchmarks/energy.ts";
import { windowRankCount } from "./windows.ts";
import { dataFile } from "../dataDir.ts";

const base = loadSeason();
const clone = (): Season => JSON.parse(JSON.stringify(base));

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

const refuses = (s: Season): string | null => {
  try {
    validateSeason(s);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

check("the season as built is valid", refuses(base) === null, refuses(base) ?? "");

// A rank added to the ladder but not to the scenarios under it.
const nameOnly = clone();
nameOnly.categories[0].rankNames.push("Tier V");
nameOnly.categories[0].rankColors["Tier V"] = "#888888";
nameOnly.categories[0].rankMaxes.push(75000);
check(
  "a rank added without extending its scenarios is refused",
  refuses(nameOnly) !== null,
  refuses(nameOnly) ?? "accepted",
);

// A rank removed from the scenarios but left on the ladder.
const dropped = clone();
dropped.scenarios
  .filter((s) => s.category === dropped.categories[0].name)
  .forEach((s) => s.rankMaxes.pop());
check(
  "a scenario short of a threshold is refused",
  refuses(dropped) !== null,
  refuses(dropped) ?? "accepted",
);

// Energy thresholds out of step with the ladder.
const energyOff = clone();
energyOff.categories[1].rankNames.push("Tier V");
energyOff.categories[1].rankColors["Tier V"] = "#888888";
check(
  "a ladder longer than its energy thresholds is refused",
  refuses(energyOff) !== null,
  refuses(energyOff) ?? "accepted",
);

/**
 * Give every variant of a category as many thresholds as its window now grades.
 *
 * Adding or dropping a window is not purely additive once windows overlap: the window that
 * used to be top had nothing above to reach into and carried the short ladder, and the
 * moment a harder one appears above it, it grades two more ranks. So a fixture that changes
 * the depth has to restate the widths, exactly as `buildSeason` does.
 */
function resizeVariants(season: Season, category: string): void {
  const stride = season.windowSize ?? 1;
  const overlap = season.windowOverlap ?? 0;
  const depth =
    season.categories.find((c) => c.name === category)?.rankNames.length ??
    season.rankNames.length;

  for (const s of season.scenarios) {
    if (s.category !== category) continue;
    const want = windowRankCount(s.window ?? 0, stride, depth, overlap);
    const have = s.rankMaxes.length;
    if (have === want) continue;
    if (have > want) {
      s.rankMaxes = s.rankMaxes.slice(0, want);
      continue;
    }
    // Extended by the last step it already takes, so the ladder keeps ascending.
    const step = have > 1 ? s.rankMaxes[have - 1] - s.rankMaxes[have - 2] : 1;
    const out = [...s.rankMaxes];
    while (out.length < want) out.push(out[out.length - 1] + Math.max(1, step));
    s.rankMaxes = out;
  }
}

// A correct add.
//
// On a windowed season a ladder grows by a whole window, not by one rank: the ranks a
// window covers are graded by one scenario, so half a window is a set of ranks with
// nothing measuring them. Adding one at a time is what the checks above refuse, and this
// is the shape that has to keep working.
const size = base.windowSize ?? 1;
const good = clone();
const cat = good.categories[0];
// A window that grades ranks nobody has a name for is a window that cannot be shown.
if (good.windows) good.windows.push("Elite");

for (let i = 0; i < size; i++) {
  const name = `Tier ${cat.rankNames.length + 1}`;
  cat.rankNames.push(name);
  cat.rankColors[name] = "#888888";
  cat.rankMaxes.push(cat.rankMaxes[cat.rankMaxes.length - 1] + 15000);
}

// One new variant per family, covering the window just added. Cloned off the family's
// hardest existing variant and scaled up, which is what a real harder scenario is.
for (const family of new Set(
  good.scenarios.filter((s) => s.category === cat.name).map((s) => s.family),
)) {
  const variants = good.scenarios.filter((s) => s.family === family);
  const hardest = variants.reduce((a, b) => ((b.window ?? 0) > (a.window ?? 0) ? b : a));
  good.scenarios.push({
    ...hardest,
    scenario: `${hardest.scenario} (harder)`,
    window: Math.max(...variants.map((v) => v.window ?? 0)) + 1,
    rankMaxes: hardest.rankMaxes.map((v) => Math.round(v * 1.1)),
  });
}

resizeVariants(good, cat.name);

check(
  "a window added everywhere it belongs is accepted",
  refuses(good) === null,
  refuses(good) ?? "",
);

// One category may be a different depth from another.
check(
  "categories may have different numbers of ranks",
  good.categories[0].rankNames.length !== good.categories[1].rankNames.length,
  `${good.categories[0].rankNames.length} vs ${good.categories[1].rankNames.length}`,
);

// A rank above the energy ceiling.
//
// The one failure mode with no symptom other than a top rank that stays empty forever:
// the ladder ascends, the counts line up, and no score anybody can produce reaches it.
// Voltaic's published Switching thresholds have this shape, which is why it is checked.
//
// The step is derived from the category's own family count rather than written down. It
// used to be a literal 17,500, which was above the ceiling while the category had six
// families and exactly *at* it the moment the pool grew to seven - so the check passed a
// season it was supposed to refuse, and the only symptom was this suite going green.
const unreachable = clone();
const ceilingCat = unreachable.categories[0];
const ceilingFamilies = new Set(
  unreachable.scenarios.filter((s) => s.category === ceilingCat.name).map((s) => s.family),
).size;
const overCeiling = (ceilingFamilies + 1) * ENERGY_PER_RANK;
ceilingCat.rankMaxes = ceilingCat.rankMaxes.map((_, i) => overCeiling * (i + 1));
check(
  "a rank above the energy ceiling is refused",
  refuses(unreachable) !== null,
  refuses(unreachable) ?? "accepted",
);

// ---- windows ---------------------------------------------------------------------
//
// The three below are the ways a windowed season goes wrong that a flat one cannot, and
// each of them is silent without a check: ranks nobody can reach, two scenarios grading
// the same ranks, and a family that belongs to two categories at once.
if (base.windowSize) {
  const holed = clone();
  const victim = holed.scenarios.find((s) => (s.window ?? 0) === 1)!;
  holed.scenarios = holed.scenarios.filter((s) => s !== victim);
  check(
    "a family missing a window is refused",
    refuses(holed) !== null,
    refuses(holed) ?? "accepted",
  );

  // Two different scenarios in one window used to be accepted here and refused by
  // validate:pool and by the database's UNIQUE (season_id, family, window_index). A season
  // built on the permissive reading passed locally and failed on push, so this check now
  // asserts the refusal the other two always gave.
  const shared = clone();
  const twin = shared.scenarios.find((s) => (s.window ?? 0) === 0)!;
  shared.scenarios.push({ ...twin, scenario: `${twin.scenario} (alternate)` });
  check(
    "two scenarios in one window is refused, as the database refuses it",
    refuses(shared) !== null,
    refuses(shared) ?? "accepted",
  );

  // The same scenario twice adds nothing and is what a mis-click produces.
  const doubled = clone();
  const dupe = doubled.scenarios.find((s) => (s.window ?? 0) === 0)!;
  doubled.scenarios.push({ ...dupe });
  check(
    "the same scenario listed twice in a family is refused",
    refuses(doubled) !== null,
    refuses(doubled) ?? "accepted",
  );

  // Deliberately not the first window-2 scenario: the destination is categories[1], and
  // the first one is already in it, so the move was a no-op and the check could not fail.
  // Re-ordering the pool is all it took - this passed for a whole rebuild saying nothing.
  const split = clone();
  const destination = split.categories[1].name;
  const moved = split.scenarios.find((s) => (s.window ?? 0) === 2 && s.category !== destination)!;
  moved.category = destination;
  check(
    "a family split across categories is refused",
    refuses(split) !== null,
    refuses(split) ?? "accepted",
  );
}


// ---- the overall rank is derived from the three categories -----------------------
//
// Not graded on its own: with ladders of different depths a summed-energy overall
// silently drops every time one category is shorter than another. These pin the ends,
// which is where a derivation of this kind goes wrong first.
import { evaluateBenchmark } from "../benchmarks/energy.ts";
import { seasonAsDifficulties, seasonAsDifficulty } from "./season.ts";

console.log("\n-- derived overall --");

const diff = seasonAsDifficulty(base);
const everyScenario = base.scenarios;

const atLeast = (fraction: number) =>
  new Map(
    everyScenario.map((s) => {
      const top = s.rankMaxes[s.rankMaxes.length - 1];
      return [s.scenario, top * fraction];
    }),
  );

const maxed = evaluateBenchmark(diff, atLeast(1.5));
check(
  "maxing every category reaches the top overall rank",
  maxed.rankName === base.rankNames[base.rankNames.length - 1],
  `${maxed.rankName}`,
);

const nothing = evaluateBenchmark(diff, new Map());
check("scoring nothing is unranked overall", nothing.rankIndex < 0, `${nothing.rankName}`);

// A category shorter than the others must not drag the overall down by arithmetic.
// Shortened by a whole window, for the same reason the add above adds one.
const uneven: Season = clone();
const short = uneven.categories[0];
const keep = Math.max(size, short.rankNames.length - size);
short.rankNames = short.rankNames.slice(0, keep);
short.rankColors = Object.fromEntries(short.rankNames.map((n, i) => [n, i % 2 ? "#888" : "#999"]));
short.rankMaxes = short.rankMaxes.slice(0, keep);
uneven.scenarios = uneven.scenarios.filter(
  (s) => s.category !== short.name || (s.window ?? 0) < keep / size,
);

resizeVariants(uneven, short.name);

check("a season with uneven ladders is valid", refuses(uneven) === null, refuses(uneven) ?? "");

const unevenMaxed = evaluateBenchmark(seasonAsDifficulty(uneven), atLeast(1.5));
check(
  "a shorter ladder does not stop the overall reaching the top",
  unevenMaxed.rankName === uneven.rankNames[uneven.rankNames.length - 1],
  `${unevenMaxed.rankName}`,
);

// ---- the positional top rank is unreachable by any score ---------------------------
//
// This is the whole safety property. The rank is meant to be handed out by the server
// from board order, so if energy could ever reach it the client would be awarding itself
// the rarest rank in the game off numbers it computed locally. It cannot, structurally:
// `rankIndex` reads `rankMaxes`, the positional name lives past the end of it, and the
// two arrays differ in length by exactly one. Asserted rather than assumed, because that
// invariant is one careless `rankNames.length` away from silently going.
{
  const bands = seasonAsDifficulties(base);
  const top = bands[bands.length - 1];

  if (top && top.categories.some((c) => c.positional)) {
    const maxed = new Map<string, number>();
    for (const c of top.categories) for (const sc of c.scenarios) maxed.set(sc.name, 1e9);

    const graded = evaluateBenchmark(top, maxed);
    const positional = graded.categories.filter((c) => c.positional);
    const claimed = positional.filter((c) => c.rankName === c.positional!.rankName);
    const eligible = positional.filter((c) => c.positional!.eligible);

    check(
      "no score can reach the positional top rank",
      claimed.length === 0,
      `${claimed.length} category(ies) awarded it on energy alone`,
    );
    check(
      "maxing the band makes a player eligible for it",
      positional.length > 0 && eligible.length === positional.length,
      `${eligible.length} of ${positional.length} eligible`,
    );
  }
}

// Saving the season rewrites the pool from it, and the pool holds things the season has no
// field for. Rebuilding from a season the pool itself produced therefore has to be a no-op:
// anything that changes here is something a save silently deletes.
//
// Not hypothetical. Before the rebuild carried the fields it does not own, one save from
// the editor removed twelve `admitted` reasons, three `$order` exceptions and one
// `thinBoard` exception - every written justification for a hand-picked rung in the pool -
// and turned a passing `validate:pool` into three failures. Nothing said a word at any
// point, and it was twice diagnosed as something else entirely.
{
  const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8"));
  const again = rebuildPool(pool, base as unknown as RebuildSeason);

  const differences: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (differences.length >= 6) return;
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === "object" && typeof b === "object") {
      // Arrays by index, which is sound here because the rebuild sorts families and
      // variants the same way the pool is written - and a change in that order is itself
      // worth reporting rather than hiding behind a set comparison.
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      }
      return;
    }
    differences.push(
      b === undefined ? `${path} is dropped`
        : a === undefined ? `${path} is added`
        : `${path} changes`,
    );
  };
  walk(pool, again, "pool");

  check(
    "rewriting the pool from the season it produced changes nothing",
    differences.length === 0,
    differences.join("; "),
  );
}

console.log(
  failures === 0
    ? "\nOK: season edits and the derived overall validated"
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
