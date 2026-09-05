/**
 * Self-test for the Apogee rank ladder.
 *
 * The percentile bands are hand-edited (and now editor-generated), so the loader's
 * contiguity guard is the thing standing between a typo and silently mis-ranking every
 * player. These checks exercise that guard and the band lookup.
 *
 *   npx tsx src/core/ranks/validateRanks.ts
 */

import {
  loadRankTheme,
  percentileOf,
  standingFor,
  tierForPercentile,
  type RankTheme,
} from "./apogeeRanks.ts";
import { readability, readabilityNote } from "../report/contrast.ts";
import { hasSeason, loadSeason } from "../season/season.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * A thing worth knowing that is not a thing worth blocking on.
 *
 * The tier colours are chosen to match the tier names, not to satisfy a contrast
 * formula, and that is the right trade for a ladder whose whole job is to be
 * recognisable. Where the trade costs something, saying so beats either failing the
 * build over it or pretending it is not true.
 */
function note(label: string, quiet: boolean, detail = ""): void {
  console.log(quiet ? `  ok   ${label}` : `  note ${label}${detail ? `: ${detail}` : ""}`);
}

function expectThrow(label: string, fn: () => unknown): void {
  try {
    fn();
    failures++;
    console.log(`  FAIL ${label}: expected an error, got none`);
  } catch {
    console.log(`  ok   ${label}`);
  }
}

const theme = loadRankTheme();

console.log(`\nApogee rank ladder: ${theme.tiers.length} tiers` +
  `${theme.placeholderNames ? " (placeholder names)" : ""}\n`);

for (const tier of theme.tiers) {
  const [lo, hi] = tier.percentile;
  const width = hi - lo;
  const bar = "█".repeat(Math.max(1, Math.round(width / 2)));
  console.log(
    `  ${tier.name.padEnd(11)} p${String(lo).padStart(3)}–${String(hi).padStart(3)}` +
      `  ${String(width).padStart(3)}%  ${tier.color}  ${bar}`,
  );
}

console.log("\nchecks");

// Bands must tile 0..100 with no gap or overlap.
const covered = theme.tiers.reduce((sum, t) => sum + (t.percentile[1] - t.percentile[0]), 0);
check("bands cover exactly 100 percentile points", covered === 100, `got ${covered}`);

// Every percentile must resolve to exactly one tier, including both endpoints.
let unresolved = 0;
for (let p = 0; p <= 100; p++) {
  const matches = theme.tiers.filter(
    (t) => p >= t.percentile[0] && (p < t.percentile[1] || t.percentile[1] === 100),
  );
  if (matches.length !== 1) unresolved++;
}
check("every percentile 0..100 maps to one tier", unresolved === 0, `${unresolved} ambiguous`);

check("p0 is the bottom tier", tierForPercentile(theme, 0).id === theme.tiers[0].id);
check(
  "p100 is the top tier",
  tierForPercentile(theme, 100).id === theme.tiers[theme.tiers.length - 1].id,
);
check("out-of-range percentiles clamp", tierForPercentile(theme, 999).id === theme.tiers[theme.tiers.length - 1].id);

