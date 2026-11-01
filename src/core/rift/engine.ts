/**
 * Rift is local solo progress. These rules never write a score, rank or quest award.
 *
 * The first flight resolved every run as a flat "+N damage" sum, and the first playtest
 * found nothing in it worth deciding: the abilities never changed what to play or in what
 * order. This version scores like a deckbuilder instead. A run supplies Thrust (aim) and the
 * discipline's planet level supplies Flux; anomalies resolve left to right and add Thrust,
 * add Flux or multiply Flux, so their order, their neighbours and the discipline chosen for
 * each salvo all change the result. Damage is Thrust × Flux, and encounter hulls grow
 * geometrically, so a build has to multiply rather than add to reach the final star.
 */

export type Rarity = 'common' | 'uncommon' | 'rare';
export type Family = 'Clicking' | 'Tracking' | 'Switching';
export type Grade = 'drift' | 'graze' | 'strike' | 'nova';
export const GRADES: Record<Grade, { name: string; from: number }> = {
  drift: { name: 'Drift', from: 0 }, graze: { name: 'Graze', from: 0.8 },
  strike: { name: 'Strike', from: 1 }, nova: { name: 'Nova', from: 1.15 },
};
const RANK: Record<Grade, number> = { drift: 0, graze: 1, strike: 2, nova: 3 };

export const ANOMALIES = [
  // Common: one clear idea each, cheap enough to try in the first system.
  { id: 'ion', name: 'Ion Drive', rarity: 'common', price: 4, tag: 'THRUST', text: '+50 Thrust.' },
  { id: 'pulsar', name: 'Pulsar', rarity: 'common', price: 4, tag: 'FLUX', text: '+4 Flux.' },
  { id: 'railgun', name: 'Railgun', rarity: 'common', price: 5, tag: 'CLICKING', text: '+7 Flux on Clicking scenarios.' },
  { id: 'tractor', name: 'Tractor Beam', rarity: 'common', price: 5, tag: 'TRACKING', text: '+7 Flux on Tracking scenarios.' },
  { id: 'phase', name: 'Phase Lance', rarity: 'common', price: 5, tag: 'SWITCHING', text: '+7 Flux on Switching scenarios.' },
  { id: 'sail', name: 'Solar Sail', rarity: 'common', price: 5, tag: 'SLINGSHOT', text: '+6 Flux when this salvo is a different discipline from the last one.' },
  { id: 'reddwarf', name: 'Red Dwarf', rarity: 'common', price: 4, tag: 'GRIT', text: '+9 Flux on a Graze or Drift.' },
  { id: 'firstlight', name: 'First Light', rarity: 'common', price: 5, tag: 'OPENER', text: '+90 Thrust on the first salvo of an encounter.' },
  { id: 'miner', name: 'Asteroid Miner', rarity: 'common', price: 4, tag: 'STARDUST', text: 'Clearing an encounter pays 3 ✦, plus 1 ✦ for each Nova in it.' },
  { id: 'shepherd', name: 'Shepherd Moon', rarity: 'common', price: 5, tag: 'THRUST', text: '+30 Thrust for each anomaly you carry.' },
  { id: 'warp', name: 'Warp Coil', rarity: 'common', price: 5, tag: 'JUMP', text: '+1 Jump per encounter. +3 Flux for each Jump still unspent.' },
  { id: 'scrap', name: 'Scrap Halo', rarity: 'common', price: 4, tag: 'GROWS', text: 'Gains +4 Flux whenever an anomaly is sold or devoured.' },
  { id: 'tidal', name: 'Tidal Lock', rarity: 'common', price: 5, tag: 'ORBIT', text: '+4 Flux for each salvo in a row in this same discipline before this one.' },
  // Uncommon: conditions and scaling that start to define a build.
  { id: 'overclock', name: 'Overclock', rarity: 'uncommon', price: 6, tag: 'AIM', text: 'Score above the reference counts triple toward Thrust.' },
  { id: 'supernova', name: 'Supernova Core', rarity: 'uncommon', price: 7, tag: 'AIM', text: '×2 Flux on a Nova.' },
  { id: 'graviton', name: 'Graviton Hammer', rarity: 'uncommon', price: 6, tag: 'AIM', text: '+140 Thrust on a Strike or Nova.' },
  { id: 'accretion', name: 'Accretion Disk', rarity: 'uncommon', price: 6, tag: 'GROWS', text: 'Gains +2 Flux on every Strike or Nova. A Drift scatters all of it.' },
  { id: 'darkmatter', name: 'Dark Matter', rarity: 'uncommon', price: 7, tag: 'EMPTY', text: '×1 Flux for itself and for each empty anomaly slot.' },
  { id: 'comettail', name: 'Comet Tail', rarity: 'uncommon', price: 6, tag: 'COMETS', text: '+3 Flux for each comet or star chart used this voyage.' },
  { id: 'cartographer', name: 'Cartographer', rarity: 'uncommon', price: 6, tag: 'CHARTS', text: '+2 Flux for each planet level above 1, across all six disciplines.' },
  { id: 'station', name: 'Orbital Station', rarity: 'uncommon', price: 7, tag: 'SALVO', text: '+1 salvo per encounter.' },
  { id: 'gasgiant', name: 'Gas Giant', rarity: 'uncommon', price: 5, tag: 'STARDUST', text: 'Interest is capped at 10 ✦ instead of 5 ✦.' },
  { id: 'volatile', name: 'Volatile Reactor', rarity: 'uncommon', price: 6, tag: 'RISK', text: '×2.5 Flux. Loses ×0.5 on each Graze or Drift and collapses at ×1.' },
  { id: 'beacon', name: 'Distress Beacon', rarity: 'uncommon', price: 6, tag: 'RISK', text: '+×1 Flux for each point of missing hull.' },
  { id: 'lastlight', name: 'Last Light', rarity: 'uncommon', price: 6, tag: 'CLUTCH', text: '×3 Flux on the final salvo of an encounter.' },
  { id: 'starbreaker', name: 'Starbreaker', rarity: 'uncommon', price: 6, tag: 'BOSS', text: '+15 Flux against a Star.' },
  // Rare: rule-benders. Each one is the centre of a build rather than a part of one.
  { id: 'lens', name: 'Gravitational Lens', rarity: 'rare', price: 9, tag: 'RETRIGGER', text: 'Retriggers the anomaly to its left.' },
  { id: 'binary', name: 'Binary Star', rarity: 'rare', price: 10, tag: 'COPY', text: 'Copies the ability of the anomaly to its right.' },
  { id: 'singularity', name: 'Singularity', rarity: 'rare', price: 9, tag: 'CONVERT', text: 'Adds one tenth of the current Thrust to Flux.' },
  { id: 'horizon', name: 'Event Horizon', rarity: 'rare', price: 9, tag: 'GROWS', text: '×1 Flux. Gains ×0.4 whenever an encounter falls to a single salvo.' },
  { id: 'constellation', name: 'Constellation', rarity: 'rare', price: 8, tag: 'VARIETY', text: '×1 Flux, +×0.5 for each different discipline played this system.' },
  { id: 'blackhole', name: 'Black Hole', rarity: 'rare', price: 8, tag: 'DEVOUR', text: '×1 Flux. Clearing a Star devours the anomaly to its right for +×0.75.' },
  { id: 'terraformer', name: 'Terraformer', rarity: 'rare', price: 8, tag: 'CHARTS', text: 'An encounter cleared in one salvo levels up that discipline.' },
  { id: 'observatory', name: 'Observatory', rarity: 'rare', price: 8, tag: 'CHARTS', text: '×1.5 Flux for each held star chart matching this discipline.' },
  { id: 'dyson', name: 'Dyson Sphere', rarity: 'rare', price: 8, tag: 'STARDUST', text: '+1 Flux for every 3 ✦ you hold.' },
] as const satisfies readonly { id: string; name: string; rarity: Rarity; price: number; tag: string; text: string }[];
export type AnomalyId = typeof ANOMALIES[number]['id'];

