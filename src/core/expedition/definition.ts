import { readFileSync } from "node:fs";
import { dataFile } from "../dataDir.ts";
import type { ExpeditionDefinition, Reward } from "./types.ts";

export function loadExpedition(version: 1 | 2 | 3 | 4 | 5 = 5): ExpeditionDefinition {
  // V3 changes progression, not the frozen scenario roster or score standards. V4 keeps
  // v3's progression on the roster of the rebuilt season, frozen in its own file, and v5
  // the same progression on Apogee's own scenarios, which replaced that season's.
  if (version === 3) return { ...loadExpedition(2), version: 3, id: "first-light-v3" };
  return JSON.parse(readFileSync(dataFile("expeditions", `first-light-v${version}.json`), "utf8"));
}

export function rewardCatalog(def: ExpeditionDefinition): Reward[] {
  const rewards: Reward[] = [];
  const add = (id: string, name: string, kind: Reward["kind"], color: string, design: number, requirement: string) =>
    rewards.push({ id, name, kind, color, design, requirement });
  for (const [i, d] of def.destinations.entries()) {
    for (const [j, label] of ["Survey fragment", "Signal prism", "Core relic"].entries())
      add(`${d.id}:relic:${j}`, `${d.name} ${label}`, "relic", d.color, i * 3 + j, `Complete ${["Discovery", "Steady set", "Score attack"][j]} at ${d.name} in any band.`);
    add(`${d.id}:relic:3`, `${d.name} Circuit seal`, "relic", d.color, 18 + i, `Complete the optional Mixed circuit at ${d.name} in any band.`);
    for (const kind of ["ship", "frame", "banner", "title"] as const)
      add(`${d.id}:${kind}`, kind === "title" ? `${d.name} Pathfinder` : `${d.name} ${kind}`, kind, d.color, i, `Clear the ${d.name} finale in any band.`);
  }
  for (const [b, band] of def.bands.entries()) {
    for (const [i, d] of [...def.destinations, { id: "final", name: def.name, color: "#f9df83" }].entries()) {
      add(`${d.id}:${b}:clear`, `${d.name} · ${band}`, "insignia", d.color, b, `Clear ${d.name} in ${band}.`);
      add(`${d.id}:${b}:mastery`, `${d.name} mastery · ${band}`, "trophy", d.color, i + b, `Clear every ${band} trial target at ${d.name} by at least 10%${def.version >= 3 ? ' in one attempt, with no misses or carried checkpoints' : ''}.`);
    }
  }
  for (const [i, kind] of (["ship", "frame", "banner", "title"] as const).entries())
    add(`final:${kind}`, kind === "title" ? "Beyond the First Light" : `First Light ${kind}`, kind, "#f9df83", 6 + i, "Clear the expedition finale in any band.");
  for (const [i, n] of [25, 100, 250, 500].entries())
    add(`runs:${n}`, ["Departure", "Solar Sail", "Deep Space", "Starfarer"][i], ["banner", "ship", "frame", "title"][i] as Reward["kind"], "#b2ff80", 10 + i, `Complete ${n} valid runs after joining the expedition.`);
  for (const [i, n] of [10, 25, 50].entries())
    add(`variety:${n}`, ["First Contact", "Atlas", "Constellation"][i], ["relic", "banner", "ship"][i] as Reward["kind"], "#c1a4ff", 14 + i, `Play ${n} distinct scenarios after joining the expedition.`);
  if (def.version >= 3) for (const [i, d] of [...def.destinations, { id: "final", name: def.name, color: "#f9df83" }].entries())
    add(`${d.id}:2:direct`, `${d.name} · Unassisted`, "trophy", d.color, i + 12, `Clear ${d.name} in Advanced with no retry support. Choose the unassisted attempt.`);
  return rewards;
}
