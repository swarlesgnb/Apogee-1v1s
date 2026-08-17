/**
 * Put a match's scenarios into KovaaK's, and start the game.
 *
 * KovaaK's registers no URL scheme of its own - nothing under HKLM or HKCU Classes
 * answers to kovaaks, fpsaim, aimtrainer or voltaic, while aimlab does. The conclusion
 * first drawn from that, that nothing could deep-link into the game, was wrong: the
 * deep link is Steam's. `steam://run/<appid>//?...` hands its query string to the game
 * as launch arguments, and KovaaK's parses them in
 * USteamEventManager::HandleNewLaunchQueryParameters. Its own format string ships in
 * the binary.
 *
 * So the button does both halves. It jumps straight into the first scenario, and writes
 * the other two as a local playlist, because `jump-to-playlist` keys on a published
 * playlist's share code and Apogee's are local files.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shell } from "electron";

import {
  buildMatchPlaylist,
  isApogeePlaylistFile,
  jumpToScenarioUrl,
  playlistFileName,
  serializePlaylist,
  type MatchPlaylistOptions,
} from "../core/match/playlist.ts";

/** KovaaK's on Steam. Confirmed from the local appmanifest, not remembered. */
export const KOVAAKS_APP_ID = "824270";

/**
 * Where KovaaK's keeps playlists, derived from the stats folder we already track.
 *
 * Both live under the same FPSAimTrainer directory:
 *   ...\FPSAimTrainer\FPSAimTrainer\stats
 *   ...\FPSAimTrainer\FPSAimTrainer\Saved\SaveGames\Playlists
 *
 * Deriving it beats asking the player for a second folder, but it is only a guess about
 * someone else's install layout, so the caller is told when it is not there rather than
 * having a directory invented underneath them.
 */
export function playlistsFolderFor(statsDir: string): string {
  return join(dirname(statsDir), "Saved", "SaveGames", "Playlists");
}

export interface WriteResult {
  ok: boolean;
  path?: string;
  playlistName?: string;
  /** How many of Apogee's earlier playlists were cleared out. */
  removed?: number;
  error?: string;
}

/**
 * Write the match playlist into KovaaK's.
 *
 * Always the same filename, so a second match replaces the first instead of leaving a
 * trail of dead playlists in the player's game.
 */
export function writeMatchPlaylist(
  statsDir: string,
  options: MatchPlaylistOptions,
): WriteResult {
  const folder = playlistsFolderFor(statsDir);

  if (!existsSync(folder)) {
    // Creating it is safe and is what a fresh install looks like before its first
    // playlist, but say so, because the more likely cause is a stats folder that is not
    // where we think it is.
    try {
      mkdirSync(folder, { recursive: true });
    } catch {
      return {
        ok: false,
        error: `could not find or create the KovaaK's playlists folder at ${folder}`,
      };
    }
  }

  try {
    const playlist = buildMatchPlaylist(options);
    const fileName = playlistFileName(playlist);
    const path = join(folder, fileName);

    // Each match carries its own id in the name so the player can tell which playlist
    // is the current one. That trades a fixed name for accumulating files, so our own
    // older ones are removed first.
    //
    // Only files matching the Apogee prefix are touched, and only inside the playlists
    // folder. Deleting in someone else's game directory earns being narrow: a player's
    // own playlists are irreplaceable, and a wrong sweep here is not recoverable.
    const removed = sweepOldPlaylists(folder, fileName);

    writeFileSync(path, serializePlaylist(playlist), "utf8");
    return { ok: true, path, playlistName: playlist.playlistName, removed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete Apogee's previous playlists, keeping the one about to be written.
 *
 * Failures are counted rather than thrown: a leftover playlist is untidy, and refusing
 * to start the match over it would be worse.
 */
function sweepOldPlaylists(folder: string, keep: string): number {
  let removed = 0;

  try {
    for (const file of readdirSync(folder)) {
      if (file === keep || !isApogeePlaylistFile(file)) continue;
      try {
        unlinkSync(join(folder, file));
        removed++;
      } catch {
        // Locked by the running game, most likely. Leave it.
      }
    }
  } catch {
    return removed;
  }

  return removed;
}

/**
 * Ask Steam to start KovaaK's, in a named scenario when one is given.
 *
 * KovaaK's registers no URL scheme of its own - the earlier conclusion that therefore
 * nothing could deep-link into it was wrong. Steam's `run` URL passes its query string
 * through to the game as launch arguments, and KovaaK's reads them. Its own format
 * string, lifted from the shipping binary rather than guessed:
 *
 *     steam://run/%s//?action=jump-to-scenario&name=%s&mode=%s
 *
 * Note the doubled slash after the app id: that is Steam's separator between the id and
 * the arguments, and this is the game's own literal, so it is reproduced exactly.
 *
 * The binary also carries `jump-to-playlist`, which would be the better fit, but the
 * parameter names sitting beside it are `sharecode` and `code`: it opens a *published*
 * playlist by its share code. Apogee writes local playlists (playlistId 0, no share
 * code), so using it would mean publishing every match to KovaaK's servers. Launching
 * the first scenario directly and leaving the playlist on disk for the other two is the
 * better trade.
 */
export async function launchKovaaks(
  scenario?: string | null,
): Promise<{ ok: boolean; jumped: boolean; error?: string }> {
  const url = scenario
    ? jumpToScenarioUrl(KOVAAKS_APP_ID, scenario)
    : `steam://rungameid/${KOVAAKS_APP_ID}`;

  try {
    await shell.openExternal(url);
    return { ok: true, jumped: !!scenario };
  } catch (err) {
    return {
      ok: false,
      jumped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
