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
 * KovaaK's deep link, copied from the format string in its own shipping binary:
 *
 *     steam://run/%s//?action=jump-to-scenario&name=%s&mode=%s
 *
 * The doubled slash is Steam's separator between the app id and the arguments it hands
 * to the game, and this is the game's literal, so it is reproduced rather than tidied.
 * KovaaK's registers no scheme of its own; the deep link is Steam's, which is why
 * scanning the registry for one found nothing and proved nothing.
 *
 * `mode` is challenge or freeplay. Matches are always challenge: freeplay does not
 * produce a scored run.
 */
export function jumpToScenarioUrl(appId: string, scenario: string): string {
  return (
    `steam://run/${appId}//?action=jump-to-scenario` +
    `&name=${encodeURIComponent(scenario)}&mode=challenge`
  );
}

/**
 * Prefix every Apogee playlist carries. Also what identifies our own leftovers as safe
 * to delete, so nothing the player made themselves is ever touched.
 */
export const MATCH_PLAYLIST_PREFIX = "Apogee Match";

/**
 * Characters of the match id to put in the name.
 *
 * A fixed name was the first attempt and it is not enough: the playlist menu gives no
 * indication of when a file changed, so two matches in a row look identical and there
 * is no way to tell you are about to play the previous one. Eight hex characters make
 * them distinguishable at a glance while staying short enough to read in a menu.
 */
const MATCH_ID_CHARS = 8;

/** Playlist name for a match, e.g. "Apogee Match 81a618a2". */
export function matchPlaylistName(matchId?: string): string {
  const short = matchId ? matchId.replace(/[^a-zA-Z0-9]/g, "").slice(0, MATCH_ID_CHARS) : "";
  return short ? `${MATCH_PLAYLIST_PREFIX} ${short}` : MATCH_PLAYLIST_PREFIX;
}

/** True for a playlist Apogee wrote, and therefore may delete. */
export function isApogeePlaylistFile(fileName: string): boolean {
  return fileName.startsWith(MATCH_PLAYLIST_PREFIX) && fileName.endsWith(".json");
}

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
    playlistName: matchPlaylistName(matchId),
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
  return `${safe || MATCH_PLAYLIST_PREFIX}.json`;
}
