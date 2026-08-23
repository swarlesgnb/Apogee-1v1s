/**
 * What the current ladder does to the population, with self-tests.
 *
 *   npx tsx src/core/season/validateDistribution.ts
 */

import { readFileSync } from "node:fs";

import { dataFile } from "../dataDir.ts";
import { loadSeason } from "./season.ts";
import { rankDistribution } from "./distribution.ts";
import type { Distribution } from "./percentiles.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const season = loadSeason();
const cache = JSON.parse(
  readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"),
) as { distributions: Distribution[] };

const distributions = new Map(cache.distributions.map((d) => [d.scenario, d]));
const result = rankDistribution(season, distributions);

console.log(
  `\n${BOLD}${season.name}: where the population lands${RESET}\n` +
    `${DIM}assuming a player sits at the same percentile on every scenario, which makes\n` +
    `this the sharpest shape the ladder can produce - real spread flattens it${RESET}`,
);

const bar = (share: number) => "█".repeat(Math.round(share * 60)) || (share > 0 ? "▏" : "");

for (const cat of result) {
  console.log(`\n${BOLD}${cat.category}${RESET}`);
  if (cat.unranked > 0) {
    console.log(
      `  ${"unranked".padEnd(18)}${(cat.unranked * 100).toFixed(1).padStart(6)}%  ` +
        `${DIM}${bar(cat.unranked)}${RESET}`,
    );
  }
  for (const rank of cat.ranks) {
    const pct = (rank.share * 100).toFixed(1);
    console.log(
      `  ${`${rank.rank}. ${rank.name}`.padEnd(18)}${pct.padStart(6)}%  ` +
        `${rank.share === 0 ? DIM + "empty" + RESET : bar(rank.share)}`,
    );
  }
  if (cat.empty.length > 0) {
    console.log(`  ${DIM}${cat.empty.length} rank(s) nobody reaches: ${cat.empty.join(", ")}${RESET}`);
  }
}

// ---- self-tests --------------------------------------------------------------------
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log(`\n${BOLD}checks${RESET}`);

check("every category is covered", result.length === season.categories.length, `${result.length}`);

for (const cat of result) {
  const total = cat.unranked + cat.ranks.reduce((n, r) => n + r.share, 0);
  check(
    `${cat.category} shares sum to the whole population`,
    Math.abs(total - 1) < 0.005,
    total.toFixed(4),
  );
  check(
    `${cat.category} has a rank for every name`,
    cat.ranks.length === (season.categories.find((c) => c.name === cat.category)?.rankNames.length ?? 0),
  );
}

// ---- skipped ranks ------------------------------------------------------------------
//
// A rank nobody lands in is not a broken season: it loads, it grades, and every number in
// it is real. So this reports rather than fails. It is still the most useful thing on the
// page - a rank that exists and cannot be held is a promise the ladder does not keep, and
// nothing else in the suite can see it.
console.log(`\n${BOLD}skipped and thin ranks${RESET}`);

/**
 * A rank held by under this share is nearly as bad as one held by nobody.
 *
 * It exists, it is reachable, and almost nobody will ever be it - so it reads to a player
 * as a rank that does not really happen. The cause is the same as an empty one, a handover
 * squeezing the ranks either side of it, and so is the fix.
 */
const THIN = 0.01;

let skipped = 0;
let thin = 0;

for (const cat of result) {
  const reached = cat.ranks.filter((r) => r.share > 0).map((r) => r.rank);
  const first = reached[0] ?? 1;
  const last = reached[reached.length - 1] ?? 0;
  const gaps = cat.ranks
    .filter((r) => r.share === 0 && r.rank > first && r.rank < last)
    .map((r) => `${r.rank}. ${r.name}`);

  // The top rank is exempt. Being held by very few people is what a top rank is for, and
  // flagging it every time trains the eye to skip the whole line.
  const narrow = cat.ranks.filter(
    (r) => r.share > 0 && r.share < THIN && r.rank < cat.ranks.length,
  );
  if (narrow.length > 0) {
    thin += narrow.length;
    console.log(
      `  ${cat.category} thin: ` +
        narrow.map((r) => `${r.name} ${(r.share * 100).toFixed(1)}%`).join(", "),
    );
  }

  if (gaps.length === 0) {
    console.log(`  ${DIM}${cat.category}: none${RESET}`);
    continue;
  }

  skipped += gaps.length;
  console.log(`  ${cat.category}: ${gaps.join(", ")}`);
}

if (skipped > 0) {
  console.log(
    `\n${DIM}Each of these sits at the top of a window. The next window's first rank is set\n` +
      `at almost the same percentile as the current window's last, so a player crosses\n` +
      `both at once and the lower of the two is never held. Widening the gap at each\n` +
      `handover is what closes them.${RESET}`,
  );
}

console.log(
  failures === 0
    ? `\nOK: rank distribution validated` +
      `${skipped > 0 ? `, ${skipped} rank(s) skipped` : ""}` +
      `${thin > 0 ? `, ${thin} held by under 1%` : ""}`
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
