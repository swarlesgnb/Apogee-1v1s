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

console.log(failures === 0 ? "\nOK: the validator catches a desynced ladder" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
