/** Reconstruct the pool and season as they stood before the fun rebuild, for audits of older migrations.
 * The rebuild itself, and the season as it ships, are checked by validateFunRebuild.ts.
 *
 * The expansion, theory and evasive-rework validators each audit the pool their migration
 * produced. Rewriting them to pass against the rebuilt pool would turn every one into a
 * check of nothing, so they are handed the pre-rebuild state instead: every replaced
 * family back at its position, every swapped rung back in its window, and every season row
 * the rebuild replaced, from data/season_fun_rebuild_calibration.json.
 */
import { readFileSync } from "node:fs";
import { dataFile } from "../src/core/dataDir.ts";
import type { Season } from "../src/core/season/season.ts";

const read = (name: string): any => JSON.parse(readFileSync(dataFile(name), "utf8"));
const calibration = read("season_fun_rebuild_calibration.json");
const spec = read("season_fun_rebuild.json");

export function beforeFunRebuildPool(pool: any): any {
  const families = pool.families.map((f: any) => ({ ...f, variants: [...f.variants] }));
  for (const b of calibration.beforeFamilies) families[b.index] = structuredClone(b.family);
  for (const r of calibration.beforeRungs) {
    const family = families.find((f: any) => f.category === r.category && f.family === r.family);
    family.variants[r.index] = structuredClone(r.variant);
  }
  return { ...pool, families, subCategoryOverrides: { ...pool.subCategoryOverrides, ...calibration.droppedOverrides } };
}

export function beforeFunRebuildSeason(season: Season): Season {
  // A replaced row takes the place of the row that replaced it, so playlist order survives.
  const renamed = new Map<string, string>(spec.families.map((f: any) => [`${f.category}/${f.family}`, f.replaces]));
  const before = new Map<string, any>();
  for (const s of calibration.beforeScenarios) before.set(`${s.category}/${s.family}/${s.window}`, s);
  const added = new Set<string>([...spec.families.flatMap((f: any) => f.rungs), ...spec.rungs.map((r: any) => r.scenario)]);
  const scenarios = season.scenarios.map((s: any) => {
    if (!added.has(s.scenario)) return s;
    const family = renamed.get(`${s.category}/${s.family}`) ?? s.family;
    const old = before.get(`${s.category}/${family}/${s.window}`);
    if (!old) throw new Error(`${s.scenario}: no pre-rebuild row for ${family} window ${s.window}`);
    return old;
  });
  return { ...season, scenarios };
}

export function beforeFunRebuildIdentity(scenarios: Record<string, any>): Record<string, any> {
  return { ...scenarios, ...calibration.beforeIdentity };
}
