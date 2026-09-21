/**
 * Preload bridge.
 *
 * The renderer runs with contextIsolation on and no Node access, so this file defines
 * the entire surface it can reach. Everything here is an explicit, named capability.
 * There is no general "invoke any channel" escape hatch, because a renderer that can
 * call arbitrary IPC is a renderer that can be talked into anything by injected script.
 *
 * CommonJS by design: Electron preload scripts are not ES modules.
 */

const { contextBridge, ipcRenderer } = require("electron");

/** Wrap a main-process event so listeners can be removed cleanly. */
function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("apogee", {
  /** Current state: stats folder, snapshot, error, scanning flag, session. */
  getState: () => ipcRenderer.invoke("apogee:getState"),
  expedition: () => ipcRenderer.invoke("apogee:expedition"),
  expeditionAction: (action) => ipcRenderer.invoke("apogee:expeditionAction", action),
  onExpedition: (handler) => subscribe("apogee:expedition", handler),

  /**
   * Start Steam sign-in. Opens the system browser and resolves once a session exists.
   * Returns { session } or { error }; no tokens ever cross this bridge.
   */
  signIn: () => ipcRenderer.invoke("apogee:signIn"),

  /** Forget the stored session. */
  signOut: () => ipcRenderer.invoke("apogee:signOut"),

  /** Fires when the signed-in player changes, with null on sign-out. */
  onSession: (handler) => subscribe("apogee:session", handler),

  /** Sign-in started or finished, for a spinner. */
  onSigningIn: (handler) => subscribe("apogee:signingIn", handler),

  /** The sign-in URL, so the user can finish manually if the browser misbehaves. */
  onSignInUrl: (handler) => subscribe("apogee:signInUrl", handler),

  // ---- backfill ----------------------------------------------------------
  /** Upload the whole stats folder. Idempotent; safe to run repeatedly. */
  uploadHistory: () => ipcRenderer.invoke("apogee:uploadHistory"),
  onUploading: (handler) => subscribe("apogee:uploading", handler),
  onUploadProgress: (handler) => subscribe("apogee:uploadProgress", handler),

  // ---- matches -----------------------------------------------------------
  /** Ask the server for an opponent. Returns { match } or { error }. */
  findMatch: (category, pool) => ipcRenderer.invoke("apogee:findMatch", { category, pool }),

  /**
   * Derive thresholds for a scenario from its KovaaK's leaderboard.
   * Samples the board if it is not already cached. Admin only.
   */
  sampleScenario: (scenario, leaderboardId, topFractions) =>
    ipcRenderer.invoke("apogee:sampleScenario", { scenario, leaderboardId, topFractions }),

  /** Search KovaaK's scenario catalogue by name. Admin only. */
  searchScenarios: (query) => ipcRenderer.invoke("apogee:searchScenarios", { query }),

  /** Population share per rank for the season being edited. Admin only. */
  rankDistribution: (season) => ipcRenderer.invoke("apogee:rankDistribution", { season }),

  /** Re-derive a window's thresholds from new percentiles. Admin only. */
  deriveWindow: (scenarios, topFractions) =>
    ipcRenderer.invoke("apogee:deriveWindow", { scenarios, topFractions }),

  /** Abandon the active match locally. */
  cancelMatch: () => ipcRenderer.invoke("apogee:cancelMatch"),

  /** Settle now, rather than waiting for the last run to land. */
  settleMatch: () => ipcRenderer.invoke("apogee:settleMatch"),

  /**
   * Write the match as a KovaaK's playlist and launch the game.
   * Returns { ok, playlistName, launched } or { error }.
   */
  launchMatch: () => ipcRenderer.invoke("apogee:launchMatch"),

  /**
   * Open one scenario in KovaaK's - a match scenario, or anything the season names.
   * Main refuses anything in neither, so this cannot be pointed at arbitrary text.
   */
  launchScenario: (scenario) => ipcRenderer.invoke("apogee:launchScenario", { scenario }),

  /**
   * The whole season pool measured against local history: every scenario, every window,
   * personal best, which rank it reaches and what the next one costs on it.
   * Returns { season, scenarios, playlists, playlistDir, installed } or { error }.
   */
  practice: () => ipcRenderer.invoke("apogee:practice"),

  /**
   * The apex board: how deep into the top of each graded scenario's leaderboard the
   * local history sits, past where the ladder stops measuring.
   * Returns { season, points, graded, total, categories } or { error }.
   */
  apex: () => ipcRenderer.invoke("apogee:apex"),

  /**
   * The public apex board for one category, with the caller refreshed onto it first.
   * Returns { category, population, entries, you, refreshed } or { error }.
   */
  apexBoard: (category) => ipcRenderer.invoke("apogee:apexBoard", { category }),

  /**
   * Write the season's practice playlists into KovaaK's own Playlists folder. Pass an
   * array of names for a subset; omit it for all of them.
   * Returns { ok, dir, written, installed, note } or { error }.
   */
  installPlaylists: (names) => ipcRenderer.invoke("apogee:installPlaylists", { names }),

  /** Fires when a match starts, and again with null when it ends. */
  onMatch: (handler) => subscribe("apogee:match", handler),

  /** Per-scenario progress as runs are submitted and verified. */
  onMatchProgress: (handler) => subscribe("apogee:matchProgress", handler),

  /** The settled result, including the rating change. */
  onMatchSettled: (handler) => subscribe("apogee:matchSettled", handler),

  // ---- standing ----------------------------------------------------------
  getStanding: () => ipcRenderer.invoke("apogee:getStanding"),
  onStanding: (handler) => subscribe("apogee:standing", handler),

  // ---- quests ------------------------------------------------------------
  /** Lifetime XP and account level, sent after every snapshot rebuild. */
  onProgression: (handler) => subscribe("apogee:progression", handler),

  /** Fires once per quest the moment it completes, and once for clearing the board. */
  onQuestComplete: (handler) => subscribe("apogee:questComplete", handler),

  /** Swap one of today's quests for its slot's spare. Once a day. Returns { ok } or { error }. */
  rerollQuest: (id) => ipcRenderer.invoke("apogee:rerollQuest", { id }),

  /**
   * Whether this account has uploaded enough runs to queue, and how many more it needs.
   * Null when signed out. The readout only - find-match checks again server-side.
   */
  queueEligibility: () => ipcRenderer.invoke("apogee:queueEligibility"),

  /** Fires when the uploaded-run count changes, so the readout follows a backfill. */
  onEligibility: (handler) => subscribe("apogee:eligibility", handler),

  /** Force a full rescan of the stats folder. */
  rescan: () => ipcRenderer.invoke("apogee:rescan"),

  /** Prompt for a stats folder; returns the chosen path or null. */
  chooseFolder: () => ipcRenderer.invoke("apogee:chooseFolder"),

  /** Reveal the watched folder in the OS file manager. */
  openStatsFolder: () => ipcRenderer.invoke("apogee:openStatsFolder"),

  /** Pasteable support text: build, folder, run count. Never anything private. */
  diagnostics: () => ipcRenderer.invoke("apogee:diagnostics"),

  // ---- duels -------------------------------------------------------------
  /** The inbox, what you sent, who else plays, and your shortlist. */
  duels: () => ipcRenderer.invoke("apogee:duels"),

  /**
   * Challenge a named player. Creates your own match, which you play before they can
   * answer, so this hands back a match exactly as findMatch does.
   */
  sendDuel: (to, category, pool) =>
    ipcRenderer.invoke("apogee:sendDuel", { to, category, pool }),

  /** Accept, decline, or take back one you sent. Accepting starts a rated match. */
  answerDuel: (duelId, action) =>
    ipcRenderer.invoke("apogee:answerDuel", { duelId, action }),

  /** Add or remove somebody from your shortlist. */
  setFriend: (playerId, friend) =>
    ipcRenderer.invoke("apogee:setFriend", { playerId, friend }),

  /** Fires when the duel board changes, and with null on sign-out. */
  onDuels: (handler) => subscribe("apogee:duels", handler),

  // ---- tournaments -------------------------------------------------------
  //
  // One method per action rather than a general "tournament action" call. Each one names
  // exactly the fields it sends, so nothing the page puts in an object reaches the server
  // unless this file already decided it should - and there is no method here that sends a
  // result, because results come from settled matches and nowhere else.

  /** The list, and one in full if an id is given. Returns { tournaments, view } or { error }. */
  tournaments: (tournamentId) => ipcRenderer.invoke("apogee:tournaments", { tournamentId }),

  createTournament: (s) =>
    ipcRenderer.invoke("apogee:tournamentAction", {
      action: "create",
      name: s.name,
      category: s.category,
      window: s.window,
      groupCount: s.groupCount,
      groupSize: s.groupSize,
      qualifiers: s.qualifiers,
      seeding: s.seeding,
    }),
  joinTournament: (tournamentId) =>
    ipcRenderer.invoke("apogee:tournamentAction", { action: "join", tournamentId }),
  leaveTournament: (tournamentId) =>
    ipcRenderer.invoke("apogee:tournamentAction", { action: "leave", tournamentId }),
  checkIn: (tournamentId, checkedIn) =>
    ipcRenderer.invoke("apogee:tournamentAction", { action: "check-in", tournamentId, checkedIn }),
  /** Host only; refused server-side for anybody else. */
  removeEntrant: (tournamentId, playerId) =>
    ipcRenderer.invoke("apogee:tournamentAction", { action: "remove", tournamentId, playerId }),
  /** Host only. `revision` is the one the host was shown, so a changed roster is refused. */
  startTournament: (tournamentId, revision) =>
    ipcRenderer.invoke("apogee:tournamentAction", { action: "start", tournamentId, revision }),
  /** Host only. Terminal. */
  cancelTournament: (tournamentId, reason) =>
    ipcRenderer.invoke("apogee:tournamentAction", { action: "cancel", tournamentId, reason }),

  /** Open your leg of a fixture. Hands back a match exactly as findMatch does. */
  playFixture: (tournamentId, fixtureId, attempt) =>
    ipcRenderer.invoke("apogee:playFixture", { tournamentId, fixtureId, attempt }),

  /** Fires when the tournament list changes, and with null on sign-out. */
  onTournaments: (handler) => subscribe("apogee:tournaments", handler),

  /** Whether the signed-in player holds the admin role. Gates the editors, nothing else. */
  isAdmin: () => ipcRenderer.invoke("apogee:isAdmin"),

  /**
   * This machine's look-and-copy overrides.
   *
   * Reading is open, because the app has to be painted before there is a session to
   * check. Every write below re-checks the role in main, so the hidden tab is a
   * convenience rather than the thing keeping anybody out.
   */
  adminOverrides: () => ipcRenderer.invoke("apogee:adminOverrides"),
  saveAdminOverrides: (overrides) =>
    ipcRenderer.invoke("apogee:saveAdminOverrides", { overrides }),
  resetAdminOverrides: () => ipcRenderer.invoke("apogee:resetAdminOverrides"),
  exportAdminOverrides: () => ipcRenderer.invoke("apogee:exportAdminOverrides"),
  importAdminOverrides: () => ipcRenderer.invoke("apogee:importAdminOverrides"),

  /** The season definition currently on disk. */
  getSeason: () => ipcRenderer.invoke("apogee:getSeason"),

  /**
   * The rating ladder - `data/apogee_ranks.json` - which is a different file from the
   * season and paints the accent colour, the header, the hero and the Ranks page.
   */
  getRankTheme: () => ipcRenderer.invoke("apogee:getRankTheme"),
  saveRankTheme: (theme, fingerprint, force) =>
    ipcRenderer.invoke("apogee:saveRankTheme", { theme, fingerprint, force }),

  /** Scenarios that could be added, with a suggested category and thresholds. */
  availableScenarios: () => ipcRenderer.invoke("apogee:availableScenarios"),

  /**
   * Write the season back and rebuild from it.
   * Main validates before writing and refuses a non-admin.
   */
  /**
   * `fingerprint` is what `getSeason` reported when this draft was loaded. Main refuses
   * the write if the files have moved on since, rather than putting them back.
   */
  saveSeason: (season, fingerprint, force) =>
    ipcRenderer.invoke("apogee:saveSeason", { season, fingerprint, force }),

  /** Fires whenever the snapshot is rebuilt. */
  onSnapshot: (handler) => subscribe("apogee:snapshot", handler),

  /**
   * Fires after the season on disk has been rewritten by the editor.
   *
   * Separate from `onSnapshot` because a snapshot is not always sent: it needs a stats
   * folder with runs in it, and the season can be edited without either.
   */
  onSeasonChanged: (handler) => subscribe("apogee:seasonChanged", handler),

  /** Fires the moment a new run is parsed, before the snapshot rebuild lands. */
  onRun: (handler) => subscribe("apogee:run", handler),
  onBenchmarkPromotion: (handler) => subscribe("apogee:benchmarkPromotion", handler),

  /** Scanning started or finished. */
  onScanning: (handler) => subscribe("apogee:scanning", handler),

  /** Something went wrong; payload is a human-readable message. */
  onError: (handler) => subscribe("apogee:error", handler),
});