/** Stateful anomalies start here; everything else keeps `n` at 0. */
const START_N: Partial<Record<AnomalyId, number>> = { volatile: 2.5, horizon: 1, blackhole: 1 };

export const COMETS = [
  { id: 'halley', name: "Halley's Comet", price: 4, text: '×2 Flux on the next salvo. Use during an encounter.', combat: true },
  { id: 'wormhole', name: 'Wormhole', price: 4, text: '+1 salvo in this encounter. Use during an encounter.', combat: true },
  { id: 'mirror', name: 'Mirror Moon', price: 6, text: 'Duplicate your leftmost anomaly, with its growth. Needs an open slot.', combat: false },
  { id: 'gold', name: 'Golden Comet', price: 4, text: 'Double your stardust, up to +20 ✦.', combat: false },
  { id: 'seed', name: 'Nebula Seed', price: 3, text: 'Create a random common anomaly. Needs an open slot.', combat: false },
  { id: 'aurora', name: 'Aurora', price: 7, text: 'Level up all six disciplines.', combat: false },
] as const;
export type CometId = typeof COMETS[number]['id'];
export type Consumable = { kind: 'chart'; category: string } | { kind: 'comet'; id: CometId };
export const CHART_PRICE = 3;

export const HAZARDS = [
  { id: 'dimmer', name: 'The Brown Dwarf', rule: 'Flux is halved after your anomalies resolve.' },
  { id: 'eclipse', name: 'The Eclipse', rule: 'Your leftmost anomaly is dark for this fight.' },
  { id: 'magnetar', name: 'The Magnetar', rule: 'Every salvo after the first must be the same discipline as the first.' },
  { id: 'deadstar', name: 'The Dead Star', rule: 'No Jumps. The hand you are dealt is the hand you play.' },
  { id: 'neutron', name: 'The Neutron Star', rule: 'Score references are 10% higher for grades and Thrust.' },
  { id: 'whitedwarf', name: 'The White Dwarf', rule: 'Scoring above the reference adds no Thrust.' },
  { id: 'bluegiant', name: 'The Blue Giant', rule: 'Half again as much hull, and 5 ✦ more for breaking it.' },
  { id: 'collapsar', name: 'The Collapsar', rule: 'After each salvo, your rightmost lit anomaly goes dark for the fight.' },
] as const;
export type HazardId = typeof HAZARDS[number]['id'];
/** The finale always collapses; the earlier stars draw from the rest. */
const ORDINARY_HAZARDS = HAZARDS.map(h => h.id).filter(id => id !== 'collapsar');

export const SIGNALS = [
  { id: 'cache', name: 'Supply Cache', text: '+10 ✦ now.' },
  { id: 'berth', name: 'Free Berth', text: 'The first anomaly you buy in the next shop is free.' },
  { id: 'beacon', name: 'Rare Beacon', text: 'The next shop stocks a rare anomaly.' },
  { id: 'starmap', name: 'Star Map', text: 'Level up two random disciplines now.' },
  { id: 'surge', name: 'Overcharge', text: '+1 salvo in your next encounter.' },
] as const;
export type SignalId = typeof SIGNALS[number]['id'];

