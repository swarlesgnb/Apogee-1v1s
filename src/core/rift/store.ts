import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ANOMALIES, COMETS, CONSUMABLE_SLOTS, HAND_SIZE, HAZARDS, LOG_LIMIT, SIGNALS, VESSELS, type RiftState, type Resolution, type Card, type Consumable } from './engine.ts';

export interface RiftRecord {
  id: string; outcome: string; band: string; vessel: string; system: number; cleared: number;
  damage: number; bestHit: number; anomalies: string[]; at: number;
}
export interface RiftSave { version: 2; state: RiftState | null; records: RiftRecord[] }
export const RECORD_LIMIT = 12;
const obj = (v: any): boolean => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: any): boolean => typeof v === 'number' && Number.isFinite(v);
const int = (v: any, min: number, max: number): boolean => Number.isInteger(v) && v >= min && v <= max;
const str = (v: any): boolean => typeof v === 'string' && v.length > 0 && v.length < 500;
const bool = (v: any): boolean => typeof v === 'boolean';
const anomalyIds = new Set<string>(ANOMALIES.map(a => a.id)), cometIds = new Set<string>(COMETS.map(c => c.id));
const hazardIds = new Set<string>(HAZARDS.map(h => h.id)), signalIds = new Set<string>(SIGNALS.map(s => s.id));
/** Damage numbers grow geometrically in the deep Rift; this bound only rejects garbage. */
const BIG = 1e15;

function card(c: any, cats: Set<string>): c is Card {
  return obj(c) && str(c.scenario) && cats.has(c.category) && finite(c.target) && c.target > 0 && ['Clicking', 'Tracking', 'Switching'].includes(c.family);
}
function consumable(c: any, cats: Set<string>): c is Consumable {
  return obj(c) && (c.kind === 'chart' ? cats.has(c.category) : c.kind === 'comet' && cometIds.has(c.id));
}
function resolution(r: any, cats: Set<string>): r is Resolution {
  return obj(r) && obj(r.receipt) && str(r.receipt.id) && str(r.receipt.scenario) &&
    finite(r.receipt.score) && r.receipt.score >= 0 && finite(r.receipt.at) && finite(r.receipt.startedAt) && r.receipt.at > r.receipt.startedAt &&
    card(r.card, cats) && ['ratio', 'thrust', 'flux', 'damage', 'dealt', 'hull', 'salvo'].every(k => finite(r[k]) && r[k] >= 0 && r[k] < BIG) &&
    ['drift', 'graze', 'strike', 'nova'].includes(r.grade) && ['clear', 'continue', 'failed', 'lost'].includes(r.verdict) &&
    Array.isArray(r.steps) && r.steps.length <= 40 && r.steps.every((x: any) => obj(x) && (x.uid === null || int(x.uid, 1, 1e6)) && str(x.source) && str(x.text) && finite(x.thrust) && finite(x.flux)) &&
    Array.isArray(r.payout) && r.payout.every((p: any) => obj(p) && str(p.label) && int(p.amount, 0, 1000)) &&
    Array.isArray(r.notes) && r.notes.length <= 20 && r.notes.every(str);
}

