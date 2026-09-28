/** Freeze First Light v5: the v4 journey on Apogee's own season.
 *
 *   npx tsx tools/buildExpeditionV5.ts
 *
 * Season 1's borrowed scenarios were replaced by 164 of Apogee's own before anybody played
 * it, so every scenario v4 names is gone from the ranked queue. v5 is built the way v4
 * was - per destination and band, in circuit order, the first three families are the
 * finale and the next three are Discovery, and the pool is every family - with one change
 * the new roster forces: a category holds six families rather than ten or more, so where
 * there are fewer than nine the Mixed circuit runs on the finale's three at the route
 * target, one rank below the finale's. The engine already falls back to the finale's
 * families when no fresh one is left, so no rule changes with it. Destination identities,
 * names, colours and descriptions carry over so a player's rewards still name the same
 * places.
 */
import { existsSync, writeFileSync } from "node:fs";
import { loadExpedition } from "../src/core/expedition/definition.ts";
import { loadSeason } from "../src/core/season/season.ts";
import type { ExpeditionDefinition, ExpeditionScenario } from "../src/core/expedition/types.ts";

const season = loadSeason();
const prior = loadExpedition(4);
const precision = (maxes: number[]) => Math.min(3, Math.max(0, ...maxes.map(n => (String(n).split(".")[1] ?? "").length)));

const def: ExpeditionDefinition = {
  version: 5, id: "first-light-v5", name: prior.name, sourceSeason: season.name, bands: season.windows!,
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
    const circuits = pool.map(p => (p.length >= 9 ? p.slice(6, 9) : p.slice(0, 3)));
    if (pool.some(p => p.length < 6) || [finale, discovery, circuits].some(g => g.some(p => p.length !== 3)))
      throw new Error(`Insufficient variety at ${d.name}`);
    return { id: d.id, name: d.name, category: d.category, color: d.color, description: d.description,
      bands: finale, discovery, circuits, pool };
  }),
};
const path = "data/expeditions/first-light-v5.json";
if (existsSync(path)) throw new Error("This content version is frozen. Use a new version for future changes.");
writeFileSync(path, JSON.stringify(def, null, 2) + "\n");
console.log(`Frozen ${def.destinations.length} destinations across ${def.bands.length} bands from ${season.name}.`);
