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

import { app, BrowserWindow, ipcMain, screen, shell, dialog } from "electron";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { dataFile, setDataDir, sourceDataDir } from "../core/dataDir.ts";
import { levelFor } from "../core/quests/progression.ts";
import { recordGhost, recordMatch, rerollQuest, type QuestState, type QuestSync } from "../core/quests/board.ts";
import { GhostService } from "./ghostService.ts";
import { ShareCards } from "./shareCard.ts";
import {
  installCrashHandlers,
  attachRendererLogging,
  suppressCrashDialogs,
  log,
} from "./crashLog.ts";
import { loadRankTheme } from "../core/ranks/apogeeRanks.ts";
import { rebuildPool } from "../core/season/rebuildPool.ts";
import { syncBandLadders, syncOverallLadder } from "../core/season/bandLadders.ts";
import { loadQuestState, saveQuestState } from "./questStore.ts";
import { ExpeditionService } from "./expedition.ts";
import { clearOverrides, loadOverrides, overridesPath, saveOverrides } from "./adminStore.ts";
import { MAX_COPY, PAIRS, TOKENS } from "../core/admin/overrides.ts";
import { buildSnapshot, type Snapshot } from "../core/report/snapshot.ts";
import { renderRankSheet } from "../core/report/rankSheet.ts";
import { DARK_CHROME } from "../core/report/contrast.ts";
import { scanStatsFolder, type ScenarioHistory } from "../core/history/history.ts";
import { SignInCancelled, signInWithSteam } from "../core/sync/steamAuth.ts";
import {
  fetchUploadedRuns,
  fetchStanding,
  abandonMatch,
  fetchActiveMatch,
  findMatch,
  fetchApexBoard,
  isAdmin,
  refreshApex,
  refreshBaselines,
  settleMatch,
  submitRun,
  uploadBackfill,
  uploadRecentRuns,
  answerDuel,
  fetchDuels,
  sendDuel,
  setFriend,
  fetchTournaments,
  playFixture,
  tournamentAction,
  friendlyError,
  setOnUnauthorized,
  type DuelBoard,
  type FoundMatch,
  type TournamentAction,
  type TournamentSummary,
} from "./api.ts";
import { sampleTournamentView } from "../core/tournament/sample.ts";
import {
  isConfigured,
  restoreSession,
  SessionUnreachable,
  signIn,
  signOut,
  type ApogeeSession,
} from "./session.ts";
import { candidateStatsFolders, findStatsFolder, statsFolderOverride, watchStatsFolder, type StatsWatcher } from "./watcher.ts";
import { loadSettings, saveSettings, settingsPath, type WindowBounds } from "./settings.ts";
import { installMenu } from "./menu.ts";
import { launchKovaaks, writeMatchPlaylist } from "./playlist.ts";
import { loadSeason, seasonPath, validateSeason } from "../core/season/season.ts";
import { queueEligibility, type QueueEligibility } from "../core/match/eligibility.ts";
import { sampleDistribution, RateLimited } from "../core/season/sampleLeaderboard.ts";
import { thresholdsFrom, type Distribution } from "../core/season/percentiles.ts";
import { rankDistribution } from "../core/season/distribution.ts";
import { ENERGY_PER_RANK } from "../core/benchmarks/energy.ts";
import { apexSources, apexStanding } from "../core/season/standing.ts";
import type { ApexBoard } from "../core/season/apex.ts";
import {
  installedPlaylistCount,
  installedPlaylistNames,
  playlistsFolderFor,
  refreshStalePlaylists,
  practicePlaylists,
  practiceRows,
  writePracticePlaylists,
} from "../core/season/practice.ts";
import { installSeasonScenarios, scenariosFolderFor } from "../core/season/installScenarios.ts";

/**
 * Bundled to dist/app/main.cjs, so `__dirname` is dist/app and the reference data
 * copied by the build sits at dist/data. Told explicitly rather than discovered,
 * because a packaged app has no meaningful working directory.
 */
const here = __dirname;
setDataDir(join(here, "..", "data"));

// Smoke probes exercise settings and appearance writes as well as progress. Give
// the entire process a fresh profile before any stores or Chromium caches open.
const SMOKE = process.argv.includes("--smoke");
// `--fresh` is the same throwaway profile in an ordinary window: what a new player sees on
// first launch - no remembered folder, no sign-in, no progress, the checklist not yet
// dismissed - without touching the real profile. `--no-stats` also skips finding the
// stats folder, for the screen a player sees when detection fails.
const FRESH = process.argv.includes("--fresh");
const NO_STATS = process.argv.includes("--no-stats");
// `--allow-offline` lets `--smoke` pass on a build with no Supabase settings, which is the
// only build a machine without the project's .env can make. It downgrades that one check
// to a printed warning and nothing else; without the flag the check still fails.
const ALLOW_OFFLINE = process.argv.includes("--allow-offline");
if (SMOKE || FRESH) {
  const profile = mkdtempSync(join(app.getPath("temp"), SMOKE ? "apogee-smoke-" : "apogee-fresh-"));
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
}

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
  /** A neutral message for the banner: news, not a failure. Null when there is none. */
  notice: string | null;
  scanning: boolean;
  session: ApogeeSession | null;
  signingIn: boolean;
  /** The match the player is currently playing, if any. */
  match: FoundMatch | null;
  /** Scenario ids of the active match already submitted, so runs are not sent twice. */
  submitted: Set<number>;
  uploading: boolean;
  /** The quest board and lifetime XP, persisted between launches. */
  quests: QuestState | null;
  /** The inbox, what was sent, who else plays. Null until signed in and read once. */
  duels: DuelBoard | null;
  /** The tournament list as last read. Null until signed in and read once. */
  tournaments: TournamentSummary[] | null;
}

const state: State = {
  statsDir: null,
  snapshot: null,
  lastError: null,
  notice: null,
  scanning: false,
  session: null,
  signingIn: false,
  match: null,
  submitted: new Set(),
  uploading: false,
  quests: null,
  duels: null,
  tournaments: null,
};

/** What the renderer was last told, so an unchanged board is not broadcast again. */
let duelBoardKey = "";
let tournamentsKey = "";

let window: BrowserWindow | null = null;
let watcher: StatsWatcher | null = null;
const observedBests = new Map<string, number>();
let rebuildTimer: NodeJS.Timeout | null = null;
let expeditionService: ExpeditionService | null = null;
function expedition(): ExpeditionService {
  return expeditionService ??= new ExpeditionService(app.getPath("userData"));
}

/**
 * Ghost Mode (ghostService.ts). Local-first: it needs a stats folder and nothing else, so
 * it works signed out, offline and on an empty ladder.
 */
const ghost = new GhostService({
  statsDir: () => state.statsDir,
  signedIn: () => state.session !== null,
  broadcast: (screen) => broadcast("apogee:ghost", screen),
  onFinished: (result) => {
    // Into the quest board's ghost list, never its settled matches: a ghost win is a win
    // nobody else took part in, and the ranked-wins quests count matches. The rebuild
    // then measures the board and fires apogee:questComplete the way a match does.
    state.quests = recordGhost(state.quests ?? loadQuestState(), {
      id: result.id,
      at: new Date(result.at).toISOString(),
      kind: result.kind,
      verdict: result.verdict,
    });
    saveQuestState(state.quests);
    nudge();
    scheduleRebuild("ghost match finished");
  },
  launch: (scenario) => launchKovaaks(scenario),
});

/**
 * Share cards (shareCard.ts), drawn from main's own record of a result: the settlement as
 * it arrived, or the ghost result as booked. The renderer names a card and a shape, never
 * a figure.
 */
const shareCards = new ShareCards({
  rendererDir: join(here, "renderer"),
  fontsDir: join(here, "fonts"),
  context: () => {
    const snap = state.snapshot;
    // The season rank from the player's own scores, the one the Ranks screen shows. The
    // snapshot's apogee rating and percentile are placeholders until the ladder has a
    // population, so they never reach a card.
    const rankName = snap?.player.benchmarkRank ?? null;
    const tier = rankName ? snap?.theme.find((t) => t.name === rankName) ?? null : null;
    return {
      playerName: state.session?.displayName || "You",
      season: snap?.benchmark.name || "Apogee",
      tier: tier ? { id: tier.id, name: tier.name, color: tier.color } : null,
    };
  },
  ghost: () => ghost.shareRecord(),
  window: () => window,
});

/** Show a neutral message, and keep it for a window that has not loaded yet. */
function notify(message: string | null): void {
  state.notice = message;
  broadcast("apogee:notice", message);
}

function broadcast(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

/**
 * Ask for attention when something happens behind the game.
 *
 * The player is in KovaaK's when the queue finds somebody and when a result comes back -
 * that is the point of the app running beside it - so the window that would announce it
 * is the one window they are not looking at. Flashing the taskbar button is the operating
 * system's own way to say "over here" without taking focus from a game mid-run. Only while
 * the window is unfocused, and it stops as soon as the window is.
 */
function nudge(): void {
  const win = window;
  if (!win || win.isDestroyed() || win.isFocused()) return;
  win.flashFrame(true);
  win.once("focus", () => {
    if (!win.isDestroyed()) win.flashFrame(false);
  });
}

function rebuild(reason: string): void {
  if (!state.statsDir) return;

  state.scanning = true;
  broadcast("apogee:scanning", { scanning: true, reason });
  const startedAt = performance.now();

  try {
    // Its own try: the solo Expedition failing to load must not cost the player their
    // snapshot, which is what the ranked screens are drawn from. It shares the parse of the
    // stats folder with the snapshot (stats/folderCache.ts), so this costs nothing extra.
    let expeditionView: ReturnType<ExpeditionService["view"]> | undefined;
    try {
      expeditionView = expedition().view(state.statsDir, true);
      broadcast("apogee:expedition", expeditionView);
    } catch (err) {
      console.error("expedition sync failed:", err);
    }
    if (!state.quests) state.quests = loadQuestState();
    const syncs: QuestSync[] = [];
    const snapshot = buildSnapshot({
      statsDir: state.statsDir,
      quests: { state: state.quests, ranked: state.session !== null, onSync: (sync) => syncs.push(sync) },
    });
    if (snapshot) {
      snapshot.expedition = expeditionView;
      const previous = state.snapshot;
      state.snapshot = snapshot;
      state.lastError = null;
      broadcast("apogee:snapshot", snapshot);
      if (reason.startsWith("new run:") && previous &&
          previous.benchmark.name === snapshot.benchmark.name &&
          snapshot.player.benchmarkRank && previous.player.benchmarkRank &&
          JSON.stringify(previous.benchmark.rankNames) === JSON.stringify(snapshot.benchmark.rankNames) &&
          snapshot.benchmark.rankNames.indexOf(snapshot.player.benchmarkRank) >
            previous.benchmark.rankNames.indexOf(previous.player.benchmarkRank) &&
          snapshot.player.benchmarkEnergy > previous.player.benchmarkEnergy) {
        broadcast("apogee:benchmarkPromotion", { from: previous.player.benchmarkRank, to: snapshot.player.benchmarkRank });
      }
      if (syncs[0]) applyQuestSync(syncs[0]);
    } else {
      // A new KovaaK's install is a normal state, not a failure: the folder is right and
      // the watcher picks up the first run the moment it lands.
      state.lastError = null;
      notify("Folder found. Play any scenario in KovaaK's and it will show up here.");
    }
  } catch (err) {
    state.lastError = friendlyError(err);
    broadcast("apogee:error", state.lastError);
  } finally {
    state.scanning = false;
    broadcast("apogee:scanning", { scanning: false, reason });
    // Timed into the log so a stutter in KovaaK's can be laid against what Apogee was
    // doing at that minute. A warm rebuild measured 44-144ms on a 13,861-run folder and a
    // cold one 54s, so a line here past a second is the thing worth asking about.
    log(`rebuild (${reason}) ${Math.round(performance.now() - startedAt)}ms`);
  }
}

function scheduleRebuild(reason: string): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild(reason), REBUILD_DEBOUNCE_MS);
}

function startWatching(dir: string): void {
  watcher?.close();
  state.statsDir = dir;
  observedBests.clear();

  watcher = watchStatsFolder(dir, {
    onRun: (run, file) => {
      // Surface the run immediately. The snapshot rebuild follows, but the player
      // should see their run acknowledged the moment it lands, not a second later.
      const known = state.snapshot?.categories.flatMap(category => {
        if (!category || typeof category !== "object" || !("scenarios" in category) || !Array.isArray(category.scenarios)) return [];
        return category.scenarios.filter((scenario): scenario is { name: string; runs: number; score: number } =>
          scenario && typeof scenario === "object" && typeof scenario.name === "string" &&
          typeof scenario.runs === "number" && Number.isFinite(scenario.score));
      }).find(scenario => scenario.name === run.scenario);
      // A burst can arrive before the next snapshot. Compare with the preceding run too.
      const previousBest = known && known.runs > 0
        ? Math.max(known.score, observedBests.get(run.scenario) ?? -Infinity) : null;
      if (previousBest !== null) observedBests.set(run.scenario, Math.max(previousBest, run.score));
      broadcast("apogee:run", {
        scenario: run.scenario,
        score: run.score,
        playedAt: run.playedAt?.toISOString() ?? null,
        localPersonalBest: previousBest !== null && run.score > previousBest ? { previous: previousBest } : null,
        file,
      });

      // A ghost match in progress takes the first run on each of its scenarios. Its own
      // try: a ghost failure must not cost a ranked submission below.
      try {
        ghost.onRun(run, file);
      } catch (err) {
        console.error("ghost run failed:", err);
      }

      // If this scenario belongs to the active match, send it for verification without
      // being asked. Making the player click "submit" after every run would undo the
      // entire point of watching the folder.
      //
      // Every other run is history, and goes up now rather than whenever Upload history
      // is next pressed, so the next match is measured against what was actually played.
      void maybeSubmitForMatch(run.scenario, file).then((forMatch) => {
        if (!forMatch) void keepHistoryCurrent("new run", [file]);
      });

      scheduleRebuild(`new run: ${run.scenario}`);
    },
    onError: (err) => {
      state.lastError = err.message;
      broadcast("apogee:error", err.message);
    },
  });

  rebuild("initial scan");
  try {
    ghost.catchUp();
  } catch (err) {
    console.error("ghost catch-up failed:", err);
  }
  installScenarioFiles(dir);
  refreshInstalledPlaylists(dir);
}

/**
 * Put the season's scenario files into KovaaK's, rewriting any that differ.
 *
 * Every Season 1 scenario is Apogee's own and exists nowhere but in this app, and a ranked
 * run on one is refused unless KovaaK's hashed exactly the shipped file - so a missing file
 * is a scenario the player cannot open, and a stale one is a scenario whose runs cannot
 * count. See core/season/installScenarios.ts.
 */
function installScenarioFiles(statsDir: string): void {
  try {
    const { written, removed } = installSeasonScenarios(scenariosFolderFor(statsDir));
    if (written.length > 0 || removed.length > 0) {
      log(`scenario files: ${written.length} written, ${removed.length} removed`);
      notify(
        `Installed ${written.length} Apogee scenario${written.length === 1 ? "" : "s"}. ` +
        "If KovaaK's is open, restart it to load them.");
    }
  } catch (err) {
    console.warn("could not install the season's scenarios:", friendlyError(err));
  }
}

/**
 * Bring the practice playlists the player already installed up to this season. Their
 * names outlive a change of scenarios, so without this a player who installed before a
 * season changed kept practising the old pool.
 */
function refreshInstalledPlaylists(statsDir: string): void {
  try {
    const refreshed = refreshStalePlaylists(loadSeason(), playlistsFolderFor(statsDir));
    if (refreshed.length > 0) {
      notify(
        `Updated ${refreshed.length} Apogee playlist${refreshed.length === 1 ? "" : "s"} to this season's scenarios. ` +
        "If KovaaK's is open, restart it to load them.");
    }
  } catch (err) {
    console.warn("could not refresh installed playlists:", friendlyError(err));
  }
}

/**
 * Ask for the stats folder and start watching it.
 *
 * Shared by the button in the status bar and the menu item, because two ways to do the
 * same thing should not be two implementations of it.
 */
/** True when the folder holds at least one KovaaK's run file. */
function holdsRuns(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith(" Stats.csv"));
  } catch {
    return false;
  }
}

/**
 * The stats folder a pick most plausibly meant. The obvious guess is the game folder or
 * the Steam library, one or three levels above the real one, and saving that for good
 * left the player watching a folder that would never hold a run.
 */
