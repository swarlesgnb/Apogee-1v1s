import { canStartTrial, preparationReady, savedCheckpoints, trialSteps } from "./engine.ts";
import type { ExpeditionDefinition, ExpeditionState, JourneyView } from "./types.ts";

export const journeys = [
  { title: "Explore at your pace", description: "Clear one target at a time. Every checkpoint you secure stays yours.", rules: "Miss a target? Retry it. Secured checkpoints survive stopping, switching destinations, and restarting the app." },
  { title: "Earn your trial", description: "One short warm-up opens a three-round trial.", rules: "Any one warm-up (Score attack, Steady set or Mixed circuit) opens the trial. Meet all three targets in order; a miss ends the attempt, and the warm-up stays done." },
  { title: "Prepare or go unassisted", description: "Enter the trial now, or finish a warm-up to give every attempt here one retry.", rules: "One warm-up here gives every attempt one retry. A second miss ends the attempt. An unassisted clear earns its own trophy." },
  { title: "Prove your mastery", description: "Every trial is open from the start. Conquer each destination on your own terms.", rules: "Meet every target in order without a miss. Completed destinations stay cleared. Nothing needs unlocking first." },
];

export function journeyView(state: ExpeditionState | null, def: ExpeditionDefinition, band = state?.band ?? 0, id = state?.selected ?? def.destinations[0].id): JourneyView {
  const destinations = Object.fromEntries([...def.destinations.map(d => d.id), "final"].map(destination => [destination, {
    ready: state ? canStartTrial(state, def, destination, band) : destination !== "final" && band !== 1,
    preparationReady: state ? preparationReady(state, def, destination, band) : false,
    checkpoints: state ? savedCheckpoints(state, destination, band, destination === "final" ? undefined : trialSteps(def, destination, band)).length : 0,
  }]));
  const cleared = def.destinations.filter(d => state?.rewards[`${d.id}:${band}:clear`]).length;
  const active = state?.trials.find(t => t.status === "active" && t.band === band);
  const next = active?.destination ?? def.destinations.find(d => !state?.rewards[`${d.id}:${band}:clear`])?.id ?? "final";
  return { ...journeys[band], ...destinations[id], cleared, next, destinations };
}
