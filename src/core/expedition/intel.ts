import type { ExpeditionDefinition, ExpeditionRun } from "./types.ts";

/**
 * What the player's own history says about the scenarios the expedition asks for.
 *
 * Read from every valid local run, before and after enrolment, because a target means
 * little without knowing how far away it is. Nothing here affects progress: it is shown
 * next to a target, never compared against one to settle anything.
 */
export interface ScenarioIntel { best: number; last: number; median: number; runs: number; lastAt: number }
export interface BandFit { played: number; met: number; total: number }
export interface Recommendation { band: number; reason: string }

const median = (scores: number[]) => {
  const sorted = [...scores].sort((a, b) => a - b), m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

export function scenarioIntel(def: ExpeditionDefinition, history: ExpeditionRun[]): Record<string, ScenarioIntel> {
  const names = new Set(def.destinations.flatMap(d => [...d.bands, ...(d.pool ?? []), ...(d.circuits ?? []), ...(d.discovery ?? [])].flat().map(s => s.name)));
  const byScenario = new Map<string, ExpeditionRun[]>();
  for (const r of new Map(history.map(r => [r.id, r])).values()) {
    if (!names.has(r.scenario) || !Number.isFinite(r.score) || !Number.isFinite(r.at)) continue;
    const list = byScenario.get(r.scenario) ?? [];
    list.push(r); byScenario.set(r.scenario, list);
  }
  const intel: Record<string, ScenarioIntel> = {};
  for (const [name, runs] of byScenario) {
    runs.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const last = runs.at(-1)!;
    intel[name] = { best: Math.max(...runs.map(r => r.score)), last: last.score, median: median(runs.slice(-10).map(r => r.score)), runs: runs.length, lastAt: last.at };
  }
  return intel;
}

/** Per band: of its eighteen trial targets, how many were played and how many a best already meets. */
export function bandFit(def: ExpeditionDefinition, intel: Record<string, ScenarioIntel>): BandFit[] {
  return def.bands.map((_, b) => {
    const roster = def.destinations.flatMap(d => d.bands[b]);
    const played = roster.filter(s => intel[s.name]);
    return { played: played.length, met: played.filter(s => intel[s.name].best >= s.target).length, total: roster.length };
  });
}

/**
 * A suggestion, never a gate: every band stays open. The highest band where at least three
 * targets were tried and half of them are already met is where the player is being
 * tested rather than coasting; a band met almost everywhere points one band higher.
 */
export function recommendBand(def: ExpeditionDefinition, fit: BandFit[]): Recommendation {
  let band = -1;
  for (const [b, f] of fit.entries()) if (f.played >= 3 && f.met / f.played >= .5) band = b;
  if (band < 0) {
    const tried = fit.reduce((n, f) => n + f.played, 0);
    return { band: 0, reason: tried ? `Your bests meet fewer than half of the targets you have tried. ${def.bands[0]} saves every checkpoint, so nothing is lost by starting there.`
      : `No runs on these scenarios yet. ${def.bands[0]} saves every checkpoint, so it is the gentlest way in.` };
  }
  const f = fit[band];
  if (band < def.bands.length - 1 && f.played >= 9 && f.met / f.played >= .8)
    return { band: band + 1, reason: `Your bests already meet ${f.met} of ${f.played} ${def.bands[band]} targets you have played. ${def.bands[band + 1]} should be a real test.` };
  return { band, reason: `Your bests meet ${f.met} of the ${f.played} ${def.bands[band]} targets you have played: close enough to reach, far enough to matter.` };
}