function resolveStatsFolder(chosen: string): string | null {
  const tries = [chosen, join(chosen, "stats"), join(chosen, "FPSAimTrainer", "stats"),
    join(chosen, "FPSAimTrainer", "FPSAimTrainer", "stats"),
    join(chosen, "steamapps", "common", "FPSAimTrainer", "FPSAimTrainer", "stats"),
    join(chosen, "common", "FPSAimTrainer", "FPSAimTrainer", "stats")];
  return tries.find((dir) => existsSync(dir) && holdsRuns(dir))
    // A fresh install has the folder and no runs yet. That is the right folder too.
    ?? tries.find((dir) => /[\\/]FPSAimTrainer[\\/]stats$/i.test(dir) && existsSync(dir))
    ?? null;
}

async function chooseStatsFolder(): Promise<string | { error: string } | null> {
  const nearest = candidateStatsFolders().map((dir) => dirname(dir)).find((dir) => existsSync(dir));
  const result = await dialog.showOpenDialog({
    title: "Select your KovaaK's stats folder",
    properties: ["openDirectory"],
    defaultPath: state.statsDir ?? nearest ?? undefined,
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const chosen = resolveStatsFolder(result.filePaths[0]);
  if (!chosen) {
    return {
      error: "That folder has no KovaaK's stats. It is usually Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats.",
    };
  }

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
 * questions this answers are "which build", "which folder", "how many runs": the three
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
 * Keep what the rebuild made of the quest board, and announce what it paid.
 *
 * The board is measured inside the snapshot rebuild, which runs on every run that lands.
 * Progress is read from the stats folder rather than counted as events arrive, so a quest
 * finished with the app closed is paid the next time it opens, and payment is idempotent:
 * a quest with a completion stamp is never paid again, however many rebuilds happen.
 */
function applyQuestSync(sync: QuestSync): void {
  state.quests = sync.state;
  if (sync.changed) saveQuestState(state.quests);

  const level = levelFor(state.quests.totalXp);
  broadcast("apogee:progression", {
    totalXp: state.quests.totalXp,
    level,
    completedToday: state.quests.daily.filter((q) => q.completedAt).length,
  });

  for (const quest of sync.newlyCompleted) {
    broadcast("apogee:questComplete", { quest, level, xpAwarded: sync.xpAwarded });
  }
}

/**
 * Submit a freshly-played run if it is one the active match asked for.
 *
 * Only the first run per scenario counts. Without that, a player could keep replaying a
 * scenario until it went well and settle on the best attempt, which would make the
 * ladder measure patience rather than performance.
 *
 * Resolves true when the run was taken for the match, so the caller knows not to send
 * it again as history. A repeat of a scenario already counted is history.
 */
async function maybeSubmitForMatch(scenarioName: string, file: string): Promise<boolean> {
  const match = state.match;
  if (!match || !state.session || !state.statsDir) return false;

  const wanted = match.scenarios.find((s) => s.name === scenarioName);
  if (!wanted) return false;

  if (state.submitted.has(wanted.id)) {
    broadcast("apogee:matchProgress", {
      matchId: match.matchId,
      scenarioId: wanted.id,
      status: "already-submitted",
      message: `${scenarioName} already counted · first run per scenario only`,
    });
    return false;
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
    const message = friendlyError(err);
    broadcast("apogee:matchProgress", {
      matchId: match.matchId,
      scenarioId: wanted.id,
      status: "failed",
      message,
    });
  }

  return true;
}

/**
 * Send ordinary runs up as history: one as it lands, or on the way in, whatever was
 * played while the app was shut.
 *
 * Best effort. Upload history still exists, and a failure here costs a baseline a few
 * runs stale, not a run.
 */
async function keepHistoryCurrent(reason: string, only?: string[]): Promise<void> {
  // A backfill in progress is already sending all of it.
  if (!state.session || !state.statsDir || state.uploading) return;

  try {
    const result = await uploadRecentRuns(state.statsDir, state.session.playerId, only);
    if (result.errors.length) console.warn(`history upload (${reason}): ${result.errors.join("; ")}`);
  } catch (err) {
    console.warn(`history upload (${reason}): ${friendlyError(err)}`);
  }
}

/**
 * Retries after a failed settle. Every run is already in when settle is called, so a
 * failure here used to leave the player one way out - Abandon, which forfeits a match
 * they finished - and waiting it out expired the match as a forfeit too. One network
 * blip turned a possible win into a loss.
 */
const SETTLE_RETRY_MS = [2_000, 5_000, 15_000, 30_000];
let settleRetry: NodeJS.Timeout | null = null;

/**
 * Take the runs already filed against a recovered match as submitted, and settle it if
 * that is all three. A restart used to forget them, ask for them again, and never settle.
 */
function seedSubmitted(match: FoundMatch): void {
  state.submitted = new Set(match.submittedScenarioIds ?? []);
  if (match.scenarios.length > 0 && match.scenarios.every((s) => state.submitted.has(s.id))) {
    void settleActiveMatch();
  }
}

/** Settle the active match. Resolves with an error message when it could not, else null. */
async function settleActiveMatch(attempt = 0): Promise<string | null> {
  const match = state.match;
  if (!match) return null;
  if (settleRetry) {
    clearTimeout(settleRetry);
    settleRetry = null;
  }

  try {
    const settled = await settleMatch(match.matchId);
    state.match = null;
    state.submitted.clear();
    shareCards.recordSettled(settled, !!match.duel?.to);
    // `sentDuel` rides along because a duel you sent settles exactly like a seeding match
    // (one side, nobody yet) and the payload cannot tell them apart. Ghost Mode's
    // "nobody in the pool yet" offer is wrong about somebody you just named.
    broadcast("apogee:matchSettled", { ...settled, sentDuel: !!match.duel?.to });
    nudge();
    // Ranked quests are measured from results the server settled, never from anything
    // the client worked out. Kept locally because nothing re-sends a settled match.
    state.quests = recordMatch(state.quests ?? loadQuestState(), {
      id: settled.matchId,
      at: new Date().toISOString(),
      verdict: settled.verdict,
      seeding: settled.seeding === true,
      category: settled.category ?? null,
    });
    saveQuestState(state.quests);
    scheduleRebuild("match settled");
    // A settled leg can decide a fixture, open the next round or crown somebody.
    if (settled.tournament) void refreshTournaments("a fixture leg settled");
    // Duel buttons read the active match when drawn; redraw them now it is gone.
    void refreshDuels("match settled", true);
    return null;
  } catch (err) {
    const message = friendlyError(err);
    const retrying = attempt < SETTLE_RETRY_MS.length;
    broadcast("apogee:matchProgress", { matchId: match.matchId, status: "settle-failed", message, retrying });
    if (retrying) {
      settleRetry = setTimeout(() => {
        settleRetry = null;
        if (state.match?.matchId === match.matchId) void settleActiveMatch(attempt + 1);
      }, SETTLE_RETRY_MS[attempt]);
    }
    return message;
  }
}

/**
 * Where to open the window.
 *
 * A remembered position is only honoured if it still lands on a display that exists.
 * Unplugging a second monitor otherwise reopens the app at coordinates nothing can
 * reach, and the fix (delete a JSON file you have never heard of) is not one anybody
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
    backgroundColor: DARK_CHROME.ground,
    show: false,
    title: "Apogee",
    // The app draws its own top bar. `hidden` with an overlay rather than a fully
    // frameless window: the operating system keeps drawing minimise, maximise and
    // close, so they behave exactly as they do everywhere else, and the only thing
    // this side owns is the strip they sit on. The renderer marks that strip as a
    // drag region, and reserves the width the overlay reports.
    titleBarStyle: "hidden",
    // Opaque, and matched to the top bar rather than transparent: a translucent
    // overlay is not supported everywhere, and the failure mode is a light grey
    // block in the corner of a black app.
    // Read from DARK_CHROME rather than written out again: these were the fourth
    // hand-written copy of the palette, and they went stale the moment the ink ramp
    // was lifted for the orb field while this kept the old --ink-mid.
    titleBarOverlay: {
      color: DARK_CHROME.ground,
      symbolColor: DARK_CHROME.inkMid,
      height: 46,
    },
    // The menu is entirely duplicated by buttons on screen, and a Windows menu bar
    // under a custom title bar is a second row of chrome for nothing. Hidden, not
    // removed: every accelerator in it still fires.
    autoHideMenuBar: true,
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

  attachRendererLogging(window.webContents);

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

// The failure-surface probe rejects a promise on purpose; this marks that rejection so
// its own console error is not counted as a renderer error.
const SMOKE_FAILURE_MARKER = "apogee smoke probe";

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

// Before anything else can throw: a packaged app has no terminal for a stack trace
// to land in, so an uncaught error would otherwise leave a window that simply stops
// working with nothing anywhere to say why.
installCrashHandlers();
if (SMOKE) suppressCrashDialogs();
log(`built ${BUILD}`);

const HAS_LOCK = SMOKE || app.requestSingleInstanceLock();
if (!HAS_LOCK) {
  console.log(
    "another Apogee instance already holds the lock, so this one is quitting and the " +
      "existing window will be focused. That window is running whatever bundle it " +
      "started with - close it fully before `npm start` to pick up a new build.",
  );
  // exit, not quit: quit waits for ready, and the ready handler below then ran the whole
  // startup - window, session restore, a full stats rebuild - racing the real instance.
  app.exit(0);
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
  let offline = false;

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
        // Hand it to the probe window, not just to this console.
        //
        // It used to be built, printed and dropped, so `getState` handed the renderer
        // nothing and every data-driven screen stayed empty behind a window that
        // reported "renders". The smoke test was checking that the shell loads, which is
        // the smallest part of what it is for - and it is why an empty Season screen
        // could not be caught here.
        state.snapshot = snapshot;
        console.log(`runs         : ${snapshot.player.totalRuns}`);
        console.log(`benchmark    : ${snapshot.benchmark.name} ${snapshot.benchmark.difficulty}` +
          ` (${snapshot.player.benchmarkRank})`);
        console.log(`apogee tier  : ${snapshot.player.apogee.tier.name}`);
        console.log(`weakest      : ${snapshot.weakest}`);
        console.log(`quests       : ${snapshot.quests.daily.length} daily, ` +
          `${snapshot.quests.weekly ? 1 : 0} weekly`);
      }
    } catch (err) {
      problems.push(`snapshot threw: ${friendlyError(err)}`);
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
    if (level >= 2 && !message.includes(SMOKE_FAILURE_MARKER)) rendererLogs.push(message);
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
    // Only an explicit --allow-offline says otherwise, and the summary line repeats it.
    if (!isConfigured()) {
      if (ALLOW_OFFLINE) offline = true;
      else problems.push("built without Supabase settings; fill in .env and rebuild");
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
    } else if (button.disabled && !(offline && button.text === "Sign-in unavailable")) {
      // Disabled is what an unconfigured build is meant to show, so --allow-offline accepts
      // exactly that state and no other: a disabled button saying anything else still fails.
      problems.push(`the sign-in button is disabled (${button.text})`);
    } else if (!button.listeners) {
      // A button that is present, visible and enabled with nothing bound to it looks
      // identical to a working one from out here, and is the exact failure a smoke test
      // exists to catch. The probe above computed this from the start and nothing ever
      // read it, which is the vacuous-assertion pattern: a check that cannot fail hides
      // the thing it was written for.
      problems.push("the sign-in button is present but nothing is bound to it");
    }

    console.log(
      `supabase     : ${isConfigured() ? "configured" : offline ? "MISSING (allowed by --allow-offline)" : "MISSING"}`,
    );
    console.log(`sign-in      : ${hasSignIn ? "wired" : "MISSING"}`);
    console.log(
      `button       : ${
        button.present
          ? `${button.hidden ? "hidden" : "visible"}, ${button.disabled ? "disabled" : "enabled"}, "${button.text}"`
          : "MISSING"
      }`,
    );
    // The footer link that carries a bug report. Checked the same way as sign-in and for
    // the same reason: it is present, visible and bound, and the text it copies is real.
    // The menu item beside it was reachable only behind Alt, so this is the path anybody
    // will actually find, and a dead one costs a report nobody knows was lost.
    const report = await probe.webContents.executeJavaScript(`(() => {
      const a = document.getElementById("reportProblem");
      if (!a) return { present: false };
      const s = getComputedStyle(a);
      return {
        present: true,
        href: a.getAttribute("href") || "",
        display: s.display,
        visibility: s.visibility,
        bridged: typeof window.apogee?.diagnostics === "function",
      };
    })()`);

    const support = diagnostics();

    if (!report.present) problems.push("the report-a-problem link is not in the DOM");
    else if (report.display === "none" || report.visibility === "hidden") {
      problems.push("the report-a-problem link is present but not visible");
    } else if (!report.href) {
      problems.push("the report-a-problem link has no href to fall back on");
    } else if (!report.bridged) {
      problems.push("the report-a-problem link cannot reach diagnostics over the bridge");
    } else if (!support.trim()) {
      problems.push("diagnostics came back empty, so the link would copy nothing");
    }

    console.log(
      `report link  : ${
        report.present
          ? `${report.display === "none" ? "hidden" : "visible"}, ` +
            `${support.trim().length} characters of diagnostics`
          : "MISSING"
      }`,
    );
    // Ghost Mode round trip: the bridge answers, main builds the screen, and the page drew
    // it. A missing handler here is the "No handler registered" of a stale bundle, which
    // is the failure CLAUDE.md warns makes every button do nothing.
    const ghostProbe = await probe.webContents.executeJavaScript(`(async () => {
      if (typeof window.apogee?.ghost !== "function") return { bridged: false };
      const screen = await window.apogee.ghost();
      await new Promise((r) => setTimeout(r, 100));
      return {
        bridged: true,
        error: screen?.error ?? null,
        kinds: Array.isArray(screen?.kinds) ? screen.kinds.map((k) => k.kind + (k.available ? "+" : "-")).join(" ") : null,
        tab: !!document.querySelector('.tab[data-screen="ghost"]'),
        drawn: (document.getElementById("ghostRoot")?.textContent ?? "").includes("Race your past self"),
      };
    })()`);
    if (!ghostProbe.bridged) problems.push("Ghost Mode is not on the preload bridge");
    else if (ghostProbe.error) problems.push(`Ghost Mode's screen failed: ${ghostProbe.error}`);
    else if (!ghostProbe.kinds || ghostProbe.kinds.split(" ").length !== 3) problems.push("Ghost Mode did not offer three ghosts");
    else if (!ghostProbe.tab || !ghostProbe.drawn) problems.push("Ghost Mode's tab or screen is missing from the page");
    console.log(`ghost mode   : ${ghostProbe.bridged ? ghostProbe.kinds ?? "no screen" : "MISSING"}`);
    console.log(`session      : ${state.session ? state.session.displayName : "signed out"}`);

    // The renderer's failure surface, proved rather than assumed. An unhandled rejection
    // used to leave the screen half-rendered with nothing anywhere saying so - which is
    // how `api is not defined` sat in a shipped build. Checking that a handler is
    // *registered* would pass whether or not it reaches the screen, so this rejects for
    // real and fails unless the banner ends up carrying the message.
    const surfaced = await probe.webContents.executeJavaScript(`(async () => {
      const banner = document.getElementById("banner");
      if (!banner) return { present: false };
      const before = { cls: banner.className, text: banner.textContent };
      Promise.reject(new Error(${JSON.stringify(SMOKE_FAILURE_MARKER)}));
      await new Promise((r) => setTimeout(r, 150));
      const seen = { present: true, on: banner.classList.contains("on"), text: banner.textContent };
      banner.className = before.cls;
      banner.textContent = before.text;
      return seen;
    })()`);

    if (!surfaced.present) problems.push("the error banner is not in the DOM");
    else if (!surfaced.on || !surfaced.text.includes(SMOKE_FAILURE_MARKER)) {
      problems.push("an unhandled rejection never reaches the banner");
    }
    console.log(`failures     : ${surfaced.on ? "surfaced to the banner" : "SILENT"}`);

    if (rendererLogs.length > 0) {
      console.log(`\nrenderer errors:`);
      for (const l of rendererLogs.slice(0, 8)) console.log(`  ${l}`);
      problems.push(`${rendererLogs.length} renderer error(s)`);
    }

    const rendered = await probe.webContents.executeJavaScript(
      "document.getElementById('shellCheck') !== null || document.querySelectorAll('.tab').length",
    );
    if (!rendered) problems.push("renderer produced no tabs");

    // The Season screen is the only way to play the pool outside a match, and nothing
    // else here touches it: the queue renders whether or not it works.
    //
    // Two things are checked and they are not the same thing. The handler is checked
    // unconditionally, because it is the data the screen cannot exist without. The screen
    // itself is checked only once a snapshot has actually rendered - this probe window
    // does not always get one, and an assertion that can only fail is worse than none.
    const practice = await probe.webContents.executeJavaScript(`(async () => {
      const tab = document.querySelector('.tab[data-screen="seasonview"]');
      if (tab) tab.click();

      const data = await window.apogee
        .practice()
        .then((r) => (r && r.error ? { err: String(r.error).slice(0, 160) } : r))
        .catch((e) => ({ err: String(e).slice(0, 160) }));

      // The snapshot drives every screen here, and it arrives over IPC. Wait for it
      // rather than assume it, and say plainly when it never came.
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline && document.querySelectorAll("#svCats .sv-cat").length === 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 150));

      return {
        tab: Boolean(tab),
        host: document.getElementById("svPool") !== null,
        err: data.err ?? null,
        scenarios: Array.isArray(data.scenarios) ? data.scenarios.length : -1,
        families: Array.isArray(data.families) ? data.families.length : -1,
        playlists: Array.isArray(data.playlists) ? data.playlists.length : -1,
        named: Array.isArray(data.families) ? data.families.filter((f) => f.next).length : -1,
        painted: document.querySelectorAll("#svCats .sv-cat").length > 0,
        bands: document.querySelectorAll("#svDiffs .pool-band").length,
        cats: document.querySelectorAll("#svCatNav .pool-nav-item").length,
        rows: document.querySelectorAll("#svPool .pool-row").length,
        subs: document.querySelectorAll("#svPool .pool-sub").length,
        next: document.querySelectorAll("#svPool .pool-row.next").length,
        fills: [...document.querySelectorAll("#svPool .pool-row")].filter(
          (r) => r.style.getPropertyValue("--fill") !== "",
        ).length,
        nums: document.querySelectorAll("#svPool .pool-num").length,
        chips: document.querySelectorAll("#svChips .pool-chip").length,
        marks: document.querySelectorAll("#svChips .pool-chip .mark").length,
        stated: [...document.querySelectorAll("#svChips .pool-chip")].filter(
          (c) => c.getAttribute("aria-pressed") !== null,
        ).length,
        chipsIn: document.querySelectorAll("#svChips .pool-chip.is-installed").length,
        legend: (document.getElementById("svChipLegend")?.textContent ?? "").length,
        play: document.querySelector("#svPool .pool-row .scen-play") !== null,
      };
    })()`);

    if (!practice.tab) problems.push("the Season tab is not in the DOM");
    if (!practice.host) problems.push("the Season screen has nowhere to list the pool");
    if (practice.err) problems.push(`the practice list failed: ${practice.err}`);
    else if (practice.scenarios <= 0) problems.push("the practice list is empty");
    else if (practice.families <= 0) problems.push("the practice list has no families");
    else if (practice.named <= 0) {
      // Every family names one variant to play next unless it is maxed, and a whole pool
      // maxed on the machine running a smoke test is not a state worth allowing for.
      problems.push("no family says which scenario to play next");
    }
    if (practice.playlists <= 0) problems.push("the season implies no practice playlists");

    // Only once something snapshot-driven is on screen is the panel's absence meaningful.
    if (practice.painted) {
      if (practice.bands === 0) problems.push("the Season screen offers no difficulty to pick");
      // "All categories" plus at least one: a rail with only the first is no choice.
      else if (practice.cats < 2) problems.push("the Season screen offers no category to pick");
      else if (practice.rows === 0) problems.push("the Season screen lists no scenarios to play");
      else if (practice.subs === 0) problems.push("the Season screen groups nothing by sub-skill");
      else if (!practice.play) problems.push("the Season screen has no Play button");
      // A chip that cannot say whether that playlist is already in KovaaK's is the bug
      // this replaced: the only way to find out was to click it and watch. Counting the
      // chips alone would pass with every one of them mute, which is the state that was
      // wrong, so the mark and the pressed state are what get counted.
      else if (practice.marks !== practice.chips) {
        problems.push(
          `${practice.chips - practice.marks} playlist chip(s) draw no installed mark`,
        );
      } else if (practice.stated !== practice.chips) {
        problems.push(
          `${practice.chips - practice.stated} playlist chip(s) do not say whether they are installed`,
        );
      } else if (practice.legend === 0) {
        problems.push("the playlist chips carry a mark with nothing saying what it means");
      } else if (practice.fills !== practice.rows) {
        // Progress is the row's own ground now, so a row with no --fill is not a row
        // missing a decoration - it is a row that silently claims no progress at all.
        problems.push("not every row carries its progress");
      } else if (practice.nums !== practice.rows) {
        problems.push("not every row says what it wants next");
      } else if (practice.chips === 0) {
        problems.push("the Season screen offers no playlist to install");
      } else if (practice.next === 0) {
        // The band it opens on is the one holding the most of the player's next ranks,
        // so a band with none of them showing means the default picked the wrong one.
        problems.push("the band it opened on has nothing marked to play next");
      }
    }

    console.log(
      `season pool  : ${
        practice.err
          ? `FAILED (${practice.err})`
          : `${practice.scenarios} scenarios, ${practice.families} families, ` +
            `${practice.playlists} playlists` +
            (practice.painted
              ? `, ${practice.bands} bands, ${practice.rows} rows in ${practice.subs} ` +
                `sub-skills, ${practice.next} to play next, ${practice.chips} playlist ` +
                `chips (${practice.chipsIn} installed, ${practice.marks} marked), ` +
                `Play ${practice.play ? "wired" : "MISSING"}`
              : ", screen not painted (no snapshot in this window)")
      }`,
    );

    // The Scenarios screen paints the same practice list, so it is held to that list: one
    // row per scenario with the filters at All, and a rank name on exactly the rows the
    // core says hold one. Both are counted against the IPC result rather than a fixed
    // number, so the check can fail on any machine's history, including an empty one.
    const scenarioRanks = await probe.webContents.executeJavaScript(`(async () => {
      const tab = document.querySelector('.tab[data-screen="scenarios"]');
      if (tab) tab.click();
      const data = await window.apogee.practice().catch(() => null);
      const want = data && Array.isArray(data.scenarios) ? data.scenarios : [];
      const deadline = Date.now() + 2500;
      while (
        Date.now() < deadline &&
        document.querySelectorAll("#scRanksBody tr.sc-row").length < want.length
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const rows = [...document.querySelectorAll("#scRanksBody tr.sc-row")];
      return {
        tab: Boolean(tab),
        want: want.length,
        wantRanked: want.filter((s) => s.rankIndex !== null).length,
        rows: rows.length,
        ranked: rows.filter((r) => r.dataset.rank !== "").length,
      };
    })()`);

    if (!scenarioRanks.tab) problems.push("the Scenarios tab is not in the DOM");
    else if (scenarioRanks.want > 0) {
      if (scenarioRanks.rows !== scenarioRanks.want) {
        problems.push(
          `the Scenarios screen lists ${scenarioRanks.rows} of ${scenarioRanks.want} scenarios`,
        );
      } else if (scenarioRanks.ranked !== scenarioRanks.wantRanked) {
        problems.push(
          `the Scenarios screen names a rank on ${scenarioRanks.ranked} scenarios ` +
            `where the core holds ${scenarioRanks.wantRanked}`,
        );
      }
    }
    console.log(
      `scenario ranks: ${scenarioRanks.rows} rows, ${scenarioRanks.ranked} ranked ` +
        `(core: ${scenarioRanks.want}, ${scenarioRanks.wantRanked})`,
    );

    // The apex board renders from committed data rather than the snapshot, so it is
    // probed on its own: a build shipped without the sampled boards would leave the
    // screen empty, and empty here reads as a bad score rather than as a missing file.
    const apex = await probe.webContents.executeJavaScript(`(async () => {
      // Apex lives on the Season screen now, not a tab of its own.
      const tab = document.querySelector('.tab[data-screen="seasonview"]');
      if (tab) tab.click();

      const data = await window.apogee
        .apex()
        .then((r) => (r && r.error ? { err: String(r.error).slice(0, 160) } : r))
        .catch((e) => ({ err: String(e).slice(0, 160) }));

      const deadline = Date.now() + 2500;
      while (
        Date.now() < deadline &&
        document.querySelectorAll("#apexCategories .panel").length === 0
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }

      return {
        tab: Boolean(tab),
        err: data.err ?? null,
        categories: Array.isArray(data.categories) ? data.categories.length : -1,
        graded: typeof data.graded === "number" ? data.graded : -1,
        families: typeof data.total === "number" ? data.total : -1,
        points: typeof data.points === "number" ? data.points : -1,
        panels: document.querySelectorAll("#apexCategories .panel").length,
        rows: document.querySelectorAll("#apexCategories tbody tr").length,
        placed: [...document.querySelectorAll("#apexCategories tbody tr")].filter((r) =>
          /#[\\d,]+ of/.test(r.children[3] ? r.children[3].textContent : ""),
        ).length,
        // A board people are meant to chase has to say what to chase. Counted rather
        // than assumed: adding the column and never rendering into it would look
        // exactly like a rendered page.
        targets: [...document.querySelectorAll("#apexCategories tbody tr")].filter((r) =>
          /\\u2192 #[\\d,]+/.test(r.children[5] ? r.children[5].textContent : ""),
        ).length,
        // The public board needs a session, so signed out it must degrade to a
        // sentence rather than an empty panel. The tabs come from local data and
        // should be there either way.
        tabs: document.querySelectorAll("#apexTabs .apex-tab").length,
        // A board position read from a committed sample must say which day it is
        // from. Dropping that turns a dated fact into a wrong current one, and
        // nothing else would notice.
        datedBoards: /boards as of/.test(
          document.getElementById("apexNote")?.textContent ?? "",
        ),
        note: document.getElementById("apexNote")?.textContent ?? "",
        boardPanel: document.getElementById("apexBoardBody") !== null,
        boardNote: (
          document.getElementById("apexBoardNote")?.textContent ?? ""
        ).trim().length,
      };
    })()`);

    // No season scenario has a KovaaK's board until they are shared in-game: that is a
    // state to say, not a failure, and the check is that the screen says it.
    const unsampled = apex.err === APEX_UNSAMPLED;
    if (!apex.tab) problems.push("the Apex tab is not in the DOM");
    if (unsampled) {
      if (!apex.note.includes("No KovaaK's leaderboard")) problems.push("the apex board does not say its boards are unsampled");
    } else if (apex.err) problems.push(`the apex board failed: ${apex.err}`);
    else if (apex.categories <= 0) problems.push("the apex board has no categories");
    else if (apex.panels === 0) problems.push("the apex board painted no categories");
    else if (apex.rows !== apex.families) {
      problems.push("the apex board does not list every family");
    } else if (apex.graded > 0 && apex.placed === 0) {
      // A scored family that shows no board position means the sampled boards are
      // absent or unreadable, which is the one failure this screen can have that
      // still looks like a rendered page.
      problems.push("no scored family shows a board position");
    } else if (apex.graded > 0 && !(apex.points > 0)) {
      problems.push("the apex board scored families but no points");
    } else if (apex.graded > 0 && apex.targets === 0) {
      problems.push("no scored family says what to chase next");
    } else if (apex.graded > 0 && !apex.datedBoards) {
      problems.push("the apex board does not say when its boards were sampled");
    }

    if (!apex.boardPanel) problems.push("the Apex screen has nowhere to list the leaderboard");
    // One per category plus the derived overall; unsampled, there are no categories to tab.
    else if (!unsampled && apex.tabs !== apex.categories + 1) {
      problems.push("the leaderboard does not offer a tab per category");
    } else if (apex.boardNote === 0) {
      // Signed out this is the line telling somebody why the board is empty. Blank
      // is the state that looks like a bug and reads like nothing.
      problems.push("the leaderboard says nothing about why it is empty");
    }

    console.log(
      `apex board   : ${
        unsampled
          ? "no season scenario has a sampled board yet, and the screen says so"
          : apex.err
          ? `FAILED (${apex.err})`
          : `${apex.points.toFixed(2)} points, ${apex.graded}/${apex.families} families ` +
            `scored, ${apex.placed} placed, ${apex.targets} with a next target, ` +
            `${apex.panels} categories painted, ${apex.tabs} board tabs`
      }`,
    );
    // The Ranks screen draws one card per band per category, and the three states it
    // distinguishes - unplayed, played but under the first threshold, holding a rank -
    // are the whole point of the split. Counting cards alone would pass on a screen that
    // painted every band identically, so the states are counted too.
    const ranks = await probe.webContents.executeJavaScript(`(() => {
      const tab = document.querySelector('.tab[data-screen="ranks"]');
      if (tab) tab.click();
      const cards = [...document.querySelectorAll("#catRanks .band-card")];
      return {
        cats: document.querySelectorAll("#catRanks .cat-rank").length,
        cards: cards.length,
        held: cards.filter((c) => c.classList.contains("held")).length,
        pips: cards.every((c) => c.querySelectorAll(".pip").length > 0),
        named: cards.every((c) => (c.querySelector(".band-rank")?.textContent ?? "").trim() !== ""),
        legend: document.querySelectorAll("#catRanks .band-title").length,
        perCat: [...document.querySelectorAll("#catRanks .cat-rank")].map(
          (c) => c.querySelectorAll(".band-card").length,
        ),
      };
    })()`);

    if (ranks.cats === 0) problems.push("the Ranks screen paints no category");
    else if (ranks.cards === 0) {
      // A season split into bands that draws none of them is the exact regression this
      // whole change could suffer silently: the old chained strip looked almost the same.
      problems.push("the Ranks screen shows no bands");
    } else if (ranks.perCat.some((n: number) => n !== ranks.perCat[0])) {
      // Every category is cut into the same windows, so an uneven count means one
      // category dropped a band rather than that it legitimately has fewer.
      problems.push("the categories do not all show the same number of bands");
    } else if (!ranks.pips) problems.push("a band card shows no ranks to climb");
    else if (!ranks.named) problems.push("a band card does not say where the player stands");
    else if (ranks.legend !== ranks.cards) problems.push("a band card does not name its band");

    console.log(
      `band ranks   : ${ranks.cards} cards over ${ranks.cats} categories, ` +
        `${ranks.held} held`,
    );


    // Every readout that is counted rather than written.
    //
    // A counter is handed an element found by selector inside markup this file also
    // builds, and the two can part company without anything throwing: countTo returns
    // quietly on a null element, the span stays empty, and a number disappears off the
    // screen while everything still renders. That is invisible from out here unless it
    // is looked for, so it is looked for.
    const counted = await probe.webContents.executeJavaScript(`(() => {
      const classes = [
        "band-pct", "held-n", "you-pc", "c-best", "c-gap",
        "sv-played", "sub-played",
      ];
      const out = { total: 0, empty: [], byClass: {} };
      for (const c of classes) {
        const found = [...document.querySelectorAll("." + c)];
        out.byClass[c] = found.length;
        out.total += found.length;
        for (const el of found) {
          if (!el.textContent.trim()) out.empty.push(c);
        }
      }
      // The season panel's five headline cells, which are built a different way.
      const cells = [...document.querySelectorAll("#svStats .v")];
      out.svStats = cells.length;
      out.total += cells.length;
      for (const el of cells) if (!el.textContent.trim()) out.empty.push("sv-stat");
      return out;
    })()`);

    if (counted.total === 0) {
      problems.push("no counted readouts were drawn at all, so nothing here was checked");
    } else if (counted.empty.length > 0) {
      problems.push(
        `${counted.empty.length} counted readout(s) came out empty: ` +
        [...new Set(counted.empty)].join(", "),
      );
    } else {
      console.log(
        `counted      : ${counted.total} readouts, none empty ` +
        `(${counted.byClass["c-gap"]} gaps, ${counted.byClass["band-pct"]} band bars, ` +
        `${counted.svStats} season cells)`,
      );
    }

    // Clicking a band opens its own page, so the check clicks one. Asserting that the
    // markup exists would pass on a page that never filled, and this screen is built
    // entirely at click time - nothing about it is in the HTML.
    //
    // The *last* band of the first category, not the first. Only the top band carries the
    // rank held by a place on the board, and opening Novice tests every path except the
    // one that is easiest to get wrong. The first draft of this check clicked the first
    // card and failed for that reason.
    const band = await probe.webContents.executeJavaScript(`(() => {
      const cards = document.querySelectorAll("#catRanks .cat-rank:first-child .band-card");
      const card = cards[cards.length - 1];
      if (!card) return { opened: false };
      card.click();
      const rows = [...document.querySelectorAll("#bandMatrix tbody tr")];
      return {
        opened: document.getElementById("screen-band")?.classList.contains("active") ?? false,
        title: (document.getElementById("bandTitle")?.textContent ?? "").trim(),
        rungs: document.querySelectorAll("#bandLadder .band-rung").length,
        columns: document.querySelectorAll("#bandMatrix thead th").length,
        rows: rows.length,
        cells: document.querySelectorAll("#bandMatrix td.cell").length,
        cleared: document.querySelectorAll("#bandMatrix td.cell.cleared").length,
        next: document.querySelectorAll("#bandMatrix td.cell.next").length,
        positional: [...document.querySelectorAll("#bandLadder .cost")].some(
          (e) => (e.textContent ?? "").includes("on the board"),
        ),
        back: !!document.getElementById("bandBack"),
      };
    })()`);

    if (!band.opened) problems.push("clicking a band does not open its page");
    else if (!band.title) problems.push("the band page does not say which band it is");
    else if (band.rungs === 0) problems.push("the band page lists no ranks");
    else if (!band.positional) {
      // The one rank a score cannot buy. If it prints an energy figure like the others,
      // the page is inventing a threshold for a rank that has none.
      problems.push("the band page does not mark the rank held by board place");
    } else if (band.rows === 0) problems.push("the band page shows no scenarios");
    else if (band.cells === 0) problems.push("the band page asks nothing of any scenario");
    else if (band.next === 0 && band.cleared === 0) {
      problems.push("the band page marks no cell as cleared or next");
    } else if (!band.back) problems.push("the band page has no way back");

    console.log(
      `band detail  : ${band.opened ? `"${band.title}"` : "DID NOT OPEN"}, ` +
        `${band.rungs} ranks, ${band.rows}x${band.columns - 2} grid, ` +
        `${band.cleared} cleared, ${band.next} next`,
    );

    // Left where it was found, or a later check reads a screen nobody asked for.
    await probe.webContents.executeJavaScript(
      `document.querySelector('.tab[data-screen="ranks"]')?.click()`,
    );

    // The override machinery has to have captured the markup's own words before
    // anything paints over them, because those defaults are what Reset resets to and
    // they are unrecoverable once overwritten. Which elements may carry a key at all is
    // a static question and `npm run audit:look` answers it; this is the runtime half:
    // that the capture happened, and how much copy it covers.
    const copy = await probe.webContents.executeJavaScript(
      'typeof copyDefaults === "undefined" ? null : copyDefaults.size',
    );
    if (copy === null) {
      problems.push("the copy defaults were never captured, so Reset has nothing to restore");
    } else if (copy === 0) {
      problems.push("no authored copy was found, so the copy editor would be empty");
    }
    console.log(`copy keys    : ${copy === null ? "NOT CAPTURED" : `${copy} authored`}`);

    // The duel bridge, and the wiring that puts a match on screen.
    //
    // Pushed down the real channel rather than by calling the painter: the bug this
    // covers is that `onMatch` used to set a variable and paint nothing, so a match
    // recovered on restart left an empty Play screen while the watcher submitted runs
    // against a match the player could not see. Calling the painter directly would prove
    // the painter works and say nothing about whether anything calls it.
    const bridgeGaps = await probe.webContents.executeJavaScript(
      `["duels", "sendDuel", "answerDuel", "setFriend", "onDuels"]
         .filter((k) => typeof window.apogee[k] !== "function")`,
    );
    if (bridgeGaps.length > 0) {
      problems.push(`the duel bridge is missing: ${bridgeGaps.join(", ")}`);
    }

    probe.webContents.send("apogee:match", {
      matchId: "smoke",
      category: "Static Clicking",
      difficulty: "Intermediate",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scenarios: [
        { id: 1, name: "one" },
        { id: 2, name: "two" },
        { id: 3, name: "three" },
      ],
      opponent: null,
      seeding: true,
      winProbability: null,
      poolSize: 0,
      duel: { id: "d", to: "somebody" },
    });

    const painted = await probe.webContents.executeJavaScript(`(async () => {
      await new Promise((r) => setTimeout(r, 120));
      const shown = {
        on: document.getElementById("opponent").classList.contains("on"),
        named: document.getElementById("oppName").textContent,
        verb: document.getElementById("queueVerb").textContent,
      };
      return shown;
    })()`).catch((err) => ({ failed: String(err && err.message ? err.message : err) }));

    if (painted.failed) {
      problems.push(`the match broadcast threw: ${painted.failed}`);
    } else if (!painted.on) {
      problems.push("a match pushed to the client never reaches the screen");
    } else if (painted.named !== "somebody") {
      problems.push(`a duel names "${painted.named}" rather than who it was sent to`);
    }

    // Clear it the same way, which also exercises the other half of the handler.
    probe.webContents.send("apogee:match", null);
    const cleared = await probe.webContents.executeJavaScript(`(async () => {
      await new Promise((r) => setTimeout(r, 120));
      return document.getElementById("opponent").classList.contains("on");
    })()`).catch(() => true);
    if (cleared) problems.push("clearing the match leaves its panel on screen");

    // The panel, driven with a board rather than a live session.
    //
    // This account is signed out, so list-duels would refuse it and the panel would stay
    // empty forever - which is exactly the shape of an assertion that can only pass. So
    // renderDuels is handed a board directly: what is under test is that a duel becomes a
    // row with two answers, that a name reaches the screen, and that the score never does.
    const panel = await probe.webContents.executeJavaScript(`(() => {
      if (typeof renderDuels !== "function") return null;
      renderDuels(null);
      const hiddenWhenSignedOut = document.getElementById("duels").hidden;

      renderDuels({
        incoming: [
          { id: "a", from: { playerId: "p1", displayName: "ready one", rating: 1500,
              provisional: false, lastPlayedAt: null, friend: false },
            status: "open", createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(), ready: true },
          { id: "b", from: { playerId: "p2", displayName: "still playing", rating: 1400,
              provisional: true, lastPlayedAt: null, friend: false },
            status: "open", createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(), ready: false },
        ],
        outgoing: [
          { id: "c", to: { playerId: "p3", displayName: "sent to", rating: 1600,
              provisional: false, lastPlayedAt: null, friend: false },
            status: "open", createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            answeredAt: null, played: true },
        ],
        roster: [], friends: [],
      });

      const rows = [...document.querySelectorAll("#duelList .duel-row")];
      const accepts = [...document.querySelectorAll("#duelList button")]
        .filter((b) => b.textContent === "Accept");

      const shown = {
        hiddenWhenSignedOut,
        visible: !document.getElementById("duels").hidden,
        rows: rows.length,
        names: rows.map((r) => r.querySelector(".duel-name").textContent),
        acceptEnabled: accepts.map((b) => !b.disabled),
        chip: document.getElementById("duelLive").hidden,
        chipText: document.getElementById("duelLiveText").textContent,
        // Nothing on this panel may carry a score or a delta. It is not in the payload by
        // construction, and this is the only place that can be checked end to end.
        leaks: /\\d+\\.\\d{2}|match_score|delta/i.test(
          document.getElementById("duelList").textContent,
        ),
      };

      renderDuels(null);
      return shown;
    })()`).catch((err) => ({ failed: String(err && err.message ? err.message : err) }));

    if (panel === null) {
      problems.push("nothing renders the duel panel");
    } else if (panel.failed) {
      problems.push(`the duel panel threw: ${panel.failed}`);
    } else if (!panel.hiddenWhenSignedOut) {
      problems.push("the duel panel shows before there is a board to show");
    } else if (panel.rows !== 3) {
      problems.push(`three duels drew ${panel.rows} rows`);
    } else if (!panel.names.includes("ready one") || !panel.names.includes("sent to")) {
      problems.push(`the duel rows name ${panel.names.join(", ")}`);
    } else if (panel.acceptEnabled.join() !== "true,false") {
      problems.push("a duel nobody has finished playing can still be accepted");
    } else if (panel.chip) {
      problems.push("the bar says nothing while a duel is waiting to be answered");
    } else if (panel.chipText !== "1 duel") {
      problems.push(`the bar counts "${panel.chipText}" for one answerable duel`);
    } else if (panel.leaks) {
      problems.push("the duel panel shows the sender's score, which decides who to answer");
    }

    console.log(
      `duel panel   : ${
        panel && !panel.failed
          ? `${panel.rows} rows, bar reads "${panel.chipText}", no scores shown`
          : "MISSING"
      }`,
    );

    // The rematch offer, which only exists for a result that had somebody in it.
    const rematch = await probe.webContents.executeJavaScript(`(() => {
      if (typeof renderRematch !== "function") return null;
      const box = document.getElementById("rematch");
      // The box also holds Queue again, which every result offers; the duel is the rematch.
      const duel = document.getElementById("rematchBtn");
      const offering = () => !box.hidden && !duel.hidden;
      const base = {
        matchId: "m", verdict: "win", explanation: "", voidReason: null, ratingWeight: 1,
        yourMatchScore: 0.05, theirMatchScore: 0.02, ratingBefore: 1500, ratingAfter: 1512,
        ratingChange: 12, rounds: [],
      };

      renderRematch({ ...base, seeding: true, verdict: null, opponent: null, category: null });
      const afterSeeding = !offering();

      renderRematch({ ...base, verdict: "void", opponent: { playerId: "p", displayName: "x" },
        category: "Static Clicking" });
      const afterVoid = !offering();

      renderRematch({ ...base, opponent: { playerId: "p9", displayName: "rival" },
        category: "Static Clicking" });
      const shown = {
        afterSeeding, afterVoid,
        offered: offering(),
        label: document.getElementById("rematchBtn").textContent,
        bound: typeof document.getElementById("rematchBtn").onclick === "function",
      };

      renderRematch({ ...base, seeding: true, verdict: null, opponent: null, category: null });
      return shown;
    })()`).catch((err) => ({ failed: String(err && err.message ? err.message : err) }));

    if (rematch === null) {
      problems.push("nothing offers a rematch after a result");
    } else if (rematch.failed) {
      problems.push(`the rematch offer threw: ${rematch.failed}`);
    } else if (!rematch.afterSeeding) {
      problems.push("a seeding match offers a rematch against nobody");
    } else if (!rematch.afterVoid) {
      problems.push("a void match offers a rematch, though it did not count");
    } else if (!rematch.offered) {
      problems.push("a contested result offers no rematch");
    } else if (rematch.label !== "Duel rival") {
      problems.push(`the rematch button reads "${rematch.label}"`);
    } else if (!rematch.bound) {
      problems.push("the rematch button is present but nothing is bound to it");
    }

    console.log(
      `rematch      : ${
        rematch && !rematch.failed ? `offered as "${rematch.label}", hidden on void and seeding` : "MISSING"
      }`,
    );

    console.log(
      `duels        : ${
        painted.failed
          ? "THREW"
          : `bridge complete, a pushed match paints "${painted.verb}" for ${painted.named}`
      }`,
    );

    // Tournaments: the bridge, then the screen driven with a view rather than a session,
    // for the reason the duel panel is - signed out, list-tournaments refuses, and a check
    // that waits on it can only pass. The views come from the real engine (sample.ts), one
    // of them carrying a name that is markup, because every name on a bracket is somebody
    // else's Steam text.
    const tnBridgeGaps = await probe.webContents.executeJavaScript(
      `["tournaments", "createTournament", "joinTournament", "leaveTournament", "checkIn",
        "removeEntrant", "startTournament", "cancelTournament", "playFixture", "onTournaments"]
         .filter((k) => typeof window.apogee[k] !== "function")`,
    );
    if (tnBridgeGaps.length > 0) problems.push(`the tournament bridge is missing: ${tnBridgeGaps.join(", ")}`);

    const tnPlaying = sampleTournamentView({ stage: "groups", hostileName: '<img src=x onerror="window.__tnPwned=1">' });
    const tnEntry = sampleTournamentView({ stage: "registration", viewerHosts: true });
    const cup = await probe.webContents.executeJavaScript(`(async () => {
      if (typeof renderTournamentView !== "function") return null;
      document.querySelector('.tab[data-screen="tournaments"]')?.click();
      const detail = document.getElementById("tnDetail");

      tnTab = "groups";
      renderTournamentView(${JSON.stringify(tnPlaying)});
      await new Promise((r) => setTimeout(r, 80));
      const shown = {
        visible: !detail.hidden,
        groups: detail.querySelectorAll(".tn-group").length,
        rows: detail.querySelectorAll(".tn-table tbody tr").length,
        play: [...detail.querySelectorAll(".tn-next button")].map((b) => b.textContent),
        hostPanel: !!detail.querySelector(".tn-host-panel"),
        injected: detail.querySelectorAll("img").length > 0 || window.__tnPwned === 1,
        nameShown: detail.textContent.includes("<img src=x"),
        // Nothing on a tournament screen is a score. The view carries none, and this is the
        // one place that can check it end to end. A number with decimals or a signed
        // percentage is what a score or a delta looks like on this client; the word
        // "baseline" is not, because the screen explains how fixtures are won.
        leaks: /match_score|\\bdeltas?\\b|\\d+\\.\\d{2}|[+\\u2212-]\\d+(\\.\\d+)?%/i.test(detail.textContent),
      };
      tnTab = "bracket";
      renderTournamentView(tnView);
      shown.slots = detail.querySelectorAll(".tn-slot").length;

      tnTab = "players";
      renderTournamentView(${JSON.stringify(tnEntry)});
      shown.start = [...detail.querySelectorAll(".tn-host-panel .tn-btn.primary")].map((b) => b.disabled);
      shown.warned = !!detail.querySelector(".tn-warn");
      shown.removable = detail.querySelectorAll(".tn-entrant button").length;

      tnClose();
      document.querySelector('.tab[data-screen="ranks"]')?.click();
      return shown;
    })()`).catch((err) => ({ failed: String(err && err.message ? err.message : err) }));

    if (cup === null) {
      problems.push("nothing renders a tournament");
    } else if (cup.failed) {
      problems.push(`the tournament screen threw: ${cup.failed}`);
    } else if (!cup.visible || cup.groups !== 4 || cup.rows !== 16) {
      problems.push(`a four-group tournament drew ${cup.groups} groups and ${cup.rows} rows`);
    } else if (cup.play.join() !== "Play fixture") {
      problems.push(`the viewer's ready fixture offers "${cup.play.join()}"`);
    } else if (cup.hostPanel) {
      problems.push("host controls show to somebody who is not the host");
    } else if (cup.injected || !cup.nameShown) {
      problems.push("a player name was treated as markup rather than text");
    } else if (cup.leaks) {
      problems.push("the tournament screen shows something shaped like a score");
    } else if (cup.slots !== 7) {
      problems.push(`an eight-player bracket drew ${cup.slots} slots`);
    } else if (cup.start.join() !== "true" || !cup.warned) {
      problems.push("the host can start short-handed, or is not warned who is left out");
    } else if (cup.removable !== 10) {
      problems.push(`the host can remove ${cup.removable} of 10 other entrants`);
    }

    console.log(
      `tournaments  : ${
        cup && !cup.failed
          ? `${cup.groups} groups, ${cup.slots}-slot bracket, names as text, no scores shown`
          : "MISSING"
      }`,
    );

    // Whether you are in a queue has to be legible without scrolling, and the Play screen
    // cannot promise that: the button saying "Searching" sits under a tall rank panel and
    // above a list of every scenario in the window. The bar can, so the state is mirrored
    // there - hidden while idle, and driven from the same function as the button so the
    // two cannot disagree.
    const chip = await probe.webContents.executeJavaScript(`(() => {
      const el = document.getElementById("queueLive");
      if (!el) return null;
      const idle = el.hidden;
      setCommit("working", "Searching", "", "0:07");
      const working = { hidden: el.hidden, text: document.getElementById("queueLiveText").textContent };
      setCommit("idle", "Find opponent", "", "");
      return { idle, working, hiddenAgain: el.hidden, drag: getComputedStyle(el).webkitAppRegion };
    })()`).catch(() => null);

    if (chip === null) {
      problems.push("the queue readout is not on the bar");
    } else if (!chip.idle) {
      problems.push("the queue readout shows while nothing is queued");
    } else if (chip.working.hidden) {
      problems.push("the queue readout stays hidden while searching");
    } else if (chip.working.text !== "Searching") {
      problems.push(`the queue readout says "${chip.working.text}" while searching`);
    } else if (!chip.hiddenAgain) {
      problems.push("the queue readout stays up after the queue ends");
    } else if (chip.drag === "drag") {
      problems.push("the queue readout is part of the window drag region, so it cannot be clicked");
    }

    console.log(`queue chip   : ${chip === null ? "MISSING" : "hidden idle, shows while searching"}`);

    // The searching orb is a fragment shader, and a shader that will not compile fails
    // the way nothing else in this file does: silently, into a blank canvas, with the
    // only complaint on a console nobody has open. So it is compiled here, against a
    // real driver, and asked to produce a frame with something in it.
    //
    // A machine with no WebGL at all is reported rather than failed: that is the
    // environment, not the code. A context that exists and then will not compile or
    // draw is a genuine failure and is treated as one.
    const orb = await probe.webContents.executeJavaScript(`(() => {
      if (typeof mountSearchOrb !== "function") return { wired: false };
      const probeGl = document.createElement("canvas").getContext("webgl");
      if (!probeGl) return { wired: true, webgl: false };

      mountSearchOrb();
      const host = document.getElementById("orbSearch");
      const canvas = host && host.querySelector("canvas");
      if (!canvas) return { wired: true, webgl: true, mounted: false };

      // Read the frame back. An orb that compiled but drew nothing comes back as an
      // entirely transparent buffer, which is the failure this exists to catch.
      const gl = canvas.getContext("webgl");
      const px = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let lit = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) lit++;
      const coverage = lit / (canvas.width * canvas.height);

      const size = canvas.width;
      mountSearchOrb();                       // must not stack a second context
      const afterDouble = host.querySelectorAll("canvas").length;

      unmountSearchOrb();
      const afterUnmount = {
        canvases: host.querySelectorAll("canvas").length,
        hidden: host.hidden,
        display: getComputedStyle(host).display,
      };
      return {
        wired: true, webgl: true, mounted: true,
        coverage, size, afterDouble, afterUnmount,
      };
    })()`);

    if (!orb.wired) {
      problems.push("the searching orb is not wired into the renderer");
    } else if (orb.webgl === false) {
      console.log("searching orb: no WebGL on this machine, shader not exercised");
    } else if (!orb.mounted) {
      problems.push("the searching orb mounted no canvas (the shader did not compile)");
    } else if (orb.coverage < 0.5 || orb.coverage > 0.9) {
      // A disc inscribed in its own square covers pi/4, about 0.785. Far under means the
      // shader drew nothing; far over means the circular mask stopped working and it is
      // painting the whole square.
      problems.push(
        `the searching orb drew ${(orb.coverage * 100).toFixed(1)}% of its canvas, ` +
        "which is neither a disc nor nothing",
      );
    } else if (orb.afterDouble !== 1) {
      problems.push(`mounting the searching orb twice left ${orb.afterDouble} canvases`);
    } else if (orb.afterUnmount.canvases !== 0 || orb.afterUnmount.display !== "none") {
      problems.push(
        "the searching orb did not clean up: " + JSON.stringify(orb.afterUnmount),
      );
    } else {
      console.log(
        `searching orb: ${orb.size}px, ${(orb.coverage * 100).toFixed(1)}% covered, ` +
        "one context, released on unmount",
      );
    }

    // The three panels of the look editor, drawn. Reading the overrides is deliberately
    // not behind the admin check - the app has to paint before there is a session to ask
    // about - so the editor populates on any account and can be checked on this one. What
    // the role gates is saving, and main re-checks that on all four write handlers.
    // Opened the way a person opens it. The editors are drawn on the way into the screen
    // and not at boot, so checking the DOM without the click would check an empty screen
    // and pass forever. `.click()` works on the hidden tab, which is what this account is
    // looking at: reading the overrides is open to everyone, and only saving is not.
    const editor = await probe.webContents.executeJavaScript(`(() => {
      document.getElementById("tabAdmin").click();
      return {
        tokens: document.querySelectorAll("#adminTokens .adm-row").length,
        copy: document.querySelectorAll("#adminCopy .adm-copy-row").length,
        ranks: document.querySelectorAll("#adminRanks .adm-rank-row").length,
        save: document.getElementById("adminSave") !== null,
        path: (document.getElementById("adminPath").textContent || "").trim().length > 0,
      };
    })()`);

    if (editor.tokens === 0) problems.push("the look editor drew no colours");
    else if (editor.copy === 0) problems.push("the look editor drew no copy");
    else if (editor.ranks === 0) problems.push("the look editor drew no ranks");
    else if (!editor.save) problems.push("the look editor has no save button");
    else if (!editor.path) problems.push("the look editor does not say where it writes");
    console.log(
      `look editor  : ${editor.tokens} colours, ${editor.copy} strings, ${editor.ranks} ranks`,
    );

    // The season editor, driven the way rebuilding a pool drives it.
    //
    // Neither read behind it is admin-gated - the role gates writing, not looking - so this
    // signed-out account can open it and edit in memory. Nothing is saved and the window is
    // discarded when the run ends. No step here reaches KovaaK's: the replacement moves a
    // scenario between two families in the same difficulty, which keeps the thresholds it
    // had rather than cutting new ones, so it answers the same offline as online.
    //
    // Caught here as well as inside. A rejected executeJavaScript leaves this handler's
    // await pending for ever, and the smoke run then hangs with no output rather than
    // failing - which is the worst way for a check to break.
    const season = await probe.webContents.executeJavaScript(`(async () => {
      try {
      if (typeof loadSeasonEditor !== "function" || typeof renderPoolGrid !== "function") return null;

      // The editor stashes an unfinished draft and a rebuild baseline in localStorage, and
      // this window shares that storage with the real app. Both are put back exactly as
      // they were found.
      const KEY = "apogee.seasonDraft";
      const BASE = "apogee.seasonBaseline";
      const stashBefore = localStorage.getItem(KEY);
      const baseBefore = localStorage.getItem(BASE);

      await loadSeasonEditor();
      if (!seasonDraft || !(seasonDraft.categories || []).length) return { noSeason: true };
      document.getElementById("tabSeason").click();

      const cellsOf = () => [...document.querySelectorAll("#poolGrid td.pg-cell")];
      const cells = cellsOf().length;
      const slots = seasonDraft.scenarios.length;
      const ladder = seasonPercentiles && Array.isArray(seasonPercentiles.ranks)
        ? seasonPercentiles.ranks.length : 0;
      const rungs = (seasonDraft.categories[0].rankNames || []).length;

      // Arrow keys move the selection, and do not fall through to the tab strip.
      const first = cellsOf()[0];
      gridSelect(first.dataset.family, 0);
      const screenBefore = document.body.dataset.screen;
      document.getElementById("poolGrid").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      const moved = gridSel.window === 1 && document.body.dataset.screen === screenBefore;

      // The search finds a scenario from the first few letters of its name. It searches the
      // scenarios it can offer, and by the letters that tell one apart: every season name
      // starts "Apogee ", so six letters of one matched all 164 and the forty shown were
      // whichever sorted first, and none of them is on offer until it has been played.
      const named = seasonAvailable.find((o) => /^[A-Za-z0-9+]+ [A-Za-z0-9]{3}/.test(o.name));
      const term = named ? named.name.replace(/^(\S+ \S{3}).*$/, "$1") : "";
      gridOpenSearch(term);
      const found = !!named && gridSearchHits.some((o) => o.name === named.name);
      gridCloseSearch(false);

      // Move a scenario into another family's slot in the same difficulty. It keeps the
      // thresholds it had, so nothing is left waiting on a cut, and undo puts it back.
      const w0 = seasonDraft.scenarios.filter((x) => (x.window ?? 0) === 0 && x.scenario);
      const into = w0[0];
      const from = w0.find((x) => x.family !== into.family);
      const intoKey = slotKeyOf(into);
      const wasName = into.scenario;
      gridRemember();
      gridReplace(into, { name: from.scenario, leaderboardId: from.leaderboardId });
      const after = gridSlot(familyKeyOf(into), 0);
      const kept = after.scenario === from.scenario &&
        JSON.stringify(after.rankMaxes) === JSON.stringify(from.rankMaxes);
      const waiting = gridWaiting();
      renderPoolGrid();
      const replacedShown = document.querySelectorAll("#poolGrid td.pg-cell.replaced").length;
      gridStep(-1);
      const undone = seasonDraft.scenarios.find((x) => slotKeyOf(x) === intoKey).scenario === wasName;

      // A new family opens a slot in every difficulty, drawn in the grid, and undo removes it.
      const category = seasonDraft.categories[0].name;
      const family = "ZZ smoke probe";
      gridRemember();
      addFamily(category, family);
      renderPoolGrid();
      const inDraft = seasonDraft.scenarios.filter((x) => x.family === family).length;
      const onScreen = cellsOf().filter((td) => td.dataset.family === category + "/" + family).length;
      gridStep(-1);
      const familyUndone = seasonDraft.scenarios.every((x) => x.family !== family);

      if (stashBefore === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, stashBefore);
      if (baseBefore === null) localStorage.removeItem(BASE);
      else localStorage.setItem(BASE, baseBefore);

      return {
        cells, slots, ladder, rungs, moved, found, kept,
        cutting: waiting.cutting, replacedShown, undone,
        inDraft, onScreen, familyUndone,
        windows: (seasonDraft.windows || []).length,
        available: seasonAvailable.length,
        restored: localStorage.getItem(KEY) === stashBefore && localStorage.getItem(BASE) === baseBefore,
      };
      } catch (err) {
        return { failed: String(err && err.message ? err.message : err) };
      }
    })()`).catch((err) => ({ failed: String(err && err.message ? err.message : err) }));

    if (season === null) {
      problems.push("the season editor is not reachable from the renderer");
    } else if (season.failed) {
      problems.push(`the season editor threw: ${season.failed}`);
    } else if (season.noSeason) {
      problems.push("the season editor loaded no season to edit");
    } else if (season.cells !== season.slots) {
      problems.push(`the pool grid drew ${season.cells} cells for ${season.slots} slots`);
    } else if (season.ladder !== season.rungs) {
      problems.push(
        `the editor has ${season.ladder} percentile ranks for a ${season.rungs}-rank ladder, ` +
          `so a replaced scenario cannot be cut from its board`,
      );
    } else if (season.available === 0) {
      problems.push("the season editor knows no scenarios to put in a slot");
    } else if (!season.moved) {
      problems.push("an arrow key did not move the grid's selection, or switched screens");
    } else if (!season.found) {
      problems.push("the grid's search did not find a scenario from its first letters");
    } else if (!season.kept || season.cutting !== 0) {
      problems.push("a scenario moved between families lost its thresholds or waited on a cut");
    } else if (season.replacedShown !== 1) {
      problems.push(`one replacement showed ${season.replacedShown} replaced cells`);
    } else if (!season.undone) {
      problems.push("undo did not put the replaced scenario back");
    } else if (season.inDraft !== season.windows || season.onScreen !== season.windows) {
      problems.push(
        `a new family opened ${season.inDraft} slots and drew ${season.onScreen} ` +
          `for ${season.windows} difficulties`,
      );
    } else if (!season.familyUndone) {
      problems.push("undo did not remove the family it had just added");
    } else if (!season.restored) {
      problems.push("the probe did not put the stashed draft and baseline back as it found them");
    }

    console.log(
      `season editor: ${season && season.cells} cells for ${season && season.slots} slots, ` +
        `${season && season.ladder}-rank percentile ladder, ` +
        `${season && season.available} scenarios to choose from`,
    );

    // The window buttons' strip was set once and never matched the top bar under it.
    const barColor = await probe.webContents
      .executeJavaScript(`(() => { const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(getComputedStyle(document.querySelector(".topbar")).backgroundColor); return m ? "#" + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : null; })()`)
      .catch(() => null);
    if (!windowChrome) problems.push("the renderer never reported the top bar's colour for the window buttons");
    else if (windowChrome.color !== barColor) problems.push(`window buttons sit on ${windowChrome.color}, the top bar is ${barColor}`);
    console.log(`window chrome: ${windowChrome ? `${windowChrome.color} on a ${barColor} top bar` : "NOT REPORTED"}`);

    console.log(`preload      : ${hasBridge ? "bridge exposed" : "MISSING"}`);
    console.log(`renderer     : ${rendered ? "loaded" : "EMPTY"}`);

    console.log();
    if (problems.length > 0) {
      console.error("FAIL:\n  " + problems.join("\n  "));
      app.exit(1);
    } else {
      console.log(
        "OK: desktop client boots, finds stats, and renders" +
          (offline ? " (offline: no Supabase settings, sign-in untested; allowed by --allow-offline)" : ""),
      );
      app.exit(0);
    }
  });

  void probe.loadFile(join(here, "renderer", "index.html"));
}


/**
 * Restore the stored sign-in, retrying while the server cannot be reached. A launch with
 * the network still coming up used to delete the token and sign the player out.
 */
const RESTORE_RETRY_MS = [5_000, 15_000, 60_000, 120_000];
async function restoreSignedIn(attempt = 0): Promise<void> {
  let session: ApogeeSession | null;
  try {
    session = await restoreSession();
  } catch (err) {
    if (!(err instanceof SessionUnreachable)) return;
    if (attempt === 0) notify("Can't reach Apogee's server yet. You're still signed in; retrying.");
    setTimeout(() => void restoreSignedIn(attempt + 1), RESTORE_RETRY_MS[Math.min(attempt, RESTORE_RETRY_MS.length - 1)]);
    return;
  }
  if (attempt > 0) notify(null);

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
      broadcast("apogee:match", active);
      seedSubmitted(active);
    }
  } catch {
    // Best effort. Queueing surfaces the same match anyway, so a failure here
    // costs a convenience rather than the match.
  }

  // Whatever was played while the app was shut.
  void keepHistoryCurrent("session restored");

  // And the duel board, for the same reason: somebody who was challenged while the
  // app was shut should be told on the way in rather than the next time they think
  // to look. Nothing here is on a timer - this fires on the way in and after every
  // action - so a duel that arrives mid-session appears when the player next does
  // something, which is the honest limit of it until there is a reason to poll.
  void refreshDuels("session restored");
  // Same reasoning: a fixture that became yours to play while the app was shut.
  void refreshTournaments("session restored");
}

app.whenReady().then(() => {
  if (!HAS_LOCK) return;
  if (SMOKE) {
    runSmokeTest();
    return;
  }

  createWindow();
  installMenu({
    rescan: () => rebuild("menu rescan"),
    chooseFolder: () => void chooseStatsFolder().then((r) => { if (r && typeof r === "object") broadcast("apogee:error", r.error); }),
    openStatsFolder: () => {
      if (state.statsDir) void shell.openPath(state.statsDir);
    },
    diagnostics: () => diagnostics(),
  });

  // A previous sign-in is restored from the encrypted refresh token, so the player
  // does not re-authenticate every launch.
  void restoreSignedIn();

  setOnUnauthorized(() => {
    // The server refused the access token. Say so where the player looks, rather than
    // showing them signed in while every action answers "sign in".
    if (!state.session) return;
    state.session = null;
    broadcast("apogee:session", null);
    broadcast("apogee:error", "Your session expired. Sign in with Steam again.");
  });

  // A folder the player picked themselves wins over auto-detection. Someone with two
  // Steam libraries, or a stats folder copied off another machine, told us the answer
  // once and should not be asked again every launch.
  // A folder named on the command line (`--stats`, or APOGEE_STATS_DIR) beats both: it is
  // somebody saying which folder to read this time, without changing the remembered one.
  const remembered = loadSettings().statsDir;
  const found = NO_STATS
    ? null
    : statsFolderOverride()
      ? findStatsFolder()
      : remembered && existsSync(remembered) ? remembered : findStatsFolder();

  if (found) {
    startWatching(found);
  } else {
    state.lastError =
      "Couldn't find your KovaaK's stats folder.";
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
  // A reloaded window has to be able to repaint a match in progress.
  match: state.match,
  notice: state.notice,
}));

ipcMain.handle("apogee:expedition", () => {
  try {
    return expedition().view(state.statsDir, true);
  } catch (err) {
    return { error: friendlyError(err) };
  }
});
ipcMain.handle("apogee:expeditionAction", async (_e, action: unknown) => {
  try {
    if (action && typeof action === "object" && (action as { type?: unknown }).type === "launch") {
      const view = expedition().view(state.statsDir, true);
      if (view.error) return { error: view.error };
      const result = expedition().playlist(state.statsDir);
      const launched = await launchKovaaks(result.scenario);
      broadcast("apogee:expedition", view);
      return launched.ok ? { view, note: result.note } : { view, error: launched.error ?? "KovaaK's could not be opened. Your activity is still saved." };
    }
    const view = expedition().action(action, state.statsDir);
    broadcast("apogee:expedition", view);
    return { view };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
});

ipcMain.handle("apogee:ghost", () => {
  try {
    return ghost.view();
  } catch (err) {
    return { error: friendlyError(err) };
  }
});
ipcMain.handle("apogee:ghostAction", async (_e, action: unknown) => {
  try {
    return await ghost.action(action);
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

// { source: "match" | "ghost", layout, action: "preview" | "copy" | "save" } and nothing
// else: the card is drawn from main's record, so there is no figure for the renderer to send.
ipcMain.handle("apogee:shareCard", async (_e, request: unknown) => {
  try {
    return await shareCards.handle(request);
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
});

// ---------------------------------------------------------------------------
// Steam sign-in
//
// The whole flow lives in the main process. The renderer is told who is signed in
// and nothing else: no tokens cross the bridge, so injected script in the renderer
// has nothing to steal.
// ---------------------------------------------------------------------------

let signInAbort: AbortController | null = null;

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
  signInAbort?.abort();
  const attempt = new AbortController();
  signInAbort = attempt;

  state.signingIn = true;
  broadcast("apogee:signingIn", { signingIn: true });

  try {
    const session = await signIn(
      (config) => signInWithSteam({ ...config, signal: attempt.signal }),
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
    void refreshDuels("signed in");
    void refreshTournaments("signed in");
    void keepHistoryCurrent("signed in");
    return { session };
  } catch (err) {
    // Superseded by a newer attempt, or cancelled: the player already knows.
    if (err instanceof SignInCancelled) return { cancelled: true };
    const message = friendlyError(err);
    state.lastError = message;
    broadcast("apogee:error", message);
    return { error: message };
  } finally {
    if (signInAbort === attempt) {
      signInAbort = null;
      state.signingIn = false;
      broadcast("apogee:signingIn", { signingIn: false });
    }
  }
});

ipcMain.handle("apogee:cancelSignIn", () => {
  signInAbort?.abort();
  return { ok: true };
});

ipcMain.handle("apogee:signOut", async () => {
  await signOut().catch(() => undefined);
  state.session = null;
  // The match panel reads this broadcast; without it an open match stayed on screen
  // while nothing submitted its runs any more.
  if (state.match) broadcast("apogee:match", null);
  state.match = null;
  state.submitted.clear();
  // Somebody else's inbox must not be left on screen for whoever signs in next.
  state.duels = null;
  duelBoardKey = "";
  broadcast("apogee:duels", null);
  state.tournaments = null;
  tournamentsKey = "";
  broadcast("apogee:tournaments", null);
  broadcast("apogee:session", null);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// backfill, matchmaking, settlement
// ---------------------------------------------------------------------------

ipcMain.handle("apogee:uploadHistory", async () => {
  if (!state.session) return { error: "Sign in with Steam to play ranked." };
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
    const message = friendlyError(err);
    broadcast("apogee:error", message);
    return { error: message };
  } finally {
    state.uploading = false;
    broadcast("apogee:uploading", { uploading: false });
  }
});

/**
 * Take up a new match: remember it, write its playlist, and tell the renderer.
 *
 * Four steps, and all four have to happen together. Three paths create a match now - the
 * queue, sending a duel and accepting one - and the third copy of this is where somebody
 * forgets `writeMatchPlaylist` and the playlist silently never appears in KovaaK's, which
 * is the failure the paragraph below is about.
 */
function adoptMatch(match: FoundMatch): void {
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
  nudge();
}

ipcMain.handle("apogee:findMatch", async (_e, args) => {
  const { category, pool } = args ?? {};
  if (!state.session) return { error: "Sign in with Steam to play ranked." };
  if (typeof pool?.window !== "number") return { error: "Your history is still loading. Try again in a moment." };

  try {
    const match = await findMatch(category, pool);
    adoptMatch(match);
    // A match handed back rather than created may already hold some of this player's
    // runs; find out which, so they are not asked for again and a complete one settles.
    if (match.resumed) {
      void fetchActiveMatch()
        .then((active) => {
          if (active && active.matchId === match.matchId && state.match?.matchId === match.matchId) {
            state.match.submittedScenarioIds = active.submittedScenarioIds;
            broadcast("apogee:match", state.match);
            seedSubmitted(state.match);
          }
        })
        .catch(() => undefined);
    }
    return { match };
  } catch (err) {
    const message = friendlyError(err);
    return { error: message };
  }
});

/* ------------------------------------------------------------------------ duels ---- */

/**
 * Re-read the duel board and tell the renderer only when it actually changed.
 *
 * The panel is repainted from this, and repainting it on an unchanged board would throw
 * away a scroll position and a half-typed filter for nothing. Comparing the ids is enough:
 * everything else on a duel that can move - ready, played, status - moves with them.
 */
async function refreshDuels(reason: string, force = false): Promise<void> {
  if (!state.session) {
    state.duels = null;
    return;
  }

  try {
    const board = await fetchDuels();
    const key = JSON.stringify([
      board.incoming.map((d) => `${d.id}:${d.ready}`),
      board.outgoing.map((d) => `${d.id}:${d.status}:${d.played}`),
      board.friends.map((f) => f.playerId),
    ]);

    const changed = force || key !== duelBoardKey;
    duelBoardKey = key;
    state.duels = board;
    if (changed) broadcast("apogee:duels", board);
  } catch (err) {
    // Best effort, and quiet. The board is a convenience: failing to read it should not
    // put an error banner over a screen the player is using for something else.
    console.warn(`could not read duels (${reason}):`, err instanceof Error ? err.message : err);
  }
}

ipcMain.handle("apogee:duels", async () => {
  if (!state.session) return { error: "Sign in with Steam to play ranked." };
  try {
    const board = await fetchDuels();
    state.duels = board;
    return { board };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

ipcMain.handle("apogee:sendDuel", async (_e, { to, category, pool } = {} as any) => {
  if (!state.session) return { error: "Sign in with Steam to play ranked." };
  if (typeof pool?.window !== "number") return { error: "no match pool: rebuild the snapshot" };

  try {
    const match = await sendDuel(to, category, pool);
    adoptMatch(match);
    void refreshDuels("sent a duel");
    return { match };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

/**
 * Repaint the strip the operating system draws minimise, maximise and close on.
 *
 * It was set once, at window creation, from DARK_CHROME, and the top bar it sits in is
 * painted by the renderer's stylesheets: the arcade look moved --ground to #171918, the
 * theme menu moves it again, and Expedition has its own. The buttons stayed on #10121b
 * in a visibly different box. The renderer reports what the top bar actually computes
 * to, whenever that can change, and this applies it. Hex only: it goes straight to the OS.
 */
let windowChrome: { color: string; symbolColor: string } | null = null;
ipcMain.handle("apogee:setWindowChrome", (_e, { color, symbolColor } = {} as any) => {
  const hex = /^#[0-9a-f]{6}$/i;
  if (!hex.test(color) || !hex.test(symbolColor)) return false;
  // Kept for the smoke test, whose probe window has no overlay to paint.
  windowChrome = { color, symbolColor };
  if (!window) return false;
  try {
    window.setTitleBarOverlay({ color, symbolColor, height: 46 });
    return true;
  } catch {
    // Not every platform has an overlay to repaint; the default one stays.
    return false;
  }
});

ipcMain.handle("apogee:answerDuel", async (_e, { duelId, action } = {} as any) => {
  if (!state.session) return { error: "Sign in with Steam to play ranked." };

  try {
    const result = await answerDuel(duelId, action);
    // Accepting hands back a whole match; declining and cancelling hand back a verdict.
    // Taking up a match that is not there would wipe the one the player is playing.
    if (action === "accept" && result.matchId) adoptMatch(result);
    // Taking back an unplayed duel voids the match it made; the panel must not keep it.
    if (result.matchVoided && state.match?.matchId === result.matchVoided) {
      state.match = null;
      state.submitted.clear();
      broadcast("apogee:match", null);
    }
    void refreshDuels(`answered a duel: ${action}`);
    return { ok: true, status: result.status, match: action === "accept" ? result : undefined };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

ipcMain.handle("apogee:setFriend", async (_e, { playerId, friend } = {} as any) => {
  if (!state.session) return { error: "Sign in with Steam to play ranked." };
  try {
    await setFriend(playerId, friend);
    void refreshDuels("changed the shortlist");
    return { ok: true };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

/* ------------------------------------------------------------------ tournaments ---- */

/**
 * Tell the renderer about the list only when something on it moved.
 *
 * The same reasoning as the duel board: a repaint on an unchanged list throws away where
 * the player was on the page. The key covers everything a row shows that can change.
 */
function publishTournaments(list: TournamentSummary[]): void {
  const key = JSON.stringify(
    list.map((t) => [t.id, t.phase, t.entrants, t.checkedIn, t.entered, t.yourTurn, t.championName]),
  );
  const changed = key !== tournamentsKey;
  tournamentsKey = key;
  state.tournaments = list;
  if (changed) broadcast("apogee:tournaments", list);
}

async function refreshTournaments(reason: string): Promise<void> {
  if (!state.session) {
    state.tournaments = null;
    return;
  }
  try {
    publishTournaments((await fetchTournaments()).tournaments);
  } catch (err) {
    // Best effort and quiet, like the duel board: a list that could not be read this
    // moment is not worth a banner over whatever the player is doing.
    console.warn(`could not read tournaments (${reason}):`, err instanceof Error ? err.message : err);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rebuild a tournament action from what came over the bridge, known fields only.
 *
 * The preload already names each field it sends, and the server refuses anything else,
 * but main is where the bridge ends: checking here means a renderer talked into sending
 * something odd gets a plain answer instead of a round trip, and nothing it adds travels
 * further. A string back is the refusal.
 */
function tournamentRequest(raw: Record<string, unknown> | null | undefined): TournamentAction | string {
  const id = raw?.tournamentId;
  const hasId = typeof id === "string" && UUID.test(id);
  switch (raw?.action) {
    case "create": {
      const { name, category, window: poolWindow, groupCount, groupSize, qualifiers, seeding } = raw;
      if (typeof name !== "string" || !name.trim() || name.length > 200) return "Give it a name.";
      if (typeof category !== "string" || !category || category.length > 40) return "Pick a category.";
      if (typeof poolWindow !== "number" || !Number.isInteger(poolWindow) || poolWindow < 0) {
        return "The season pool has not loaded yet.";
      }
      if (groupCount !== 2 && groupCount !== 4 && groupCount !== 8) return "Pick 2, 4 or 8 groups.";
      if (typeof groupSize !== "number" || !Number.isInteger(groupSize) || groupSize < 3 || groupSize > 8) {
        return "Groups hold 3 to 8 players.";
      }
      if (qualifiers !== 1 && qualifiers !== 2) return "One or two go through from each group.";
      if (seeding !== "seeded" && seeding !== "shuffle") return "Pick how the groups are drawn.";
      return { action: "create", name, category, window: poolWindow, groupCount, groupSize, qualifiers, seeding };
    }
    case "join":
    case "leave":
      return hasId ? { action: raw.action, tournamentId: id as string } : "No such tournament.";
    case "check-in":
      return hasId && typeof raw.checkedIn === "boolean"
        ? { action: "check-in", tournamentId: id as string, checkedIn: raw.checkedIn }
        : "No such tournament.";
    case "remove":
      return hasId && typeof raw.playerId === "string" && UUID.test(raw.playerId)
        ? { action: "remove", tournamentId: id as string, playerId: raw.playerId }
        : "No such player.";
    case "start":
      return hasId && typeof raw.revision === "number" && Number.isSafeInteger(raw.revision)
        ? { action: "start", tournamentId: id as string, revision: raw.revision }
        : "No such tournament.";
    case "cancel":
      return hasId && typeof raw.reason === "string" && raw.reason.trim() && raw.reason.length <= 400
        ? { action: "cancel", tournamentId: id as string, reason: raw.reason }
        : "Say why it is being cancelled.";
    default:
      return "Unknown action.";
  }
}

ipcMain.handle("apogee:tournaments", async (_e, args) => {
  if (!state.session) return { error: "Sign in with Steam to play ranked." };
  const tournamentId = args?.tournamentId;
  if (tournamentId != null && (typeof tournamentId !== "string" || !UUID.test(tournamentId))) {
    return { error: "No such tournament." };
  }
  try {
    const result = await fetchTournaments(tournamentId ?? undefined);
    publishTournaments(result.tournaments);
    return result;
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

ipcMain.handle("apogee:tournamentAction", async (_e, raw) => {
  if (!state.session) return { error: "Sign in with Steam to play ranked." };
  const request = tournamentRequest(raw);
  if (typeof request === "string") return { error: request };
  try {
    const result = await tournamentAction(request);
    void refreshTournaments(`tournament ${request.action}`);
    return { view: result.view };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

ipcMain.handle("apogee:playFixture", async (_e, args) => {
  if (!state.session) return { error: "Sign in with Steam to play ranked." };
  const { tournamentId, fixtureId, attempt } = args ?? {};
  if (
    typeof tournamentId !== "string" || !UUID.test(tournamentId) ||
    typeof fixtureId !== "string" || fixtureId.length === 0 || fixtureId.length > 128 ||
    typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1
  ) {
    return { error: "That fixture cannot be played." };
  }
  try {
    const match = await playFixture(tournamentId, fixtureId, attempt);
    // Resuming the leg already held keeps what was submitted against it. Adopting it fresh
    // would forget the runs already in and offer to send them again.
    if (state.match?.matchId === match.matchId) {
      state.match = match;
      broadcast("apogee:match", match);
    } else {
      adoptMatch(match);
    }
    void refreshTournaments("opened a fixture leg");
    return { match };
  } catch (err) {
    return { error: friendlyError(err) };
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
    if (result.tournament) void refreshTournaments("abandoned a fixture leg");
    return result;
  } catch (err) {
    // Clear locally anyway. A player who cannot reach the server is better off with a
    // usable app than stuck on a match screen, and find-match will surface the open
    // match again the moment they queue.
    clearLocal();
    return { ok: false, error: friendlyError(err) };
  }
});

/** Settle early, for a match where a run was played before Apogee was watching. */
ipcMain.handle("apogee:settleMatch", async () => {
  if (!state.match) return { error: "There is no match open to settle." };
  const error = await settleActiveMatch();
  return error ? { error } : { ok: true };
});

ipcMain.handle("apogee:getStanding", async () => {
  if (!state.session) return null;
  try {
    return await fetchStanding(state.session.playerId);
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

/**
 * Whether this account may queue yet, and how far off it is if not.
 *
 * Signed out, the answer is null rather than a refusal: "you need 50 runs" is a
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

/* ------------------------------------------------------------------ admin mode
 *
 * What an admin may change about this client, and what they may not.
 *
 * May: the chrome's colours and the app's own copy, stored per machine in userData, and
 * the season's rank names and colours - those through `saveSeason` below, which validates
 * the ladder and refuses a published season, rather than through a second path that
 * would let a machine drift from what it is graded against.
 *
 * May not: anything a rank is computed from. Ratings, deltas, verification tiers and
 * baselines are server-side and RLS gives this client no write grant on any of them, so
 * the strongest thing on this page is a repaint. That is not an accident of scope - it is
 * why unlocking an editor with a role check is a reasonable thing to do at all.
 *
 * Reading is ungated. The overrides have to be applied before the first paint, which
 * happens long before a session exists, and they are this machine's own file rather than
 * anybody else's secret. Every write re-checks the role in main: the hidden tab in the
 * renderer is a courtesy, and the side that decides is the side that checks.
 */

async function adminOrRefusal(): Promise<string | null> {
  if (!state.session) return "Sign in with Steam to play ranked.";
  if (!(await isAdmin().catch(() => false))) return "only an admin can change how this looks";
  return null;
}

ipcMain.handle("apogee:adminOverrides", () => {
  const loaded = loadOverrides();
  return {
    overrides: loaded.overrides,
    rejected: loaded.rejected,
    error: loaded.error,
    path: overridesPath(),
    tokens: TOKENS,
    // Handed over rather than restated in the renderer, which measures these live as
    // an admin types and has no way to import the module that decides them. Same for the
    // length cap: two copies of a limit drift, and the one the editor shows would be the
    // one that is wrong.
    pairs: PAIRS,
    maxCopy: MAX_COPY,
  };
});

ipcMain.handle("apogee:saveAdminOverrides", async (_e, { overrides } = {} as any) => {
  const refusal = await adminOrRefusal();
  if (refusal) return { error: refusal };
  try {
    const saved = saveOverrides(overrides);
    return { overrides: saved.overrides, rejected: saved.rejected, path: overridesPath() };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

ipcMain.handle("apogee:resetAdminOverrides", async () => {
  const refusal = await adminOrRefusal();
  if (refusal) return { error: refusal };
  try {
    const cleared = clearOverrides();
    return { overrides: cleared.overrides, rejected: [], path: overridesPath() };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

/**
 * Write the current set somewhere a person can keep it.
 *
 * The one answer to overrides being per-machine: a file that can be moved, committed as
 * the shipped defaults, or handed to somebody else's install.
 */
ipcMain.handle("apogee:exportAdminOverrides", async () => {
  const refusal = await adminOrRefusal();
  if (refusal) return { error: refusal };

  const win = BrowserWindow.getAllWindows()[0];
  const target = await dialog.showSaveDialog(win, {
    title: "Export look and copy",
    defaultPath: "apogee-look.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (target.canceled || !target.filePath) return { canceled: true };

  try {
    writeFileSync(
      target.filePath,
      JSON.stringify(loadOverrides().overrides, null, 2) + "\n",
      "utf8",
    );
    return { path: target.filePath };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

ipcMain.handle("apogee:importAdminOverrides", async () => {
  const refusal = await adminOrRefusal();
  if (refusal) return { error: refusal };

  const win = BrowserWindow.getAllWindows()[0];
  const picked = await dialog.showOpenDialog(win, {
    title: "Import look and copy",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };

  try {
    // Through the same validation as anything else. A file from another machine is the
    // least trusted input this feature has.
    const parsed: unknown = JSON.parse(readFileSync(picked.filePaths[0], "utf8"));
    const saved = saveOverrides(parsed);
    return { overrides: saved.overrides, rejected: saved.rejected, path: overridesPath() };
  } catch (err) {
    return { error: friendlyError(err) };
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
      {
        aimType: string | null;
        difficulty: string | null;
        leaderboardId: number | null;
        /** Every "<benchmark> <tier>" that publishes this scenario. */
        tiers: string[];
        /** Just the benchmark names, for the coverage readout. */
        benchmarks: string[];
      }
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
          tiers: [],
          benchmarks: [],
        });
      }
    } catch {
      // A missing taxonomy costs aim-type suggestions, not the picker.
    }

    // Every committed benchmark, not a list of three.
    //
    // This was `["voltaic-s5.json", "voltaic-s5-5.json", "voltaic-s4.json"]`, and it is
    // the reason the pool stayed Voltaic-shaped however many benchmark definitions were
    // added beside them: a scenario the picker never offers is a scenario nobody puts in
    // a season. Sixteen benchmarks are committed and the picker knew three.
    //
    // Reading the directory means a benchmark is usable the moment its definition lands,
    // which is what `npm run fetch:evxl` and `sync:reference` are for.
    for (const file of readdirSync(dataFile("benchmarks")).filter((f) => f.endsWith(".json"))) {
      try {
        const def = JSON.parse(readFileSync(dataFile("benchmarks", file), "utf8")) as {
          benchmarkName: string;
          difficulties: {
            name: string;
            categories: {
              name: string;
              scenarios: { name: string; leaderboardId: number | null }[];
            }[];
          }[];
        };
        for (const d of def.difficulties ?? []) {
          for (const c of d.categories ?? []) {
            for (const s of c.scenarios ?? []) {
              const tier = `${def.benchmarkName} ${d.name}`;
              const prior = known.get(s.name);
              if (!prior) {
                known.set(s.name, {
                  aimType: c.name,
                  difficulty: d.name,
                  leaderboardId: s.leaderboardId ?? null,
                  tiers: [tier],
                  benchmarks: [def.benchmarkName],
                });
              } else {
                // The taxonomy knew the scenario but not its board. A benchmark that names
                // the same scenario does, and an id is the difference between a scenario
                // that can be added and one that cannot.
                if (prior.leaderboardId == null && s.leaderboardId != null) {
                  prior.leaderboardId = s.leaderboardId;
                }
                // Where a scenario is published matters more than that it exists: which
                // benchmark and which tier is how its difficulty band gets decided, and a
                // scenario several benchmarks name is a different proposition from one
                // only its author uses.
                if (!prior.tiers.includes(tier)) prior.tiers.push(tier);
                if (!prior.benchmarks.includes(def.benchmarkName)) {
                  prior.benchmarks.push(def.benchmarkName);
                }
              }
            }
          }
        }
      } catch {
        // Optional: a definition we cannot parse simply contributes nothing.
      }
    }

    const history = state.statsDir ? scanStatsFolder(state.statsDir) : new Map();
    for (const name of history.keys()) {
      if (!known.has(name)) {
        known.set(name, {
          aimType: null,
          difficulty: null,
          leaderboardId: null,
          tiers: [],
          benchmarks: [],
        });
      }
    }

    // How many accounts hold a score on each board, from the committed sample.
    //
    // A threshold is the score at a percentile of a board, so board size decides whether a
    // threshold means anything: on 2,000 entries the hardest rank is the two people at the
    // top of it and moves whenever either has a good day. The picker shows the number and
    // marks the thin ones, because choosing a scenario is the moment that matters - the
    // alternative is finding out from validate:pool after a season is built on it.
    const entriesOf = new Map<string, number>();
    try {
      const sample = JSON.parse(
        readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"),
      ) as { distributions: { scenario: string; total: number }[] };
      for (const d of sample.distributions) entriesOf.set(d.scenario, d.total);
    } catch {
      // No sample yet: the picker loses the board sizes, not the scenarios.
    }

    // What the benchmarks say about each scenario that validate:pool holds a variant to:
    // the sub-skill they file it under, and the part of the arm Viscose names for it. A
    // replacement carries the arm Viscose publishes, and the editor warns when the family's
    // sub-skill disagrees - both would otherwise surface only as a failed validate:pool.
    const benchmarkSays = new Map<string, { subSkill: string | null; mechanic: string | null }>();
    try {
      const subskills = JSON.parse(readFileSync(dataFile("subskills.json"), "utf8")) as {
        scenarios: { scenario: string; subSkill: string | null; mechanic?: string | null }[];
      };
      for (const s of subskills.scenarios) {
        benchmarkSays.set(s.scenario, { subSkill: s.subSkill ?? null, mechanic: s.mechanic ?? null });
      }
    } catch {
      // Without it the editor cannot warn; the scenarios are still offered.
    }

    const options = [...known.entries()]
      .map(([name, meta]) => {
        const local = history.get(name);
        const scores = local ? local.runs.map((r: { score: number }) => r.score) : [];

        return {
          name,
          // Offered, not hidden. Rebuilding a pool is mostly moving scenarios between
          // slots, and a picker that hides every scenario in use cannot put one back
          // where it was or into the slot it is about to leave.
          inSeason: already.has(name),
          subSkill: benchmarkSays.get(name)?.subSkill ?? null,
          publishedArm: benchmarkSays.get(name)?.mechanic ?? null,
          // KovaaK's calls it Target Switching; the season's category is Switching.
          category: meta.aimType === "Target Switching" ? "Switching" : meta.aimType,
          difficulty: meta.difficulty,
          leaderboardId: meta.leaderboardId,
          /** Which benchmarks and tiers publish it - where its difficulty band comes from. */
          tiers: meta.tiers,
          /** Accounts on its KovaaK's board, or null when it has never been sampled. */
          entries: entriesOf.get(name) ?? null,
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
      // Where every scenario is published and how big its board is, keyed by name for the
      // rows already in the season.
      //
      // The rows the editor spends its time on are the filled ones, and until now they
      // said only a name. On a pool drawn from one benchmark that was no loss; on one
      // drawn from ten, "which benchmark is this from and is its board big enough to cut
      // ranks out of" is the question being asked of every row.
      provenance: Object.fromEntries(
        [...known].map(([name, meta]) => [
          name,
          {
            tiers: meta.tiers,
            benchmarks: meta.benchmarks,
            entries: entriesOf.get(name) ?? null,
          },
        ]),
      ),
      // A windowed season is not added to one scenario at a time: a family needs one
      // variant per window, so a lone scenario would leave a family incomplete and the
      // season unsaveable. Said here rather than discovered on Save.
      // evxl's own listing order, which is what "most played" means here (see
      // tools/benchmarkPopularity.ts). Sent so the coverage readout can name the
      // benchmarks a season uses *nothing* from - the ones a count alone cannot show.
      benchmarkOrder: (() => {
        try {
          const pop = JSON.parse(
            readFileSync(dataFile("benchmark_popularity.json"), "utf8"),
          ) as { benchmarks: { benchmark: string; players: number | null }[] };
          return pop.benchmarks.slice(0, 10).map((b) => ({
            name: b.benchmark,
            players: b.players,
          }));
        } catch {
          return [];
        }
      })(),
      windowed: windowSize > 0,
      windowNote:
        windowSize > 0
          ? `This season grades families across ${season.windows?.length ?? 0} windows. ` +
            `Adding one means a scenario per window, which buildSeason does.`
          : null,
    };
  } catch (err) {
    return { error: friendlyError(err) };
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
type PercentileCache = {
  source: string;
  sampledAt: string;
  samplePoints: number[];
  distributions: Distribution[];
};
/** The sampled boards, read once and shared by every sample the editor starts. */
let percentileCache: PercentileCache | null = null;
let percentileWrite: Promise<void> = Promise.resolve();

ipcMain.handle("apogee:sampleScenario", async (_e, { scenario, leaderboardId, topFractions } = {} as any) => {
  if (!state.session || !(await isAdmin().catch(() => false))) {
    return { error: "only an admin can edit the season" };
  }
  if (!leaderboardId) return { error: "no leaderboard id for this scenario" };

  const file = dataFile("leaderboard_percentiles.json");
  let cache: PercentileCache;
  try {
    cache = percentileCache ??= JSON.parse(readFileSync(file, "utf8")) as PercentileCache;
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
    //
    // The grid samples several slots at once. Each call used to read the file, add its
    // board and write the whole file back, so two samples in flight each wrote a copy
    // missing the other's board. They now share one cache in memory, a board sampled by
    // two calls is kept once, and writes are queued so no two overlap.
    const found = dist;
    if (!cache.distributions.some((d) => d.scenario === found.scenario)) {
      cache.distributions.push(found);
      cache.distributions.sort((a, b) => a.scenario.localeCompare(b.scenario));
    }
    percentileWrite = percentileWrite.then(() => {
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
    });
    await percentileWrite;
  }

  return { rankMaxes, entries: dist.total, sampledAt: dist.sampledAt, sampled };
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
ipcMain.handle("apogee:searchScenarios", async (_e, { query } = {} as any) => {
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
    return { error: friendlyError(err) };
  }
});

/**
 * What the ladder currently on screen would do to the population.
 *
 * Tuning thresholds without this is guesswork: you can see that a rank asks for 929, and
 * not that it holds two players in a thousand or that nobody holds it at all. Computed
 * from the draft rather than the saved season, so it answers for what is being edited.
 */
ipcMain.handle("apogee:rankDistribution", async (_e, { season } = {} as any) => {
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
    return { error: friendlyError(err) };
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
ipcMain.handle("apogee:deriveWindow", async (_e, { scenarios, topFractions } = {} as any) => {
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

/**
 * What the files looked like when the editor was handed them.
 *
 * Not a version number and not a lock: a hash of the two files the save rewrites, taken
 * when they are read and checked when they are written back. Cheap, needs nothing kept in
 * memory between an open and a save, and survives the app being restarted in between.
 *
 * The pool is in it as well as the season, because `saveSeason` reconstructs the pool from
 * the season it is given. An editor that never saw a change to `data/pool.json` will
 * happily rebuild it from a stale draft and take the change out again.
 */
function fileFingerprint(file: string): string {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
  } catch {
    return "missing";
  }
}

function seasonFingerprint(): string {
  return [seasonPath(), dataFile("pool.json")].map(fileFingerprint).join(".");
}

ipcMain.handle("apogee:getSeason", () => {
  try {
    // energyPerRank travels with the season because the renderer needs it to rebalance a
    // category's ladder and cannot import it - it is a browser script. It used to be a
    // literal 2500 there, a third copy of a constant that has one owner.
    // The percentile ladder travels with it. It lives in the pool, not the season, and a
    // scenario dropped into a slot has its thresholds cut from its own board at that
    // window's share of the ladder. The editor used to read it from `season.derivedFrom`,
    // which the season stopped carrying when thresholds moved into the pool, so every slot
    // fill failed with "this season has no percentile ladder to derive from".
    let ladder: { ranks: number[]; overlap: number } | null = null;
    try {
      const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8"));
      if (Array.isArray(pool.ladder?.ranks)) {
        ladder = { ranks: pool.ladder.ranks, overlap: pool.ladder.overlap ?? 0 };
      }
    } catch {
      // No pool: scenarios can still be moved between slots, only not re-cut.
    }
    return {
      season: loadSeason(),
      path: seasonPath(),
      energyPerRank: ENERGY_PER_RANK,
      fingerprint: seasonFingerprint(),
      ladder,
    };
  } catch (err) {
    return { error: friendlyError(err) };
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
/**
 * The rating ladder: the eight tiers in `data/apogee_ranks.json`.
 *
 * Separate from the season on purpose - a tier says where you sit against other players
 * and a season rank says what your scores are worth - but it had no editor in the app at
 * all, and it paints more of the window than the season does: the accent colour on every
 * screen, the badge and name in the header, the hero, the opponent card, the Ranks page's
 * top ladder and the Season page's overall tier. Editing ranks in the season editor and
 * watching none of that move is indistinguishable from the editor being broken, which is
 * exactly how it was reported. `tools/rank-theme-editor.html` could always do this; a
 * standalone browser page is not where somebody looks when the app is open in front of
 * them.
 */
ipcMain.handle("apogee:getRankTheme", () => {
  try {
    const path = dataFile("apogee_ranks.json");
    return {
      theme: loadRankTheme(),
      path,
      fingerprint: fileFingerprint(path),
    };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

ipcMain.handle("apogee:saveRankTheme", async (_e, { theme, fingerprint, force } = {} as any) => {
  if (!state.session || !(await isAdmin().catch(() => false))) {
    return { error: "only an admin can edit the ranks" };
  }

  const path = dataFile("apogee_ranks.json");
  if (!force && fingerprint && fingerprint !== fileFingerprint(path)) {
    return {
      error:
        "the ranks on disk have changed since this editor loaded them. Save again to write " +
        "this draft over them, or Discard to reload and start from what is there.",
      stale: true,
    };
  }

  const body = JSON.stringify(theme, null, 2) + "\n";
  const written: string[] = [];

  try {
    // Written to a scratch path and loaded back before either real copy is touched.
    // `loadRankTheme` is where the percentile bands are checked for gaps and overlaps,
    // and a theme with a gap mis-ranks every player silently - so it has to fail here,
    // with the file still the way it was, rather than after the app is already wrong.
    const probe = join(app.getPath("temp"), `apogee-ranks-${process.pid}.json`);
    writeFileSync(probe, body, "utf8");
    try {
      loadRankTheme(probe);
    } finally {
      try { unlinkSync(probe); } catch { /* a temp file that will not delete is not an error */ }
    }
  } catch (err) {
    return { error: friendlyError(err) };
  }

  try {
    writeFileSync(path, body, "utf8");
    written.push(path);

    const source = sourceDataDir();
    const sourcePath = source ? join(source, "apogee_ranks.json") : null;
    if (sourcePath && sourcePath !== path) {
      writeFileSync(sourcePath, body, "utf8");
      written.push(sourcePath);
    }
  } catch (err) {
    return { error: `could not write the ranks: ${err instanceof Error ? err.message : err}` };
  }

  // The overall readout is these names, so renaming a tier has to reach the season as
  // well - otherwise editing the ranks here puts the two ladders back out of step, which
  // is the thing deriving them was for.
  try {
    const season = loadSeason();
    if (syncOverallLadder(season, loadRankTheme().tiers)) {
      const seasonBody = JSON.stringify(season, null, 2) + "\n";
      writeFileSync(seasonPath(), seasonBody, "utf8");
      written.push(seasonPath());
      const dir = sourceDataDir();
      const seasonSource = dir ? join(dir, "seasons", "season-1.json") : null;
      if (seasonSource && seasonSource !== seasonPath()) {
        writeFileSync(seasonSource, seasonBody, "utf8");
        written.push(seasonSource);
      }
    }
  } catch {
    // A season that will not load is a separate problem with its own message elsewhere;
    // it must not make renaming a tier fail.
  }

  rebuild("ranks edited");
  broadcast("apogee:seasonChanged", { at: Date.now() });
  return { ok: true, paths: written };
});

ipcMain.handle("apogee:saveSeason", async (_e, { season, fingerprint, force } = {} as any) => {
  if (!state.session || !(await isAdmin().catch(() => false))) {
    return { error: "only an admin can edit the season" };
  }

  // Refuse to write over a season that changed since this editor read it.
  //
  // The draft is the whole file, so a save is a whole-file overwrite: whatever the editor
  // was handed at load is what goes back, and anything that happened to those files in
  // between is gone without a message. That is not hypothetical. A client left open across
  // an afternoon of work on the pool put every one of those edits back the way they were,
  // twice - once silently reverting `data/pool.json`, and once undoing a rank rename and
  // all forty-eight colours a palette pass had just written, which read from the outside
  // as "saving does not do anything" because the app faithfully repainted itself to the
  // season it had just been told to use.
  //
  // A missing fingerprint is allowed through: an editor from a build before this one has
  // no way to send it, and refusing every one of those saves would be a worse failure than
  // the one being fixed.
  //
  // And the refusal is a warning, not a wall. The first version of this had no way past it,
  // which turns "you might lose the file's version" into "you will lose yours" - the draft
  // on screen can be an afternoon of work that exists nowhere else, and Discard is the only
  // other exit. Pressing Save a second time sends `force` and writes it.
  if (!force && fingerprint && fingerprint !== seasonFingerprint()) {
    return {
      error:
        "the season on disk has changed since this editor loaded it. Save again to write " +
        "this draft over it, or Discard to reload and start from what is there.",
      stale: true,
    };
  }

  // The editor edits `category.rankNames`, and every screen in the app reads
  // `category.bands[].rankNames`. Nothing kept them in step, so a rank renamed here landed
  // in a field nothing displays - which is what "the season editor is not saving" was, for
  // three whole ladders. Derived rather than reconciled: the bands are slices of the ladder
  // by construction, so the ladder is where the information is.
  // Families renamed in the grid, new key to old. Not part of the season - it is what lets
  // the pool rebuild below find what a renamed family carried under its old name - so it is
  // taken off before anything validates or writes the season.
  const renamed: Record<string, string> =
    season && typeof season.$renamed === "object" && season.$renamed ? season.$renamed : {};
  const editorLadder = season?.$editorLadder;
  if (season) delete season.$renamed;
  if (season) { delete season.$editorLadder; delete season.$editor; }
  if (editorLadder && (!Array.isArray(editorLadder.ranks) ||
      editorLadder.ranks.length !== (season.windows?.length ?? 0) * (season.windowSize ?? 0) ||
      editorLadder.ranks.some((n: number, i: number) => !Number.isFinite(n) || n <= 0 || n > 1 || (i > 0 && n >= editorLadder.ranks[i - 1])))) {
    return { error: "The percentile ladder must have one descending share per rank, between zero and one." };
  }

  syncBandLadders(season);
  // And the overall readout takes its names from the rating ladder, which is now the only
  // place they are chosen.
  syncOverallLadder(season, loadRankTheme().tiers);

  try {
    validateSeason(season);
  } catch (err) {
    return { error: friendlyError(err) };
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
      const rebuilt = rebuildPool(pool, season, renamed);
      if (editorLadder) rebuilt.ladder = { ...(pool.ladder ?? {}), ...editorLadder };
      return JSON.stringify(rebuilt, null, 2) + "\n";
    } catch {
      // A windowed season must keep its source pool in sync, or the next build erases
      // the edit. The renderer retains the draft when this save is refused below.
      return null;
    }
  })();
  if (!poolBody && season.windowSize) {
    return { error: "Could not rebuild the source pool. The season was not saved; your draft is still in the editor." };
  }

  // A renamed family keeps its written rationale. `data/scenario_rationale.json` is keyed
  // by family name, and validate:rationale refuses a family with none and a rationale for a
  // family that no longer exists, so a rename in the grid would otherwise orphan both.
  const rationaleBody = (() => {
    if (Object.keys(renamed).length === 0) return null;
    try {
      const file = JSON.parse(readFileSync(dataFile("scenario_rationale.json"), "utf8"));
      let changed = false;
      for (const [now, was] of Object.entries(renamed)) {
        const category = was.slice(0, was.indexOf("/"));
        const oldName = was.slice(category.length + 1);
        const newName = now.slice(now.indexOf("/") + 1);
        for (const f of file.families ?? []) {
          if (f.family === oldName) {
            f.family = newName;
            changed = true;
          }
        }
      }
      return changed ? JSON.stringify(file, null, 2) + "\n" : null;
    } catch {
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
    if (rationaleBody) writeFileSync(dataFile("scenario_rationale.json"), rationaleBody, "utf8");

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
      if (rationaleBody) {
        writeFileSync(join(source, "scenario_rationale.json"), rationaleBody, "utf8");
        written.push(join(source, "scenario_rationale.json"));
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

  // Rebuild, then say so separately, because the rebuild is not guaranteed to say
  // anything at all.
  //
  // A rank name or a colour changed in the editor has to reach every screen that draws
  // one, and `rebuild` was the only thing telling the renderer to redraw. It returns
  // early when no stats folder is set, and `buildSnapshot` returns null when the folder
  // holds no runs - both of which are ordinary states for the machine doing the editing,
  // and in both of them a save repainted the editor and left the rest of the window
  // showing the old ladder until it was restarted. It also cannot help the views that do
  // not come from the snapshot: the practice list and the apex board fetch the season
  // themselves.
  //
  // Ratings, standings and the public board are deliberately *not* in this: those come
  // from Supabase, and they do not change until `npm run push:season`. Refreshing them
  // here would draw the old server ladder over the new local one and look like the save
  // had failed.
  rebuild("season edited");
  broadcast("apogee:seasonChanged", { at: Date.now() });
  // The files as this save left them, so the editor's next save is measured against its
  // own last write. Without it every save after the first in a session was refused as
  // "changed on disk since this editor loaded it" - the change being the previous save.
  return { ok: true, path: written[0], paths: written, fingerprint: seasonFingerprint() };
});

ipcMain.handle("apogee:openStatsFolder", () => {
  if (state.statsDir) void shell.openPath(state.statsDir);
});

// The same text as Copy diagnostics on the menu, for the footer link. The menu is
// hidden under the custom title bar, so until this existed the one thing worth
// attaching to a bug report was reachable only by somebody who knew to press Alt.
ipcMain.handle("apogee:diagnostics", () => diagnostics());

/**
 * Swap one of today's quests for the spare drawn with the board.
 *
 * The spare was chosen when the board was issued, so this needs no history and cannot be
 * used to fish: the one alternative is fixed for the day, and the reroll is spent either way.
 */
ipcMain.handle("apogee:rerollQuest", (_event, args: { id?: unknown } | undefined) => {
  const id = typeof args?.id === "string" ? args.id : null;
  if (!id) return { error: "No quest named." };

  const result = rerollQuest(state.quests ?? loadQuestState(), id);
  if ("error" in result) return result;

  state.quests = result.state;
  saveQuestState(state.quests);
  // Rebuilt now rather than debounced: the button is waiting on this, and the new
  // quest may already be half done from this morning's runs.
  rebuild("quest rerolled");
  return { ok: true };
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
/**
 * Open one scenario in KovaaK's.
 *
 * Anything the season names, whether or not a match is running. It used to require a live
 * match and refuse everything else, which made the season pool unplayable except by
 * queueing - the Season screen could name all 88 scenarios and offer no way to run one.
 *
 * Still not "any string the renderer sends": this hands a name to a Steam deep link, so it
 * is checked against the match and the season first. Both lists come from the main
 * process, so a renderer with injected script cannot widen them.
 */
ipcMain.handle("apogee:launchScenario", async (_e, { scenario } = {} as any) => {
  if (typeof scenario !== "string" || scenario.length === 0) {
    return { error: "no scenario given" };
  }

  const inMatch = state.match?.scenarios.some((s) => s.name === scenario) ?? false;
  const inSeason = (() => {
    try {
      return loadSeason().scenarios.some((s) => s.scenario === scenario);
    } catch {
      return false;
    }
  })();

  // A ghost match is drawn from the player's own library, so its scenarios are almost
  // never in the season. Read from the main-side match, like inMatch, never from anything
  // the renderer sent.
  const inGhost = ghost.scenarios().has(scenario);

  if (!inMatch && !inSeason && !inGhost) {
    // Wording kept: mixtape.js matches "not in this match or this season" to explain a
    // scenario that left the pool.
    return { error: "that scenario is not in this match or this season" };
  }

  const launched = await launchKovaaks(scenario);
  return launched.ok
    ? { ok: true, scenario }
    : { error: launched.error ?? "could not start KovaaK's" };
});

/**
 * Everything needed to grind the season, per scenario rather than per family.
 *
 * The snapshot already carries one row per family - whichever variant earned the rank -
 * which is the right shape for a standing and the wrong one for a practice list: it
 * cannot say what you have done on the other three difficulties, so it cannot say which
 * one to play next. This reads the whole pool against local history instead.
 *
 * Read-only and computed on demand. Deliberately not cached on `state`: it is a few
 * milliseconds over a folder the watcher is already rescanning, and a stale practice list
 * would show a personal best that a run five minutes ago already beat.
 */
/**
 * The apex board: where the player sits on the boards the ladder stops measuring.
 *
 * Read locally from the committed samplings, so it renders with no session and no
 * network - the same way practice and the rank sheet do. The server keeps its own copy
 * for the cross-player leaderboard (`refresh-apex`), computed from KovaaK's-verified
 * bests rather than from the stats folder, because a public board is exactly the surface
 * somebody would forge a score onto. The two agree for an honest player, and where they
 * do not, the server's is the one that counts.
 */
const APEX_UNSAMPLED =
  "No KovaaK's leaderboard for this season's scenarios yet, so there is nothing to place " +
  "you against. Apex points start once the boards are sampled.";

ipcMain.handle("apogee:apex", () => {
  let season;
  try {
    season = loadSeason();
  } catch (err) {
    return { error: friendlyError(err) };
  }

  let sources;
  try {
    sources = apexSources(
      JSON.parse(readFileSync(dataFile("leaderboard_apex.json"), "utf8")) as {
        boards: ApexBoard[];
      },
      JSON.parse(readFileSync(dataFile("leaderboard_percentiles.json"), "utf8")) as {
        distributions: Distribution[];
      },
    );
  } catch {
    // Absent rather than fatal: a build without the sampled boards still runs, it just
    // cannot show this panel. Saying so beats an empty board that reads as a bad score.
    return { error: "no sampled leaderboards in this build - run npm run sample:apex" };
  }

  // Apogee's own scenarios have no KovaaK's board until they are shared in-game (see
  // docs/season-1.md). Without one every family grades as 0.00 points and "41 of 41
  // scored", which reads as a bad score rather than as nothing to measure against.
  if (!season.scenarios.some((sc) => sources.boards.has(sc.scenario))) {
    return { error: APEX_UNSAMPLED };
  }

  const history = state.statsDir
    ? scanStatsFolder(state.statsDir)
    : new Map<string, ScenarioHistory>();
  const scores = new Map<string, number>();
  for (const [scenario, entry] of history) {
    const best = Math.max(...entry.runs.map((r) => r.score));
    if (Number.isFinite(best)) scores.set(scenario, best);
  }

  const standing = apexStanding(season, scores, sources);

  return {
    season: { name: season.name, status: season.status },
    points: standing.points,
    graded: standing.graded,
    total: standing.total,
    sampledAt: standing.sampledAt,
    categories: standing.categories.map((c) => ({
      name: c.name,
      points: c.points,
      graded: c.graded,
      total: c.total,
      families: c.families.map((f) => ({
        family: f.family,
        subCategory: f.subCategory,
        scenario: f.scenario,
        label: f.label,
        score: f.score,
        points: f.points,
        boardRank: f.boardRank === null ? null : Math.round(f.boardRank),
        boardTotal: f.boardTotal,
        next:
          f.next === null
            ? null
            : {
                points: f.next.points,
                score: f.next.score,
                rank: Math.round(f.next.rank),
              },
      })),
    })),
  };
});

/**
 * The public apex board for one category.
 *
 * Refresh then read, in that order and in one call, because the two are one action
 * from the player's side: opening the board should show them on it. They stay separate
 * on the server - `refresh-apex` writes, `apex-board` reads - so a client that only
 * wants to look does not have to write to do it.
 *
 * A refresh failure is not fatal. The board is still worth showing without the caller's
 * own row updated, and the most likely cause is the rate limit, which means their row
 * was written moments ago anyway.
 */
ipcMain.handle("apogee:apexBoard", async (_e, { category } = {} as any) => {
  if (!state.session) return { error: "sign in to see the board" };

  // The server builds this board from the same sampled boards (refresh-apex answers 503
  // without them), so an unsampled season is said plainly rather than shown as empty.
  try {
    const sampled = JSON.parse(readFileSync(dataFile("leaderboard_apex.json"), "utf8")) as { boards?: { scenario: string }[] };
    const names = new Set((sampled.boards ?? []).map((b) => b.scenario));
    if (!loadSeason().scenarios.some((sc) => names.has(sc.scenario))) return { error: APEX_UNSAMPLED };
  } catch {
    // Unreadable locally is not a reason to hide the server's board; ask it anyway.
  }

  let refreshed = true;
  try {
    await refreshApex();
  } catch {
    refreshed = false;
  }

  try {
    const board = await fetchApexBoard(String(category ?? "Overall"));
    return { ...board, refreshed };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

ipcMain.handle("apogee:practice", () => {
  let season;
  try {
    season = loadSeason();
  } catch (err) {
    return { error: friendlyError(err) };
  }

  const history = state.statsDir ? scanStatsFolder(state.statsDir) : new Map();
  const { rows, families } = practiceRows(season, history);
  const playlistDir = state.statsDir ? playlistsFolderFor(state.statsDir) : null;
  const allPlaylists = practicePlaylists(season);
  const installedNames = playlistDir
    ? installedPlaylistNames(playlistDir, allPlaylists.map((p) => p.name))
    : [];

  return {
    families,
    scenarios: rows,
    season: {
      name: season.name,
      status: season.status,
      windows: season.windows ?? [],
      windowSize: season.windowSize ?? 4,
      categories: season.categories.map((c) => ({
        name: c.name,
        rankNames: c.rankNames,
        rankColors: c.rankColors,
      })),
    },
    playlists: allPlaylists.map((p) => ({
      name: p.name,
      category: p.category,
      window: p.window,
      scenarios: p.scenarios.length,
    })),
    playlistDir,
    installed: playlistDir ? installedPlaylistCount(playlistDir) : 0,
    // Which ones, not just how many: the chips draw their own state from this.
    installedNames,
  };
});

/**
 * Write the season's practice playlists into KovaaK's own Playlists folder.
 *
 * The one action here that touches a folder outside Apogee, so it is explicit rather than
 * automatic and says exactly where it wrote. KovaaK's reads its playlists at startup, so
 * the reply carries that too - a player hunting a menu for a playlist that is genuinely on
 * disk and genuinely not on screen is the failure this note exists to prevent.
 */
ipcMain.handle("apogee:installPlaylists", (_e, args) => {
  if (!state.statsDir) return { error: "no stats folder" };

  // A named subset, for the one band on screen. Filtered here rather than trusted: the
  // renderer sends names, and only names this season actually produces are written.
  const only = Array.isArray(args?.names) ? new Set<string>(args.names) : null;

  let season;
  try {
    season = loadSeason();
  } catch (err) {
    return { error: friendlyError(err) };
  }

  const dir = playlistsFolderFor(state.statsDir);
  const result = writePracticePlaylists(season, dir, { only });
  if (!result.ok) {
    return {
      error:
        `${result.error}. Apogee found KovaaK's stats at ${state.statsDir}, so it expected ` +
        `a Playlists folder beside it.`,
    };
  }

  return {
    ok: true,
    dir,
    written: result.written?.length ?? 0,
    installed: installedPlaylistCount(dir),
    // Re-read rather than assume what was written: a folder the player cleaned out by
    // hand between two clicks should leave the chips telling the truth.
    installedNames: installedPlaylistNames(dir, practicePlaylists(season).map((p) => p.name)),
    note: "KovaaK's reads playlists at startup - restart the game to see them.",
  };
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
