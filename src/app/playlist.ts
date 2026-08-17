/**
 * Put a match's scenarios into KovaaK's, and start the game.
 *
 * The gap this closes: KovaaK's registers no URL scheme on Windows. Aim Lab does, which
 * is why one-click "play this scenario" links exist for that and not for this; the
 * KovaaK's sites offering the same thing are really handing over a share code to paste.
 * Checked against the registry rather than assumed: nothing under HKLM or HKCU Classes
 * answers to kovaaks, fpsaim, aimtrainer or voltaic.
 *
 * So the closest honest thing to one button is two steps that need no typing: write the
 * three scenarios as a local playlist, then launch the game through Steam. The player
 * picks "Apogee Match" from their playlist menu instead of searching for scenario names
 * one at a time.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shell } from "electron";

import {
  buildMatchPlaylist,
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
    const path = join(folder, playlistFileName(playlist));
    writeFileSync(path, serializePlaylist(playlist), "utf8");
    return { ok: true, path, playlistName: playlist.playlistName };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ask Steam to start KovaaK's.
 *
 * `steam://rungameid/` is a Steam scheme, not a KovaaK's one, so it can launch the game
 * and nothing more: there is no argument that selects a scenario or a playlist. The
 * playlist has to already be on disk for the player to pick, which is why writing it
 * comes first.
 */
export async function launchKovaaks(): Promise<{ ok: boolean; error?: string }> {
  try {
    await shell.openExternal(`steam://rungameid/${KOVAAKS_APP_ID}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
