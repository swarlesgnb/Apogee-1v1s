/**
 * Put season 2's scenarios into KovaaK's, so they can be played before they are shared.
 *
 * Copies every file in data/season-2/scenarios into the game's own scenario folder, writes
 * "Apogee S2 Playtest" (one scenario per template, the first playtest), and one playlist
 * per category and band - "Apogee S2 Static Clicking Novice", six
 * scenarios, one per family, in the season's family order - into its playlists folder.
 * They appear under the game's offline scenarios and playlists.
 *
 * `--remove` takes them out again, and removes only what it can prove it put there: a
 * scenario file whose name is one of season 2's, and a playlist whose name is one this
 * tool writes. Nothing else in either folder is touched.
 *
 * Playing them locally is not the same as ranking them. A ranked run is verified against
 * KovaaK's own servers (PLAN.md §5), and a scenario only has a board there once it has
 * been shared from inside the game; see docs/season-2.md.
 *
 *   npx tsx tools/installSeason2.ts [--remove] [--to <FPSAimTrainer folder>]
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { PLAYLIST_FORMAT_VERSION, serializePlaylist, type KovaaksPlaylist } from "../src/core/match/playlist.ts";
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
const source = dataFile("season-2", "scenarios");
const season = JSON.parse(readFileSync(dataFile("seasons", "season-2.json"), "utf8")) as Season;
const files = readdirSync(source).filter((f) => f.endsWith(".sce"));

const PLAYLIST_PREFIX = "Apogee S2 ";
const playlists: KovaaksPlaylist[] = [];
for (const category of season.categories) {
  for (const [band, bandName] of (season.windows ?? []).entries()) {
    const scenarios = season.scenarios.filter((s) => s.category === category.name && s.window === band).map((s) => s.scenario);
    if (!scenarios.length) continue;
    playlists.push({
      playlistName: `${PLAYLIST_PREFIX}${category.name} ${bandName}`,
      playlistId: 0,
      authorSteamId: "",
      authorName: "",
      scenarioList: scenarios.map((scenario_name) => ({ scenario_name, play_Count: 1 })),
      description: `Apogee Season 2, ${category.name}, ${bandName}: one scenario from each family, once each.`,
      hasOfflineScenarios: true,
      hasEdited: true,
      shareCode: "",
      version: PLAYLIST_FORMAT_VERSION,
      updated: Math.floor(Date.now() / 1000),
      isPrivate: false,
    });
  }
}
// The first playtest (docs/season-2.md): one Novice scenario per template, in the order the
// list gives, so every kind of generated file is loaded once before anything else is judged.
const PLAYTEST = ["Meridian", "Drift", "Hopper", "Glide", "Lift", "Relay", "Swarm"].map((f) => `Apogee ${f} Novice`);
if (PLAYTEST.every((n) => season.scenarios.some((s) => s.scenario === n))) {
  playlists.unshift({
    playlistName: `${PLAYLIST_PREFIX}Playtest`,
    playlistId: 0,
    authorSteamId: "",
    authorName: "",
    scenarioList: PLAYTEST.map((scenario_name) => ({ scenario_name, play_Count: 1 })),
    description: "Apogee Season 2 first playtest: one scenario from each template. Check the room loads, the targets appear, and they move as described.",
    hasOfflineScenarios: true,
    hasEdited: true,
    shareCode: "",
    version: PLAYLIST_FORMAT_VERSION,
    updated: Math.floor(Date.now() / 1000),
    isPrivate: false,
  });
}

const playlistFile = (p: KovaaksPlaylist) => `${p.playlistName}.json`;

if (remove) {
  const ours = new Set(files);
  const ourPlaylists = new Set(playlists.map(playlistFile));
  let n = 0;
  if (existsSync(scenariosDir)) for (const f of readdirSync(scenariosDir)) if (ours.has(f)) { rmSync(join(scenariosDir, f)); n++; }
  let p = 0;
  if (existsSync(playlistsDir)) for (const f of readdirSync(playlistsDir)) if (ourPlaylists.has(f)) { rmSync(join(playlistsDir, f)); p++; }
  console.log(`removed ${n} scenario(s) and ${p} playlist(s)`);
  process.exit(0);
}

mkdirSync(scenariosDir, { recursive: true });
mkdirSync(playlistsDir, { recursive: true });
for (const f of files) copyFileSync(join(source, f), join(scenariosDir, f));
for (const p of playlists) writeFileSync(join(playlistsDir, playlistFile(p)), serializePlaylist(p));
console.log(`installed ${files.length} scenarios into ${scenariosDir}`);
console.log(`wrote ${playlists.length} playlists into ${playlistsDir}`);