export const VESSELS = [
  { id: 'drifter', name: 'The Drifter', text: 'Balanced and forgiving. +1 Jump every encounter.', start: ['pulsar'] as AnomalyId[], hull: 3, slots: 5, stardust: 8 },
  { id: 'prospector', name: 'The Prospector', text: 'Starts rich, buys early, grows on interest.', start: ['miner'] as AnomalyId[], hull: 3, slots: 5, stardust: 14 },
  { id: 'cartographer', name: 'The Cartographer', text: 'Starts with two star charts. Pick a discipline and own it.', start: ['ion'] as AnomalyId[], hull: 3, slots: 5, stardust: 4 },
  { id: 'glasswing', name: 'The Glass Wing', text: 'One hull, six anomaly slots and a Volatile Reactor. No second chances.', start: ['volatile'] as AnomalyId[], hull: 1, slots: 6, stardust: 4 },
] as const;
export type VesselId = typeof VESSELS[number]['id'];

export const STAGES = [
  { id: 'moon', name: 'Moon', scale: 1, pay: 3 },
  { id: 'planet', name: 'Planet', scale: 1.5, pay: 4 },
  { id: 'star', name: 'Star', scale: 2, pay: 5 },
] as const;
/**
 * Hull per system before the stage multiplier. Chosen against `validate:rift`'s simulated
 * voyages: a pilot who buys nothing never finishes, even at 1.3× the reference, while a
 * greedy buyer that never plans a synergy finishes about two in five at 1.0×. The check
 * prints the measured rates; a person who orders and combines anomalies should beat them.
 */
const SYSTEM_HULL = [300, 800, 2000, 5000];
export const FINAL_SYSTEM = 3;
export const BASE_SALVOS = 2, BASE_JUMPS = 2, HAND_SIZE = 3, CONSUMABLE_SLOTS = 2, LOG_LIMIT = 40;

export const familyOf = (category: string): Family =>
  category.endsWith('Tracking') ? 'Tracking' : category.endsWith('Switching') ? 'Switching' : 'Clicking';
export const gradeOf = (ratio: number): Grade => ratio >= GRADES.nova.from ? 'nova' : ratio >= 1 ? 'strike' : ratio >= GRADES.graze.from ? 'graze' : 'drift';
export function systemHull(system: number): number {
  if (system < SYSTEM_HULL.length) return SYSTEM_HULL[system];
  // Past the finale every system is 2.5× the last, rounded to two significant figures.
  const raw = SYSTEM_HULL.at(-1)! * 2.5 ** (system - FINAL_SYSTEM), unit = 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 1);
  return Math.round(raw / unit) * unit;
}

export interface RiftScenario { scenario: string; category: string; target: number }
export interface Card extends RiftScenario { family: Family }
export interface Owned { uid: number; id: AnomalyId; n: number }
export interface Receipt { id: string; scenario: string; score: number; at: number; startedAt: number }
export interface Step { uid: number | null; source: string; text: string; thrust: number; flux: number }
export interface Payout { label: string; amount: number }
export interface Resolution {
  receipt: Receipt; card: Card; ratio: number; grade: Grade; steps: Step[]; thrust: number; flux: number; damage: number;
  dealt: number; hull: number; salvo: number; verdict: 'clear' | 'continue' | 'failed' | 'lost'; payout: Payout[]; notes: string[];
}
export interface Fight {
  stage: number; name: string; hull: number; dealt: number; salvo: number; salvos: number; jumps: number;
  hand: Card[]; armed: { at: number; card: number } | null; boost: boolean; dark: number[]; lock: string | null; novas: number;
}
export type Phase = 'map' | 'combat' | 'result' | 'shop' | 'won' | 'lost' | 'extracted';
export interface AnomalyOffer { id: AnomalyId; price: number }
export interface GoodsOffer { item: Consumable; price: number }
/** Sold items stay in place as null so the row does not shuffle under the pointer. */
export interface Shop { anomalies: (AnomalyOffer | null)[]; goods: (GoodsOffer | null)[]; rerollCost: number; free: boolean }
export interface RiftStats {
  salvos: number; clears: number; bestHit: number; damage: number; used: number; sold: number;
  last: string | null; chain: number; systemCats: string[]; endless: boolean;
}
export interface RiftState {
  version: 2; id: string; seed: number; rng: number; startedAt: number; band: number; bandName: string; vessel: VesselId;
  phase: Phase; system: number; stage: number; pool: RiftScenario[]; hazards: HazardId[]; skips: SignalId[];
  hull: number; maxHull: number; stardust: number; slots: number; anomalies: Owned[]; consumables: Consumable[];
  levels: Record<string, number>; signals: SignalId[]; surge: boolean; shop: Shop | null; fight: Fight | null;
  last: Resolution | null; log: Resolution[]; seen: string[]; stats: RiftStats; nextUid: number;
}

