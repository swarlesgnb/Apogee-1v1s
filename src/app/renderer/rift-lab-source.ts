/**
 * The Rift Academy's calculator: the real engine's `score`, bundled for the renderer.
 *
 * Lessons let a player move a score slider and reorder anomalies and watch Thrust × Flux
 * change. A second copy of the formula in the guide would teach whatever it drifted to;
 * bundling the engine means the lesson and the game cannot disagree. Nothing here is saved
 * or sent anywhere: it scores hypothetical salvos on a throwaway voyage.
 *
 *   node tools/buildCosmic.mjs   (writes rift-lab.js beside this file)
 */
import { ANOMALIES, actRift, familyOf, score, startRift, type AnomalyId, type HazardId } from '../../core/rift/engine.ts';

export const LAB_CATEGORIES = ['Static Clicking', 'Dynamic Clicking', 'Precise Tracking', 'Reactive Tracking', 'Speed Switching', 'Evasive Switching'];
const pool = LAB_CATEGORIES.map(category => ({ scenario: `Lab ${category}`, category, target: 1000 }));

export interface LabSalvo {
  ratio: number; category?: string; level?: number; anomalies?: { id: AnomalyId; n?: number }[];
  stage?: 0 | 1 | 2; hazard?: HazardId; salvo?: number; salvos?: number; jumps?: number;
  last?: string | null; chain?: number; stardust?: number; boost?: boolean; levels?: Record<string, number>;
}

export function salvo(spec: LabSalvo) {
  const category = spec.category ?? LAB_CATEGORIES[0];
  let s = startRift(pool, 0, 'Novice', 'drifter', 1, 1);
  s.stage = spec.stage ?? 0;
  if (spec.hazard) s.hazards[0] = spec.hazard;
  s = actRift(s, { type: 'engage' }, 2);
  const f = s.fight!;
  f.salvos = spec.salvos ?? 2; f.salvo = Math.min(spec.salvo ?? 0, f.salvos - 1); f.jumps = spec.jumps ?? 0; f.boost = !!spec.boost; f.dark = [];
  s.anomalies = (spec.anomalies ?? []).map((a, i) => ({ uid: i + 1, id: a.id, n: a.n ?? ({ volatile: 2.5, horizon: 1, blackhole: 1 } as Record<string, number>)[a.id] ?? 0 }));
  s.slots = Math.max(5, s.anomalies.length); s.nextUid = s.anomalies.length + 1;
  if (spec.levels) Object.assign(s.levels, spec.levels);
  s.levels[category] = spec.level ?? s.levels[category];
  s.stats.last = spec.last ?? null; s.stats.chain = spec.chain ?? 0; s.stardust = spec.stardust ?? 0;
  const card = { scenario: `Lab ${category}`, category, target: 1000, family: familyOf(category) };
  return score(s, card, spec.ratio * 1000);
}

(globalThis as any).ApogeeRiftLab = { salvo, categories: LAB_CATEGORIES, anomalies: ANOMALIES };
