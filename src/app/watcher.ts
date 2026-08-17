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

import { watch, statSync, readFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

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
      // Deleted or briefly locked between events; drop it.
      pending.delete(file);
      return;
    }

    const grewOrLocked = size !== entry.size;
    const waitedTooLong = Date.now() - entry.since > MAX_WAIT_MS;

    if (grewOrLocked && !waitedTooLong) {
      entry.size = size;
      entry.timer = setTimeout(() => settle(file), SETTLE_MS);
      return;
    }

    pending.delete(file);

    try {
      const result = parseStatsFile(file, readFileSync(full, "utf8"));
      // An unfinished run has no Score line. That is normal (the player quit early)
      // and must not surface as an error.
      if (result.ok) events.onRun?.(result.run, file);
    } catch (err) {
      events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const schedule = (file: string): void => {
    if (!file.endsWith("Stats.csv")) return;

    const existing = pending.get(file);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => settle(file), SETTLE_MS);
      return;
    }

    pending.set(file, {
      timer: setTimeout(() => settle(file), SETTLE_MS),
      size: -1,
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

/**
 * Common install locations, in the order worth trying.
 *
 * KovaaK's is a Steam title, so it follows the user's Steam library layout rather than
 * a fixed path; a second library on another drive is the normal case, not an edge one.
 */
export function candidateStatsFolders(): string[] {
  const suffix = "steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";
  const roots = [
    "C:\\Program Files (x86)\\Steam",
    "C:\\Steam",
    "D:\\Steam",
    "D:\\SteamLibrary",
    "E:\\Steam",
    "E:\\SteamLibrary",
    "F:\\Steam",
    "F:\\SteamLibrary",
  ];
  return roots.map((root) => `${root}\\${suffix}`);
}

/** First candidate folder that exists, or null. */
export function findStatsFolder(): string | null {
  for (const candidate of candidateStatsFolders()) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}