export const terminal = (s: RiftState) => ['won', 'lost', 'extracted'].includes(s.phase);
export const anomaly = (id: string) => ANOMALIES.find(a => a.id === id);
export const comet = (id: string) => COMETS.find(c => c.id === id);
export const sellValue = (id: AnomalyId) => Math.max(1, Math.floor(anomaly(id)!.price / 2));
const owns = (s: RiftState, id: AnomalyId) => s.anomalies.filter(a => a.id === id).length;
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const round2 = (v: number) => Math.round(v * 100) / 100;
function random(s: { rng: number }) { s.rng = (Math.imul(s.rng, 1664525) + 1013904223) >>> 0; return s.rng / 4294967296; }
function pick<T>(s: { rng: number }, list: readonly T[]): T { return list[Math.floor(random(s) * list.length)]; }
function shuffle<T>(s: { rng: number }, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random(s) * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
export const categories = (s: RiftState) => Object.keys(s.levels);
export function encounterHull(s: RiftState, system = s.system, stage = s.stage): number {
  const giant = stage === 2 && s.hazards[system] === 'bluegiant' ? 1.5 : 1;
  return Math.round(systemHull(system) * STAGES[stage].scale * giant);
}
export const interestCap = (s: RiftState) => owns(s, 'gasgiant') ? 10 : 5;

function addAnomaly(s: RiftState, id: AnomalyId, n = START_N[id] ?? 0) {
  check(s.anomalies.length < s.slots, 'Every anomaly slot is full. Sell one first.');
  s.anomalies.push({ uid: s.nextUid++, id, n });
}
function levelUp(s: RiftState, category: string, by = 1) { s.levels[category] = Math.min(99, s.levels[category] + by); }
function rollHazards(s: RiftState) {
  while (s.hazards.length <= s.system) {
    const sys = s.hazards.length;
    s.hazards.push(sys === FINAL_SYSTEM ? 'collapsar' : sys > FINAL_SYSTEM && random(s) < 0.4 ? 'collapsar' : pick(s, ORDINARY_HAZARDS));
  }
  s.skips = [pick(s, SIGNALS).id, pick(s, SIGNALS).id];
}

/** A hand favours disciplines it does not hold yet, so a jump is a real chance to change course. */
function draw(s: RiftState, hand: Card[], lock: string | null): Card {
  const inHand = new Set(hand.map(c => c.scenario)), cats = new Set(hand.map(c => c.category));
  let options = s.pool.filter(p => !inHand.has(p.scenario) && (lock ? p.category === lock : true));
  if (!lock) { const fresh = options.filter(p => !cats.has(p.category)); if (fresh.length) options = fresh; }
  if (!options.length) options = s.pool.filter(p => lock ? p.category === lock : true);
  const p = pick(s, options);
  return { ...p, family: familyOf(p.category) };
}

export function startRift(pool: RiftScenario[], band: number, bandName: string, vessel: string, seed: number, now: number): RiftState {
  const kit = VESSELS.find(k => k.id === vessel);
  check(kit, 'Choose a vessel.');
  check(Number.isInteger(band) && band >= 0 && band < 4 && !!bandName, 'Choose a difficulty.');
  check(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff && Number.isFinite(now) && now > 0, 'Invalid voyage identity.');
  const valid = pool.filter(p => p.scenario && p.category && Number.isFinite(p.target) && p.target > 0);
  check(valid.length === pool.length && valid.length >= 6 && new Set(valid.map(p => p.category)).size >= 3, 'This difficulty needs at least three disciplines with valid score references.');
  const cats = [...new Set(valid.map(p => p.category))].sort();
  const s: RiftState = {
    version: 2, id: `${now}-${seed}`, seed, rng: seed, startedAt: now, band, bandName, vessel: kit!.id,
    phase: 'map', system: 0, stage: 0, pool: valid.map(p => ({ scenario: p.scenario, category: p.category, target: p.target })),
    hazards: [], skips: [], hull: kit!.hull, maxHull: kit!.hull, stardust: kit!.stardust, slots: kit!.slots,
    anomalies: [], consumables: [], levels: Object.fromEntries(cats.map(c => [c, 1])), signals: [], surge: false,
    shop: null, fight: null, last: null, log: [], seen: [], nextUid: 1,
    stats: { salvos: 0, clears: 0, bestHit: 0, damage: 0, used: 0, sold: 0, last: null, chain: 0, systemCats: [], endless: false },
  };
  for (const id of kit!.start) addAnomaly(s, id);
  if (kit!.id === 'cartographer') for (let i = 0; i < 2; i++) s.consumables.push({ kind: 'chart', category: pick(s, cats) });
  rollHazards(s);
  return s;
}

function stockShop(s: RiftState): Shop {
  const free = s.signals.includes('berth'), rare = s.signals.includes('beacon');
  s.signals = s.signals.filter(x => x !== 'berth' && x !== 'beacon');
  const c = pick(s, COMETS);
  return { anomalies: anomalyRow(s, rare), rerollCost: 3, free, goods: [
    { item: { kind: 'chart', category: pick(s, categories(s)) }, price: CHART_PRICE },
    { item: { kind: 'comet', id: c.id }, price: c.price },
  ] };
}
/** Rarity odds of 55/33/12; anomalies already carried never reappear. */
function anomalyRow(s: RiftState, rare = false): AnomalyOffer[] {
  const held = new Set(s.anomalies.map(a => a.id)), row: AnomalyOffer[] = [];
  for (const forced of [rare, false]) {
    const r = random(s), rarity: Rarity = forced || r < 0.12 ? 'rare' : r < 0.45 ? 'uncommon' : 'common';
    let options = ANOMALIES.filter(a => a.rarity === rarity && !held.has(a.id) && !row.some(o => o.id === a.id));
    if (!options.length) options = ANOMALIES.filter(a => !held.has(a.id) && !row.some(o => o.id === a.id));
    if (options.length) { const a = pick(s, options); row.push({ id: a.id, price: a.price }); }
  }
  return row;
}

function beginFight(s: RiftState) {
  const hazard = s.stage === 2 ? s.hazards[s.system] : null;
  const salvos = BASE_SALVOS + owns(s, 'station') + (s.surge ? 1 : 0);
  const jumps = hazard === 'deadstar' ? 0 : BASE_JUMPS + (s.vessel === 'drifter' ? 1 : 0) + owns(s, 'warp');
  const hand: Card[] = [];
  for (let i = 0; i < HAND_SIZE; i++) hand.push(draw(s, hand, null));
  s.surge = false;
  s.fight = {
    stage: s.stage, name: hazard ? HAZARDS.find(h => h.id === hazard)!.name : `${['Outer', 'Inner', 'Far', 'Deep'][s.system % 4]} ${STAGES[s.stage].name}`,
    hull: encounterHull(s), dealt: 0, salvo: 0, salvos, jumps, hand, armed: null, boost: false,
    dark: hazard === 'eclipse' && s.anomalies.length ? [s.anomalies[0].uid] : [], lock: null, novas: 0,
  };
  s.last = null; s.phase = 'combat';
}

function advance(s: RiftState) {
  s.fight = null;
  s.stage++;
  if (s.stage > 2) { s.stage = 0; s.system++; s.stats.systemCats = []; rollHazards(s); }
}

function useConsumable(s: RiftState, index: number) {
  const item = s.consumables[index];
  check(item, 'Choose a held comet or chart.');
  const armed = !!s.fight?.armed;
  check(!armed && ['map', 'combat', 'shop'].includes(s.phase), 'Use comets and charts between salvos.');
  if (item.kind === 'chart') levelUp(s, item.category);
  else {
    const c = comet(item.id)!;
    check(!c.combat || s.phase === 'combat', `${c.name} can only be used during an encounter.`);
    switch (item.id) {
      case 'halley': check(!s.fight!.boost, "Halley's Comet is already primed for the next salvo."); s.fight!.boost = true; break;
      case 'wormhole': s.fight!.salvos++; break;
      case 'mirror': {
        check(s.anomalies.length, 'Mirror Moon needs an anomaly to copy.');
        const first = s.anomalies[0]; addAnomaly(s, first.id, first.n); break;
      }
      case 'gold': s.stardust += Math.min(20, s.stardust); break;
      case 'seed': {
        const options = ANOMALIES.filter(a => a.rarity === 'common');
        check(s.anomalies.length < s.slots, 'Nebula Seed needs an open anomaly slot.');
        addAnomaly(s, pick(s, options).id); break;
      }
      case 'aurora': for (const cat of categories(s)) levelUp(s, cat); break;
    }
  }
  s.consumables.splice(index, 1);
  s.stats.used++;
}

/** Only choices cross IPC. A renderer can never submit a score to this function. */
export function actRift(state: RiftState, raw: unknown, now: number): RiftState {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'Choose a Rift action.');
  const a = raw as Record<string, unknown>, s = structuredClone(state);
  check(typeof a.type === 'string', 'Choose a Rift action.');
  const index = (v: unknown, length: number, what: string) => { check(Number.isInteger(v) && (v as number) >= 0 && (v as number) < length, what); return v as number; };
  const between = !s.fight?.armed && ['map', 'combat', 'shop'].includes(s.phase);
  switch (a.type) {
    case 'engage':
      check(s.phase === 'map', 'Engage from the system map.');
      beginFight(s); break;
    case 'skip': {
      check(s.phase === 'map' && s.stage < 2, 'Only moons and planets can be skipped. Stars must be broken.');
      const signal = s.skips[s.stage];
      if (signal === 'cache') s.stardust += 10;
      else if (signal === 'starmap') { const cats = categories(s); levelUp(s, pick(s, cats)); levelUp(s, pick(s, cats)); }
      else if (signal === 'surge') s.surge = true;
      else s.signals.push(signal);
      advance(s); break;
    }
    case 'jump': {
      check(s.phase === 'combat' && s.fight && !s.fight.armed, 'Jump before arming a salvo.');
      check(s.fight!.jumps > 0, 'No Jumps left in this encounter.');
      const i = index(a.card, s.fight!.hand.length, 'Choose a target to jump away from.');
      const rest = s.fight!.hand.filter((_, j) => j !== i);
      s.fight!.hand[i] = draw(s, s.fight!.hand, s.fight!.lock);
      if (rest.some(c => c.scenario === s.fight!.hand[i].scenario)) s.fight!.hand[i] = draw(s, rest, s.fight!.lock);
      s.fight!.jumps--; break;
    }
    case 'arm': {
      check(s.phase === 'combat' && s.fight && !s.fight.armed, 'This salvo is already listening or is not ready.');
      const i = index(a.card, s.fight!.hand.length, 'Choose a target to play.');
      check(!s.fight!.lock || s.fight!.hand[i].category === s.fight!.lock, `The Magnetar holds you to ${s.fight!.lock}.`);
      s.fight!.armed = { at: now, card: i }; break;
    }
    case 'use': check(between, 'Use comets and charts between salvos.'); useConsumable(s, index(a.slot, s.consumables.length, 'Choose a held comet or chart.')); break;
    case 'discard':
      check(between, 'Discard between salvos.');
      s.consumables.splice(index(a.slot, s.consumables.length, 'Choose a held comet or chart.'), 1); break;
    case 'sell': {
      check(between, 'Sell anomalies between salvos.');
      const i = s.anomalies.findIndex(o => o.uid === a.uid);
      check(i >= 0, 'Choose an anomaly you carry.');
      s.stardust += sellValue(s.anomalies[i].id); s.anomalies.splice(i, 1); s.stats.sold++;
      for (const o of s.anomalies) if (o.id === 'scrap') o.n += 4;
      if (s.fight) s.fight.dark = s.fight.dark.filter(uid => s.anomalies.some(o => o.uid === uid));
      break;
    }
    case 'move': {
      check(between, 'Rearrange anomalies between salvos.');
      const i = s.anomalies.findIndex(o => o.uid === a.uid), j = i + (a.dir === -1 ? -1 : a.dir === 1 ? 1 : NaN);
      check(i >= 0 && j >= 0 && j < s.anomalies.length, 'That anomaly cannot move further.');
      [s.anomalies[i], s.anomalies[j]] = [s.anomalies[j], s.anomalies[i]]; break;
    }
    case 'continue': {
      check(s.phase === 'result' && s.last, 'There is no result to continue.');
      const v = s.last!.verdict;
      if (v === 'continue') s.phase = 'combat';
      else if (v === 'lost') s.phase = 'lost';
      else if (v === 'failed') { advance(s); s.phase = 'map'; }
      else if (s.stage === 2 && s.system === FINAL_SYSTEM && !s.stats.endless) { s.phase = 'won'; }
      else { s.shop = stockShop(s); s.phase = 'shop'; }
      break;
    }
    case 'buy': {
      check(s.phase === 'shop' && s.shop, 'You are not at a shop.');
      check(a.row === 'anomaly' || a.row === 'goods', 'That item is not in this shop.');
      const row: (AnomalyOffer | GoodsOffer | null)[] = a.row === 'anomaly' ? s.shop!.anomalies : s.shop!.goods;
      const i = index(a.index, row.length, 'That item is not in this shop.'), offer = row[i];
      check(offer, 'That item is sold out.');
      const price = a.row === 'anomaly' && s.shop!.free ? 0 : offer!.price;
      check(s.stardust >= price, 'Not enough stardust.');
      if (a.row === 'anomaly') { addAnomaly(s, (offer as AnomalyOffer).id); s.shop!.free = false; }
      else { check(s.consumables.length < CONSUMABLE_SLOTS, 'Both comet slots are full. Use or discard one first.'); s.consumables.push(structuredClone((offer as GoodsOffer).item)); }
      s.stardust -= price; row[i] = null; break;
    }
    case 'reroll':
      check(s.phase === 'shop' && s.shop, 'You are not at a shop.');
      check(s.stardust >= s.shop!.rerollCost, `Rerolling costs ${s.shop!.rerollCost} ✦.`);
      // Only the anomaly row rerolls, and each reroll in the same shop costs 1 ✦ more.
      s.stardust -= s.shop!.rerollCost; s.shop!.rerollCost++; s.shop!.anomalies = anomalyRow(s);
      break;
    case 'leave':
      check(s.phase === 'shop', 'You are not at a shop.');
      s.shop = null; advance(s); s.phase = 'map'; break;
    case 'deeper':
      check(s.phase === 'won', 'The deep Rift opens only after the final star.');
      s.stats.endless = true; s.shop = stockShop(s); s.phase = 'shop'; break;
    case 'extract':
      check(['map', 'shop'].includes(s.phase), 'Extract between encounters.'); s.shop = null; s.phase = 'extracted'; break;
    case 'abandon':
      check(s.phase === 'combat', 'End an encounter only while it is active.'); s.fight!.armed = null; s.phase = 'lost'; break;
    default: throw new Error('Unknown Rift action.');
  }
  return s;
}

