import { canStartTrial, preparationReady, savedCheckpoints } from "./engine.ts";
import type { ExpeditionDefinition, ExpeditionState, JourneyView } from "./types.ts";

export const journeys = [
  { title: "Explore at your pace", description: "Clear one target at a time. Every successful checkpoint stays yours.", rules: "Miss a target? Retry it. Completed steps survive stopping, switching destinations, and restarting the app." },
  { title: "Choose your route", description: "Choose one short challenge, then take on a three-round finale.", rules: "Any one score, consistency, or mixed route opens the finale. Meet all finale targets in order; a miss ends the attempt." },
  { title: "Prepare or go unassisted", description: "Enter the trial now, or prepare to unlock a retry on every attempt.", rules: "One preparation route unlocks one retry per attempt here. A second miss ends the attempt. An unassisted clear earns its own trophy." },
  { title: "Prove your mastery", description: "Your trials are open from the start. Conquer each destination on your own terms.", rules: "Meet every target in order without a miss. Completed destinations stay cleared. No introductory routes are required." },
];

export function journeyView(state: ExpeditionState | null, def: ExpeditionDefinition, band = state?.band ?? 0, id = state?.selected ?? def.destinations[0].id): JourneyView {
  const destinations = Object.fromEntries([...def.destinations.map(d => d.id), "final"].map(destination => [destination, {
    ready: state ? canStartTrial(state, def, destination, band) : destination !== "final" && band !== 1,
    preparationReady: state ? preparationReady(state, def, destination, band) : false,
    checkpoints: state ? savedCheckpoints(state, destination, band).length : 0,
  }]));
  const cleared = def.destinations.filter(d => state?.rewards[`${d.id}:${band}:clear`]).length;
  const active = state?.trials.find(t => t.status === "active" && t.band === band);
  const next = active?.destination ?? def.destinations.find(d => !state?.rewards[`${d.id}:${band}:clear`])?.id ?? "final";
  return { ...journeys[band], ...destinations[id], cleared, next, destinations };
}
