/**
 * Keep a log, and make a crash say something.
 *
 * In development a thrown error lands in the terminal that started the app. A packaged
 * app has no terminal: an uncaught exception in the main process leaves a window that
 * is still on screen and no longer does anything, which reads to the player as "the
 * buttons stopped working" and produces a bug report that cannot be acted on.
 *
 * So two things happen here that did not before. Everything worth knowing is appended
 * to a file under the user's data directory, which gives a bug report something to
 * attach; and a crash puts a dialog in front of the player naming what broke, with the
 * log one click away.
 *
 * Deliberately not a crash *reporter*. Uploading stack traces from a public build means
 * collecting data from people who have not been asked, and PLAN.md §5 makes a point of
 * being honest about what leaves the machine. The log stays local until its owner
 * chooses to send it.
 */

import { app, dialog, shell, type WebContents } from "electron";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/** Roll over at a megabyte, keeping one previous file. */
const MAX_BYTES = 1_000_000;

/**
 * How many crash dialogs to show before falling back to logging only.
 *
 * A failure inside a watcher or an interval does not happen once, it happens every time
 * the timer fires. Three dialogs is enough for the player to know something is wrong;
 * three hundred is a second bug on top of the first.
 */
const MAX_DIALOGS = 3;

let dialogsShown = 0;

/**
 * Log crashes but never show a dialog.
 *
 * `--smoke` runs headless and unattended. A modal there is not a warning anyone reads,
 * it is a process that never exits, so a crash during a smoke run would turn a failing
 * test into a hanging one.
 */
export function suppressCrashDialogs(): void {
  dialogsShown = MAX_DIALOGS;
}
let logDir: string | null = null;

function dir(): string {
  if (!logDir) {
    logDir = join(app.getPath("userData"), "logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

/** Where the log lives. Shown to the player, so it has to be a real, openable path. */
export function logPath(): string {
  return join(dir(), "apogee.log");
}

export function log(line: string): void {
  try {
    const path = logPath();
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, `${new Date().toISOString()}  ${line}\n`, "utf8");
  } catch {
    // Logging must never be the thing that takes the app down. If the data directory
    // is unwritable there is nowhere to report that to anyway.
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function report(kind: string, err: unknown): void {
  const detail = describe(err);
  log(`${kind}: ${detail}`);

  if (dialogsShown >= MAX_DIALOGS) return;
  dialogsShown++;

  // Async, and never awaited: this can be called from inside a failing handler, and
  // blocking there is how a recoverable error becomes a frozen window.
  void dialog
    .showMessageBox({
      type: "error",
      title: "Apogee hit an error",
      message: "Something went wrong inside Apogee.",
      detail:
        `${detail.split("\n").slice(0, 6).join("\n")}\n\n` +
        "The app may keep working. If it does not, quit and reopen it - and the log " +
        "below is worth attaching to a bug report.",
      buttons: ["Open log", "Continue"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 0) void shell.showItemInFolder(logPath());
    })
    .catch(() => undefined);
}

/**
 * Catch what would otherwise be silent.
 *
 * Note what this does *not* do: quit. Electron, unlike bare Node, keeps running after
 * an uncaught exception, and most of what reaches here is one failed IPC handler rather
 * than a corrupted process. Killing the app would throw away a match in progress to fix
 * a problem the player might not even have noticed.
 */
export function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => report("uncaught exception", err));
  process.on("unhandledRejection", (reason) => report("unhandled rejection", reason));

  log(`--- started, ${process.platform} ${process.arch}, electron ${process.versions.electron}`);
}

/**
 * Log what the renderer says, and notice when it dies.
 *
 * Reading console messages rather than adding an IPC channel is the point: the renderer
 * is a view and the bridge it is given is deliberately narrow (see the IPC section of
 * main.ts), so widening it to carry error reports would trade a real architectural rule
 * for a convenience. An uncaught error in the renderer already arrives here as a
 * console error, for free.
 */
export function attachRendererLogging(contents: WebContents): void {
  contents.on("console-message", (_event, level, message, line, source) => {
    // 2 is warning, 3 is error in Chromium's levels. Ordinary logging is noise.
    if (level < 2) return;
    log(`renderer ${level === 3 ? "error" : "warning"}: ${message} (${source}:${line})`);
  });

  contents.on("render-process-gone", (_event, details) => {
    report("renderer process gone", `${details.reason} (exit code ${details.exitCode})`);
  });

  contents.on("unresponsive", () => log("renderer became unresponsive"));
  contents.on("responsive", () => log("renderer recovered"));
}