interface Ctx { s: RiftState; f: Fight; card: Card; ratio: number; grade: Grade; thrust: number; flux: number; steps: Step[]; first: boolean; final: boolean; same: number }
type Hook = (c: Ctx, self: Owned, index: number) => string | null;
const at = (c: Ctx, rank: Grade) => RANK[c.grade] >= RANK[rank];
const add = (c: Ctx, thrust: number, flux: number) => { c.thrust = Math.round(c.thrust + thrust); c.flux = round2(c.flux + flux); };
const times = (c: Ctx, x: number) => { c.flux = round2(c.flux * x); };
/** Each hook changes the running totals and returns its line in the breakdown, or null if it did not fire. */
const SCORE: Partial<Record<AnomalyId, Hook>> = {
  ion: c => (add(c, 50, 0), '+50 Thrust'),
  pulsar: c => (add(c, 0, 4), '+4 Flux'),
  railgun: c => c.card.family === 'Clicking' ? (add(c, 0, 7), '+7 Flux') : null,
  tractor: c => c.card.family === 'Tracking' ? (add(c, 0, 7), '+7 Flux') : null,
  phase: c => c.card.family === 'Switching' ? (add(c, 0, 7), '+7 Flux') : null,
  sail: c => c.s.stats.last && c.s.stats.last !== c.card.category ? (add(c, 0, 6), '+6 Flux · slingshot') : null,
  reddwarf: c => !at(c, 'strike') ? (add(c, 0, 9), '+9 Flux') : null,
  firstlight: c => c.first ? (add(c, 90, 0), '+90 Thrust') : null,
  shepherd: c => { const n = c.s.anomalies.length * 30; add(c, n, 0); return `+${n} Thrust`; },
  warp: c => c.f.jumps ? (add(c, 0, c.f.jumps * 3), `+${c.f.jumps * 3} Flux`) : null,
  scrap: (c, o) => o.n ? (add(c, 0, o.n), `+${o.n} Flux`) : null,
  tidal: c => c.same ? (add(c, 0, c.same * 4), `+${c.same * 4} Flux · ${c.same} in orbit`) : null,
  overclock: c => {
    const above = Math.round(100 * Math.max(0, Math.min(c.ratio, c.s.hazards[c.s.system] === 'whitedwarf' && c.f.stage === 2 ? 1 : 2) - 1)) * 2;
    return above ? (add(c, above, 0), `+${above} Thrust`) : null;
  },
  supernova: c => c.grade === 'nova' ? (times(c, 2), '×2 Flux') : null,
  graviton: c => at(c, 'strike') ? (add(c, 140, 0), '+140 Thrust') : null,
  accretion: (c, o) => o.n ? (add(c, 0, o.n), `+${o.n} Flux`) : null,
  darkmatter: c => { const x = 1 + c.s.slots - c.s.anomalies.length; return x > 1 ? (times(c, x), `×${x} Flux`) : null; },
  comettail: c => c.s.stats.used ? (add(c, 0, c.s.stats.used * 3), `+${c.s.stats.used * 3} Flux`) : null,
  cartographer: c => { const n = Object.values(c.s.levels).reduce((t, l) => t + l - 1, 0) * 2; return n ? (add(c, 0, n), `+${n} Flux`) : null; },
  volatile: (c, o) => (times(c, o.n), `×${o.n} Flux`),
  beacon: c => { const x = 1 + c.s.maxHull - c.s.hull; return x > 1 ? (times(c, x), `×${x} Flux`) : null; },
  lastlight: c => c.final ? (times(c, 3), '×3 Flux · final salvo') : null,
  starbreaker: c => c.f.stage === 2 ? (add(c, 0, 15), '+15 Flux') : null,
  singularity: c => { const n = Math.floor(c.thrust / 10); add(c, 0, n); return `+${n} Flux from ${c.thrust} Thrust`; },
  horizon: (c, o) => o.n > 1 ? (times(c, o.n), `×${o.n} Flux`) : null,
  constellation: c => {
    const seen = new Set([...c.s.stats.systemCats, c.card.category]).size, x = 1 + seen * 0.5;
    times(c, x); return `×${x} Flux · ${seen} disciplines`;
  },
  blackhole: (c, o) => o.n > 1 ? (times(c, o.n), `×${o.n} Flux`) : null,
  observatory: c => {
    const n = c.s.consumables.filter(x => x.kind === 'chart' && x.category === c.card.category).length;
    return n ? (times(c, round2(1.5 ** n)), `×${round2(1.5 ** n)} Flux · ${n} chart${n > 1 ? 's' : ''}`) : null;
  },
  dyson: c => { const n = Math.floor(c.s.stardust / 3); return n ? (add(c, 0, n), `+${n} Flux`) : null; },
};

