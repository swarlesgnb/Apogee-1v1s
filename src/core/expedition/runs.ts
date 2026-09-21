import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dataFile } from "../dataDir.ts";
import { readStatsFolder } from "../stats/folderCache.ts";
import { isAbandonedRun, runDurationSeconds } from "../stats/duration.ts";
import type { ExpeditionRun } from "./types.ts";

/**
 * Complete, coherent local runs. Parsing is shared with history (stats/folderCache.ts), so
 * a file is read once per session whichever of them sees it first; this keeps only what a
 * run became for the Expedition, keyed by file, so a rescan hashes only new files.
 */
export class ExpeditionRunReader {
  private cache = new Map<string, ExpeditionRun | null>();
  private cachedDir: string | null = null;
  private durations: Map<string, number | null> | null = null;
  read(dir: string): ExpeditionRun[] {
    this.durations ??= new Map((JSON.parse(readFileSync(dataFile("scenario_durations.json"), "utf8")).durations as { scenario: string; seconds: number | null }[]).map(d => [d.scenario, d.seconds]));
    if (dir !== this.cachedDir) { this.cache.clear(); this.cachedDir = dir; }
    const runs: ExpeditionRun[] = [];
    for (const { file, run: r } of readStatsFolder(dir)) {
      let run = this.cache.get(file);
      if (run === undefined) {
        const valid = !!r.playedAt && Number.isFinite(r.playedAt.getTime()) && r.coherent &&
          !isAbandonedRun(runDurationSeconds(r.challengeStart, r.playedAt!), this.durations.get(r.scenario));
        run = valid ? { id: createHash("sha256").update(`${r.scenario}\n${r.playedAt!.getTime()}\n${r.challengeStart ?? ""}`).digest("hex"), scenario: r.scenario, score: r.score, at: r.playedAt!.getTime() } : null;
        this.cache.set(file, run);
      }
      if (run) runs.push(run);
    }
    return [...new Map(runs.map(r => [r.id, r])).values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }
}
