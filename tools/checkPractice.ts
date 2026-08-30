/**
 * Print the Season screen's practice list, from the terminal.
 *
 *   npx tsx tools/checkPractice.ts [--stats <dir>] [--band <name>] [--all]
 *
 * The Season screen shows the pool one difficulty at a time, measured against local
 * history: personal best per scenario, the score the next rank wants, and which scenario
 * that next rank is actually scored on. All of that is computed in `apogee:practice`,
 * inside the main process, where the only way to see it is to open the app and look.
 * This calls the same function against the same files, so the numbers can be checked
 * against a scoreboard rather than eyeballed through a window.
 *
 * Grouped exactly as the screen groups it - category, then sub-skill, and no further.
 * Which family a scenario belongs to is how the ladder grades it, not something anyone
 * needs to read. `--all` prints every band instead of the one the screen would open on.
 */

import { existsSync } from "node:fs";

import { scanStatsFolder } from "../src/core/history/history.ts";
import { loadSeason } from "../src/core/season/season.ts";
import {
  installedPlaylistCount,
  playlistsFolderFor,
  practicePlaylists,
  practiceRows,
} from "../src/core/season/practice.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function findStatsDir(): string | null {
  const roots = [
    flag("stats"),
    process.env.APOGEE_STATS_DIR,
    "C:/Program Files (x86)/Steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
    "D:/steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
    "E:/steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
  ].filter((p): p is string => Boolean(p));
  return roots.find((p) => existsSync(p)) ?? null;
}

const num = (v: number) => Math.round(v).toLocaleString();

const season = loadSeason();
const statsDir = findStatsDir();
const history = statsDir ? scanStatsFolder(statsDir) : new Map();
const { rows } = practiceRows(season, history);
const bands: string[] = season.windows ?? [];

// The band the screen opens on: the one holding the most of the player's next ranks,
// which is the answer to the question this list exists to answer.
const perBand = bands.map((_, w) => rows.filter((r) => r.window === w && r.isNext).length);
const opensOn = Math.max(0, perBand.indexOf(Math.max(...perBand)));
const wanted = flag("band");
const showing = args.includes("--all")
  ? bands.map((_, w) => w)
  : [
      wanted ? bands.findIndex((b) => b.toLowerCase().startsWith(wanted.toLowerCase())) : opensOn,
    ].filter((w) => w >= 0);

console.log(
  `\n${season.name} - ${rows.length} scenarios across ${bands.length} difficulties\n` +
    `${DIM}${statsDir ?? "no stats folder found"}${RESET}\n`,
);
console.log(
  bands
    .map((b, w) => (showing.includes(w) ? `${BOLD}[${b}]${RESET}` : `${DIM} ${b} ${RESET}`))
    .join("  ") + `   ${DIM}next ranks per band: ${perBand.join(" / ")}${RESET}\n`,
);

for (const w of showing) {
  const inBand = rows.filter((r) => r.window === w);
  if (inBand.length === 0) continue;
  if (showing.length > 1) console.log(`${BOLD}\u2500\u2500 ${bands[w]}${RESET}`);

  for (const category of season.categories) {
    const inCategory = inBand.filter((r) => r.category === category.name);
    if (inCategory.length === 0) continue;
    console.log(`${BOLD}${category.name}${RESET}`);

    const subs: string[] = [];
    for (const r of inCategory) {
      const key = r.subCategory ?? "\u2014";
      if (!subs.includes(key)) subs.push(key);
    }

    for (const sub of subs) {
      console.log(`  ${DIM}${sub}${RESET}`);
      for (const r of inCategory.filter((x) => (x.subCategory ?? "\u2014") === sub)) {
        console.log(
          `   ${r.isNext ? "\u25b8" : " "} ${r.label.slice(0, 44).padEnd(46)}` +
            `${(r.best === null ? "never played" : num(r.best)).padStart(12)}` +
            `${DIM}${(r.nextRankScore === null ? "maxed" : `\u2192 ${num(r.nextRankScore)}`).padStart(12)}` +
            `${`${r.runs} runs`.padStart(11)}${RESET}`,
        );
      }
    }
    console.log("");
  }
}

const playlists = practicePlaylists(season);
const dir = statsDir ? playlistsFolderFor(statsDir) : null;
console.log(
  `${playlists.length} practice playlists` +
    (dir ? `, ${installedPlaylistCount(dir)} installed in ${dir}` : ""),
);
console.log(
  `\n${rows.filter((r) => r.runs > 0).length} of ${rows.length} scenarios have local history\n`,
);
