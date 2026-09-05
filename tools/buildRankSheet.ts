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
const sheet = renderRankSheet(season);
writeFileSync(out, sheet, "utf8");

// Counted off the bands, which is what the sheet draws. Counting the categories' own
// flat rankNames instead had this line printing "4 ladders, 56 ranks" under a page
// headlined "Thirteen ladders, fifty-nine ranks", which is exactly the drift the sheet is
// generated to prevent, printed by the command that generates it.
const ladders = season.categories.reduce((n, c) => n + (c.bands?.length || 1), 1);
const ranks =
  season.rankNames.length +
  season.categories.reduce(
    (n, c) =>
      n +
      (c.bands?.length
        ? c.bands.reduce((m, b) => m + b.rankNames.length, 0)
        : c.rankNames.length),
    0,
  );

// Lifted out of the page rather than re-derived, so this can never report a different
// number from the one a reader is looking at. The findings are the reason the sheet is
// sent to anybody: which names vanish, on which ground, and how many.
const findings = [...sheet.matchAll(/<span class="flag-text"><b>([^<]*)<\/b>/g)].map(
  (m) => m[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
);

console.log(
  `wrote ${out}
` +
    `  ${ladders} ladders, ${ranks} ranks` +
    (season.windows?.length ? `, ${season.windows.length} bands per category` : ""),
);
for (const finding of findings) console.log(`  ${finding}`);
