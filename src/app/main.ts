/**
 * Arena desktop client: the Electron main process.
 *
 * Responsibilities, and deliberately nothing else:
 *   - find the KovaaK's stats folder
 *   - watch it, and rebuild the player snapshot when a run lands
 *   - serve that snapshot to the renderer over a narrow IPC surface
 *
 * All parsing and computation happens here rather than in the renderer, which keeps
 * the renderer a pure view. That mirrors the server-side rule from PLAN.md §7: the
 * layer that can be tampered with is never the layer that decides anything.
 */

import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { setDataDir } from "../core/dataDir.ts";
import {
  levelFor,
  reconcile,
  type QuestProgressState,
  type QuestSnapshot,
} from "../core/quests/progression.ts";
import { loadQuestState, saveQuestState } from "./questStore.ts";
import { buildSnapshot, type Snapshot } from "../core/report/snapshot.ts";
import { signInWithSteam } from "../core/sync/steamAuth.ts";
import {
  fetchStanding,
  findMatch,
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
  type ArenaSession,
} from "./session.ts";
import { findStatsFolder, watchStatsFolder, type StatsWatcher } from "./watcher.ts";

/**
 * Bundled to dist/app/main.cjs, so `__dirname` is dist/app and the reference data
 * copied by the build sits at dist/data. Told explicitly rather than discovered,
 * because a packaged app has no meaningful working directory.
 */
const here = __dirname;
setDataDir(join(here, "..", "data"));

/** Rebuilding scans the whole folder, so coalesce bursts of runs into one rebuild. */
const REBUILD_DEBOUNCE_MS = 1200;

interface State {
  statsDir: string | null;
  snapshot: Snapshot | null;
  lastError: string | null;
  scanning: boolean;
  session: ArenaSession | null;
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
  broadcast("arena:scanning", { scanning: true, reason });

  try {
    const snapshot = buildSnapshot({ statsDir: state.statsDir });
    if (snapshot) {
      state.snapshot = snapshot;
      state.lastError = null;
      broadcast("arena:snapshot", snapshot);
      checkQuestCompletions(snapshot);
    } else {
      state.lastError = "No runs found in the stats folder yet.";
      broadcast("arena:error", state.lastError);
    }
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    broadcast("arena:error", state.lastError);
  } finally {
    state.scanning = false;
    broadcast("arena:scanning", { scanning: false, reason });
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
      broadcast("arena:run", {
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
      broadcast("arena:error", err.message);
    },
  });

  rebuild("initial scan");
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
  broadcast("arena:progression", {
    totalXp: state.quests.totalXp,
    level,
    completedToday: Object.keys(state.quests.completed).length,
  });