// Colours must be usable by the UI without further parsing.
const badHex = theme.tiers.filter((t) => !/^#[0-9a-f]{6}$/i.test(t.color));
check("all colours are 6-digit hex", badHex.length === 0, badHex.map((t) => t.name).join(", "));

// A rank name is drawn on the client's near-black ground and again on a light one - a
// screenshot, a profile, a web page. Measured, but reported rather than enforced: the
// colours name the tiers on purpose, and Quasar not being a dark colour is what makes it
// Quasar. legibleOnDark() in the renderer handles the dark side at draw time; the light
// side is a thing to know about a screenshot, not a reason to fail a build.
const unreadable = theme.tiers.filter((t) => !readability(t.color).ok);
note(
  "every tier colour survives both grounds",
  unreadable.length === 0,
  unreadable.map((t) => `${t.name}: ${readabilityNote(t.color)}`).join("; "),
);

// A colour shared by two tiers is two ranks that look like one.
const shared = new Map<string, string[]>();
for (const t of theme.tiers) {
  const key = t.color.toLowerCase();
  shared.set(key, [...(shared.get(key) ?? []), t.name]);
}
const dupes = [...shared.values()].filter((names) => names.length > 1);
check("no two tiers share a colour", dupes.length === 0, dupes.map((n) => n.join(" = ")).join("; "));

// And no tier shares a *name* with anything the season ranks, which is the rule
// `apogeeRanks.ts` opens by stating and nothing asserted.
//
// It had been broken for the whole life of the season file. Both ladders ran Stargazer,
// Astrologist, Cosmonaut, Lunar, Odyssey, Arecibo, Quasar, Supernova - the same eight
// words for two different claims, in two different sets of colours. The Ranks page paints
// its top ladder from the tiers and everything else from the season, so Stargazer was
// #00EAEA in one place and #4824ff in every other, and no amount of editing in the season
// editor could reconcile them because they are different files.
//
// A rating tier says where you sit against other players. A season rank says what your
// scores are worth. Sharing a vocabulary makes those one sentence, which is the thing the
// module comment says must never happen.
const seasonNames = new Map<string, string>();
if (hasSeason()) {
  const season = loadSeason();

  // The overall readout is the exception, and a deliberate one: it takes its names AND its
  // colours from these tiers, so it is not a second ladder wearing the same words - it is
  // this ladder, shown against energy instead of against other players. Checked as an
  // exact match rather than waved through, because a partial one is the original bug back:
  // the same eight words in two different sets of colours, with the app painting Stargazer
  // cyan on one screen and blue-violet on every other.
  const tierNames = theme.tiers.map((t) => t.name);
  const tierColors = Object.fromEntries(theme.tiers.map((t) => [t.name, t.color]));
  const overallIsTheTiers =
    JSON.stringify(season.rankNames) === JSON.stringify(tierNames) &&
    JSON.stringify(season.rankColors) === JSON.stringify(tierColors);

  check(
    "the overall readout is the rating ladder exactly, or shares nothing with it",
    overallIsTheTiers ||
      !season.rankNames.some((n) => tierNames.some((t) => t.toLowerCase() === n.toLowerCase())),
    overallIsTheTiers ? "" : "same names, different colours",
  );

  if (!overallIsTheTiers) {
    for (const name of season.rankNames) seasonNames.set(name.toLowerCase(), "the overall ladder");
  }
  for (const category of season.categories) {
    for (const band of category.bands ?? []) {
      for (const name of band.rankNames) seasonNames.set(name.toLowerCase(), category.name);
    }
    for (const name of category.rankNames) {
      if (!seasonNames.has(name.toLowerCase())) seasonNames.set(name.toLowerCase(), category.name);
    }
  }
}
const collisions = theme.tiers
  .filter((t) => seasonNames.has(t.name.toLowerCase()))
  .map((t) => `${t.name} is also in ${seasonNames.get(t.name.toLowerCase())}`);
check(
  "no tier shares a name with a season rank",
  collisions.length === 0,
  collisions.join("; "),
);

// Percentile helper.
const population = [1200, 1300, 1400, 1500, 1600];
check("percentileOf ranks mid-population", percentileOf(1450, population) === 60,
  `got ${percentileOf(1450, population)}`);
check("percentileOf floors at 0", percentileOf(1000, population) === 0);

// Placements hide the rank until enough matches are played.
const provisional = standingFor(theme, 1500, 3, population);
check("rank hidden during placements", provisional.tier === null && provisional.placementsRemaining === 7);
const placed = standingFor(theme, 1500, 10, population);
check("rank shown after placements", placed.tier !== null && placed.percentile !== null);

// The guard must reject malformed themes rather than silently mis-ranking.
const broken = (mutate: (t: RankTheme) => void): (() => unknown) => () => {
  const clone = JSON.parse(JSON.stringify(theme)) as RankTheme;
  mutate(clone);
  // Re-run the loader's validation by round-tripping through a data URL.
  const json = JSON.stringify(clone);
  return loadRankTheme(
    new URL(`data:application/json;base64,${Buffer.from(json).toString("base64")}`),
  );
};

expectThrow("rejects a gap between bands", broken((t) => { t.tiers[1].percentile[0] += 3; }));
expectThrow("rejects an overlap", broken((t) => { t.tiers[1].percentile[0] -= 3; }));
expectThrow("rejects not starting at 0", broken((t) => { t.tiers[0].percentile[0] = 5; }));
expectThrow("rejects not ending at 100", broken((t) => {
  t.tiers[t.tiers.length - 1].percentile[1] = 98;
}));

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: rank ladder is well-formed");
