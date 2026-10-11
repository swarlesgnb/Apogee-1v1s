/**
 * Every stats file in a folder, parsed once per session and shared by every reader.
 *
 * History and the Expedition each used to keep their own cache and fill it from disk, so
 * a cold start parsed the 13,654 files of a real folder twice on Electron's main process:
 * measured at 4.9 s for history and 6.6 s for the Expedition, back to back, before the
 * window could show. The Expedition's reader also re-statted every file on every call to
 * notice changes, 0.6-1.3 s each time, after every run and on every click.
 *
 * Neither was needed. KovaaK's writes a stats file once, when the run ends, and never
 * touches it again (the reasoning history.ts already relied on), so a file that parsed
 * once cannot parse differently later and needs no stat to prove it. Only a failure is
 * retried: a file caught mid-write fails now and parses on the next scan.
 *
 * Because a parse is kept for the session, a file is not parsed until it has been quiet
 * for SETTLE_MS: one caught between two writes could otherwise parse as whatever the
 * first write left and be kept that way. Only files not yet parsed are statted for this,
 * so it costs nothing on a rescan. The watcher already waits longer than this before a
 * rebuild, so a new run is not delayed in practice.
 *
 * What is kept is what the readers need and no more. A parsed run carries its kill table,
 * and 13k of those is memory spent on nothing. `coherent` is computed here, once, rather
 * than by the Expedition, because computing it needs the full run and the full run is
 * only in hand at parse time. It adds about 0.24 s to a cold scan of that folder.
 *
 * Two additions for the cold start itself: `primeStatsFolder` does the first parse in
 * slices so the main process keeps answering while it runs, and `useDiskCache` keeps the
 * parse between sessions so a relaunch reads only the files it has not seen.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dataFile } from "../dataDir.ts";
import { checkConsistency, type ScoreModel, type WeaponScoreModel } from "../verify/consistency.ts";
import { parseStatsFile, type ParsedRun } from "./parseStatsFile.ts";

export interface StatsFileRun extends Pick<ParsedRun, "scenario" | "score" | "playedAt" | "challengeStart"> {
  /** Whether the file is internally consistent (verify/consistency.ts). */
  coherent: boolean;
}

const SETTLE_MS = 400;
const parsed = new Map<string, StatsFileRun>();
let parsedDir: string | null = null;
let models: { models?: Record<string, ScoreModel>; weaponModels?: Record<string, WeaponScoreModel> } | null = null;

/** The folder's file names as last listed, so a saved cache drops files that have gone. */
let listed: string[] = [];
/** Files parsed since the cache was last written. */
let unsaved = 0;
let disk: { path: string; key: string } | null = null;
let priming: { dir: string; promise: Promise<void> } | null = null;
let primedDir: string | null = null;

function enter(dir: string): void {
  if (dir === parsedDir) return;
  parsed.clear();
  parsedDir = dir;
  priming = null;
  primedDir = null;
  unsaved = 0;
  loadDiskCache(dir);
}

/** Parse one file into the cache. False when it is too fresh, unreadable or incomplete. */
function parseInto(dir: string, file: string): boolean {
  try {
    const path = join(dir, file);
    if (Date.now() - statSync(path).mtimeMs < SETTLE_MS) return false;
    const result = parseStatsFile(file, readFileSync(path, "utf8"));
    if (!result.ok) return false;
    const r = result.run;
    models ??= JSON.parse(readFileSync(dataFile("score_models.json"), "utf8"));
    parsed.set(file, {
      scenario: r.scenario,
      score: r.score,
      playedAt: r.playedAt,
      challengeStart: r.challengeStart,
      coherent: checkConsistency(r, {
        scoreModel: models!.models?.[r.scenario],
        weaponScoreModel: models!.weaponModels?.[r.scenario],
      }).coherent,
    });
    unsaved++;
    return true;
  } catch {
    // Locked while KovaaK's finishes writing it. Tried again on the next scan.
    return false;
  }
}

function list(dir: string): string[] | null {
  try {
    listed = readdirSync(dir).filter((f) => f.endsWith("Stats.csv"));
    return listed;
  } catch {
    return null;
  }
}

/**
 * The runs in a stats folder that parse, keyed by file name, in directory order.
 *
 * An unreadable folder is an empty one; callers already treat "no runs" as their state
 * for a folder that has not been chosen or has been moved.
 */
export function readStatsFolder(dir: string): { file: string; run: StatsFileRun }[] {
  const files = list(dir);
  if (!files) return [];
  enter(dir);

  const out: { file: string; run: StatsFileRun }[] = [];
  for (const file of files) {
    if (!parsed.has(file) && !parseInto(dir, file)) continue;
    out.push({ file, run: parsed.get(file)! });
  }
  return out;
}

