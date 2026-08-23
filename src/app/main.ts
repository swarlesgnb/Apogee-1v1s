/**
 * Apogee desktop client: the Electron main process.
 *
 * Responsibilities, and deliberately nothing else:
 *   - find the KovaaK's stats folder
 *   - watch it, and rebuild the player snapshot when a run lands
 *   - serve that snapshot to the renderer over a narrow IPC surface
 *
 * All parsing and computation happens here rather than in the renderer, which keeps
 * the renderer a pure view. That mirrors the server-side rule from PLAN.md Â§7: the
 * layer that can be tampered with is never the layer that decides anything.
 */

import { app, BrowserWindow, ipcMain, screen, shell, dialog } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile, setDataDir, sourceDataDir } from "../core/dataDir.ts";
import {
  levelFor,
  reconcile,
  type QuestProgressState,
  type QuestSnapshot,
} from "../core/quests/progression.ts";
import { loadQuestState, saveQuestState } from "./questStore.ts";
import { buildSnapshot, type Snapshot } from "../core/report/snapshot.ts";
import { renderRankSheet } from "../core/report/rankSheet.ts";
import { scanStatsFolder } from "../core/history/history.ts";
import { signInWithSteam } from "../core/sync/steamAuth.ts";
import {
  fetchUploadedRuns,
  fetchStanding,
  abandonMatch,
  fetchActiveMatch,
  findMatch,
  isAdmin,
  refreshBaselines,
  settleMatch,
  submitRun,
  uploadBackfill,
  type FoundMatch,
} from "./api.ts";
import {
  isConfigured,
  restoreSession,
  signIn,
  signOut,
  type ApogeeSession,
} from "./session.ts";
import { findStatsFolder, watchStatsFolder, type StatsWatcher } from "./watcher.ts";
import { loadSettings, saveSettings, settingsPath, type WindowBounds } from "./settings.ts";
import { installMenu } from "./menu.ts";
import { launchKovaaks, writeMatchPlaylist } from "./playlist.ts";
import { loadSeason, seasonPath, validateSeason } from "../core/season/season.ts";
import { queueEligibility, type QueueEligibility } from "../core/match/eligibility.ts";
import { sampleDistribution, RateLimited } from "../core/season/sampleLeaderboard.ts";
import { thresholdsFrom, type Distribution } from "../core/season/percentiles.ts";
import { rankDistribution } from "../core/season/distribution.ts";

/**
 * Bundled to dist/app/main.cjs, so `__dirname` is dist/app and the reference data
 * copied by the build sits at dist/data. Told explicitly rather than discovered,
 * because a packaged app has no meaningful working directory.
 */
const here = __dirname;
setDataDir(join(here, "..", "data"));

/**
 * When this bundle was built. Replaced at build time by esbuild's `define`.
 *
 * Printed at startup, and again whenever a second launch is refused, because the
 * single-instance lock makes a stale process very hard to spot: `npm start` with a window
 * already open quits the new process and focuses the old one, so the app appears to
 * restart while running the previous bundle.
 */
declare const __APOGEE_BUILD__: string;
const BUILD = typeof __APOGEE_BUILD__ === "string" ? __APOGEE_BUILD__ : "dev";

/** Rebuilding scans the whole folder, so coalesce bursts of runs into one rebuild. */
const REBUILD_DEBOUNCE_MS = 1200;

interface State {
  statsDir: string | null;
  snapshot: Snapshot | null;
  lastError: string | null;
  scanning: boolean;
  session: ApogeeSession | null;
  signingIn: boolean;
  /** The match the player is currently playing, if any. */
  match: FoundMatch | null;
  /** Scenario ids of the active match already submitted, so runs are not sent twice. */
  submitted: Set<number>;
  uploading: boolean;
  /** Quest completions and lifetime XP, persisted between launches. */
  quests: QuestProgressState | null;
}

const state: State = {
  statsDir: null,
  snapshot: null,
  lastError: null,
  scanning: false,
  session: null,
  signingIn: false,
  match: null,
  submitted: new Set(),
  uploading: false,
  quests: null,
};

let window: BrowserWindow | null = null;
let watcher: StatsWatcher | null = null;
let rebuildTimer: NodeJS.Timeout | null = null;

function broadcast(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function rebuild(reason: string): void {
  if (!state.statsDir) return;

  state.scanning = true;
  broadcast("apogee:scanning", { scanning: true, reason });

  try {
    const snapshot = buildSnapshot({ statsDir: state.statsDir });
    if (snapshot) {
      state.snapshot = snapshot;
      state.lastError = null;
      broadcast("apogee:snapshot", snapshot);
      checkQuestCompletions(snapshot);
    } else {
      state.lastError = "No runs found in the stats folder yet.";
      broadcast("apogee:error", state.lastError);
    }
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    broadcast("apogee:error", state.lastError);
  } finally {
    state.scanning = false;
    broadcast("apogee:scanning", { scanning: false, reason });
  }
}

function scheduleRebuild(reason: string): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild(reason), REBUILD_DEBOUNCE_MS);
}

function startWatching(dir: string): void {
  watcher?.close();
  state.statsDir = dir;

  watcher = watchStatsFolder(dir, {
    onRun: (run, file) => {
      // Surface the run immediately. The snapshot rebuild follows, but the player
      // should see their run acknowledged the moment it lands, not a second later.
      broadcast("apogee:run", {
        scenario: run.scenario,
        score: run.score,
        playedAt: run.playedAt?.toISOString() ?? null,
        file,
      });

      // If this scenario belongs to the active match, send it for verification without
      // being asked. Making the player click "submit" after every run would undo the
      // entire point of watching the folder.
      void maybeSubmitForMatch(run.scenario, file);

      scheduleRebuild(`new run: ${run.scenario}`);
    },
    onError: (err) => {
      state.lastError = err.message;
      broadcast("apogee:error", err.message);
    },
  });

  rebuild("initial scan");
}

/**
 * Ask for the stats folder and start watching it.
 *
 * Shared by the button in the status bar and the menu item, because two ways to do the
 * same thing should not be two implementations of it.
 */
async function chooseStatsFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "Select your KovaaK's stats folder",
    properties: ["openDirectory"],
    defaultPath: state.statsDir ?? undefined,
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const chosen = result.filePaths[0];
  if (!existsSync(chosen)) return null;

  // Remembered from here on: this is the one thing the app cannot work out for itself
  // when auto-detection misses, so asking twice is asking one time too many.
  saveSettings({ statsDir: chosen });
  startWatching(chosen);
  return chosen;
}

