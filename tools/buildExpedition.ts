/** Freeze the first expedition's scenario identities and published score targets. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSeason } from "../src/core/season/season.ts";
import type { ExpeditionDefinition } from "../src/core/expedition/types.ts";

const season = loadSeason();
const names = ["Glass Meridian", "Ember Reach", "Tidal Archive", "Ion Wilds", "Prism Crossing", "Cinder Veil"];
const colors = ["#8de8ff", "#ffab79", "#86efc4", "#c0a3ff", "#f1e386", "#ff8dbb"];
const descriptions = [
  "Quiet structures catch the light. Find the shortest path between them.",
  "Fragments move through a copper sky. Catch their rhythm before they disappear.",
  "Follow the current through a sea of old signals. Keep your movement steady.",
  "Nothing holds its course here. Read each turn and stay with it.",
  "Light splits across the crossing. Move decisively from one signal to the next.",
  "Signals slip behind the veil. Find them again without losing your pace.",
];
const def: ExpeditionDefinition = {
  version: 1, id: "first-light-v1", name: "First Light", sourceSeason: season.name, bands: season.windows!,
  destinations: season.categories.map((category, i) => ({
    id: `destination-${i + 1}`, name: names[i], category: category.name, color: colors[i], description: descriptions[i],
    bands: season.windows!.map((_, band) => {
      const seen = new Set<string>();
      return season.scenarios.filter(s => {
        if (s.category !== category.name || s.window !== band || seen.has(s.family ?? s.scenario)) return false;
        seen.add(s.family ?? s.scenario); return true;
      }).slice(0, 3).map(s => ({
        name: s.scenario, family: s.family ?? s.scenario, focus: s.focus ?? category.description ?? "",
        target: s.rankMaxes[2], finalTarget: s.rankMaxes[3],
        precision: Math.min(3, Math.max(0, ...s.rankMaxes.map(n => (String(n).split(".")[1] ?? "").length))),
      }));
    }),
  })),
};
if (def.destinations.length !== 6 || def.destinations.some(d => d.bands.some(b => b.length !== 3 || b.some(s => !s.target || !s.finalTarget))))
  throw new Error("The season must supply three distinct families and four score thresholds per category and band.");
const folder = join("data", "expeditions"), path = join(folder, "first-light-v1.json");
if (existsSync(path)) throw new Error("This content version is frozen. Create a new expedition version to change it.");
mkdirSync(folder, { recursive: true }); writeFileSync(path, JSON.stringify(def, null, 2) + "\n");
console.log(`Frozen ${def.destinations.length} destinations across ${def.bands.length} bands.`);