/** `actor` is the card the player sees fire: a Lens or Binary takes the credit for what it repeats. */
function trigger(c: Ctx, i: number, depth: number, label?: string, actor?: number) {
  const o = c.s.anomalies[i];
  if (!o || depth > 3 || c.f.dark.includes(o.uid)) return;
  const def = anomaly(o.id)!, name = label ?? def.name, uid = actor ?? o.uid;
  if (o.id === 'lens') {
    const left = c.s.anomalies[i - 1];
    if (left) trigger(c, i - 1, depth + 1, `${name} → ${anomaly(left.id)!.name}`, uid);
    return;
  }
  if (o.id === 'binary') {
    const right = c.s.anomalies[i + 1];
    if (!right || c.f.dark.includes(right.uid)) return;
    if (right.id === 'lens' || right.id === 'binary') { trigger(c, i + 1, depth + 1, `${name} as ${anomaly(right.id)!.name}`, uid); return; }
    // The copy reads the original's growth, so a Binary beside a grown Accretion Disk is worth as much as it.
    const text = SCORE[right.id]?.(c, right, i);
    if (text) c.steps.push({ uid, source: `${name} as ${anomaly(right.id)!.name}`, text, thrust: c.thrust, flux: c.flux });
    return;
  }
  const text = SCORE[o.id]?.(c, o, i);
  if (text) c.steps.push({ uid, source: name, text, thrust: c.thrust, flux: c.flux });
}

