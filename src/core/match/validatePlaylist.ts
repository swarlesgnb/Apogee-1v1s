/**
 * Check the playlist we write against the ones KovaaK's writes.
 *
 * The format is undocumented and was read off a real local playlist, so the risk is not
 * that the code is wrong today but that the shape drifts and nobody notices until a
 * player's game silently ignores the file. The key set below is copied from
 * "Goat warmup.json", a playlist KovaaK's itself authored:
 *
 *   Saved/SaveGames/Playlists/Goat warmup.json
 *
 * If an install is present the real files are compared too, which is what would catch
 * KovaaK's changing the format. When it is absent the embedded reference still runs, so
 * this is not a test that only works on one machine.
 *
 *   npx tsx src/core/match/validatePlaylist.ts [kovaaksPlaylistsFolder]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildMatchPlaylist,
  MATCH_PLAYLIST_PREFIX,
  matchPlaylistName,
  isApogeePlaylistFile,
  jumpToScenarioUrl,
  playlistFileName,
  serializePlaylist,
} from "./playlist.ts";

const DEFAULT_PLAYLISTS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\Saved\\SaveGames\\Playlists";

/** Every key a KovaaK's-authored local playlist carries, in its own order. */
const REFERENCE_KEYS = [
  "playlistName",
  "playlistId",
  "authorSteamId",
  "authorName",
  "scenarioList",
  "description",
  "hasOfflineScenarios",
  "hasEdited",
  "shareCode",
  "version",
  "updated",
  "isPrivate",
];

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const SCENARIOS = [
  "VT Pasu Intermediate S5",
  "VT Popcorn Intermediate S5",
  "VT Frogtagon Intermediate S5",
];

function shape(): void {
  console.log("── the playlist we write ────────────────────────");

  const p = buildMatchPlaylist({
    scenarios: SCENARIOS,
    matchId: "3f9a21c4-0b5e-4d77-9a11-8c2de4f10b93",
    opponent: "Watchmojo",
  });

  check("carries exactly KovaaK's keys, in order", JSON.stringify(Object.keys(p)) === JSON.stringify(REFERENCE_KEYS), Object.keys(p).join(", "));
  check("is marked local, not published", p.playlistId === 0 && p.authorSteamId === "" && p.shareCode === "");
  check("holds every scenario, in order", JSON.stringify(p.scenarioList.map((s) => s.scenario_name)) === JSON.stringify(SCENARIOS));
  check("asks for one play each", p.scenarioList.every((s) => s.play_Count === 1));
  check("declares the format version", p.version === 31);
  check("stamps seconds, not milliseconds", p.updated > 1_600_000_000 && p.updated < 4_000_000_000, String(p.updated));
  check("names the opponent in the description", p.description.includes("Watchmojo"));
  check("says only the first run counts", /first run/i.test(p.description));

  check("round-trips through JSON", JSON.stringify(JSON.parse(serializePlaylist(p))) === JSON.stringify(p));
  check("is tab-indented like KovaaK's own files", serializePlaylist(p).includes('\n\t"playlistName"'));

  // The match id is in the name so two matches in a row are distinguishable in a menu
  // that shows nothing else about them.
  check("carries the match id in its name", p.playlistName === "Apogee Match 3f9a21c4", p.playlistName);
  check("names the file after the playlist", playlistFileName(p) === "Apogee Match 3f9a21c4.json", playlistFileName(p));
  check("two matches get two names", matchPlaylistName("aaaaaaaa-1111") !== matchPlaylistName("bbbbbbbb-2222"));

  const named = buildMatchPlaylist({ scenarios: SCENARIOS });
  check("falls back to the bare prefix without an id", playlistFileName(named) === `${MATCH_PLAYLIST_PREFIX}.json`, playlistFileName(named));

  // The sweep deletes by this test, so a false positive here deletes a player's own
  // playlist. It has to be exact.
  check("recognises its own files", isApogeePlaylistFile("Apogee Match 3f9a21c4.json") && isApogeePlaylistFile("Apogee Match.json"));
  check("leaves the player's playlists alone", !isApogeePlaylistFile("Goat warmup.json") && !isApogeePlaylistFile("Viscose Benchmark S2 - Medium.json") && !isApogeePlaylistFile("My Apogee Match.json"));
  check("ignores non-playlist files", !isApogeePlaylistFile("Apogee Match 3f9a21c4.txt"));

  // A scenario list is data, and data that reached a path separator would write outside
  // the playlists folder entirely.
  const hostile = { ...named, playlistName: "../../evil/Apogee" };
  check("cannot escape the playlists folder", !playlistFileName(hostile).includes("/") && !playlistFileName(hostile).includes("\\"), playlistFileName(hostile));

  let threw = false;
  try {
    buildMatchPlaylist({ scenarios: [] });
  } catch {
    threw = true;
  }
  check("refuses to write an empty playlist", threw);

  // ---- the deep link ---------------------------------------------------------------
  //
  // Asserted literally against the format string in KovaaK's shipping binary:
  //   steam://run/%s//?action=jump-to-scenario&name=%s&mode=%s
  // A typo here fails silently - Steam launches the game and the game ignores an
  // argument it does not recognise - so it is pinned rather than eyeballed.
  const url = jumpToScenarioUrl("824270", "VT Pasu Intermediate S5");
  check(
    "the deep link matches the game's own format string",
    url === "steam://run/824270//?action=jump-to-scenario&name=VT%20Pasu%20Intermediate%20S5&mode=challenge",
    url,
  );
  check("the app id separator is a doubled slash", url.includes("/824270//?action="));
  check("scenario names are encoded, not pasted", jumpToScenarioUrl("1", "a&b=c").includes("a%26b%3Dc"));
  check("matches launch in challenge mode, never freeplay", url.endsWith("&mode=challenge"));
}

function againstRealFiles(dir: string): void {
  console.log("\n── against KovaaK's own playlists ───────────────");

  if (!existsSync(dir)) {
    console.log(`  skipped: no playlists folder at ${dir}`);
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("  skipped: no playlists on this machine");
    return;
  }

  let compared = 0;
  const missing = new Set<string>();
  const extra = new Set<string>();

  for (const file of files) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (isApogeePlaylistFile(file)) continue; // one we wrote

    compared++;
    for (const key of REFERENCE_KEYS) if (!(key in parsed)) missing.add(`${key} (${file})`);
    for (const key of Object.keys(parsed)) if (!REFERENCE_KEYS.includes(key)) extra.add(key);
  }

  check(`every real playlist has the keys we write`, missing.size === 0, missing.size ? [...missing].join(", ") : `${compared} playlists`);

  // Extra keys are not a failure. KovaaK's may add fields, and a playlist we write
  // without them still loads; this only says so out loud rather than silently.
  if (extra.size > 0) {
    console.log(`  note: KovaaK's also writes ${[...extra].join(", ")}, which we omit`);
  }
}

function main(): void {
  shape();
  againstRealFiles(process.argv[2] ?? DEFAULT_PLAYLISTS_DIR);

  console.log(failures === 0 ? "\nOK: playlist format validated" : `\n${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main();
