/**
 * Self-test for the Arena rank ladder.
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
} from "./arenaRanks.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
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

console.log(`\nArena rank ladder: ${theme.tiers.length} tiers` +
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
const badHex = theme.tiers.filter(
  (t) =>
    ![t.color, t.glow, ...t.gradient].every((c) => /^#[0-9a-f]{6}$/i.test(c)),
);
check("all colours are 6-digit hex", badHex.length === 0, badHex.map((t) => t.name).join(", "));

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
