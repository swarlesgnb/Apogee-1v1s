/** Rift is local solo progress. These rules never write a score, rank or quest award. */
export const ABILITIES = [
  { id: 'capacitor', name: 'Capacitor', tag: 'CHARGE', text: 'Reach the reference score to gain 1 Charge.', price: 18 },
  { id: 'overdrive', name: 'Overdrive', tag: 'ACTIVE', text: 'Before playing, spend all Charge for +25 damage per Charge.', price: 22 },
  { id: 'prism', name: 'Prism', tag: 'CHARGE', text: 'Clear a different discipline from your last clear to gain 1 Charge.', price: 18 },
  { id: 'afterglow', name: 'Afterglow', tag: 'SHIELD', text: 'Each Charge spent on Overdrive grants 1 shield before retaliation.', price: 20 },
  { id: 'battery', name: 'Deep Cell', tag: 'CHARGE', text: 'Raise Charge capacity from 3 to 5. Gain 2 Charge when equipped.', price: 18 },
  { id: 'momentum', name: 'Momentum', tag: 'STREAK', text: 'Each consecutive run at reference adds +10 damage, up to +30. A miss resets it.', price: 22 },
  { id: 'echo', name: 'Echo Chamber', tag: 'STREAK', text: 'Consecutive runs at reference repeat 20% of your previous attack, up to +40 damage.', price: 22 },
  { id: 'bulwark', name: 'Bulwark', tag: 'SHIELD', text: 'Reach the reference score to gain 1 shield before retaliation. Hold up to 6.', price: 18 },
  { id: 'leech', name: 'Hullweave', tag: 'RECOVERY', text: 'Clearing an encounter restores 1 hull, up to 12.', price: 20 },
  { id: 'salvager', name: 'Salvager', tag: 'SALVAGE', text: 'Earn 8 extra salvage whenever you clear an encounter.', price: 18 },
  { id: 'glass', name: 'Glass Reactor', tag: 'RISK', text: 'Multiply attack damage by 1.35. Every retaliation deals 1 extra damage.', price: 22 },
  { id: 'bounty', name: 'Giantkiller', tag: 'ELITE', text: 'Deal +35 damage to elites and bosses.', price: 22 },
] as const;
export type AbilityId = typeof ABILITIES[number]['id'];
export const STARTERS = [
  { id: 'charge', name: 'The Conductor', text: 'Build Charge. Choose your moment. Release everything.', abilities: ['capacitor', 'overdrive'] as AbilityId[] },
  { id: 'momentum', name: 'The Vanguard', text: 'Find your rhythm. Keep the streak. Build a shield.', abilities: ['momentum', 'bulwark'] as AbilityId[] },
  { id: 'salvage', name: 'The Daredevil', text: 'Hit harder. Take more damage. Buy your way out.', abilities: ['salvager', 'glass'] as AbilityId[] },
] as const;
export const BOSSES = [
  { id: 'warden', name: 'The Warden', rule: 'Its first retaliation deals 2 extra damage. Break it early or bring shields.' },
  { id: 'collapse', name: 'Event Horizon', rule: 'Retaliation grows by 1 each round. Clear it within 3 runs to escape.' },
] as const;
export interface RiftScenario { scenario: string; category: string; target: number }
export interface Encounter extends RiftScenario {
  id: string; kind: 'scout' | 'elite' | 'boss'; name: string; hp: number; attack: number;
  rounds: number; reward: number; boss: 'warden' | 'collapse' | null;
}
export interface Receipt { id: string; scenario: string; score: number; at: number; startedAt: number }
export interface Resolution {
  receipt: Receipt; base: number; damage: number; ratio: number; effects: string[];
  retaliation: number; absorbed: number; hullLost: number; enemyLeft: number;
  verdict: 'clear' | 'continue' | 'retreat' | 'lost';
}
export interface Fight { encounter: Encounter; hp: number; round: number; armed: { at: number; overdrive: boolean } | null }
export type Phase = 'route' | 'combat' | 'result' | 'reward' | 'shop' | 'won' | 'lost' | 'extracted';
export interface RiftState {
  version: 1; id: string; seed: number; rng: number; startedAt: number; band: number; bandName: string;
  starter: string; phase: Phase; depth: number; map: Encounter[][]; hull: number; shield: number;
  charge: number; streak: number; salvage: number; abilities: AbilityId[]; offers: AbilityId[];
  rerolled: boolean; shop: AbilityId[]; repaired: boolean; fight: Fight | null;
  last: Resolution | null; log: Resolution[]; seen: string[]; lastCategory: string | null; lastDamage: number;
}
export const terminal = (s: RiftState) => ['won', 'lost', 'extracted'].includes(s.phase);
export const chargeCap = (s: RiftState) => s.abilities.includes('battery') ? 5 : 3;
const has = (s: RiftState, id: AbilityId) => s.abilities.includes(id);
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
function random(s: { rng: number }) { s.rng = (Math.imul(s.rng, 1664525) + 1013904223) >>> 0; return s.rng / 4294967296; }
function shuffle<T>(s: { rng: number }, list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random(s) * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function offer(s: RiftState) { return shuffle(s, ABILITIES.map(a => a.id).filter(id => !has(s, id))).slice(0, 3); }

export function startRift(pool: RiftScenario[], band: number, bandName: string, starter: string, seed: number, now: number): RiftState {
  const kit = STARTERS.find(k => k.id === starter);
  check(kit, 'Choose a starting ship.');
  check(Number.isInteger(band) && band >= 0 && band < 4 && !!bandName, 'Choose a difficulty.');
  check(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff && Number.isFinite(now) && now > 0, 'Invalid voyage identity.');
  const valid = pool.filter(p => p.scenario && p.category && Number.isFinite(p.target) && p.target > 0);
  check(valid.length === pool.length && valid.length >= 3 && new Set(valid.map(p => p.category)).size >= 3, 'This difficulty needs at least three disciplines with valid score references.');
  const s: RiftState = { version: 1, id: `${now}-${seed}`, seed, rng: seed, startedAt: now, band, bandName, starter,
    phase: 'route', depth: 0, map: [], hull: 12, shield: 0, charge: 0, streak: 0, salvage: 10,
    abilities: [...kit!.abilities], offers: [], rerolled: false, shop: [], repaired: false, fight: null,
    last: null, log: [], seen: [], lastCategory: null, lastDamage: 0 };
  const categories = [...new Set(valid.map(p => p.category))];
  for (let depth = 0; depth < 8; depth++) {
    const boss = depth === 3 ? BOSSES[0] : depth === 7 ? BOSSES[1] : null;
    const choices = shuffle(s, categories).slice(0, boss ? 2 : 3);
    s.map.push(choices.map((category, lane) => {
      const entry = shuffle(s, valid.filter(p => p.category === category))[0];
      const elite = !boss && lane === 2;
      return { ...entry, id: `${depth}:${lane}`, kind: boss ? 'boss' : elite ? 'elite' : 'scout',
        name: boss?.name ?? (elite ? ['Rift Reaver', 'Null Sentinel', 'Starbreaker'][depth % 3] : ['Drift Drone', 'Void Stalker', 'Signal Hunter'][depth % 3]),
        hp: boss ? depth === 3 ? 210 : 270 : elite ? 145 + depth * 5 : 100 + depth * 5,
        attack: boss ? 4 : elite ? 3 : 2, rounds: boss ? 3 : 2,
        reward: boss ? 28 : elite ? 22 : 14, boss: boss?.id ?? null };
    }));
  }
  return s;
}

function equip(s: RiftState, id: AbilityId, replace?: unknown) {
  check(!has(s, id), 'That ability is already equipped.');
  if (s.abilities.length === 5) {
    check(typeof replace === 'string' && s.abilities.includes(replace as AbilityId), 'Choose an equipped ability to replace.');
    s.abilities.splice(s.abilities.indexOf(replace as AbilityId), 1);
  } else check(replace === undefined, 'There is an empty ability slot.');
  s.abilities.push(id);
  if (id === 'battery') s.charge += 2;
  s.charge = Math.min(s.charge, chargeCap(s));
}
function advance(s: RiftState) {
  s.depth++;
  s.fight = null; s.offers = [];
  if (s.depth >= 8) { s.depth = 7; s.phase = 'won'; return; }
  if (s.depth === 3 || s.depth === 6) { s.phase = 'shop'; s.shop = offer(s); s.repaired = false; }
  else s.phase = 'route';
}

/** Only choices cross IPC. A renderer can never submit a score to this function. */
export function actRift(state: RiftState, raw: unknown, now: number): RiftState {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'Choose a Rift action.');
  const a = raw as Record<string, unknown>, s = structuredClone(state);
  check(typeof a.type === 'string', 'Choose a Rift action.');
  switch (a.type) {
    case 'enter': {
      check(s.phase === 'route', 'Choose a route between encounters.');
      const encounter = s.map[s.depth].find(e => e.id === a.id);
      check(encounter, 'That route is unavailable.');
      s.fight = { encounter: structuredClone(encounter!), hp: encounter!.hp, round: 0, armed: null };
      s.last = null; s.phase = 'combat'; break;
    }
    case 'arm':
      check(s.phase === 'combat' && s.fight && !s.fight.armed, 'This round is already listening or is not ready.');
      check(typeof a.overdrive === 'boolean', 'Choose whether to use Overdrive.');
      check(!a.overdrive || has(s, 'overdrive') && s.charge > 0, 'Overdrive needs the ability and at least one Charge.');
      s.fight!.armed = { at: now, overdrive: a.overdrive as boolean }; break;
    case 'continue':
      check(s.phase === 'result' && s.last, 'There is no result to continue.');
      if (s.last!.verdict === 'continue') s.phase = 'combat';
      else if (s.last!.verdict === 'clear') {
        if (s.depth === 7) s.phase = 'won';
        else { s.phase = 'reward'; s.offers = offer(s); s.rerolled = false; }
      } else if (s.last!.verdict === 'lost') s.phase = 'lost';
      else advance(s);
      break;
    case 'take': {
      check(s.phase === 'reward' && s.offers.includes(a.id as AbilityId), 'Choose an offered ability.');
      equip(s, a.id as AbilityId, a.replace); advance(s); break;
    }
    case 'skip': check(s.phase === 'reward', 'There is no reward to skip.'); s.salvage += 6; advance(s); break;
    case 'reroll':
      check(s.phase === 'reward' && !s.rerolled && s.salvage >= 8, 'A reward can be rerolled once for 8 salvage.');
      s.salvage -= 8; s.offers = offer(s); s.rerolled = true; break;
    case 'buy': {
      check(s.phase === 'shop' && s.shop.includes(a.id as AbilityId), 'That ability is not in this shop.');
      const item = ABILITIES.find(a2 => a2.id === a.id)!;
      check(s.salvage >= item.price, 'Not enough salvage.');
      equip(s, item.id, a.replace); s.salvage -= item.price; s.shop = s.shop.filter(id => id !== item.id); break;
    }
    case 'repair':
      check(s.phase === 'shop' && !s.repaired && s.hull < 12 && s.salvage >= 12, 'Repair costs 12 salvage and is available once per shop.');
      s.salvage -= 12; s.hull = Math.min(12, s.hull + 4); s.repaired = true; break;
    case 'leave': check(s.phase === 'shop', 'You are not at a shop.'); s.phase = 'route'; break;
    case 'extract':
      check(['route', 'shop'].includes(s.phase), 'Extract between encounters.'); s.phase = 'extracted'; break;
    case 'abandon':
      check(s.phase === 'combat', 'End an encounter only while it is active.'); s.fight!.armed = null; s.phase = 'lost'; break;
    default: throw new Error('Unknown Rift action.');
  }
  return s;
}

