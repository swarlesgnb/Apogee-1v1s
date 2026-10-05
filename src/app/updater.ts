/**
 * Update in place from the GitHub releases.
 *
 * Every version before this one had to be downloaded from the release page by hand, so a
 * fix reached only the players who went looking for it - and a server change that the
 * old client reads differently (0.4.3's rounds, against 0.4.2's delta labels) stayed
 * visible for as long as anybody kept the old build.
 *
 * electron-updater reads `latest.yml` from the newest release, which `npm run dist`
 * already writes and the release already carries. A newer version downloads in the
 * background, only the changed blocks where the `.blockmap` allows it, and its sha512 is
 * checked against `latest.yml` before anything runs. Then the player is told it is ready:
 * restarting installs it, and so does quitting normally, so nobody is ever interrupted
 * mid-match by an install they did not ask for.
 *
 * The installer is unsigned (docs/release-readiness.md), so there is no publisher check
 * to make; the hash is what ties the download to the release. Publishing a release is
 * therefore the act that ships an update to everyone, and `latest.yml` should only go up
 * on a build that has passed validate:release and validatePackage.
 *
 * Main decides; the renderer only shows `UpdateState` and can ask for the restart.
 */

import { app } from "electron";
import { autoUpdater } from "electron-updater";

import { log } from "./crashLog.ts";

export type UpdateState =
  | { status: "idle"; current: string }
  | { status: "checking"; current: string }
  | { status: "downloading"; current: string; version: string; percent: number }
  | { status: "ready"; current: string; version: string }
  | { status: "error"; current: string; message: string };

/** First check a little after launch, so it does not compete with the initial scan. */
const FIRST_CHECK_MS = 15_000;
/** Then every few hours, for the app that is left open beside the game for days. */
const RECHECK_MS = 4 * 60 * 60 * 1000;

export class Updater {
  private state: UpdateState;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly publish: (state: UpdateState) => void) {
    this.state = { status: "idle", current: app.getVersion() };
  }

  get current(): UpdateState {
    return this.state;
  }

  /**
   * Start checking, unless this is a build that must not update itself.
   *
   * A dev build (`electron .`) is not installed, so there is nothing to replace, and the
   * smoke and fresh modes run in throwaway profiles where a background download would be
   * noise in a test. `APOGEE_NO_UPDATE=1` turns it off for anyone who wants that.
   *
   * `APOGEE_UPDATE_FEED` points it at another feed, which is how an update is rehearsed
   * against a local folder before a real release goes up (docs/release-readiness.md).
   * It is read from the environment of somebody already running code on the machine, so
   * it grants nothing that person did not already have.
   */
  start(options: { disabled: boolean }): void {
    if (options.disabled || process.env.APOGEE_NO_UPDATE === "1") return;

    const feed = process.env.APOGEE_UPDATE_FEED;
    if (!app.isPackaged && !feed) return;
    if (feed) {
      autoUpdater.setFeedURL({ provider: "generic", url: feed });
      autoUpdater.forceDevUpdateConfig = !app.isPackaged;
      log(`update feed overridden: ${feed}`);
    }

    autoUpdater.autoDownload = true;
    // Releases ship the full installer, never a web installer that fetches the app later.
    autoUpdater.disableWebInstaller = true;
    // Quitting normally installs a downloaded update too, so a player who never clicks
    // the bar still ends up current the next time they open the app.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (m: unknown) => log(`update: ${String(m)}`),
      warn: (m: unknown) => log(`update warning: ${String(m)}`),
      error: (m: unknown) => log(`update error: ${String(m)}`),
      debug: () => {},
    };

    const current = app.getVersion();
    autoUpdater.on("checking-for-update", () => {
      // Never step back from a download in progress or a ready update to "checking":
      // a recheck four hours later would hide the bar that says a restart is waiting.
      if (this.state.status === "idle" || this.state.status === "error") this.set({ status: "checking", current });
    });
    autoUpdater.on("update-not-available", () => {
      if (this.state.status === "checking") this.set({ status: "idle", current });
    });
    autoUpdater.on("update-available", (info) => {
      this.set({ status: "downloading", current, version: info.version, percent: 0 });
    });
    autoUpdater.on("download-progress", (p) => {
      if (this.state.status === "downloading") {
        this.set({ ...this.state, percent: Math.round(p.percent) });
      }
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.set({ status: "ready", current, version: info.version });
    });
    autoUpdater.on("error", (e) => {
      // Offline, GitHub down, rate-limited: none of it is the player's problem, and the
      // next check retries. Shown only so the state is honest, never as an error banner.
      if (this.state.status !== "ready") {
        this.set({ status: "error", current, message: e instanceof Error ? e.message : String(e) });
      }
    });

    const check = () => {
      autoUpdater.checkForUpdates().catch((e) => log(`update check failed: ${e instanceof Error ? e.message : e}`));
    };
    setTimeout(check, FIRST_CHECK_MS);
    this.timer = setInterval(check, RECHECK_MS);
  }

  /** Restart into the downloaded version. Ignored unless one is ready. */
  install(): boolean {
    if (this.state.status !== "ready") return false;
    if (this.timer) clearInterval(this.timer);
    log(`update: restarting into ${this.state.version}`);
    // Silent, because the player already chose this by clicking; relaunch afterwards so
    // they land back in the app rather than on their desktop.
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  private set(next: UpdateState): void {
    this.state = next;
    this.publish(next);
  }
}
