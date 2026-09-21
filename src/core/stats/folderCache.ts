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
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

/**
 * The runs in a stats folder that parse, keyed by file name, in directory order.
 *
 * An unreadable folder is an empty one; callers already treat "no runs" as their state
 * for a folder that has not been chosen or has been moved.
 */
export function readStatsFolder(dir: string): { file: string; run: StatsFileRun }[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith("Stats.csv"));
  } catch {
    return [];
  }

  if (dir !== parsedDir) {
    parsed.clear();
    parsedDir = dir;
  }

  const out: { file: string; run: StatsFileRun }[] = [];
  for (const file of files) {
    let run = parsed.get(file);
    if (!run) {
      try {
        const path = join(dir, file);
        if (Date.now() - statSync(path).mtimeMs < SETTLE_MS) continue;
        const result = parseStatsFile(file, readFileSync(path, "utf8"));
        if (!result.ok) continue;
        const r = result.run;
        models ??= JSON.parse(readFileSync(dataFile("score_models.json"), "utf8"));
        run = {
          scenario: r.scenario,
          score: r.score,
          playedAt: r.playedAt,
          challengeStart: r.challengeStart,
          coherent: checkConsistency(r, {
            scoreModel: models!.models?.[r.scenario],
            weaponScoreModel: models!.weaponModels?.[r.scenario],
          }).coherent,
        };
        parsed.set(file, run);
      } catch {
        // Locked while KovaaK's finishes writing it. Tried again on the next scan.
        continue;
      }
    }
    out.push({ file, run });
  }
  return out;
}