/**
 * Parse everything in the folder that is not parsed yet, a slice at a time, giving the
 * event loop back between slices.
 *
 * `readStatsFolder` does the same work in one go, and on Electron's main process one go
 * is a frozen app: measured on a 15,000-run synthetic folder, the first scan held the main
 * process for 2.0 s, and the window could not paint, answer a click or answer the
 * renderer until it was done. Primed first, the first `readStatsFolder` finds every file
 * already parsed and costs a listing. Repeated calls for the same folder share one pass,
 * and once it is done they resolve at once; files that arrive later are parsed by
 * `readStatsFolder` as they always were, a few at a time.
 */
export function primeStatsFolder(dir: string, sliceMs = 12): Promise<void> {
  if (priming && priming.dir === dir) return priming.promise;
  const promise = (async () => {
    enter(dir);
    const files = list(dir);
    // Unreadable is read as empty, as readStatsFolder reads it: done, with nothing in it.
    if (!files) {
      primedDir = dir;
      return;
    }
    let sliceStart = performance.now();
    for (const file of files) {
      if (!parsed.has(file)) parseInto(dir, file);
      if (performance.now() - sliceStart > sliceMs) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        // A different folder was chosen while this one was being read.
        if (parsedDir !== dir) return;
        sliceStart = performance.now();
      }
    }
    if (parsedDir === dir) primedDir = dir;
  })();
  priming = { dir, promise };
  return promise;
}

/** True once `primeStatsFolder` has finished with this folder. */
export function isPrimed(dir: string): boolean {
  return primedDir === dir;
}

// ---------------------------------------------------------------------------
// the cache on disk
//
// Within a session every file is parsed once (see the header). Across sessions every
// launch parsed the whole folder again, which is the cold start: 13,654 files on the
// owner's machine, where a cold rebuild was logged at 54 s. The same reasoning that lets
// a parse be kept for a session - KovaaK's writes a stats file once, when the run ends,
// and never again - lets it be kept between sessions, keyed by file name.
//
// Kept only where the host asks for it (`useDiskCache`), with a key the host chooses:
// the app passes its build stamp, so a new build, which may parse or grade differently,
// starts from the files again. What is stored is exactly what is kept in memory, for one
// folder; a different folder or key reads as no cache at all. Failures are never stored,
// so a file caught mid-write is still tried again next time.
// ---------------------------------------------------------------------------

interface DiskCache {
  version: 1;
  key: string;
  dir: string;
  /** [file, scenario, score, playedAt ms or null, challengeStart, coherent 1/0] */
  runs: [string, string, number, number | null, string | null, 0 | 1][];
}

/** Keep parsed runs at `path` between sessions, valid only under the same `key`. */
export function useDiskCache(path: string, key: string): void {
  disk = { path, key };
}

function loadDiskCache(dir: string): void {
  if (!disk) return;
  try {
    const data = JSON.parse(readFileSync(disk.path, "utf8")) as DiskCache;
    if (data.version !== 1 || data.key !== disk.key || data.dir !== dir || !Array.isArray(data.runs)) return;
    for (const [file, scenario, score, playedAt, challengeStart, coherent] of data.runs) {
      parsed.set(file, {
        scenario,
        score,
        playedAt: playedAt === null ? null : new Date(playedAt),
        challengeStart,
        coherent: coherent === 1,
      });
    }
  } catch {
    // No cache yet, or one that cannot be read: the files are the source of truth.
  }
}

/**
 * Write what has been parsed to the disk cache, if anything new has been since the last
 * write. Returns whether it wrote. Written to a temporary file and renamed into place, so
 * a crash mid-write leaves the previous cache rather than half of one.
 */
export function saveDiskCache(): boolean {
  if (!disk || !parsedDir || unsaved === 0) return false;
  const present = new Set(listed);
  const runs: DiskCache["runs"] = [];
  for (const [file, r] of parsed) {
    if (!present.has(file)) continue;
    runs.push([file, r.scenario, r.score, r.playedAt ? r.playedAt.getTime() : null, r.challengeStart, r.coherent ? 1 : 0]);
  }
  try {
    mkdirSync(dirname(disk.path), { recursive: true });
    const tmp = `${disk.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, key: disk.key, dir: parsedDir, runs } satisfies DiskCache));
    renameSync(tmp, disk.path);
    unsaved = 0;
    return true;
  } catch {
    return false;
  }
}
