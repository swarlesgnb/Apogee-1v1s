/**
 * Put the season's scenarios into KovaaK's from a checkout, for playtesting.
 *
 * The app does all of this itself on every launch - the scenarios through
 * `core/season/installScenarios.ts`, which this shares, and the practice playlists - so a
 * player never runs it. This adds only "Apogee S1 Playtest", the families whose mechanism
 * is new.
 *
 * `--remove` takes them out again, and removes only what it can prove it put there: a
 * scenario file the season names or tagged as an Apogee season, and a playlist named with
 * this tool's prefix, current or from the playtest builds. Nothing else is touched.
 *
 *   npx tsx tools/installSeason.ts [--remove] [--to <FPSAimTrainer folder>]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { PLAYLIST_FORMAT_VERSION, serializePlaylist, type KovaaksPlaylist } from "../src/core/match/playlist.ts";
import { installSeasonScenarios, removeSeasonScenarios } from "../src/core/season/installScenarios.ts";
import { kovaaksRoot } from "./scenarioCorpus.ts";
import type { Season } from "../src/core/season/season.ts";

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const toArg = args.indexOf("--to");
const root = toArg >= 0 ? args[toArg + 1] : kovaaksRoot();
if (!root) {
  console.error("No KovaaK's install found. Pass --to <...\\FPSAimTrainer\\FPSAimTrainer>.");
  process.exit(1);
}

const scenariosDir = join(root, "Saved", "SaveGames", "Scenarios");
const playlistsDir = join(root, "Saved", "SaveGames", "Playlists");
const season = JSON.parse(readFileSync(dataFile("seasons", "season-1.json"), "utf8")) as Season;
const PLAYLIST_PREFIX = "Apogee S1 ";
/** The playtest builds' prefix, from when the season was drafted as Season 2. */
const EARLIER_PREFIXES = ["Apogee S2 "];
const playlists: KovaaksPlaylist[] = [];
// No per-category playlists: the app writes those itself ("Apogee Static Clicking Novice",
// "Apogee All Novice"; core/season/practice.ts), and a second copy here under another name
// put every one in the game's list twice. The ones earlier installs wrote are removed below.
// The playtest (docs/season-1.md): the Novice cut of every family changed since the last
// round was played, so each is seen working once before anything else is judged.
const PLAYTEST = ["Gravity Well", "1w6aliens", "Electric", "Satellite", "AlienTrack", "Blastoff", "Orbit", "UFO", "comeTS", "RockeTS"].map((f) => `Apogee ${f} Novice`);
if (PLAYTEST.every((n) => season.scenarios.some((s) => s.scenario === n))) {
  playlists.unshift({
    playlistName: `${PLAYLIST_PREFIX}Playtest`,
    playlistId: 0,
    authorSteamId: "",
    authorName: "",
    scenarioList: PLAYTEST.map((scenario_name) => ({ scenario_name, play_Count: 1 })),
    description: "Apogee Season 1 playtest: every family whose mechanism is new. Check the targets appear, and move and respawn as described.",
    hasOfflineScenarios: true,
    hasEdited: true,
    shareCode: "",
    version: PLAYLIST_FORMAT_VERSION,
    updated: Math.floor(Date.now() / 1000),
    isPrivate: false,
  });
}

const playlistFile = (p: KovaaksPlaylist) => `${p.playlistName}.json`;

/** Playlists this tool wrote that it no longer writes: a renamed family, or a playtest build's. */
function stalePlaylists(): string[] {
  const current = new Set(playlists.map(playlistFile));
  return existsSync(playlistsDir)
    ? readdirSync(playlistsDir).filter(
        (f) => [PLAYLIST_PREFIX, ...EARLIER_PREFIXES].some((p) => f.startsWith(p)) && f.endsWith(".json") && !current.has(f),
      )
    : [];
}

if (remove) {
  const n = removeSeasonScenarios(scenariosDir).length;
  const ours = new Set(playlists.map(playlistFile));
  let p = 0;
  if (existsSync(playlistsDir)) for (const f of readdirSync(playlistsDir)) if (ours.has(f)) { rmSync(join(playlistsDir, f)); p++; }
  for (const f of stalePlaylists()) { rmSync(join(playlistsDir, f)); p++; }
  console.log(`removed ${n} scenario(s) and ${p} playlist(s)`);
  process.exit(0);
}

const result = installSeasonScenarios(scenariosDir);
const oldPlaylists = stalePlaylists();
for (const f of oldPlaylists) rmSync(join(playlistsDir, f));
if (result.removed.length || oldPlaylists.length) {
  console.log(`removed ${result.removed.length} scenario(s) and ${oldPlaylists.length} playlist(s) the season no longer names`);
}
mkdirSync(playlistsDir, { recursive: true });
for (const p of playlists) writeFileSync(join(playlistsDir, playlistFile(p)), serializePlaylist(p));
console.log(`installed ${result.written.length + result.unchanged} scenarios into ${scenariosDir} (${result.written.length} written, ${result.unchanged} already current)`);
console.log(`wrote ${playlists.length} playlists into ${playlistsDir}`);