/** The first complete, matching run after arming is final. Duplicate and older receipts are inert. */
export function receiveRift(state: RiftState, receipt: Receipt, now: number): RiftState {
  const f = state.fight, armed = f?.armed;
  if (state.phase !== 'combat' || !f || !armed || typeof receipt.id !== 'string' || !receipt.id ||
      state.seen.includes(receipt.id) || receipt.scenario !== f.encounter.scenario ||
      !Number.isFinite(receipt.score) || receipt.score < 0 || !Number.isFinite(receipt.at) ||
      !Number.isFinite(receipt.startedAt) || receipt.startedAt < armed.at || receipt.at <= receipt.startedAt || receipt.at > now + 2000) return state;
  const s = structuredClone(state), fight = s.fight!, e = fight.encounter, effects: string[] = [];
  const ratio = receipt.score / e.target, success = ratio >= 1;
  const base = Math.floor(100 * Math.min(1.5, ratio));
  let damage = base;
  const spent = armed.overdrive ? s.charge : 0;
  if (spent) { s.charge = 0; damage += spent * 25; effects.push(`Overdrive · +${spent * 25} damage (${spent} Charge)`); }
  if (spent && has(s, 'afterglow')) { s.shield = Math.min(6, s.shield + spent); effects.push(`Afterglow · +${spent} shield (cap 6)`); }
  s.streak = success ? Math.min(3, s.streak + 1) : 0;
  if (has(s, 'momentum') && s.streak) { damage += s.streak * 10; effects.push(`Momentum · +${s.streak * 10} damage`); }
  if (has(s, 'echo') && success && state.streak > 0) {
    const echo = Math.min(40, Math.floor(state.lastDamage * .2)); damage += echo; effects.push(`Echo Chamber · +${echo} damage`);
  }
  if (has(s, 'bounty') && e.kind !== 'scout') { damage += 35; effects.push('Giantkiller · +35 damage'); }
  if (has(s, 'glass')) { damage = Math.floor(damage * 1.35); effects.push('Glass Reactor · ×1.35 attack'); }
  if (success && has(s, 'capacitor')) { s.charge = Math.min(chargeCap(s), s.charge + 1); effects.push('Capacitor · +1 Charge'); }
  if (success && has(s, 'bulwark')) { s.shield = Math.min(6, s.shield + 1); effects.push('Bulwark · +1 shield (cap 6)'); }
  fight.hp = Math.max(0, fight.hp - damage); fight.round++; fight.armed = null; s.lastDamage = damage;
  let retaliation = 0, absorbed = 0, hullLost = 0;
  if (fight.hp === 0) {
    s.salvage += e.reward + (has(s, 'salvager') ? 8 : 0);
    effects.push(`Encounter cleared · +${e.reward} salvage`);
    if (has(s, 'salvager')) effects.push('Salvager · +8 salvage');
    if (has(s, 'leech')) { s.hull = Math.min(12, s.hull + 1); effects.push('Hullweave · +1 hull (cap 12)'); }
    if (has(s, 'prism') && s.lastCategory && s.lastCategory !== e.category) {
      s.charge = Math.min(chargeCap(s), s.charge + 1); effects.push('Prism · +1 Charge for changing discipline');
    }
    s.lastCategory = e.category;
  } else {
    retaliation = e.attack + (has(s, 'glass') ? 1 : 0) + (e.boss === 'warden' && fight.round === 1 ? 2 : 0) + (e.boss === 'collapse' ? fight.round - 1 : 0);
    absorbed = Math.min(s.shield, retaliation); s.shield -= absorbed;
    hullLost = Math.min(s.hull, retaliation - absorbed); s.hull -= hullLost;
  }
  let verdict: Resolution['verdict'] = fight.hp === 0 ? 'clear' : s.hull <= 0 ? 'lost' : fight.round >= e.rounds ? 'retreat' : 'continue';
  if (verdict === 'retreat') {
    const breach = Math.min(2, s.hull); s.hull -= breach; hullLost += breach;
    effects.push(`Forced retreat · ${breach} hull lost through shields; no reward`);
    s.streak = 0;
    if (s.hull === 0 || e.boss === 'collapse') verdict = 'lost';
  }
  const result: Resolution = { receipt: structuredClone(receipt), base, damage, ratio, effects, retaliation, absorbed, hullLost, enemyLeft: fight.hp, verdict };
  s.seen.push(receipt.id); s.log.push(result); s.last = result; s.phase = 'result';
  return s;
}
