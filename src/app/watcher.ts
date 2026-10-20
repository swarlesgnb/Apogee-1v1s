/**
 * Watch the KovaaK's stats folder for new runs.
 *
 * Two things make this fiddly in practice, both learned from how KovaaK's actually
 * writes files:
 *
 *   1. The file is written progressively. Parsing on the first `rename`/`change` event
 *      yields a truncated CSV with no `Score:` line. So a file is only read once its
 *      size has stopped changing: a settle delay, not a fixed sleep.
 *
 *   2. Windows emits several events per file. Work is coalesced per path so a single
 *      run is parsed once.
 *
 * Implemented on node:fs.watch rather than a dependency: the folder is flat, the
 * events are simple, and one fewer native module is one fewer thing to rebuild for
 * Electron.
 */

import { execFileSync } from "node:child_process";
import { watch, statSync, readFileSync, readdirSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverStatsFolders } from "./steamPaths.ts";

import { parseStatsFile, type ParsedRun } from "../core/stats/parseStatsFile.ts";

/** How long a file's size must hold steady before it is considered complete. */
const SETTLE_MS = 400;

/** Give up on a file that never settles, rather than leaking a timer forever. */
const MAX_WAIT_MS = 15_000;

export interface WatcherEvents {
  onRun?: (run: ParsedRun, file: string) => void;
  onError?: (error: Error) => void;
}

export interface StatsWatcher {
  close(): void;
}

export function watchStatsFolder(dir: string, events: WatcherEvents): StatsWatcher {
  const pending = new Map<string, { timer: NodeJS.Timeout; size: number; since: number }>();
  let watcher: FSWatcher | null = null;

  const settle = (file: string): void => {
    const full = join(dir, file);
    const entry = pending.get(file);
    if (!entry) return;

    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      // Deleted between events; drop it.
      pending.delete(file);
      return;
    }

    const waitedTooLong = Date.now() - entry.since > MAX_WAIT_MS;
    const again = (): void => {
      entry.size = size;
      entry.timer = setTimeout(() => settle(file), SETTLE_MS);
    };

    if (size !== entry.size && !waitedTooLong) return again();

    let result: ReturnType<typeof parseStatsFile>;
    try {
      result = parseStatsFile(file, readFileSync(full, "utf8"));
    } catch (err) {
      // Locked by the writer on Windows. Read again shortly, and only reported once the
      // file has had longer than any run takes to be written.
      if (!waitedTooLong) return again();
      pending.delete(file);
      events.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Steady by size but not whole by content: created empty and filled later, or a tail
    // still to come. Looked at again rather than dropped, because a dropped file is a run
    // the match never hears about. A run quit early never gets a Score line; it is given
    // up on after MAX_WAIT_MS, silently, since quitting is normal and not an error.
    if (!result.ok && !waitedTooLong) return again();

    pending.delete(file);
    if (result.ok) events.onRun?.(result.run, file);
  };

  const schedule = (file: string): void => {
    if (!file.endsWith("Stats.csv")) return;

    // The size at every event, so a file that is already whole settles after one quiet
    // period. Starting from an unknown size made the first check always see growth and
    // wait a second period: 800 ms before any run could be read, measured at 812 ms
    // median from the file landing to the run on screen.
    let size = -1;
    try {
      size = statSync(join(dir, file)).size;
    } catch {
      /* Not there yet, or locked: settle reads it again. */
    }

    const existing = pending.get(file);
    if (existing) {
      clearTimeout(existing.timer);
      existing.size = size;
      existing.timer = setTimeout(() => settle(file), SETTLE_MS);
      return;
    }

    pending.set(file, {
      timer: setTimeout(() => settle(file), SETTLE_MS),
      size,
      since: Date.now(),
    });
  };

  try {
    watcher = watch(dir, { persistent: true }, (_event, filename) => {
      if (filename) schedule(String(filename));
    });
    watcher.on("error", (err) => events.onError?.(err));
  } catch (err) {
    events.onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    close() {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      watcher?.close();
      watcher = null;
    },
  };
}

/** Candidates from native Steam, Flatpak Steam, and their custom libraries. */
export function candidateStatsFolders(): string[] {
  let registryRoot: string | undefined;
  if (process.platform === "win32") {
    try {
      const output = execFileSync("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], {
        encoding: "utf8", timeout: 2000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      });
      registryRoot = /SteamPath\s+REG_SZ\s+(.+)/i.exec(output)?.[1].trim();
    } catch { /* Fixed install locations still apply. */ }
  }
  return discoverStatsFolders({ platform: process.platform, home: homedir(), env: process.env,
    registryRoot, readText: path => readFileSync(path, "utf8") });
}
/**
 * A stats folder named outright: `--stats <dir>` on the command line, else the
 * APOGEE_STATS_DIR environment variable, else null.
 *
 * For running the app, `npm run smoke` and the flow tools against a folder that is not
 * where KovaaK's keeps one, such as the synthetic fixture (tools/fixtures/syntheticStats.ts)
 * on a machine with no KovaaK's at all. The same variable already points the preview
 * build and the practice tools at a folder.
 */
export function statsFolderOverride(argv: readonly string[] = process.argv, env = process.env): string | null {
  const at = argv.indexOf("--stats");
  const named = at >= 0 ? argv[at + 1] : env.APOGEE_STATS_DIR;
  return named && named.trim() ? named.trim() : null;
}

/**
 * First candidate folder that exists, or null.
 *
 * A folder named by `statsFolderOverride` is the only candidate: when somebody says which
 * folder to read, quietly reading a different one is the wrong answer, so a named folder
 * that does not exist finds nothing.
 */
export function findStatsFolder(): string | null {
  const named = statsFolderOverride();
  if (named) {
    try {
      return statSync(named).isDirectory() ? named : null;
    } catch {
      return null;
    }
  }
  let empty: string | null = null;
  for (const candidate of candidateStatsFolders()) {
    try {
      if (!statSync(candidate).isDirectory()) continue;
      if (readdirSync(candidate).some(name => name.endsWith("Stats.csv"))) return candidate;
      empty ??= candidate;
    } catch {
      /* not this one */
    }
  }
  return empty;
}
