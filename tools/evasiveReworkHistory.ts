/** Reconstruct the frozen pre-rework circuit for audits of older migrations.
 * Current shipping behavior is checked separately by validateEvasiveRework.ts.
 */
import { readFileSync } from "node:fs";
import { dataFile } from "../src/core/dataDir.ts";
import type { Season } from "../src/core/season/season.ts";

const calibration = JSON.parse(readFileSync(dataFile("evasive_rework_calibration.json"), "utf8"));
const category = "Evasive Switching";
export function beforeEvasivePool(pool: any): any {
  // Coaching text was removed independently. Restore that historical metadata only
  // inside the prior-migration audit, without reintroducing it to the shipped pool.
  const others = pool.families.filter((f: any) => f.category !== category).map((f: any) => ({ ...f,
    ...(calibration.beforeOtherFocus?.[f.family] ? { focus: calibration.beforeOtherFocus[f.family] } : {}) }));
  return { ...pool, families: others.concat(calibration.beforeFamilies) };
}
export function beforeEvasiveSeason(season: Season): Season {
  return { ...season, categories: season.categories.map(c => c.name === category ? calibration.beforeCategory : c),
    scenarios: season.scenarios.filter(s => s.category !== category).concat(calibration.beforeScenarios) };
}
