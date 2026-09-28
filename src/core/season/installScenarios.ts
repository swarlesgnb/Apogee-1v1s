/**
 * Keep the season's own scenario files in KovaaK's scenario folder, byte for byte.
 *
 * Season 1's scenarios are Apogee's, not shared in game, so the only way a player has them
 * is this copy. Byte for byte, because KovaaK's writes the MD5 of the scenario file into
 * every stats file (`Hash:`), and submit-run holds an Apogee scenario's run to the hash of
 * the committed file: an edited file - bigger targets under the same name - is a different
 * hash and is refused. validate:verify measures that identity on the playtest runs.
 *
 * So a file is rewritten whenever it differs, not only when it is missing. A season update
 * changes a file and its expected hash together, and a player left on the old bytes would
 * have every run refused for a scenario they did nothing to.
 *
 * Removal leans to keeping: only a file that proves it is ours - named "Apogee ...", tagged
 * as an Apogee season in its own head, and not one the season names - is taken out. That is
 * how a renamed family's old file goes, and nothing else in the folder is looked at.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../dataDir.ts";

export function scenariosFolderFor(statsDir: string): string {
  return join(statsDir, "..", "Saved", "SaveGames", "Scenarios");
}

/** Where the season's files ship: data/season-1/scenarios, copied into the app bundle. */
export function seasonScenarioSource(): string {
  return dataFile("season-1", "scenarios");
}

/** Every earlier tag counts: the playtest builds were tagged "Apogee Season 2". */
const OURS = /^(SearchTags|GameTag)=.*Apogee Season \d/m;

export interface InstallResult {
  written: string[];
  unchanged: number;
  removed: string[];
}

export function installSeasonScenarios(scenariosDir: string, source = seasonScenarioSource()): InstallResult {
  const files = readdirSync(source).filter((f) => f.endsWith(".sce"));
  const current = new Set(files);
  mkdirSync(scenariosDir, { recursive: true });

  const written: string[] = [];
  let unchanged = 0;
  for (const f of files) {
    const bytes = readFileSync(join(source, f));
    const target = join(scenariosDir, f);
    if (existsSync(target) && readFileSync(target).equals(bytes)) {
      unchanged++;
      continue;
    }
    writeFileSync(target, bytes);
    written.push(f);
  }

  const removed = readdirSync(scenariosDir).filter((f) => {
    if (!f.startsWith("Apogee ") || !f.endsWith(".sce") || current.has(f)) return false;
    return OURS.test(readFileSync(join(scenariosDir, f), "utf8").slice(0, 20_000));
  });
  for (const f of removed) rmSync(join(scenariosDir, f));

  return { written, unchanged, removed };
}

/** Take out exactly the files the season names, and any stale ones `install` would remove. */
export function removeSeasonScenarios(scenariosDir: string, source = seasonScenarioSource()): string[] {
  if (!existsSync(scenariosDir)) return [];
  const current = new Set(readdirSync(source).filter((f) => f.endsWith(".sce")));
  const removed = readdirSync(scenariosDir).filter((f) => {
    if (!f.startsWith("Apogee ") || !f.endsWith(".sce")) return false;
    return current.has(f) || OURS.test(readFileSync(join(scenariosDir, f), "utf8").slice(0, 20_000));
  });
  for (const f of removed) rmSync(join(scenariosDir, f));
  return removed;
}
