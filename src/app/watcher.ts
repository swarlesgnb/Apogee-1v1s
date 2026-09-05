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
 * Where Steam is installed on this machine.
 *
 * Three sources, cheapest first: the registry value Steam itself writes, the standard
 * install path, and the drive roots people actually use. The registry is read through
 * `reg query` because Electron ships no registry binding, and one short child process at
 * startup beats a native dependency that has to be rebuilt for every Electron version.
 *
 * Forward slashes are left as they come: Node accepts them on Windows, and `join`
 * normalises them, so nothing here has to care which way a path was written.
 */
function steamRoots(): string[] {
  const roots: string[] = [];

  if (process.platform === "win32") {
    try {
      const out = execFileSync("reg", ["query", STEAM_KEY, "/v", "SteamPath"], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // SteamPath    REG_SZ    e:/steam
      const found = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out);
      if (found) roots.push(found[1].trim());
    } catch {
      /* No key, no reg.exe, or not Windows. The fixed candidates below still apply. */
    }

    const programFiles = process.env["ProgramFiles(x86)"];
    if (programFiles) roots.push(join(programFiles, "Steam"));
  }

  // Kept as a floor under the two lookups above: a machine with a broken registry value
  // and a stock install is still found.
  roots.push(
    "C:/Program Files (x86)/Steam",
    "C:/Steam",
    "D:/Steam",
    "D:/SteamLibrary",
    "E:/Steam",
    "E:/SteamLibrary",
    "F:/Steam",
    "F:/SteamLibrary",
  );

  return unique(roots);
}

/**
 * Fold duplicate paths that differ only in case or slash direction.
 *
 * Steam's registry value is lowercased with forward slashes (`e:/steam`) while the
 * fixed candidates are written the way a person would (`E:\Steam`). Windows treats them
 * as one folder, so probing both is wasted work and printing both is confusing.
 */
function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const path of paths) {
    // Uppercase the drive letter only: the rest of the path is shown to the player and
    // should read the way it does in Explorer.
    const tidy = join(path).replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
    const key = tidy.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tidy);
  }

  return out;
}

/**
 * Every Steam library on this machine, read from Steam's own `libraryfolders.vdf`.
 *
 * This is what makes an install on `G:\Games\SteamLibrary` findable. Guessing drive
 * letters only ever covered the common cases, and the player it missed had to point at
 * the folder by hand on every launch, since nothing remembered the answer. Steam has
 * always kept the real list of libraries; nobody was reading it.
 *
 * VDF is Valve's own key-value format. Only `"path" "..."` is wanted, so it is matched
 * directly rather than by writing a parser for a format we otherwise never touch.
 */
function steamLibraries(): string[] {
  const libraries: string[] = [];

  for (const root of steamRoots()) {
    libraries.push(root);
    for (const rel of ["config/libraryfolders.vdf", "steamapps/libraryfolders.vdf"]) {
      try {
        const text = readFileSync(join(root, rel), "utf8");
        for (const entry of text.matchAll(/"path"\s+"([^"]+)"/g)) {
          // Stored JSON-style, so every backslash in the path arrives doubled.
          libraries.push(join(entry[1].replace(/\\\\/g, "\\")));
        }
      } catch {
        /* Steam is not installed here, or predates this file. */
      }
    }
  }

  return unique(libraries);
}

/** Registry value Steam writes on install. */
const STEAM_KEY = "HKCU\\Software\\Valve\\Steam";

/** Where KovaaK's keeps its stats, relative to the Steam library holding it. */
const STATS_SUFFIX = join("steamapps", "common", "FPSAimTrainer", "FPSAimTrainer", "stats");

/**
 * Stats folders worth probing, best guess first.
 *
 * Exported so `npm run doctor` can print what was searched when nothing was found: a
 * bare "not found" is the least useful thing a first run can say.
 */
export function candidateStatsFolders(): string[] {
  return steamLibraries().map((library) => join(library, STATS_SUFFIX));
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
