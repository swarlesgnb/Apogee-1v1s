/**
 * Build a KovaaK's playlist for a match.
 *
 * KovaaK's keeps playlists as plain JSON under Saved/SaveGames/Playlists, and reads
 * whatever it finds there, so a match can be handed to the player as a playlist rather
 * than as three scenario names to search for by hand. The shape below is taken from a
 * real locally-authored playlist on disk, not from documentation:
 *
 *   playlistId 0 with an empty author is what marks a playlist as local. A workshop
 *   playlist carries a real id, an authorSteamId, and a shareCode; writing those on
 *   something we invented would be claiming to be a published playlist.
 *
 *   version 31 is the file format, not a revision counter. Both the local playlist and
 *   the subscribed Voltaic one carry 31.
 *
 * play_Count is 1 for each scenario, which matches how a match is scored: one attempt
 * each, and only the first counts (PLAN.md §3). The playlist is a convenience, though,
 * never the rule. Settlement reads run timestamps and would reach the same verdict if
 * the player ignored the playlist entirely and launched the three scenarios by hand,
 * which is the only safe assumption about a file living in a folder the player owns.
 *
 * Pure: no filesystem, no Electron. Writing it out is the caller's job.
 */

/** Fixed format version KovaaK's writes on every playlist file. */
const PLAYLIST_FORMAT_VERSION = 31;

/**
 * One name for every match, so playing a second match replaces the first rather than
 * leaving a drift of dead playlists in the player's game.
 */
export const MATCH_PLAYLIST_NAME = "Apogee Match";

export interface PlaylistEntry {
  scenario_name: string;
  play_Count: number;
}

export interface KovaaksPlaylist {
  playlistName: string;
  playlistId: number;
  authorSteamId: string;
  authorName: string;
  scenarioList: PlaylistEntry[];
  description: string;
  hasOfflineScenarios: boolean;
  hasEdited: boolean;
  shareCode: string;
  version: number;
  updated: number;
  isPrivate: boolean;
}

export interface MatchPlaylistOptions {
  scenarios: string[];
  /** Shown inside KovaaK's, and the only trace of which match this belonged to. */
  matchId?: string;
  opponent?: string | null;
  now?: Date;
}

export function buildMatchPlaylist(options: MatchPlaylistOptions): KovaaksPlaylist {
  const { scenarios, matchId, opponent, now = new Date() } = options;

  if (scenarios.length === 0) {
    throw new Error("a playlist needs at least one scenario");
  }

  const against = opponent ? ` vs ${opponent}` : "";
  const ref = matchId ? ` (${matchId.slice(0, 8)})` : "";

  return {
    playlistName: MATCH_PLAYLIST_NAME,
    playlistId: 0,
    authorSteamId: "",
    authorName: "",
    scenarioList: scenarios.map((scenario_name) => ({ scenario_name, play_Count: 1 })),
    description:
      `Apogee ranked match${against}${ref}. ` +
      `Play each scenario once, in order. Only your first run on each counts.`,
    hasOfflineScenarios: false,
    hasEdited: true,
    shareCode: "",
    version: PLAYLIST_FORMAT_VERSION,
    updated: Math.floor(now.getTime() / 1000),
    isPrivate: false,
  };
}

/**
 * KovaaK's writes these files tab-indented, and a playlist the player might open in a
 * text editor should not look like it came from somewhere else.
 */
export function serializePlaylist(playlist: KovaaksPlaylist): string {
  return JSON.stringify(playlist, null, "\t") + "\n";
}

/**
 * Filename for a playlist. KovaaK's keys on the file's own playlistName, but the
 * filename is what the player sees on disk, so it matches.
 *
 * Anything the filesystem could object to is stripped rather than escaped: scenario
 * and playlist names come from data, and a name that produced a path separator would
 * write outside the playlists folder.
 */
export function playlistFileName(playlist: KovaaksPlaylist): string {
  const safe = playlist.playlistName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
  return `${safe || "Apogee Match"}.json`;
}