/**
 * Everything worth knowing when someone reports a problem, as pasteable text.
 *
 * Deliberately free of anything private: no SteamID, no session, no display name. The
 * questions this answers are "which build", "which folder", "how many runs" â€” the three
 * that otherwise take a round trip each to establish.
 */
function diagnostics(): string {
  const snapshot = state.snapshot;
  return [
    `Apogee ${app.getVersion()}`,
    `bundle built  ${BUILD}`,
    `electron      ${process.versions.electron}  (node ${process.versions.node})`,
    `platform      ${process.platform} ${process.arch}`,
    `stats folder  ${state.statsDir ?? "not found"}`,
    `runs parsed   ${snapshot?.player.totalRuns ?? 0}`,
    `season        ${snapshot ? `${snapshot.benchmark.name} ${snapshot.benchmark.difficulty}` : "not loaded"}`,
    `signed in     ${state.session ? "yes" : "no"}`,
    `settings      ${settingsPath()}`,
    `last error    ${state.lastError ?? "none"}`,
  ].join("\n");
}

/**
 * Detect quests that have just been completed, and award their XP.
 *
 * Runs on every snapshot rebuild, which means on every run that lands. Progress is
 * recomputed from history rather than tracked incrementally, so a completion cannot be
 * missed by the app being closed at the wrong moment: it simply fires on next launch.
 *
 * Awards are idempotent. A quest already recorded as complete today is never paid
 * twice, however many rebuilds happen.
 */
function checkQuestCompletions(snapshot: Snapshot): void {
  const now = new Date();
  if (!state.quests) state.quests = loadQuestState(now);

  const quests = (snapshot.quests ?? []) as {
    id?: string;
    title: string;
    detail: string;
    kind: string;
    xp: number;
    steps: { done: number; total: number } | null;
    progress: number;
  }[];

  const asSnapshots: QuestSnapshot[] = quests.map((q) => ({
    // The snapshot does not carry ids, so one is derived from the stable parts of the
    // quest. Title alone would collide across days; kind plus title does not.
    id: q.id ?? `${q.kind}:${q.title}`,
    kind: q.kind,
    title: q.title,
    detail: q.detail,
    xp: q.xp,
    // `steps` is the authoritative count for window quests; `progress` is a fraction.
    progress: q.steps ? q.steps.done : q.progress,
    target: q.steps ? q.steps.total : 1,
  }));

  const result = reconcile(asSnapshots, state.quests, now);
  const changed =
    result.newlyCompleted.length > 0 || result.dayRolled || result.state.totalXp !== state.quests.totalXp;

  state.quests = result.state;
  if (changed) saveQuestState(state.quests);

  const level = levelFor(state.quests.totalXp);
  broadcast("apogee:progression", {
    totalXp: state.quests.totalXp,
    level,
    completedToday: Object.keys(state.quests.completed).length,
  });

  for (const quest of result.newlyCompleted) {
    broadcast("apogee:questComplete", { quest, level, xpAwarded: result.xpAwarded });
  }
}

/**
 * Submit a freshly-played run if it is one the active match asked for.
 *
 * Only the first run per scenario counts. Without that, a player could keep replaying a
 * scenario until it went well and settle on the best attempt, which would make the
 * ladder measure patience rather than performance.
 */
async function maybeSubmitForMatch(scenarioName: string, file: string): Promise<void> {
  const match = state.match;
  if (!match || !state.session || !state.statsDir) return;

  const wanted = match.scenarios.find((s) => s.name === scenarioName);
  if (!wanted) return;

  if (state.submitted.has(wanted.id)) {
    broadcast("apogee:matchProgress", {
      matchId: match.matchId,
      scenarioId: wanted.id,
      status: "already-submitted",
      message: `${scenarioName} already counted; only the first run per scenario does`,
    });
    return;
  }

  // Marked before the request so two runs landing together cannot both submit.
  state.submitted.add(wanted.id);

  try {
    const result = await submitRun(state.statsDir, file, match.matchId);

    // The clock only runs while nobody is playing, so a landed run moves the deadline.
    // Keep the cached match in step or the countdown shows a time that has passed.
    if (result.expiresAt) match.expiresAt = result.expiresAt;

    broadcast("apogee:matchProgress", {
      matchId: match.matchId,
      scenarioId: wanted.id,
      status: "submitted",
      scenario: result.scenario,
      score: result.score,
      verificationTier: result.verificationTier,
      advisories: result.advisories,
      expiresAt: result.expiresAt ?? null,
      remaining: match.scenarios.filter((s) => !state.submitted.has(s.id)).map((s) => s.name),
    });

    // Every scenario in, so settle without making the player ask.
    if (match.scenarios.every((s) => state.submitted.has(s.id))) {
      await settleActiveMatch();
    }
  } catch (err) {
    // Let them retry the scenario rather than stranding the match.
    state.submitted.delete(wanted.id);
    const message = err instanceof Error ? err.message : String(err);
    broadcast("apogee:matchProgress", {
      matchId: match.matchId,
      scenarioId: wanted.id,
      status: "failed",
      message,
    });
  }
}

