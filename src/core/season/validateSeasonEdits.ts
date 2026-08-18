/**
 * The editor adds and removes ranks in the renderer, which cannot import core, so the
 * guarantee that a season stays coherent rests on validateSeason refusing a desynced
 * one before main writes it. This checks that net actually holds.
 */
import { loadSeason, validateSeason, type Season } from "./season.ts";

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

// A correct add: names, colours, energy and every scenario in the category.
const good = clone();
const cat = good.categories[0];
cat.rankNames.push("Tier V");
cat.rankColors["Tier V"] = "#888888";
cat.rankMaxes.push(cat.rankMaxes[cat.rankMaxes.length - 1] + 15000);
good.scenarios
  .filter((s) => s.category === cat.name)
  .forEach((s) => {
    const last = s.rankMaxes[s.rankMaxes.length - 1];
    const gap = last - s.rankMaxes[s.rankMaxes.length - 2];
    s.rankMaxes.push(last + Math.max(1, gap));
  });
check("a rank added everywhere it belongs is accepted", refuses(good) === null, refuses(good) ?? "");

// One category may be a different depth from another.
check(
  "categories may have different numbers of ranks",
  good.categories[0].rankNames.length !== good.categories[1].rankNames.length,
  `${good.categories[0].rankNames.length} vs ${good.categories[1].rankNames.length}`,
);


// ---- the overall rank is derived from the three categories -----------------------
//
// Not graded on its own: with ladders of different depths a summed-energy overall
// silently drops every time one category is shorter than another. These pin the ends,
// which is where a derivation of this kind goes wrong first.
import { evaluateBenchmark } from "../benchmarks/energy.ts";
import { seasonAsDifficulty } from "./season.ts";

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
const uneven: Season = clone();
const short = uneven.categories[0];
short.rankNames = short.rankNames.slice(0, 2);
short.rankColors = { [short.rankNames[0]]: "#888", [short.rankNames[1]]: "#999" };
short.rankMaxes = short.rankMaxes.slice(0, 2);
uneven.scenarios
  .filter((s) => s.category === short.name)
  .forEach((s) => (s.rankMaxes = s.rankMaxes.slice(0, 2)));

check("a season with uneven ladders is valid", refuses(uneven) === null, refuses(uneven) ?? "");

const unevenMaxed = evaluateBenchmark(seasonAsDifficulty(uneven), atLeast(1.5));
check(
  "a shorter ladder does not stop the overall reaching the top",
  unevenMaxed.rankName === uneven.rankNames[uneven.rankNames.length - 1],
  `${unevenMaxed.rankName}`,
);

console.log(
  failures === 0
    ? "\nOK: season edits and the derived overall validated"
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