export function validRift(s: any): s is RiftState {
  if (!obj(s) || s.version !== 2 || !str(s.id) || !int(s.seed, 0, 0xffffffff) || !int(s.rng, 0, 0xffffffff) ||
      !finite(s.startedAt) || !int(s.band, 0, 3) || !str(s.bandName) || !VESSELS.some(k => k.id === s.vessel) ||
      !['map', 'combat', 'result', 'shop', 'won', 'lost', 'extracted'].includes(s.phase) ||
      !int(s.system, 0, 200) || !int(s.stage, 0, 2) || !int(s.maxHull, 1, 9) || !int(s.hull, 0, s.maxHull) ||
      !int(s.stardust, 0, 1e6) || !int(s.slots, 1, 9) || !int(s.nextUid, 1, 1e6) || !bool(s.surge)) return false;
  if (!obj(s.levels)) return false;
  const cats = new Set(Object.keys(s.levels));
  if (cats.size < 3 || !Object.values(s.levels).every(l => int(l, 1, 99))) return false;
  if (!Array.isArray(s.pool) || s.pool.length < 6 || !s.pool.every((p: any) => obj(p) && str(p.scenario) && cats.has(p.category) && finite(p.target) && p.target > 0)) return false;
  if (!Array.isArray(s.hazards) || s.hazards.length !== s.system + 1 || !s.hazards.every((h: any) => hazardIds.has(h))) return false;
  if (!Array.isArray(s.skips) || s.skips.length !== 2 || !s.skips.every((x: any) => signalIds.has(x))) return false;
  if (!Array.isArray(s.signals) || s.signals.length > 20 || !s.signals.every((x: any) => signalIds.has(x))) return false;
  if (!Array.isArray(s.anomalies) || s.anomalies.length > s.slots ||
      !s.anomalies.every((o: any) => obj(o) && int(o.uid, 1, s.nextUid - 1) && anomalyIds.has(o.id) && finite(o.n) && o.n >= 0 && o.n < 1e6) ||
      new Set(s.anomalies.map((o: any) => o.uid)).size !== s.anomalies.length) return false;
  if (!Array.isArray(s.consumables) || s.consumables.length > CONSUMABLE_SLOTS || !s.consumables.every((c: any) => consumable(c, cats))) return false;
  const st = s.stats;
  if (!obj(st) || !['salvos', 'clears', 'bestHit', 'damage', 'used', 'sold', 'chain'].every(k => finite(st[k]) && st[k] >= 0 && st[k] < BIG) ||
      !(st.last === null || cats.has(st.last)) || !Array.isArray(st.systemCats) || !st.systemCats.every((c: any) => cats.has(c)) || !bool(st.endless)) return false;
  if (!Array.isArray(s.log) || s.log.length > LOG_LIMIT || !s.log.every((r: any) => resolution(r, cats)) || !Array.isArray(s.seen) ||
      s.seen.length !== s.log.length || !s.seen.every(str) || new Set(s.seen).size !== s.seen.length ||
      !s.log.every((r: Resolution, i: number) => r.receipt.id === s.seen[i]) || !(s.last === null || resolution(s.last, cats))) return false;
  if (s.last !== null && JSON.stringify(s.last) !== JSON.stringify(s.log.at(-1))) return false;
  if (s.shop !== null) {
    const sh = s.shop;
    if (!obj(sh) || !int(sh.rerollCost, 3, 1000) || !bool(sh.free) || !Array.isArray(sh.anomalies) || sh.anomalies.length > 2 ||
        !sh.anomalies.every((o: any) => o === null || obj(o) && anomalyIds.has(o.id) && int(o.price, 0, 100)) ||
        !Array.isArray(sh.goods) || sh.goods.length > 2 || !sh.goods.every((o: any) => o === null || obj(o) && consumable(o.item, cats) && int(o.price, 0, 100))) return false;
  }
  if (s.fight !== null) {
    const f = s.fight;
    if (!obj(f) || !int(f.stage, 0, 2) || f.stage !== s.stage || !str(f.name) || !int(f.hull, 1, BIG) || !int(f.dealt, 0, BIG) ||
        !int(f.salvos, 1, 20) || !int(f.salvo, 0, f.salvos) || !int(f.jumps, 0, 20) || !int(f.novas, 0, f.salvo) || !bool(f.boost) ||
        !Array.isArray(f.hand) || f.hand.length !== HAND_SIZE || !f.hand.every((c: any) => card(c, cats)) ||
        !Array.isArray(f.dark) || !f.dark.every((u: any) => int(u, 1, s.nextUid - 1)) || !(f.lock === null || cats.has(f.lock)) ||
        !(f.armed === null || obj(f.armed) && finite(f.armed.at) && f.armed.at >= s.startedAt && int(f.armed.card, 0, HAND_SIZE - 1))) return false;
  }
  if (['combat', 'result'].includes(s.phase) && !s.fight) return false;
  if (s.phase === 'combat' && (s.hull === 0 || s.fight.dealt >= s.fight.hull || s.fight.salvo >= s.fight.salvos)) return false;
  if (s.phase !== 'combat' && s.fight?.armed) return false;
  if (s.phase === 'result' && !s.last) return false;
  if (s.phase === 'shop' && !s.shop) return false;
  if (s.phase === 'won' && (s.last?.verdict !== 'clear' || s.stage !== 2)) return false;
  return true;
}
export function validSave(v: any): v is RiftSave {
  return obj(v) && v.version === 2 && (v.state === null || validRift(v.state)) && Array.isArray(v.records) && v.records.length <= RECORD_LIMIT &&
    v.records.every((r: any) => obj(r) && str(r.id) && ['won', 'lost', 'extracted'].includes(r.outcome) && str(r.band) && VESSELS.some(k => k.id === r.vessel) &&
      int(r.system, 1, 201) && int(r.cleared, 0, 1e6) && finite(r.damage) && r.damage >= 0 && finite(r.bestHit) && r.bestHit >= 0 &&
      Array.isArray(r.anomalies) && r.anomalies.length <= 9 && r.anomalies.every((id: any) => anomalyIds.has(id)) && finite(r.at));
}
export class RiftStore {
  constructor(readonly path: string) {}
  load(): { save: RiftSave; warning: string | null } {
    const files = [this.path, this.path + '.bak'];
    if (!files.some(existsSync)) return { save: { version: 2, state: null, records: [] }, warning: null };
    for (const path of files) {
      try { const save = JSON.parse(readFileSync(path, 'utf8')); if (validSave(save)) return { save, warning: path === this.path ? null : 'Rift recovered the previous save. The damaged file will be preserved.' }; } catch { /* Try the previous complete write. */ }
    }
    throw new Error('The Rift save and its backup could not be read. Both files are preserved. Restore local progress to continue.');
  }
  save(save: RiftSave) {
    if (!validSave(save)) throw new Error('Rift could not validate this save. Your previous progress is unchanged.');
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      const old = readFileSync(this.path, 'utf8'); let valid = false;
      try { valid = validSave(JSON.parse(old)); } catch { /* Preserve the unreadable file. */ }
      if (valid) { writeFileSync(this.path + '.bak.tmp', old); renameSync(this.path + '.bak.tmp', this.path + '.bak'); }
      else writeFileSync(this.path + `.unreadable-${Date.now()}`, old);
    }
    writeFileSync(this.path + '.tmp', JSON.stringify(save)); renameSync(this.path + '.tmp', this.path);
  }
}