/** Thrust, Flux and the breakdown for one run. Pure: used both to settle and to preview a target. */
export function score(s: RiftState, card: Card, rawScore: number, boost = s.fight?.boost ?? false) {
  const f = s.fight!, hazard = f.stage === 2 ? s.hazards[s.system] : null;
  const reference = card.target * (hazard === 'neutron' ? 1.1 : 1), ratio = rawScore / reference, grade = gradeOf(ratio);
  const aim = Math.min(ratio, hazard === 'whitedwarf' ? 1 : 2), level = s.levels[card.category] ?? 1;
  const c: Ctx = { s, f, card, ratio, grade, thrust: Math.round(100 * aim), flux: 0, steps: [],
    first: f.salvo === 0, final: f.salvo === f.salvos - 1, same: s.stats.last === card.category ? s.stats.chain : 0 };
  c.steps.push({ uid: null, source: `${GRADES[grade].name} · ${Math.round(ratio * 100)}% of reference`, text: `${c.thrust} Thrust`, thrust: c.thrust, flux: 0 });
  add(c, 20 * level, 1 + level);
  c.steps.push({ uid: null, source: `${card.category} · level ${level}`, text: `+${20 * level} Thrust, ${1 + level} Flux`, thrust: c.thrust, flux: c.flux });
  if (boost) { times(c, 2); c.steps.push({ uid: null, source: "Halley's Comet", text: '×2 Flux', thrust: c.thrust, flux: c.flux }); }
  for (let i = 0; i < s.anomalies.length; i++) trigger(c, i, 0);
  if (hazard === 'dimmer') { c.flux = round2(c.flux / 2); c.steps.push({ uid: null, source: 'The Brown Dwarf', text: '½ Flux', thrust: c.thrust, flux: c.flux }); }
  return { ratio, grade, thrust: c.thrust, flux: c.flux, damage: Math.floor(c.thrust * c.flux), steps: c.steps };
}

/** What each card in hand would deal at exactly the reference, so the hand reads like a decision. */
export function previews(s: RiftState): number[] {
  if (s.phase !== 'combat' || !s.fight) return [];
  return s.fight.hand.map(card => score(s, card, card.target * (s.fight!.stage === 2 && s.hazards[s.system] === 'neutron' ? 1.1 : 1)).damage);
}

