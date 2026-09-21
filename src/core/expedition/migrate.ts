import { syncExpedition } from "./engine.ts";
import type { ChallengeKind, ExpeditionDefinition, ExpeditionState } from "./types.ts";

/** Upgrade route pacing while keeping the original save, rewards, and trial standards. */
export function migrateExpedition(old: ExpeditionState, legacy: ExpeditionDefinition, def: ExpeditionDefinition, now: number): ExpeditionState {
  if (old.version === 2 && legacy.version === 2 && def.version === 3 && old.definitionId === legacy.id) {
    const next = structuredClone(old);
    next.version = 3; next.definitionId = def.id; next.migratedAt = now;
    // Trials without a mode retain their original contract, including active attempts.
    return next;
  }
  if (old.version !== 1 || old.definitionId !== legacy.id) throw new Error("This expedition save cannot be migrated.");
  const next = structuredClone(old);
  next.version = 2; next.definitionId = def.id; next.migratedAt = now;
  const kinds = { explore: "discovery", consistency: "steady", breakthrough: "score_attack" } as const;
  for (const [key, route] of Object.entries(next.routes)) {
    const [id, rawBand] = key.split(":"), band = Number(rawBand);
    const oldRoster = legacy.destinations.find(d => d.id === id)!.bands[band];
    for (const c of route.challenges) {
      const kind = kinds[c.kind as keyof typeof kinds];
      if (!kind) throw new Error("An existing route could not be recognized; the original save is unchanged.");
      const selected = [...oldRoster].sort((a, b) => (c.progress[b.name] ?? 0) - (c.progress[a.name] ?? 0))[0];
      const roster = kind === "discovery" ? oldRoster : [selected];
      c.kind = kind;
      c.steps = roster.map(s => ({ scenario: s.name, focus: s.focus, required: kind === "steady" ? 3 : 1,
        target: kind === "discovery" ? null : c.targets[s.name] ?? (kind === "steady" ? def.destinations.find(d => d.id === id)!.pool![band].find(row => row.name === s.name)!.routeTarget! : s.target),
        source: kind === "discovery" ? "discovery" : "preserved" }));
      // A cold legacy challenge keeps the known scenario but no longer needs calibration.
      for (const step of c.steps) {
        if (step.target !== null) c.targets[step.scenario] = step.target;
        c.progress[step.scenario] = Math.min(step.required, c.progress[step.scenario] ?? 0);
      }
    }
    route.selectedKind = (route.challenges.find(c => !c.completedAt) ?? route.challenges.at(-1))?.kind as ChallengeKind;
  }
  // Previously played eligible runs immediately receive credit under the shorter route.
  return syncExpedition(next, def, [], now);
}
