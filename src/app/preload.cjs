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

contextBridge.exposeInMainWorld("arena", {
  /** Current state: stats folder, snapshot, error, scanning flag, session. */
  getState: () => ipcRenderer.invoke("arena:getState"),

  /**
   * Start Steam sign-in. Opens the system browser and resolves once a session exists.
   * Returns { session } or { error }; no tokens ever cross this bridge.
   */
  signIn: () => ipcRenderer.invoke("arena:signIn"),

  /** Forget the stored session. */
  signOut: () => ipcRenderer.invoke("arena:signOut"),

  /** Fires when the signed-in player changes, with null on sign-out. */
  onSession: (handler) => subscribe("arena:session", handler),

  /** Sign-in started or finished, for a spinner. */
  onSigningIn: (handler) => subscribe("arena:signingIn", handler),

  /** The sign-in URL, so the user can finish manually if the browser misbehaves. */
  onSignInUrl: (handler) => subscribe("arena:signInUrl", handler),

  // ---- backfill ----------------------------------------------------------
  /** Upload the whole stats folder. Idempotent; safe to run repeatedly. */
  uploadHistory: () => ipcRenderer.invoke("arena:uploadHistory"),
  onUploading: (handler) => subscribe("arena:uploading", handler),
  onUploadProgress: (handler) => subscribe("arena:uploadProgress", handler),

  // ---- matches -----------------------------------------------------------
  /** Ask the server for an opponent. Returns { match } or { error }. */
  findMatch: (category, difficulty) =>
    ipcRenderer.invoke("arena:findMatch", { category, difficulty }),

  /** Abandon the active match locally. */
  cancelMatch: () => ipcRenderer.invoke("arena:cancelMatch"),

  /** Settle now, rather than waiting for the last run to land. */
  settleMatch: () => ipcRenderer.invoke("arena:settleMatch"),

  /** Fires when a match starts, and again with null when it ends. */
  onMatch: (handler) => subscribe("arena:match", handler),

  /** Per-scenario progress as runs are submitted and verified. */
  onMatchProgress: (handler) => subscribe("arena:matchProgress", handler),

  /** The settled result, including the rating change. */
  onMatchSettled: (handler) => subscribe("arena:matchSettled", handler),

  // ---- standing ----------------------------------------------------------
  getStanding: () => ipcRenderer.invoke("arena:getStanding"),
  onStanding: (handler) => subscribe("arena:standing", handler),

  // ---- quests ------------------------------------------------------------
  /** Lifetime XP and account level, sent after every snapshot rebuild. */
  onProgression: (handler) => subscribe("arena:progression", handler),

  /** Fires once per quest the moment it completes. */
  onQuestComplete: (handler) => subscribe("arena:questComplete", handler),

  /** Force a full rescan of the stats folder. */
  rescan: () => ipcRenderer.invoke("arena:rescan"),

  /** Prompt for a stats folder; returns the chosen path or null. */
  chooseFolder: () => ipcRenderer.invoke("arena:chooseFolder"),

  /** Reveal the watched folder in the OS file manager. */
  openStatsFolder: () => ipcRenderer.invoke("arena:openStatsFolder"),

  /** Fires whenever the snapshot is rebuilt. */
  onSnapshot: (handler) => subscribe("arena:snapshot", handler),

  /** Fires the moment a new run is parsed, before the snapshot rebuild lands. */
  onRun: (handler) => subscribe("arena:run", handler),

  /** Scanning started or finished. */
  onScanning: (handler) => subscribe("arena:scanning", handler),

  /** Something went wrong; payload is a human-readable message. */
  onError: (handler) => subscribe("arena:error", handler),
});
