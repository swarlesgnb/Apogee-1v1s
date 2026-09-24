/**
 * How long Apogee's own scenarios last, read from their files rather than learned.
 *
 * buildDurations learns a length from the mode of a scenario's runs, because a borrowed
 * scenario's length is only knowable from how it plays. An authored one's is written in
 * the file: Timelimit is game time, so the real length is Timelimit / Timescale - sixty
 * seconds for every one in the season, which validate:season-files holds them to. Waiting
 * for five runs each would leave all 164 unchecked for abandonment until people had
 * played them, which is exactly when the check matters.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../dataDir.ts";
import { get, parseSce } from "../scenario/sce.ts";
import type { ScenarioDuration } from "./buildDurations.ts";

export function authoredDurations(): ScenarioDuration[] {
  const dir = dataFile("season-1", "scenarios");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sce"))
    .map((f) => {
      const sce = parseSce(readFileSync(join(dir, f), "utf8"));
      const seconds = Number(get(sce.head, "Timelimit")) / Number(get(sce.head, "Timescale") ?? 1);
      return { scenario: get(sce.head, "Name") ?? f.replace(/\.sce$/, ""), seconds: Math.round(seconds), runs: 0, agreement: 1, from: "file" };
    });
}
