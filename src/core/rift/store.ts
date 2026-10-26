import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ABILITIES, STARTERS, type RiftState, type Encounter, type Resolution } from './engine.ts';

export interface RiftRecord { id: string; outcome: string; band: string; starter: string; depth: number; cleared: number; damage: number; abilities: string[]; at: number }
export interface RiftSave { version: 1; state: RiftState | null; records: RiftRecord[] }
const obj = (v: any): boolean => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: any): boolean => typeof v === 'number' && Number.isFinite(v);
const int = (v: any, min: number, max: number): boolean => Number.isInteger(v) && v >= min && v <= max;
const str = (v: any): boolean => typeof v === 'string' && v.length > 0 && v.length < 500;
const ids = new Set<string>(ABILITIES.map(a => a.id));
const abilities = (v: any, max: number): boolean => Array.isArray(v) && v.length <= max && new Set(v).size === v.length && v.every((id: any) => ids.has(id));
function encounter(e: any): e is Encounter {
  return obj(e) && str(e.id) && str(e.scenario) && str(e.category) && str(e.name) && finite(e.target) && e.target > 0 &&
    ['scout', 'elite', 'boss'].includes(e.kind) && int(e.hp, 1, 1000) && int(e.attack, 1, 20) && int(e.rounds, 1, 3) && int(e.reward, 0, 100) &&
    [null, 'warden', 'collapse'].includes(e.boss);
}
function resolution(r: any): r is Resolution {
  return obj(r) && obj(r.receipt) && str(r.receipt.id) && str(r.receipt.scenario) &&
    finite(r.receipt.score) && r.receipt.score >= 0 && finite(r.receipt.at) && finite(r.receipt.startedAt) && r.receipt.at > r.receipt.startedAt &&
    ['base', 'damage', 'ratio', 'retaliation', 'absorbed', 'hullLost', 'enemyLeft'].every(k => finite(r[k]) && r[k] >= 0) &&
    Array.isArray(r.effects) && r.effects.length <= 20 && r.effects.every(str) && ['clear', 'continue', 'retreat', 'lost'].includes(r.verdict);
}
export function validRift(s: any): s is RiftState {
  if (!obj(s) || s.version !== 1 || !str(s.id) || !int(s.seed, 0, 0xffffffff) || !int(s.rng, 0, 0xffffffff) ||
      !finite(s.startedAt) || !int(s.band, 0, 3) || !str(s.bandName) || !STARTERS.some(k => k.id === s.starter) ||
      !['route', 'combat', 'result', 'reward', 'shop', 'won', 'lost', 'extracted'].includes(s.phase) ||
      !int(s.depth, 0, 7) || !int(s.hull, 0, 12) || !int(s.shield, 0, 6) || !int(s.charge, 0, 5) ||
      !int(s.streak, 0, 3) || !int(s.salvage, 0, 10000) || !abilities(s.abilities, 5) || s.abilities.length < 2 ||
      !abilities(s.offers, 3) || !abilities(s.shop, 3) || typeof s.rerolled !== 'boolean' || typeof s.repaired !== 'boolean' ||
      !(s.lastCategory === null || str(s.lastCategory)) || !int(s.lastDamage, 0, 10000) ||
      !Array.isArray(s.map) || s.map.length !== 8 || !s.map.every((routes: any, d: number) => Array.isArray(routes) && routes.length === ([3, 7].includes(d) ? 2 : 3) && routes.every((e: any, i: number) => encounter(e) && e.id === `${d}:${i}`)) ||
      !Array.isArray(s.log) || s.log.length > 24 || !s.log.every(resolution) || !Array.isArray(s.seen) ||
      s.seen.length !== s.log.length || !s.seen.every(str) || new Set(s.seen).size !== s.seen.length ||
      !s.log.every((r: Resolution, i: number) => r.receipt.id === s.seen[i]) || !(s.last === null || resolution(s.last))) return false;
  if (s.charge > (s.abilities.includes('battery') ? 5 : 3)) return false;
  if (s.last !== null && JSON.stringify(s.last) !== JSON.stringify(s.log.at(-1))) return false;
  if (s.fight !== null) {
    const f = s.fight;
    if (!obj(f) || !encounter(f.encounter) || !s.map[s.depth].some((e: Encounter) => JSON.stringify(e) === JSON.stringify(f.encounter)) ||
        !int(f.hp, 0, f.encounter.hp) || !int(f.round, 0, f.encounter.rounds) ||
        !(f.armed === null || obj(f.armed) && finite(f.armed.at) && f.armed.at >= s.startedAt && typeof f.armed.overdrive === 'boolean')) return false;
  }
  if (['combat', 'result', 'reward', 'won', 'lost'].includes(s.phase) && !s.fight) return false;
  if (s.phase === 'combat' && (s.hull === 0 || s.fight.hp === 0 || s.fight.round >= s.fight.encounter.rounds)) return false;
  if (s.phase !== 'combat' && s.fight?.armed) return false;
  if (s.phase === 'result' && !s.last) return false;
  if (s.phase === 'won' && (s.depth !== 7 || s.last?.verdict !== 'clear')) return false;
  if (s.phase === 'reward' && s.last?.verdict !== 'clear') return false;
  return true;
}
export function validSave(v: any): v is RiftSave {
  return obj(v) && v.version === 1 && (v.state === null || validRift(v.state)) && Array.isArray(v.records) && v.records.length <= 12 &&
    v.records.every((r: any) => obj(r) && str(r.id) && ['won', 'lost', 'extracted'].includes(r.outcome) && str(r.band) && str(r.starter) &&
      int(r.depth, 1, 8) && int(r.cleared, 0, 8) && int(r.damage, 0, 100000) && abilities(r.abilities, 5) && finite(r.at));
}
export class RiftStore {
  constructor(readonly path: string) {}
  load(): { save: RiftSave; warning: string | null } {
    const files = [this.path, this.path + '.bak'];
    if (!files.some(existsSync)) return { save: { version: 1, state: null, records: [] }, warning: null };
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
