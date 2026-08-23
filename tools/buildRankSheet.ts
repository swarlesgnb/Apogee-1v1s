/**
 * Write docs/season-1-ranks.html from the season.
 *
 * The sheet exists to be sent to people for feedback on names and colours, which makes
 * it the worst place in the repo for a number that has drifted: it was headlined "Four
 * ladders, thirty-two ranks" while the season held forty-four. So it is generated, and
 * generated from the one file that decides what a rank is.
 *
 * `buildSeason` and the in-app season editor both write it as part of saving, so running
 * this by hand is only for when the season was edited some other way.
 *
 *   npx tsx tools/buildRankSheet.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSeason } from "../src/core/season/season.ts";
import { renderRankSheet } from "../src/core/report/rankSheet.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const season = loadSeason();
const out = join(root, "docs", "season-1-ranks.html");

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderRankSheet(season), "utf8");

const ranks =
  season.rankNames.length + season.categories.reduce((n, c) => n + c.rankNames.length, 0);

console.log(
  `wrote ${out}\n` +
    `  ${season.categories.length + 1} ladders, ${ranks} ranks` +
    (season.windowSize ? `, ${season.windows?.length ?? 0} windows of ${season.windowSize}` : ""),
);