/** The first complete, matching run after arming is final. Duplicate and older receipts are inert. */
export function receiveRift(state: RiftState, receipt: Receipt, now: number): RiftState {
  const f = state.fight, armed = f?.armed, card = armed ? f!.hand[armed.card] : null;
  if (state.phase !== 'combat' || !f || !armed || !card || typeof receipt.id !== 'string' || !receipt.id ||
      state.seen.includes(receipt.id) || receipt.scenario !== card.scenario ||
      !Number.isFinite(receipt.score) || receipt.score < 0 || !Number.isFinite(receipt.at) ||
      !Number.isFinite(receipt.startedAt) || receipt.startedAt < armed.at || receipt.at <= receipt.startedAt || receipt.at > now + 2000) return state;
  const s = structuredClone(state), fight = s.fight!, notes: string[] = [], payout: Payout[] = [];
  const result = score(s, card, receipt.score);
  fight.armed = null; fight.boost = false; fight.salvo++; fight.dealt += result.damage;
  if (result.grade === 'nova') fight.novas++;
  const st = s.stats;
  st.chain = st.last === card.category ? st.chain + 1 : 1; st.last = card.category;
  if (!st.systemCats.includes(card.category)) st.systemCats.push(card.category);
  st.salvos++; st.damage += result.damage; st.bestHit = Math.max(st.bestHit, result.damage);
  if (fight.stage === 2 && s.hazards[s.system] === 'magnetar' && !fight.lock) { fight.lock = card.category; notes.push(`The Magnetar locks you to ${card.category}.`); }
  // Growth happens once per real salvo, after scoring, so a Lens retrigger cannot double it.
  for (const o of [...s.anomalies]) {
    if (fight.dark.includes(o.uid)) continue;
    if (o.id === 'accretion') { if (RANK[result.grade] >= RANK.strike) o.n += 2; else if (result.grade === 'drift' && o.n) { o.n = 0; notes.push('Accretion Disk scattered.'); } }
    if (o.id === 'volatile' && RANK[result.grade] < RANK.strike) {
      o.n = round2(o.n - 0.5);
      if (o.n <= 1) { s.anomalies = s.anomalies.filter(x => x.uid !== o.uid); notes.push('Volatile Reactor collapsed.'); }
    }
  }
  if (fight.stage === 2 && s.hazards[s.system] === 'collapsar') {
    const lit = s.anomalies.filter(o => !fight.dark.includes(o.uid)).at(-1);
    if (lit && fight.dealt < fight.hull) { fight.dark.push(lit.uid); notes.push(`The Collapsar darkens ${anomaly(lit.id)!.name}.`); }
  }
  let verdict: Resolution['verdict'];
  if (fight.dealt >= fight.hull) {
    verdict = 'clear'; st.clears++;
    const interest = Math.min(interestCap(s), Math.floor(s.stardust / 5));
    payout.push({ label: `${STAGES[fight.stage].name} broken`, amount: STAGES[fight.stage].pay + (fight.stage === 2 && s.hazards[s.system] === 'bluegiant' ? 5 : 0) });
    if (fight.salvos > fight.salvo) payout.push({ label: `${fight.salvos - fight.salvo} salvo${fight.salvos - fight.salvo > 1 ? 's' : ''} unspent`, amount: fight.salvos - fight.salvo });
    if (interest) payout.push({ label: 'Interest', amount: interest });
    for (const o of s.anomalies) if (o.id === 'miner') payout.push({ label: 'Asteroid Miner', amount: 3 + fight.novas });
    s.stardust += payout.reduce((t, p) => t + p.amount, 0);
    if (fight.salvo === 1) {
      for (const o of s.anomalies) if (o.id === 'horizon') { o.n = round2(o.n + 0.4); notes.push(`Event Horizon grows to ×${o.n}.`); }
      if (owns(s, 'terraformer')) { levelUp(s, card.category, owns(s, 'terraformer')); notes.push(`Terraformer levels ${card.category} to ${s.levels[card.category]}.`); }
    }
    if (fight.stage === 2) for (const o of [...s.anomalies]) {
      if (o.id !== 'blackhole' || !s.anomalies.includes(o)) continue;
      const i = s.anomalies.indexOf(o), prey = s.anomalies[i + 1];
      if (!prey) continue;
      s.anomalies.splice(i + 1, 1); o.n = round2(o.n + 0.75); st.sold++;
      for (const x of s.anomalies) if (x.id === 'scrap') x.n += 4;
      notes.push(`Black Hole devours ${anomaly(prey.id)!.name} and grows to ×${o.n}.`);
    }
  } else if (fight.salvo >= fight.salvos) {
    if (fight.stage === 2) verdict = 'lost';
    else { s.hull--; verdict = s.hull <= 0 ? 'lost' : 'failed'; notes.push(s.hull > 0 ? `It holds. You lose 1 hull and press on with no reward.` : 'It holds, and your hull is gone.'); }
  } else {
    verdict = 'continue';
    const rest = fight.hand.filter((_, i) => i !== armed.card);
    fight.hand[armed.card] = draw(s, rest, fight.lock);
    // Under the Magnetar the whole hand bends to the locked discipline as it refills.
    if (fight.lock && !fight.hand.some(c => c.category === fight.lock)) fight.hand[armed.card] = draw(s, rest, fight.lock);
  }
  const resolution: Resolution = { receipt: structuredClone(receipt), card: structuredClone(card), ratio: result.ratio, grade: result.grade,
    steps: result.steps, thrust: result.thrust, flux: result.flux, damage: result.damage, dealt: fight.dealt, hull: fight.hull,
    salvo: fight.salvo, verdict, payout, notes };
  s.seen.push(receipt.id); s.log.push(resolution);
  if (s.log.length > LOG_LIMIT) { s.log.shift(); s.seen.shift(); }
  s.last = resolution; s.phase = 'result';
  return s;
}
