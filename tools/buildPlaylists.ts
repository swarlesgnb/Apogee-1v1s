/**
 * Write a KovaaK's playlist for every category and difficulty in the season.
 *
 * The playlists themselves are built by `src/core/season/practice.ts`, because the app
 * installs the same ones from the Season screen and two builders would drift. This is the
 * command-line way in, for a machine where the app is not running or a set to inspect
 * before installing.
 *
 *   npx tsx tools/buildPlaylists.ts [--out <dir>] [--install] [--stats <dir>]
 *
 * `--install` writes straight into KovaaK's own Playlists folder, found beside the stats
 * folder the app already knows how to locate. Without it they land in `playlists/` for
 * copying by hand, which is the safer default for something that writes into a game's
 * save directory.
 */

import { existsSync, readdirSync } from "node:fs";

import { loadSeason } from "../src/core/season/season.ts";
import {
  installedPlaylistCount,
  playlistsFolderFor,
  practicePlaylists,
  writePracticePlaylists,
} from "../src/core/season/practice.ts";

function findStatsDir(): string | null {
  const roots = [
    process.env.APOGEE_STATS_DIR,
    "C:/Program Files (x86)/Steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
    "D:/steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
    "E:/steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
  ].filter((p): p is string => Boolean(p));
  return roots.find((p) => existsSync(p)) ?? null;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const season = loadSeason();
const built = practicePlaylists(season);
const install = args.includes("--install");
let outDir = flag("--out") ?? "playlists";

if (install) {
  const stats = flag("--stats") ?? findStatsDir();
  if (!stats) {
    console.error("could not find the KovaaK's stats folder - pass --stats <dir>");
    process.exit(1);
  }
  outDir = playlistsFolderFor(stats);
}

const result = writePracticePlaylists(season, outDir, { create: !install });
if (!result.ok) {
  console.error(
    install
      ? `${result.error} - is this the right stats folder?`
      : (result.error ?? "could not write the playlists"),
  );
  process.exit(1);
}

console.log(`${season.name} - wrote ${built.length} playlists to ${outDir}\n`);
for (const { name, scenarios } of built) {
  console.log(`  ${name.padEnd(34)} ${String(scenarios.length).padStart(2)} scenarios`);
}

if (!install) {
  const stats = findStatsDir();
  const target = stats ? playlistsFolderFor(stats) : "…\\FPSAimTrainer\\Saved\\SaveGames\\Playlists";
  console.log(`\ncopy them into KovaaK's, or re-run with --install:\n  ${target}`);
  readdirSync(outDir);
} else {
  console.log(
    `\n${installedPlaylistCount(outDir)} Apogee playlists now in KovaaK's. ` +
      `Restart the game to see them.`,
  );
}
