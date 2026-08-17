/**
 * Apogee desktop client: the Electron main process.
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
import { scanStatsFolder } from "../core/history/history.ts";
import { signInWithSteam } from "../core/sync/steamAuth.ts";
import {
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
import { launchKovaaks, writeMatchPlaylist } from "./playlist.ts";
import { loadSeason, seasonPath, validateSeason } from "../core/season/season.ts";

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

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 940,
    minHeight: 640,
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

  const found = findStatsFolder();
  if (found) {
    startWatching(found);
  } else {
    state.lastError =
      "Could not find your KovaaK's stats folder. Use “Choose folder…” to point Apogee at it.";
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

ipcMain.handle("apogee:findMatch", async (_e, { category, difficulty }) => {
  if (!state.session) return { error: "sign in first" };

  try {
    const match = await findMatch(category, difficulty);
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

ipcMain.handle("apogee:rescan", () => {
  rebuild("manual rescan");
  return state.snapshot;
});

ipcMain.handle("apogee:chooseFolder", async () => {
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
    const known = new Map<string, { aimType: string | null; difficulty: string | null }>();

    try {
      const taxonomy = JSON.parse(
        readFileSync(dataFile("scenario_taxonomy.json"), "utf8"),
      ) as { scenarios: { name: string; aimType: string | null; difficulty: string }[] };
      for (const s of taxonomy.scenarios) {
        known.set(s.name, { aimType: s.aimType, difficulty: s.difficulty });
      }
    } catch {
      // A missing taxonomy costs aim-type suggestions, not the picker.
    }

    for (const file of ["voltaic-s5.json", "voltaic-s5-5.json", "voltaic-s4.json"]) {
      try {
        const def = JSON.parse(readFileSync(dataFile("benchmarks", file), "utf8")) as {
          difficulties: { name: string; categories: { name: string; scenarios: { name: string }[] }[] }[];
        };
        for (const d of def.difficulties) {
          for (const c of d.categories) {
            for (const s of c.scenarios) {
              if (!known.has(s.name)) known.set(s.name, { aimType: c.name, difficulty: d.name });
            }
          }
        }
      } catch {
        // Optional: a benchmark we do not ship simply contributes nothing.
      }
    }

    const history = state.statsDir ? scanStatsFolder(state.statsDir) : new Map();
    for (const name of history.keys()) {
      if (!known.has(name)) known.set(name, { aimType: null, difficulty: null });
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
          runs: scores.length,
          best: scores.length > 0 ? Math.round(Math.max(...scores)) : null,
          // One suggestion per category, because each has its own ladder and a
          // suggestion of the wrong length would be rejected the moment it was added.
          suggested: Object.fromEntries(
            season.categories.map((c) => [
              c.name,
              suggestThresholds(scores, (c.rankNames ?? season.rankNames).length),
            ]),
          ),
        };
      })
      .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));

    return { scenarios: options, categories: season.categories.map((c) => c.name) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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

    const source = sourceDataDir();
    if (source) {
      const sourcePath = join(source, "seasons", "season-1.json");
      if (sourcePath !== seasonPath()) {
        mkdirSync(join(source, "seasons"), { recursive: true });
        writeFileSync(sourcePath, body, "utf8");
        written.push(sourcePath);
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