  for (const quest of result.newlyCompleted) {
    broadcast("arena:questComplete", { quest, level, xpAwarded: result.xpAwarded });
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
    broadcast("arena:matchProgress", {
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
    broadcast("arena:matchProgress", {
      matchId: match.matchId,
      scenarioId: wanted.id,
      status: "submitted",
      scenario: result.scenario,
      score: result.score,
      verificationTier: result.verificationTier,
      advisories: result.advisories,
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
    broadcast("arena:matchProgress", {
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
    broadcast("arena:matchSettled", settled);
  } catch (err) {
    broadcast("arena:error", err instanceof Error ? err.message : String(err));
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: "#07090e",
    show: false,
    title: "Arena",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      // The renderer is a view. It gets no Node, no remote module, and a locked-down
      // context; everything it needs arrives through the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once("ready-to-show", () => window?.show());
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
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else if (!SMOKE) {
  // A second launch focuses the window that already exists, which is what someone
  // double-clicking the icon actually wants.
  app.on("second-instance", () => {
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
        console.log(`arena tier   : ${snapshot.player.arena.tier.name}`);
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
      "typeof window.arena === 'object' && typeof window.arena.getState === 'function'",
    );
    if (!hasBridge) problems.push("preload bridge is not exposed to the renderer");

    const hasSignIn = await probe.webContents.executeJavaScript(
      "typeof window.arena?.signIn === 'function' && document.getElementById('btnSignIn') !== null",
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

  // A previous sign-in is restored from the encrypted refresh token, so the player
  // does not re-authenticate every launch. Failure here is not worth surfacing: it
  // simply means they are signed out.
  void restoreSession()
    .then((session) => {
      if (session) {
        state.session = session;
        broadcast("arena:session", session);
      }
    })
    .catch(() => undefined);

  const found = findStatsFolder();
  if (found) {
    startWatching(found);
  } else {
    state.lastError =
      "Could not find your KovaaK's stats folder. Use “Choose folder…” to point Arena at it.";
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

ipcMain.handle("arena:getState", () => ({
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

ipcMain.handle("arena:signIn", async () => {
  if (!isConfigured()) {
    const message =
      "This build has no Supabase settings. Fill in .env and run npm run build:app.";
    state.lastError = message;
    broadcast("arena:error", message);
    return { error: message };
  }

  // A sign-in that goes wrong in the browser used to leave this flag stuck until the
  // five-minute timeout, with the only feedback being "already in progress" on every
  // retry. Now the attempt is abandoned and a fresh one starts, because the common
  // case is a user who wants to try again immediately.
  if (state.signingIn) {
    state.signingIn = false;
    broadcast("arena:signingIn", { signingIn: false });
  }

  state.signingIn = true;
  broadcast("arena:signingIn", { signingIn: true });

  try {
    const session = await signIn(
      (config) => signInWithSteam(config),
      // Hand the URL to the renderer as a fallback, so a browser that fails to open is
      // recoverable rather than a dead end.
      (url) => {
        console.log("sign-in URL:", url);
        broadcast("arena:signInUrl", { url });
      },
    );
    state.session = session;
    state.lastError = null;
    broadcast("arena:session", session);
    return { session };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    broadcast("arena:error", message);
    return { error: message };
  } finally {
    state.signingIn = false;
    broadcast("arena:signingIn", { signingIn: false });
  }
});

ipcMain.handle("arena:signOut", async () => {
  await signOut();
  state.session = null;
  state.match = null;
  state.submitted.clear();
  broadcast("arena:session", null);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// backfill, matchmaking, settlement
// ---------------------------------------------------------------------------

ipcMain.handle("arena:uploadHistory", async () => {
  if (!state.session) return { error: "sign in first" };
  if (!state.statsDir) return { error: "no stats folder" };
  if (state.uploading) return { error: "upload already in progress" };

  state.uploading = true;
  broadcast("arena:uploading", { uploading: true });

  try {
    const result = await uploadBackfill(state.statsDir, state.session.playerId, (p) =>
      broadcast("arena:uploadProgress", p),
    );

    // Backfill writes straight to the table, so nothing has computed the baselines that
    // matches are scored against. Without this the first match would fall back to a
    // provisional baseline and count for half weight, which is plainly wrong for a
    // player who just uploaded years of history.
    broadcast("arena:uploadProgress", {
      uploaded: result.uploaded,
      total: result.prepared,
      batch: 0,
      batches: 0,
      phase: "baselines",
    });
    const baselines = await refreshBaselines();

    const standing = await fetchStanding(state.session.playerId);
    broadcast("arena:standing", standing);
    return { result, baselines, standing };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcast("arena:error", message);
    return { error: message };
  } finally {
    state.uploading = false;
    broadcast("arena:uploading", { uploading: false });
  }
});

ipcMain.handle("arena:findMatch", async (_e, { category, difficulty }) => {
  if (!state.session) return { error: "sign in first" };

  try {
    const match = await findMatch(category, difficulty);
    state.match = match;
    state.submitted.clear();
    broadcast("arena:match", match);
    return { match };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
});

/** Abandon the current match locally. The server row simply expires. */
ipcMain.handle("arena:cancelMatch", () => {
  state.match = null;
  state.submitted.clear();
  broadcast("arena:match", null);
  return { ok: true };
});

/** Settle early, for a match where a run was played before Arena was watching. */
ipcMain.handle("arena:settleMatch", async () => {
  if (!state.match) return { error: "no active match" };
  await settleActiveMatch();
  return { ok: true };
});

ipcMain.handle("arena:getStanding", async () => {
  if (!state.session) return null;
  return fetchStanding(state.session.playerId);
});

ipcMain.handle("arena:rescan", () => {
  rebuild("manual rescan");
  return state.snapshot;
});

ipcMain.handle("arena:chooseFolder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select your KovaaK's stats folder",
    properties: ["openDirectory"],
    defaultPath: state.statsDir ?? undefined,
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const chosen = result.filePaths[0];
  if (!existsSync(chosen)) return null;

  startWatching(chosen);
  return chosen;
});

ipcMain.handle("arena:openStatsFolder", () => {
  if (state.statsDir) void shell.openPath(state.statsDir);
});
