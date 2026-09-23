/** Freeze First Light v4: the v3 journey on the rebuilt season's roster.
 *
 *   npx tsx tools/buildExpeditionV4.ts
 *
 * v1 froze the finale from the season as it stood, v2 added routes around it, and v3
 * changed only progression. The fun rebuild replaced eighteen families, six of which
 * First Light's finales and routes named, so a solo mode built on the old roster would
 * train scenarios the ranked queue no longer serves. v4 is built the same way v1 and v2
 * were, from the season now shipping: per destination and band, the first three families
 * in circuit order are the finale, the next three are Discovery, the three after are the
 * Mixed circuit, and the pool is every family. Destination identities, names, colours
 * and descriptions carry over from v2 so a player's rewards still name the same places.
 */
import { existsSync, writeFileSync } from "node:fs";
import { loadExpedition } from "../src/core/expedition/definition.ts";
import { loadSeason } from "../src/core/season/season.ts";
import type { ExpeditionDefinition, ExpeditionScenario } from "../src/core/expedition/types.ts";

const season = loadSeason();
const prior = loadExpedition(2);
const precision = (maxes: number[]) => Math.min(3, Math.max(0, ...maxes.map(n => (String(n).split(".")[1] ?? "").length)));

const def: ExpeditionDefinition = {
  version: 4, id: "first-light-v4", name: prior.name, sourceSeason: season.name, bands: season.windows!,
  destinations: prior.destinations.map(d => {
    const description = season.categories.find(c => c.name === d.category)?.description ?? "";
    const pool = season.windows!.map((_, band) => {
      const seen = new Set<string>();
      return season.scenarios.filter(s => {
        const family = s.family ?? s.scenario;
        if (s.category !== d.category || s.window !== band || seen.has(family)) return false;
        seen.add(family); return true;
      }).map((s): ExpeditionScenario => ({ name: s.scenario, family: s.family ?? s.scenario,
        focus: s.focus ?? description, target: s.rankMaxes[2], finalTarget: s.rankMaxes[3],
        routeTarget: s.rankMaxes[1], precision: precision(s.rankMaxes) }));
    });
    const finale = pool.map(p => p.slice(0, 3).map(({ routeTarget, ...s }) => s));
    const discovery = pool.map(p => p.slice(3, 6));
    const circuits = pool.map(p => p.slice(6, 9));
    if (pool.some(p => p.length < 10) || [finale, discovery, circuits].some(g => g.some(p => p.length !== 3)))
      throw new Error(`Insufficient variety at ${d.name}`);
    return { id: d.id, name: d.name, category: d.category, color: d.color, description: d.description,
      bands: finale, discovery, circuits, pool };
  }),
};
const path = "data/expeditions/first-light-v4.json";
if (existsSync(path)) throw new Error("This content version is frozen. Use a new version for future changes.");
writeFileSync(path, JSON.stringify(def, null, 2) + "\n");
console.log(`Frozen ${def.destinations.length} destinations across ${def.bands.length} bands from ${season.name}.`);