async function settleActiveMatch(): Promise<void> {
  const match = state.match;
  if (!match) return;

  try {
    const settled = await settleMatch(match.matchId);
    state.match = null;
    state.submitted.clear();
    broadcast("apogee:matchSettled", settled);
  } catch (err) {
    broadcast("apogee:error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Where to open the window.
 *
 * A remembered position is only honoured if it still lands on a display that exists.
 * Unplugging a second monitor otherwise reopens the app at coordinates nothing can
 * reach, and the fix â€” delete a JSON file you have never heard of â€” is not one anybody
 * is going to find.
 */
function openingBounds(remembered: WindowBounds | null): {
  width: number;
  height: number;
  x?: number;
  y?: number;
} {
  const size = {
    width: Math.max(DEFAULT_MIN_WIDTH, remembered?.width ?? 1280),
    height: Math.max(DEFAULT_MIN_HEIGHT, remembered?.height ?? 880),
  };

  if (remembered?.x == null || remembered.y == null) return size;

  const visible = screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea;
    // The title bar has to be grabbable, so require the top-left corner to be on-screen
    // with room to spare rather than merely intersecting somewhere.
    return (
      remembered.x! >= x - 8 &&
      remembered.y! >= y - 8 &&
      remembered.x! < x + width - 120 &&
      remembered.y! < y + height - 60
    );
  });

  return visible ? { ...size, x: remembered.x, y: remembered.y } : size;
}

const DEFAULT_MIN_WIDTH = 940;
const DEFAULT_MIN_HEIGHT = 640;

/** Coalesce the burst of resize events a single drag produces into one write. */
let boundsTimer: NodeJS.Timeout | null = null;

function rememberBounds(): void {
  if (!window || window.isDestroyed()) return;

  const maximized = window.isMaximized();
  // Ask for the normal bounds, not the current ones: saving the maximized rectangle
  // means un-maximizing later restores to full screen size, which looks broken.
  const { x, y, width, height } = window.getNormalBounds();

  saveSettings({ window: { x, y, width, height, maximized } });
}

function scheduleRememberBounds(): void {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(rememberBounds, 500);
}

function createWindow(): void {
  const settings = loadSettings();

  window = new BrowserWindow({
    ...openingBounds(settings.window),
    minWidth: DEFAULT_MIN_WIDTH,
    minHeight: DEFAULT_MIN_HEIGHT,
    backgroundColor: "#07090e",
    show: false,
    title: "Apogee",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      // The renderer is a view. It gets no Node, no remote module, and a locked-down
      // context; everything it needs arrives through the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (settings.window?.maximized) window.maximize();

  window.once("ready-to-show", () => window?.show());
  window.on("resize", scheduleRememberBounds);
  window.on("move", scheduleRememberBounds);
  window.on("maximize", scheduleRememberBounds);
  window.on("unmaximize", scheduleRememberBounds);
  window.on("close", () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    rememberBounds();
  });
  window.on("closed", () => { window = null; });

  // External links open in the real browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void window.loadFile(join(here, "renderer", "index.html"));
}

/**
 * `--smoke` boots the app, verifies it can find the stats folder and build a real
 * snapshot, prints the result and exits. Lets the desktop client be checked in CI and
 * from a terminal without a human watching a window appear.
 */
const SMOKE = process.argv.includes("--smoke");

/**
 * One window only.
 *
 * Two instances would both watch the stats folder and both try to auto-submit the same
 * match run. The unique constraint on `csv_sha256` keeps the database honest, but the
 * loser of that race surfaces a spurious "already submitted" error to the player. They
 * also fight over the same user-data directory, which produces a burst of cache errors
 * on launch.
 *
 * Smoke runs are exempt: they are short-lived, headless, and must work while a real
 * instance is open.
 */
console.log(`apogee main built ${BUILD}`);

if (!SMOKE && !app.requestSingleInstanceLock()) {
  console.log(
    "another Apogee instance already holds the lock, so this one is quitting and the " +
      "existing window will be focused. That window is running whatever bundle it " +
      "started with - close it fully before `npm start` to pick up a new build.",
  );
  app.quit();
} else if (!SMOKE) {
  // A second launch focuses the window that already exists, which is what someone
  // double-clicking the icon actually wants.
  app.on("second-instance", () => {
    console.log(
      `focusing the existing window, built ${BUILD}. A newer bundle will not load until ` +
        "this instance is closed.",
    );
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
}

function runSmokeTest(): void {
  const found = findStatsFolder();
  const problems: string[] = [];

  console.log(`stats folder : ${found ?? "NOT FOUND"}`);
  if (!found) {
    problems.push("no stats folder found");
  } else {
    state.statsDir = found;
    try {
      const snapshot = buildSnapshot({ statsDir: found });
      if (!snapshot) {
        problems.push("snapshot came back empty");
      } else {
        console.log(`runs         : ${snapshot.player.totalRuns}`);
        console.log(`benchmark    : ${snapshot.benchmark.name} ${snapshot.benchmark.difficulty}` +
          ` (${snapshot.player.benchmarkRank})`);
        console.log(`apogee tier  : ${snapshot.player.apogee.tier.name}`);
        console.log(`weakest      : ${snapshot.weakest}`);
        console.log(`quests       : ${snapshot.quests.length}`);
      }
    } catch (err) {
      problems.push(`snapshot threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The renderer is loaded for real, so a broken preload path or a CSP violation
  // surfaces here rather than the first time a human opens the app.
  const probe = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true },
  });

  probe.webContents.on("did-fail-load", (_e, code, desc) => {
    problems.push(`renderer failed to load: ${desc} (${code})`);
  });

  // Renderer errors are invisible from the main process unless forwarded. A silently
  // broken control looks identical to a working one from out here, which is exactly
  // how a dead button ships.
  const rendererLogs: string[] = [];
  probe.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) rendererLogs.push(message);
  });

  probe.webContents.once("did-finish-load", async () => {
    const hasBridge = await probe.webContents.executeJavaScript(
      "typeof window.apogee === 'object' && typeof window.apogee.getState === 'function'",
    );
    if (!hasBridge) problems.push("preload bridge is not exposed to the renderer");

    const hasSignIn = await probe.webContents.executeJavaScript(
      "typeof window.apogee?.signIn === 'function' && document.getElementById('btnSignIn') !== null",
    );
    if (!hasSignIn) problems.push("sign-in is not wired to the renderer");

    // A build with no Supabase settings still runs, but sign-in cannot work, and that
    // is worth failing the smoke test over rather than discovering when a user clicks.
    if (!isConfigured()) {
      problems.push("built without Supabase settings; fill in .env and rebuild");
    }

    // A control that exists but is invisible or disabled is not a working control, so
    // the smoke test checks what a person would actually be able to click.
    const button = await probe.webContents.executeJavaScript(`(() => {
      const b = document.getElementById("btnSignIn");
      if (!b) return { present: false };
      const s = getComputedStyle(b);
      return {
        present: true,
        hidden: b.hidden,
        disabled: b.disabled,
        text: b.textContent,
        display: s.display,
        visibility: s.visibility,
        listeners: typeof b.onclick === "function" || b.dataset.wired === "1",
      };
    })()`);

    if (!button.present) problems.push("the sign-in button is not in the DOM");
    else if (button.hidden || button.display === "none" || button.visibility === "hidden") {
      problems.push("the sign-in button is present but not visible");
    } else if (button.disabled) {
      problems.push(`the sign-in button is disabled (${button.text})`);
    }

    console.log(`supabase     : ${isConfigured() ? "configured" : "MISSING"}`);
    console.log(`sign-in      : ${hasSignIn ? "wired" : "MISSING"}`);
    console.log(
      `button       : ${
        button.present
          ? `${button.hidden ? "hidden" : "visible"}, ${button.disabled ? "disabled" : "enabled"}, "${button.text}"`
          : "MISSING"
      }`,
    );
    console.log(`session      : ${state.session ? state.session.displayName : "signed out"}`);

    if (rendererLogs.length > 0) {
      console.log(`\nrenderer errors:`);
      for (const l of rendererLogs.slice(0, 8)) console.log(`  ${l}`);
      problems.push(`${rendererLogs.length} renderer error(s)`);
    }

    const rendered = await probe.webContents.executeJavaScript(
      "document.getElementById('shellCheck') !== null || document.querySelectorAll('.tab').length",
    );
    if (!rendered) problems.push("renderer produced no tabs");

    console.log(`preload      : ${hasBridge ? "bridge exposed" : "MISSING"}`);
    console.log(`renderer     : ${rendered ? "loaded" : "EMPTY"}`);

    console.log();
    if (problems.length > 0) {
      console.error("FAIL:\n  " + problems.join("\n  "));
      app.exit(1);
    } else {
      console.log("OK: desktop client boots, finds stats, and renders");
      app.exit(0);
    }
  });

  void probe.loadFile(join(here, "renderer", "index.html"));
}

app.whenReady().then(() => {
  if (SMOKE) {
    runSmokeTest();
    return;
  }

  createWindow();
  installMenu({
    rescan: () => rebuild("menu rescan"),
    chooseFolder: () => void chooseStatsFolder(),
    openStatsFolder: () => {
      if (state.statsDir) void shell.openPath(state.statsDir);
    },
    diagnostics: () => diagnostics(),
  });

  // A previous sign-in is restored from the encrypted refresh token, so the player
  // does not re-authenticate every launch. Failure here is not worth surfacing: it
  // simply means they are signed out.
  void restoreSession()
    .then(async (session) => {
      if (!session) return;

      state.session = session;
      broadcast("apogee:session", session);

      // Recover a match left open by a previous run of the app. The watcher only
      // submits a run against a match it knows about, so without this a player who
      // restarts mid-match plays all three scenarios for nothing: the runs upload as
      // ordinary history, the match stays at awaiting_runs, and nothing reports a
      // problem because nothing went wrong from anyone's point of view.
      try {
        const active = await fetchActiveMatch();
        if (active) {
          state.match = active;
          state.submitted.clear();
          broadcast("apogee:match", active);
        }
      } catch {
        // Best effort. Queueing surfaces the same match anyway, so a failure here
        // costs a convenience rather than the match.
      }
    })
    .catch(() => undefined);

  // A folder the player picked themselves wins over auto-detection. Someone with two
  // Steam libraries, or a stats folder copied off another machine, told us the answer
  // once and should not be asked again every launch.
  const remembered = loadSettings().statsDir;
  const found = remembered && existsSync(remembered) ? remembered : findStatsFolder();

  if (found) {
    startWatching(found);
  } else {
    state.lastError =
      "Could not find your KovaaK's stats folder. Use â€œChoose folderâ€¦â€ to point Apogee at it.";
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  watcher?.close();
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------------------
// IPC: the entire surface the renderer is given.
// ---------------------------------------------------------------------------

ipcMain.handle("apogee:getState", () => ({
  /** Which bundle this window is running, so a stale one is visible rather than guessed at. */
  build: BUILD,
  statsDir: state.statsDir,
  snapshot: state.snapshot,
  lastError: state.lastError,
  scanning: state.scanning,
  session: state.session,
  signingIn: state.signingIn,
  configured: isConfigured(),
}));

// ---------------------------------------------------------------------------
// Steam sign-in
//
// The whole flow lives in the main process. The renderer is told who is signed in
// and nothing else: no tokens cross the bridge, so injected script in the renderer
// has nothing to steal.
// ---------------------------------------------------------------------------

ipcMain.handle("apogee:signIn", async () => {
  if (!isConfigured()) {
    const message =
      "This build has no Supabase settings. Fill in .env and run npm run build:app.";
    state.lastError = message;
    broadcast("apogee:error", message);
    return { error: message };
  }

  // A sign-in that goes wrong in the browser used to leave this flag stuck until the
  // five-minute timeout, with the only feedback being "already in progress" on every
  // retry. Now the attempt is abandoned and a fresh one starts, because the common
  // case is a user who wants to try again immediately.
  if (state.signingIn) {
    state.signingIn = false;
    broadcast("apogee:signingIn", { signingIn: false });
  }

  state.signingIn = true;
  broadcast("apogee:signingIn", { signingIn: true });

  try {
    const session = await signIn(
      (config) => signInWithSteam(config),
      // Hand the URL to the renderer as a fallback, so a browser that fails to open is
      // recoverable rather than a dead end.
      (url) => {
        console.log("sign-in URL:", url);
        broadcast("apogee:signInUrl", { url });
      },
    );
    state.session = session;
    state.lastError = null;
    broadcast("apogee:session", session);
    return { session };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    broadcast("apogee:error", message);
    return { error: message };
  } finally {
    state.signingIn = false;
    broadcast("apogee:signingIn", { signingIn: false });
  }
});

ipcMain.handle("apogee:signOut", async () => {
  await signOut();
  state.session = null;
  state.match = null;
  state.submitted.clear();
  broadcast("apogee:session", null);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// backfill, matchmaking, settlement
// ---------------------------------------------------------------------------

ipcMain.handle("apogee:uploadHistory", async () => {
  if (!state.session) return { error: "sign in first" };
  if (!state.statsDir) return { error: "no stats folder" };
  if (state.uploading) return { error: "upload already in progress" };

  state.uploading = true;
  broadcast("apogee:uploading", { uploading: true });

  try {
    const result = await uploadBackfill(state.statsDir, state.session.playerId, (p) =>
      broadcast("apogee:uploadProgress", p),
    );

    // Backfill writes straight to the table, so nothing has computed the baselines that
    // matches are scored against. Without this the first match would fall back to a
    // provisional baseline and count for half weight, which is plainly wrong for a
    // player who just uploaded years of history.
    broadcast("apogee:uploadProgress", {
      uploaded: result.uploaded,
      total: result.prepared,
      batch: 0,
      batches: 0,
      phase: "baselines",
    });
    const baselines = await refreshBaselines();

    const standing = await fetchStanding(state.session.playerId);
    broadcast("apogee:standing", standing);

    // Uploading is the one action that moves the queue gate, so the readout is pushed
    // rather than waiting for a relaunch to notice.
    broadcast("apogee:eligibility", await currentEligibility());

    return { result, baselines, standing };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcast("apogee:error", message);
    return { error: message };
  } finally {
    state.uploading = false;
    broadcast("apogee:uploading", { uploading: false });
  }
});

ipcMain.handle("apogee:findMatch", async (_e, { category, pool }) => {
  if (!state.session) return { error: "sign in first" };
  if (typeof pool?.window !== "number") return { error: "no match pool: rebuild the snapshot" };

  try {
    const match = await findMatch(category, pool);
    state.match = match;
    state.submitted.clear();

    // Write the playlist now, not when the player presses Play.
    //
    // KovaaK's reads its playlists folder once, at startup. A playlist written after
    // the game is already open never appears in the menu however correct the file is,
    // which is exactly what it looked like when the file on disk matched the match and
    // the game still listed the previous one. Writing at match creation means the
    // common order - queue, then launch the game - finds it there.
    //
    // It still cannot help someone who already had KovaaK's open. That is what the
    // per-scenario deep links are for: they need nothing on disk.
    if (state.statsDir) {
      const written = writeMatchPlaylist(state.statsDir, {
        scenarios: match.scenarios.map((s) => s.name),
        matchId: match.matchId,
        opponent: match.opponent?.displayName ?? null,
      });
      if (!written.ok) console.warn(`could not write the match playlist: ${written.error}`);
    }

    broadcast("apogee:match", match);
    return { match };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
});

/**
 * Abandon the current match, on the server as well as here.
 *
 * This used to clear local state only, on the assumption the server row "simply
 * expires". It does not: nothing ever acted on expires_at, and find-match blocks on
 * status alone, so abandoning locally left the player permanently unable to queue.
 */
ipcMain.handle("apogee:cancelMatch", async () => {
  const clearLocal = () => {
    state.match = null;
    state.submitted.clear();
    broadcast("apogee:match", null);
  };

  if (!state.session) {
    clearLocal();
    return { ok: true, rated: false };
  }

  try {
    const result = await abandonMatch();
    clearLocal();
    return result;
  } catch (err) {
    // Clear locally anyway. A player who cannot reach the server is better off with a
    // usable app than stuck on a match screen, and find-match will surface the open
    // match again the moment they queue.
    clearLocal();
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/** Settle early, for a match where a run was played before Apogee was watching. */
ipcMain.handle("apogee:settleMatch", async () => {
  if (!state.match) return { error: "no active match" };
  await settleActiveMatch();
  return { ok: true };
});

ipcMain.handle("apogee:getStanding", async () => {
  if (!state.session) return null;
  return fetchStanding(state.session.playerId);
});

/**
 * Whether this account may queue yet, and how far off it is if not.
 *
 * Signed out, the answer is null rather than a refusal: "you need 100 runs" is a
 * confusing thing to tell somebody whose actual problem is that they have not signed in.
 */
async function currentEligibility(): Promise<QueueEligibility | null> {
  if (!state.session) return null;
  const uploaded = await fetchUploadedRuns();
  return uploaded == null ? null : queueEligibility(uploaded);
}

ipcMain.handle("apogee:queueEligibility", () => currentEligibility());

ipcMain.handle("apogee:rescan", () => {
  rebuild("manual rescan");
  return state.snapshot;
});

ipcMain.handle("apogee:chooseFolder", () => chooseStatsFolder());

/**
 * Is the signed-in player an admin?
 *
 * The `admins` policy lets an account see its own row and nobody else's, so a row
 * coming back *is* the answer. Anyone without one gets nothing, which is also what a
 * signed-out client gets, and both mean the same thing here.
 *
 * This gates whether the editor is offered, not whether the file can be written: the
 * season lives on this machine, so anyone with a text editor can already change it.
 * What the gate is really for is the day a season is published to other people.
 */
ipcMain.handle("apogee:isAdmin", async () => {
  if (!state.session) return { admin: false };
  try {
    return { admin: await isAdmin() };
  } catch {
    return { admin: false };
  }
});

/**
 * Scenarios that could be added to the season, and what this machine knows about them.
 *
 * Two things travel with each one, because both change what a good edit looks like:
 *
 *   a suggested category   from KovaaK's own aimType, so the common case needs no
 *                          decision at all
 *   local run history      so a scenario can arrive with thresholds drawn from real
 *                          scores rather than blanks somebody has to invent
 *
 * A scenario with no history still gets ascending placeholders. Zeroes would be
 * refused by the ascending rule and leave the season unsaveable until every cell was
 * filled, which turns adding one scenario into a chore about all of them.
 */
ipcMain.handle("apogee:availableScenarios", () => {
  try {
    const season = loadSeason();
    const already = new Set(season.scenarios.map((s) => s.scenario));
    const windowSize =
      typeof season.windowSize === "number" && season.windowSize > 0 ? season.windowSize : 0;

    // Three sources, because no single one is "every KovaaK's scenario".
    //
    //   the stats folder    everything this player has ever actually run, which on
    //                       this machine is 800-odd and is by far the most useful set:
    //                       a season is most likely to want scenarios somebody plays.
    //   the taxonomy        the 54 benchmark scenarios, with KovaaK's own aim type.
    //   benchmark files     everything any committed benchmark names, which reaches
    //                       scenarios never played here.
    //
    // All offline. KovaaK's full catalogue is far larger than any of these, so the
    // picker also accepts a name typed in directly rather than pretending this is
    // everything that exists.
    // The leaderboard id travels with the name.
    //
    // Without it a scenario can be found and chosen and then not added: thresholds are
    // derived from that scenario's KovaaK's board, and the board is addressed by id. The
    // picker looked like it worked and every selection failed at the last step.
    const known = new Map<
      string,
      { aimType: string | null; difficulty: string | null; leaderboardId: number | null }
    >();

    try {
      const taxonomy = JSON.parse(
        readFileSync(dataFile("scenario_taxonomy.json"), "utf8"),
      ) as {
        scenarios: {
          name: string;
          aimType: string | null;
          difficulty: string;
          leaderboardId: number | null;
        }[];
      };
      for (const s of taxonomy.scenarios) {
        known.set(s.name, {
          aimType: s.aimType,
          difficulty: s.difficulty,
          leaderboardId: s.leaderboardId ?? null,
        });
      }
    } catch {
      // A missing taxonomy costs aim-type suggestions, not the picker.
    }

    for (const file of ["voltaic-s5.json", "voltaic-s5-5.json", "voltaic-s4.json"]) {
      try {
        const def = JSON.parse(readFileSync(dataFile("benchmarks", file), "utf8")) as {
          difficulties: {
            name: string;
            categories: {
              name: string;
              scenarios: { name: string; leaderboardId: number | null }[];
            }[];
          }[];
        };
        for (const d of def.difficulties) {
          for (const c of d.categories) {
            for (const s of c.scenarios) {
              const prior = known.get(s.name);
              if (!prior) {
                known.set(s.name, {
                  aimType: c.name,
                  difficulty: d.name,
                  leaderboardId: s.leaderboardId ?? null,
                });
              } else if (prior.leaderboardId == null && s.leaderboardId != null) {
                // The taxonomy knew the scenario but not its board. A benchmark that names
                // the same scenario does, and an id is the difference between a scenario
                // that can be added and one that cannot.
                prior.leaderboardId = s.leaderboardId;
              }
            }
          }
        }
      } catch {
        // Optional: a benchmark we do not ship simply contributes nothing.
      }
    }

    const history = state.statsDir ? scanStatsFolder(state.statsDir) : new Map();
    for (const name of history.keys()) {
      if (!known.has(name)) {
        known.set(name, { aimType: null, difficulty: null, leaderboardId: null });
      }
    }

    const options = [...known.entries()]
      .filter(([name]) => !already.has(name))
      .map(([name, meta]) => {
        const local = history.get(name);
        const scores = local ? local.runs.map((r: { score: number }) => r.score) : [];

        return {
          name,
          // KovaaK's calls it Target Switching; the season's category is Switching.
          category: meta.aimType === "Target Switching" ? "Switching" : meta.aimType,
          difficulty: meta.difficulty,
          leaderboardId: meta.leaderboardId,
          runs: scores.length,
          best: scores.length > 0 ? Math.round(Math.max(...scores)) : null,
          // One suggestion per category, because each has its own ladder and a
          // suggestion of the wrong length would be rejected the moment it was added.
          // On a windowed season a scenario carries its window's thresholds, not the
          // whole ladder's, so that is the length to suggest.
          suggested: Object.fromEntries(
            season.categories.map((c) => [
              c.name,
              suggestThresholds(
                scores,
                windowSize || (c.rankNames ?? season.rankNames).length,
              ),
            ]),
          ),
        };
      })
      .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));

    return {
      scenarios: options,
      categories: season.categories.map((c) => c.name),
      // A windowed season is not added to one scenario at a time: a family needs one
      // variant per window, so a lone scenario would leave a family incomplete and the
      // season unsaveable. Said here rather than discovered on Save.
      windowed: windowSize > 0,
      windowNote:
        windowSize > 0
          ? `This season grades families across ${season.windows?.length ?? 0} windows. ` +
            `Adding one means a scenario per window, which buildSeason does.`
          : null,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

/**
 * Thresholds for a scenario being added, derived the way every other threshold was.
 *
 * The season's numbers are percentiles of each scenario's own KovaaK's leaderboard. A
 * scenario added by hand with invented numbers would be the one row nobody could justify,
 * so the editor samples the board rather than asking the owner to make something up.
 *
 * Cached to `data/leaderboard_percentiles.json` on the way through, so adding the same
 * scenario twice costs nothing and so the next `build:season` derives the same numbers
 * this dialog just showed.
 */
ipcMain.handle("apogee:sampleScenario", async (_e, { scenario, leaderboardId, topFractions }) => {
  if (!state.session || !(await isAdmin().catch(() => false))) {
    return { error: "only an admin can edit the season" };
  }
  if (!leaderboardId) return { error: "no leaderboard id for this scenario" };

  const file = dataFile("leaderboard_percentiles.json");
  let cache: { source: string; sampledAt: string; samplePoints: number[]; distributions: Distribution[] };
  try {
    cache = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { error: "no leaderboard_percentiles.json - run npm run sample:leaderboards" };
  }

  let dist = cache.distributions.find((d) => d.scenario === scenario);
  let sampled = false;

  if (!dist) {
    try {
      const fetched = await sampleDistribution(scenario, Number(leaderboardId), {
        points: cache.samplePoints,
      });
      if (!fetched) return { error: "that leaderboard has no entries" };
      dist = fetched;
      sampled = true;
    } catch (err) {
      return {
        error:
          err instanceof RateLimited
            ? "KovaaK's is rate-limiting us; wait a minute and try again"
            : err instanceof Error
              ? err.message
              : String(err),
      };
    }
  }

  const rankMaxes = thresholdsFrom(dist, topFractions);
  if (!rankMaxes) return { error: "could not derive thresholds from that board" };

  if (sampled) {
    // Written back so the pool and the cache stay in step; a scenario in the season with
    // no sampled board is one `build:season` would refuse to build.
    cache.distributions.push(dist);
    cache.distributions.sort((a, b) => a.scenario.localeCompare(b.scenario));
    try {
      const body = JSON.stringify(cache, null, 2) + "\n";
      writeFileSync(file, body, "utf8");
      const source = sourceDataDir();
      if (source) {
        writeFileSync(join(source, "leaderboard_percentiles.json"), body, "utf8");
      }
    } catch {
      // A cache we could not write still gave correct thresholds for this dialog.
    }
  }

  return { rankMaxes, entries: dist.total, sampled };
});

/**
 * Search KovaaK's own scenario catalogue by name.
 *
 * The local picker can only offer what some committed file already names - the taxonomy's
 * fifty-four, plus whatever the benchmark definitions mention. That is a few hundred
 * against a catalogue of sixty thousand, and everything outside it was unaddable: a
 * scenario needs a leaderboard id for its thresholds to be derived, and nothing local knew
 * the id. Asking the source removes the ceiling entirely.
 *
 * Read-only, and the same host the app already talks to for verification.
 */
ipcMain.handle("apogee:searchScenarios", async (_e, { query }) => {
  if (!state.session || !(await isAdmin().catch(() => false))) {
    return { error: "only an admin can edit the season" };
  }

  const term = String(query ?? "").trim();
  if (term.length < 2) return { scenarios: [] };

  try {
    const url =
      "https://kovaaks.com/webapp-backend/scenario/popular?page=0&max=25" +
      `&scenarioNameSearch=${encodeURIComponent(term)}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36",
        accept: "application/json",
      },
    });
    if (!res.ok) return { error: `KovaaK's returned ${res.status}` };

    const body = (await res.json()) as {
      data?: {
        leaderboardId?: number;
        scenarioName?: string;
        scenario?: { aimType?: string | null };
        counts?: { plays?: number; entries?: number };
      }[];
    };

    return {
      scenarios: (body.data ?? [])
        .filter((row) => row.scenarioName && row.leaderboardId)
        .map((row) => ({
          name: row.scenarioName!,
          leaderboardId: row.leaderboardId!,
          aimType: row.scenario?.aimType ?? null,
          entries: row.counts?.entries ?? 0,
        })),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

/**
 * What the ladder currently on screen would do to the population.
 *
 * Tuning thresholds without this is guesswork: you can see that a rank asks for 929, and
 * not that it holds two players in a thousand or that nobody holds it at all. Computed
 * from the draft rather than the saved season, so it answers for what is being edited.
 */
ipcMain.handle("apogee:rankDistribution", async (_e, { season }) => {
  if (!state.session || !(await isAdmin().catch(() => false))) {
    return { error: "only an admin can edit the season" };
  }

  let cache: { distributions: Distribution[] };
  try {
    cache = JSON.parse(readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"));
  } catch {
    return { error: "no leaderboard_percentiles.json - run npm run sample:leaderboards" };
  }

  try {
    return {
      categories: rankDistribution(
        season,
        new Map(cache.distributions.map((d) => [d.scenario, d])),
      ),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

/**
 * Re-derive every threshold in one window from a new set of percentiles.
 *
 * The percentile ladder is the season's real control surface: moving rank 7 from the top
 * 15% to the top 8% is one decision that should move eighteen numbers, and moving eighteen
 * numbers by hand to express it is how they end up inconsistent. Editing the percentages
 * re-derives from the cached boards immediately, so what is on screen is always what the
 * next `build:season` would produce.
 */
ipcMain.handle("apogee:deriveWindow", async (_e, { scenarios, topFractions }) => {
  if (!state.session || !(await isAdmin().catch(() => false))) {
    return { error: "only an admin can edit the season" };
  }

  let cache: { distributions: Distribution[] };
  try {
    cache = JSON.parse(readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"));
  } catch {
    return { error: "no leaderboard_percentiles.json - run npm run sample:leaderboards" };
  }

  const distOf = new Map(cache.distributions.map((d) => [d.scenario, d]));
  const derived: Record<string, number[]> = {};
  const missing: string[] = [];

  for (const scenario of scenarios as string[]) {
    const dist = distOf.get(scenario);
    const rankMaxes = dist ? thresholdsFrom(dist, topFractions) : null;
    if (rankMaxes) derived[scenario] = rankMaxes;
    else missing.push(scenario);
  }

  return { derived, missing };
});

/**
 * A starting ladder for a scenario being added.
 *
 * Drawn from the player's own scores when there are enough of them - percentiles of
 * what they actually hit is a far better first guess than a round number, and it is the
 * same reasoning seasons use at rollover, just with one person's data instead of a
 * population's. Below that it is placeholders, clearly wrong and clearly ascending, so
 * the season stays saveable while they are corrected.
 */
function suggestThresholds(scores: number[], ranks: number): number[] {
  if (scores.length < 5) {
    return Array.from({ length: ranks }, (_, i) => (i + 1) * 100);
  }

  const sorted = [...scores].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

  // Spread across the upper half of what they have done: the lowest rank should be
  // reachable and the highest should not be automatic.
  const out: number[] = [];
  for (let i = 0; i < ranks; i++) {
    const p = 0.5 + (0.45 * i) / Math.max(1, ranks - 1);
    out.push(Math.round(at(p)));
  }

  // Percentiles can tie on a flat history, and equal thresholds break the ascending
  // rule. Nudge each one past the last rather than handing back something invalid.
  for (let i = 1; i < out.length; i++) {
    if (out[i] <= out[i - 1]) out[i] = out[i - 1] + 1;
  }
  return out;
}

ipcMain.handle("apogee:getSeason", () => {
  try {
    return { season: loadSeason(), path: seasonPath() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

/**
 * Write the season back, then rebuild from it.
 *
 * Validated before it is written, not after. A season with a threshold count that does
 * not match its ladder produces ranks nobody can reach, on every screen that grades a
 * score, and writing it first would mean the app is already broken by the time anyone
 * finds out.
 */
ipcMain.handle("apogee:saveSeason", async (_e, { season }) => {
  if (!state.session || !(await isAdmin().catch(() => false))) {
    return { error: "only an admin can edit the season" };
  }

  try {
    validateSeason(season);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  // Write the pool back too, or an evening of editing lives until the next build.
  //
  // `data/pool.json` is what buildSeason reads: the families, the windows, the percentile
  // ladder. The editor edits the *season*, which is the build output - so without this a
  // rebuild would regenerate from a pool that never heard about the family somebody just
  // added, and silently undo it. Derived from the season rather than tracked separately,
  // so there is one thing to keep right instead of two.
  //
  // Thresholds that differ from what the percentiles give are recorded as overrides. A
  // derived number is reproducible and a hand-set one is a judgement; the difference has to
  // survive the rebuild, and has to be visible afterwards rather than looking like a
  // measurement.
  const poolBody = (() => {
    try {
      const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8"));

      let cache: { distributions: Distribution[] } | null = null;
      try {
        cache = JSON.parse(readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"));
      } catch {
        // No cache: every threshold is treated as hand-set, which is the safe direction.
      }
      const distOf = new Map((cache?.distributions ?? []).map((d) => [d.scenario, d]));

      // The season's own ladder wins: if the percentiles were edited this session, the
      // pool has not heard about it yet, and diffing against the old ones would record
      // every freshly-derived threshold as a hand-set override.
      const ladders: number[][] = season.derivedFrom?.perWindow ?? pool.ladder?.perWindow ?? [];
      const overrides: Record<string, number[]> = {};

      const families: Record<string, {
        family: string;
        category: string;
        variants: { window: number; scenario: string; label: string; leaderboardId: number | null }[];
      }> = {};

      for (const scen of season.scenarios) {
        const key = `${scen.category}/${scen.family}`;
        families[key] ??= { family: scen.family, category: scen.category, variants: [] };
        families[key].variants.push({
          window: scen.window ?? 0,
          scenario: scen.scenario,
          label: scen.label,
          leaderboardId: scen.leaderboardId ?? null,
        });

        const dist = distOf.get(scen.scenario);
        const ladder = ladders[scen.window ?? 0];
        const derived = dist && ladder ? thresholdsFrom(dist, ladder) : null;

        if (!derived || derived.some((n, i) => n !== scen.rankMaxes[i])) {
          overrides[scen.scenario] = scen.rankMaxes.slice();
        }
      }

      for (const f of Object.values(families)) f.variants.sort((a, b) => a.window - b.window);

      pool.windowSize = season.windowSize ?? pool.windowSize;
      pool.windows = season.windows ?? pool.windows;
      pool.matchWindow = season.matchPool?.window ?? pool.matchWindow;
      pool.categories = season.categories.map((c: { name: string }) => c.name);
      pool.families = Object.values(families).sort(
        (a, b) => a.category.localeCompare(b.category) || a.family.localeCompare(b.family),
      );
      pool.overrides = overrides;
      if (season.derivedFrom?.perWindow) {
        pool.ladder = { ...(pool.ladder ?? {}), perWindow: season.derivedFrom.perWindow };
      }

      return JSON.stringify(pool, null, 2) + "\n";
    } catch {
      // A pool we could not rebuild must not stop the season being saved: the season is
      // the thing the app grades against, and losing that edit would be worse.
      return null;
    }
  })();

  // Write the source too, not only the copy the app reads.
  //
  // The app points the core at dist/data, which build:app rewrites from data/ on every
  // build. Writing only there meant an edit survived exactly until the next build and
  // then vanished with nothing to say it had - tolerable for a cache, ruinous for the
  // file that defines what every rank means.
  const written: string[] = [];
  const body = JSON.stringify(season, null, 2) + "\n";

  try {
    writeFileSync(seasonPath(), body, "utf8");
    written.push(seasonPath());

    if (poolBody) writeFileSync(dataFile("pool.json"), poolBody, "utf8");

    const source = sourceDataDir();
    if (source) {
      const sourcePath = join(source, "seasons", "season-1.json");
      if (sourcePath !== seasonPath()) {
        mkdirSync(join(source, "seasons"), { recursive: true });
        writeFileSync(sourcePath, body, "utf8");
        written.push(sourcePath);
      }

      if (poolBody) {
        writeFileSync(join(source, "pool.json"), poolBody, "utf8");
        written.push(join(source, "pool.json"));
      }

      // Refresh the rank sheet alongside the source.
      //
      // Renaming a rank in this editor is the single most likely reason for the sheet to
      // go stale, since the sheet is what gets sent to people to ask about the names. Only
      // where a source tree exists: a packaged build has no docs/ to write to, and
      // inventing one would be creating a file nobody asked for.
      const docsDir = join(source, "..", "docs");
      if (existsSync(docsDir)) {
        const sheet = join(docsDir, "season-1-ranks.html");
        writeFileSync(sheet, renderRankSheet(season), "utf8");
        written.push(sheet);
      }
    }
  } catch (err) {
    return { error: `could not write the season: ${err instanceof Error ? err.message : err}` };
  }

  rebuild("season edited");
  return { ok: true, path: written[0], paths: written };
});

ipcMain.handle("apogee:openStatsFolder", () => {
  if (state.statsDir) void shell.openPath(state.statsDir);
});

/**
 * Write the current match as a KovaaK's playlist and start the game.
 *
 * Two steps rather than one because KovaaK's registers no URL scheme, so nothing can
 * launch it straight into a scenario. The playlist has to be on disk first for the
 * player to pick it from the menu.
 *
 * The playlist is a convenience and never the rule: settlement reads run timestamps, so
 * ignoring it and launching the three scenarios by hand settles identically.
 */
/**
 * Open one scenario in KovaaK's.
 *
 * The playlist is written at match start, but KovaaK's reads its playlists folder when
 * it launches, so a match written while the game is already running does not appear in
 * the menu. Deep-linking each scenario sidesteps that: it needs nothing on disk and
 * nothing refreshed, and it works whether or not the game is already open.
 *
 * Restricted to the scenarios of the active match. This drives an OS-level launch from
 * a renderer message, and "open whatever the page asks for" is how that becomes a way
 * to start arbitrary things.
 */
ipcMain.handle("apogee:launchScenario", async (_e, { scenario }) => {
  if (!state.match) return { error: "no active match" };

  const known = state.match.scenarios.some((s) => s.name === scenario);
  if (!known) return { error: "that scenario is not part of this match" };

  const launched = await launchKovaaks(scenario);
  return launched.ok
    ? { ok: true, scenario }
    : { error: launched.error ?? "could not start KovaaK's" };
});

ipcMain.handle("apogee:launchMatch", async () => {
  if (!state.match) return { error: "no active match" };
  if (!state.statsDir) return { error: "no stats folder" };

  const written = writeMatchPlaylist(state.statsDir, {
    scenarios: state.match.scenarios.map((s) => s.name),
    matchId: state.match.matchId,
    opponent: state.match.opponent?.displayName ?? null,
  });

  if (!written.ok) return { error: written.error };

  // Jump straight into the first scenario. The playlist still gets written, because
  // nothing can deep-link into a *local* playlist and the player needs the other two
  // scenarios queued up somewhere.
  //
  // A running game read its playlists at startup, so a match written now will not
  // appear until it restarts. Better to say so than to have the player hunt for a
  // playlist that is genuinely on disk and genuinely not on screen.
  const first = state.match.scenarios[0]?.name ?? null;
  const launched = await launchKovaaks(first);

  return {
    ok: true,
    playlistName: written.playlistName,
    path: written.path,
    launched: launched.ok,
    jumpedTo: launched.jumped ? first : null,
    launchError: launched.error,
  };
});
