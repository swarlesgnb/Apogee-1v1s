/**
 * Export the season as a spreadsheet you can tune the ladder in.
 *
 *   npx tsx tools/buildTuningSheet.ts
 *
 * The problem this solves: changing a rank boundary today means editing
 * `data/pool.json`, running `build:season`, running `distribution`, reading the result,
 * and going round again. That is a slow loop for a decision that is mostly a judgement
 * about shape - where the ladder should be dense, where it should thin out, and whether
 * any rank ends up held by nobody.
 *
 * So the thresholds are not exported as numbers. They are exported as FORMULAS over the
 * sampled leaderboard distributions, driven by twelve editable percentile cells. Change
 * one cell and all 54 scenarios' thresholds, every rank's share of the population, and
 * the skipped-rank check all move at once.
 *
 * WHY THE FORMULA IS WRITTEN THE WAY IT IS
 *
 * It has to agree with `scoreAtTopFraction` in `src/core/season/percentiles.ts`, or the
 * sheet is a second opinion rather than a preview - and a tuning tool that disagrees with
 * the builder is worse than no tuning tool. That function clamps to the first and last
 * sampled point, interpolates linearly in score against fraction between the two
 * bracketing points, `thresholdsFrom` rounds to a whole point, and then it nudges any
 * threshold that did not come out above the one below it. The exported formula does those
 * five things in that order. The nudge is the one that is easy to leave out - it only
 * fires where a board is dense enough that two adjacent percentiles round to the same
 * score, which on this pool is tamTargetSwitch Smooth Easy, whose whole Advanced window
 * spans six points of score. Leaving it out made the sheet disagree with the season by
 * one point there and by nothing anywhere else, which is exactly the kind of gap a
 * preview is supposed to close. `npm run validate:tuning` re-derives every cell
 * against the committed season and fails if any disagrees, so this claim is checkable
 * rather than asserted.
 *
 * Output: docs/season-1-tuning/*.csv, one per tab, imported into Google Sheets with
 * File > Import > Insert new sheet. Formulas survive the import; values do not need to.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { dataFile } from "../src/core/dataDir.ts";
import type { Distribution } from "../src/core/season/percentiles.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const outDir = join(root, "docs", "season-1-tuning");

interface Season {
  name: string;
  windows: string[];
  windowSize: number;
  categories: { name: string; rankNames: string[]; rankColors: Record<string, string>; rankMaxes: number[] }[];
  scenarios: {
    scenario: string;
    category: string;
    family: string;
    window: number;
    label: string;
    leaderboardId: number;
    rankMaxes: number[];
    derivedFrom: { leaderboardEntries: number; topFractions: number[] };
  }[];
}

const season = JSON.parse(readFileSync(dataFile("seasons/season-1.json"), "utf8")) as Season;
const cache = JSON.parse(
  readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"),
) as { samplePoints: number[]; distributions: Distribution[] };

const dists = new Map(cache.distributions.map((d) => [d.scenario, d]));
const points = cache.samplePoints;
const N = points.length;

/** RFC 4180. Formulas are comma-dense, so nearly every one of them needs quoting. */
function csv(rows: (string | number)[][]): string {
  return (
    rows
      .map((r) =>
        r
          .map((v) => {
            const s = String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(","),
      )
      .join("\r\n") + "\r\n"
  );
}

/** Spreadsheet column letter for a 0-based index. 16 sample points stay inside A..Z. */
const col = (i: number) => String.fromCharCode(65 + i);

const scenarios = season.scenarios;
const firstCol = col(1); // B
const lastCol = col(N); // Q for 16 points
const lastRow = scenarios.length + 1;

// ---- Tuning ------------------------------------------------------------------------
//
// The twelve cells everything else reads. Kept in one column so the ladder can be read
// down the page as the single decreasing list it has to be.
const tuning: (string | number)[][] = [
  ["Rank", "Window", "Percentile (top fraction)", "Share of players", "Check"],
];
const ranks = season.windows.length * season.windowSize;
for (let r = 1; r <= ranks; r++) {
  const row = r + 1;
  const window = season.windows[Math.floor((r - 1) / season.windowSize)];
  const share =
    r === ranks ? `=C${row}` : `=IF(C${row}>C${row + 1},C${row}-C${row + 1},0)`;
  const check =
    r === ranks
      ? `=IF(C${row}>0,"","top rank unreachable")`
      : `=IF(C${row}>C${row + 1},"","SKIPPED - rank ${r} is superseded by rank ${r + 1}")`;
  tuning.push([r, window, "", share, check]);
}
tuning.push([]);
tuning.push(["unranked", "", "", "=1-C2", ""]);
tuning.push(["total", "", "", `=SUM(D2:D${ranks + 1})+D${ranks + 4}`, `=IF(ABS(D${ranks + 5}-1)<0.0001,"","shares do not sum to 1")`]);

// The current ladder goes in as the starting point, read from the season rather than
// retyped, so the sheet opens showing exactly what is committed.
const perWindow = season.windows.map((_, w) => {
  const sample = scenarios.find((s) => s.window === w);
  return sample ? sample.derivedFrom.topFractions : [];
});
for (let r = 1; r <= ranks; r++) {
  const w = Math.floor((r - 1) / season.windowSize);
  const j = (r - 1) % season.windowSize;
  tuning[r][2] = perWindow[w][j];
}

// ---- Distributions -------------------------------------------------------------------
const distRows: (string | number)[][] = [["Scenario", ...points]];
for (const s of scenarios) {
  const d = dists.get(s.scenario);
  distRows.push([s.scenario, ...(d ? d.points.map((p) => p.score) : Array(N).fill(""))]);
}

// ---- Thresholds ----------------------------------------------------------------------
const thrRows: (string | number)[][] = [
  ["Scenario", "Category", "Family", "Window", "Ranks", "Board entries", "T1", "T2", "T3", "T4"],
];
scenarios.forEach((s, idx) => {
  const row = idx + 2;
  const lo = s.window * season.windowSize + 1;
  const cells: string[] = [];
  for (let j = 0; j < season.windowSize; j++) {
    const pCell = `Tuning!$C$${lo + j + 1}`;
    // Ties are real, and a flat step makes a rank unreachable by definition. The nudge
    // reads the cell to its left, which is the same chain `thresholdsFrom` walks.
    const previous = j === 0 ? null : `$${col(6 + j - 1)}${row}`;
    const raw =
      `LET(p,${pCell},` +
        `f,Distributions!$${firstCol}$1:$${lastCol}$1,` +
        `s,INDEX(Distributions!$${firstCol}$2:$${lastCol}$${lastRow},MATCH($A${row},Distributions!$A$2:$A$${lastRow},0),0),` +
        `IF(p<=INDEX(f,1,1),INDEX(s,1,1),` +
        `IF(p>=INDEX(f,1,${N}),INDEX(s,1,${N}),` +
        `LET(i,MATCH(p,f,1),a,INDEX(f,1,i),b,INDEX(f,1,i+1),c,INDEX(s,1,i),d,INDEX(s,1,i+1),` +
        `ROUND(c+(p-a)/(b-a)*(d-c))))))`;
    cells.push(previous === null ? `=${raw}` : `=MAX(${raw},${previous}+1)`);
  }
  thrRows.push([
    s.scenario,
    s.category,
    s.family,
    season.windows[s.window],
    `${lo}-${lo + season.windowSize - 1}`,
    s.derivedFrom.leaderboardEntries,
    ...cells,
  ]);
});

// ---- Ranks ---------------------------------------------------------------------------
const rankRows: (string | number)[][] = [["Rank", "Window", ...season.categories.flatMap((c) => [c.name, `${c.name} energy`])]];
for (let r = 1; r <= ranks; r++) {
  rankRows.push([
    r,
    season.windows[Math.floor((r - 1) / season.windowSize)],
    ...season.categories.flatMap((c) => [c.rankNames[r - 1] ?? "", c.rankMaxes[r - 1] ?? ""]),
  ]);
}

mkdirSync(outDir, { recursive: true });
// Google Sheets names an imported tab after the file, and the exported formulas address
// `Tuning!` and `Distributions!` by name - so these filenames are load-bearing, not
// cosmetic. Renaming a file breaks every threshold in the sheet.
const tabs: [string, (string | number)[][]][] = [
  ["Tuning", tuning],
  ["Thresholds", thrRows],
  ["Distributions", distRows],
  ["Ranks", rankRows],
];
for (const [name, rows] of tabs) {
  writeFileSync(join(outDir, `${name}.csv`), csv(rows), "utf8");
}

console.log(`${season.name}: ${scenarios.length} scenarios, ${ranks} ranks, ${N} sample points`);
for (const [name] of tabs) console.log(`  ${join("docs", "season-1-tuning", `${name}.csv`)}`);
