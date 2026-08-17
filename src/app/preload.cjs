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
  findMatch: (category, difficulty) =>
    ipcRenderer.invoke("apogee:findMatch", { category, difficulty }),

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
   * Open one of the active match's scenarios in KovaaK's.
   * Main refuses any scenario that is not part of the match.
   */
  launchScenario: (scenario) => ipcRenderer.invoke("apogee:launchScenario", { scenario }),

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

  /** Fires once per quest the moment it completes. */
  onQuestComplete: (handler) => subscribe("apogee:questComplete", handler),

  /** Force a full rescan of the stats folder. */
  rescan: () => ipcRenderer.invoke("apogee:rescan"),

  /** Prompt for a stats folder; returns the chosen path or null. */
  chooseFolder: () => ipcRenderer.invoke("apogee:chooseFolder"),

  /** Reveal the watched folder in the OS file manager. */
  openStatsFolder: () => ipcRenderer.invoke("apogee:openStatsFolder"),

  /** Fires whenever the snapshot is rebuilt. */
  onSnapshot: (handler) => subscribe("apogee:snapshot", handler),

  /** Fires the moment a new run is parsed, before the snapshot rebuild lands. */
  onRun: (handler) => subscribe("apogee:run", handler),

  /** Scanning started or finished. */
  onScanning: (handler) => subscribe("apogee:scanning", handler),

  /** Something went wrong; payload is a human-readable message. */
  onError: (handler) => subscribe("apogee:error", handler),
});
