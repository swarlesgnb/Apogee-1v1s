/** Add varied route content without changing any existing finale standard. */
import { existsSync, writeFileSync } from "node:fs";
import { loadExpedition } from "../src/core/expedition/definition.ts";
import { loadSeason } from "../src/core/season/season.ts";
import type { ExpeditionScenario } from "../src/core/expedition/types.ts";
const def = loadExpedition(1), season = loadSeason();
def.id = "first-light-v2"; def.version = 2;
for (const d of def.destinations) {
  d.pool = def.bands.map((_, band) => {
    const seen = new Set<string>();
    return season.scenarios.filter(s => {
      const family = s.family ?? s.scenario;
      if (s.category !== d.category || s.window !== band || seen.has(family)) return false;
      seen.add(family); return true;
    }).map((s): ExpeditionScenario => ({ name: s.scenario, family: s.family ?? s.scenario,
      focus: s.focus ?? season.categories.find(c => c.name === d.category)?.description ?? "",
      target: s.rankMaxes[2], finalTarget: s.rankMaxes[3], routeTarget: s.rankMaxes[1],
      precision: Math.min(3, Math.max(0, ...s.rankMaxes.map(n => (String(n).split(".")[1] ?? "").length))),
    }));
  });
  d.discovery = d.pool.map((pool, band) => pool.filter(s => !d.bands[band].some(f => f.family === s.family)).slice(0, 3));
  d.circuits = d.pool.map((pool, band) => pool.filter(s => ![...d.bands[band], ...d.discovery![band]].some(f => f.family === s.family)).slice(0, 3));
  if (d.pool.some(pool => pool.length < 10) || d.discovery.some(p => p.length !== 3) || d.circuits.some(p => p.length !== 3))
    throw new Error(`Insufficient variety at ${d.name}`);
}
const path = "data/expeditions/first-light-v2.json";
if (existsSync(path)) throw new Error("This content version is frozen. Use a new version for future changes.");
writeFileSync(path, JSON.stringify(def, null, 2) + "\n");
console.log("Frozen varied discovery, route pools, and circuits; all finale standards preserved.");
