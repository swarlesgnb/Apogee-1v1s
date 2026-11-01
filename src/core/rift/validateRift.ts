import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ANOMALIES, COMETS, HAZARDS, VESSELS, actRift, startRift, receiveRift, terminal, previews, systemHull, encounterHull,
  type AnomalyId, type HazardId, type RiftState, type Receipt } from './engine.ts';
import { RiftStore, validRift } from './store.ts';
import { loadSeason } from '../season/season.ts';
import { riftReceipt, RiftService, RIFT_SAVE } from '../../app/rift.ts';
import { createProgressBackup, restoreProgressBackup } from '../../app/progressBackup.ts';

const tests: [string, () => void][] = [];
const testRoot = resolve('.cache/rift-validation'); mkdirSync(testRoot, { recursive: true });
const test = (name: string, run: () => void) => tests.push([name, run]);
const season = loadSeason();
const bandPool = (band: number) => season.scenarios.filter(s => s.window === band).map(s => ({ scenario: s.scenario, category: s.category, target: s.rankMaxes[0] }));
const pool = bandPool(0);
let clock = Date.now() - 600_000, serial = 0;
const fresh = (vessel = 'drifter', seed = 42) => startRift(pool, 0, 'Novice', vessel, seed, clock);
const act = (s: RiftState, a: unknown) => actRift(s, a, clock += 1000);
/** Replace the build outright; uids stay unique because nextUid keeps counting. */
function own(s: RiftState, ids: AnomalyId[], n: Record<number, number> = {}) {
  s.anomalies = ids.map((id, i) => ({ uid: s.nextUid++, id, n: n[i] ?? ({ volatile: 2.5, horizon: 1, blackhole: 1 } as Record<string, number>)[id] ?? 0 }));
  return s;
}
function fight(s = fresh(), stage = 0, hazard?: HazardId) {
  s.stage = stage; if (hazard) s.hazards[s.system] = hazard;
  return act(s, { type: 'engage' });
}
const armed = (s: RiftState, card = 0) => act(s, { type: 'arm', card });
function receipt(s: RiftState, ratio = 1): Receipt {
  const f = s.fight!, start = f.armed!.at + 1000;
  return { id: `run-${++serial}`, scenario: f.hand[f.armed!.card].scenario, score: f.hand[f.armed!.card].target * ratio, startedAt: start, at: start + 60_000 };
}
function play(s: RiftState, ratio = 1, card = 0) { if (!s.fight!.armed) s = armed(s, card); const r = receipt(s, ratio); clock = Math.max(clock, r.at); return receiveRift(s, r, clock); }
/** Force a card of a known discipline into hand slot 0. */
function hold(s: RiftState, category: string) { const p = pool.find(p => p.category === category)!; s.fight!.hand[0] = { ...p, family: category.endsWith('Tracking') ? 'Tracking' : category.endsWith('Switching') ? 'Switching' : 'Clicking' }; return s; }
const cats = [...new Set(pool.map(p => p.category))].sort();
/** Encounters that must survive several salvos get an unbreakable hull. */
const tough = (s: RiftState) => { s.fight!.hull = 1e9; s.fight!.salvos = 9; return s; };
const stepFor = (s: RiftState, uid: number) => s.last!.steps.find(x => x.uid === uid);

test('Real season: all four bands start valid voyages with six disciplines and frozen references', () => {
  assert.equal(season.windows?.length, 4);
  for (let band = 0; band < 4; band++) {
    const p = bandPool(band);
    assert.equal(new Set(p.map(p => p.category)).size, 6);
    const s = startRift(p, band, season.windows![band], 'drifter', 9, clock);
    assert.ok(validRift(s)); assert.equal(Object.keys(s.levels).length, 6); assert.equal(s.pool.length, p.length);
    p[0].target *= 2; assert.notEqual(s.pool[0].target, p[0].target, 'The voyage keeps its own copy of the references.');
  }
});
test('Seeds reproduce hazards, signals and hands; different seeds differ; the finale is always the Collapsar', () => {
  const a = fight(fresh()), b = fight(fresh());
  assert.deepEqual(a.fight!.hand, b.fight!.hand); assert.deepEqual(a.skips, b.skips);
  const hands = new Set([1, 2, 3, 4, 5].map(seed => JSON.stringify(fight(fresh('drifter', seed)).fight!.hand.map(c => c.scenario))));
  assert.ok(hands.size > 1);
  let s = fresh(); s.system = 2; s.stage = 2; s.phase = 'shop'; s.shop = { anomalies: [], goods: [], rerollCost: 3, free: false };
  s.hazards = ['dimmer', 'dimmer', 'dimmer'];
  s = act(s, { type: 'leave' }); assert.equal(s.system, 3); assert.equal(s.hazards[3], 'collapsar');
  assert.equal(new Set(fight(fresh()).fight!.hand.map(c => c.category)).size, 3, 'A fresh hand deals three disciplines.');
});
test('Invalid starts and out-of-phase actions refuse without mutating progress', () => {
  assert.throws(() => startRift([], 0, 'Novice', 'drifter', 1, clock)); assert.throws(() => startRift(pool, 0, 'Novice', 'missing', 1, clock));
  const s = fresh(), before = JSON.stringify(s);
  for (const a of [{ type: 'buy', row: 'anomaly', index: 0 }, { type: 'reroll' }, { type: 'arm', card: 0 }, { type: 'jump', card: 0 }, { type: 'continue' },
    { type: 'leave' }, { type: 'deeper' }, { type: 'abandon' }, { type: 'use', slot: 0 }, { type: 'sell', uid: 999 }, { type: 'unknown' }]) assert.throws(() => act(s, a));
  assert.equal(JSON.stringify(s), before);
  const f = armed(fight());
  for (const a of [{ type: 'sell', uid: f.anomalies[0].uid }, { type: 'move', uid: f.anomalies[0].uid, dir: 1 }, { type: 'jump', card: 1 }, { type: 'arm', card: 1 }]) assert.throws(() => act(f, a));
});
test('First matching complete receipt settles once; wrong names, stale starts, invalid and future scores never settle', () => {
  const s = armed(fight()), r = receipt(s);
  for (const patch of [{ scenario: 'other' }, { score: NaN }, { score: Infinity }, { score: -1 }, { at: NaN }, { startedAt: NaN }, { startedAt: s.fight!.armed!.at - 1 }, { at: r.at + 10000 }, { id: '' }])
    assert.equal(receiveRift(s, { ...r, ...patch }, r.at), s);
  const next = receiveRift(s, r, r.at); assert.equal(next.phase, 'result'); assert.equal(next.log.length, 1); assert.equal(next.seen[0], r.id);
  assert.equal(receiveRift(next, r, r.at), next); assert.equal(s.log.length, 0); assert.equal(s.fight!.salvo, 0);
});
test('Damage is Thrust × Flux: aim supplies Thrust, the planet level supplies Flux, and the preview matches settlement', () => {
  let s = own(fight(), []);
  assert.equal(previews(s)[0], 240);
  s = play(s, 1); assert.equal(s.last!.thrust, 120); assert.equal(s.last!.flux, 2); assert.equal(s.last!.damage, 240);
  let t = own(fight(), []); t.levels[t.fight!.hand[0].category] = 3; t = play(t, 1.5);
  assert.equal(t.last!.damage, (150 + 60) * 4); assert.equal(t.last!.grade, 'nova');
  let u = own(fight(), []); u = play(u, 5); assert.equal(u.last!.thrust, 220, 'Aim Thrust is capped at twice the reference.');
});
test('Order matters: anomalies resolve left to right, and the player can reorder them between salvos', () => {
  let a = own(fight(), ['pulsar', 'volatile']); a = play(a, 1);
  let b = own(fight(), ['volatile', 'pulsar']); b = play(b, 1);
  assert.equal(a.last!.flux, (2 + 4) * 2.5); assert.equal(b.last!.flux, 2 * 2.5 + 4); assert.ok(a.last!.damage > b.last!.damage);
  let c = own(fight(), ['volatile', 'pulsar']); c = act(c, { type: 'move', uid: c.anomalies[1].uid, dir: -1 });
  assert.deepEqual(c.anomalies.map(o => o.id), ['pulsar', 'volatile']);
});
test('Lens retriggers its left neighbour; Binary copies its right neighbour including grown state', () => {
  let s = own(fight(), ['pulsar', 'lens']); s = play(s, 1); assert.equal(s.last!.flux, 2 + 8);
  let t = own(fight(), ['binary', 'accretion', 'pulsar'], { 1: 6 }); t = play(t, 1); assert.equal(t.last!.flux, 2 + 6 + 6 + 4);
  assert.ok(t.last!.steps.some(x => x.source.startsWith('Binary Star as Accretion Disk')));
  let u = own(fight(), ['binary', 'binary', 'lens']); u = play(u, 1); assert.equal(u.last!.flux, 2, 'Copy chains end without looping.');
});
test('Grades change what fires: Supernova, Graviton and Red Dwarf; Accretion grows and scatters; Volatile collapses', () => {
  let n = own(fight(), ['graviton', 'supernova', 'reddwarf']); n = play(n, 1.2);
  assert.equal(n.last!.grade, 'nova'); assert.equal(n.last!.damage, (120 + 20 + 140) * 4);
  let g = own(fight(), ['graviton', 'supernova', 'reddwarf']); g = play(g, 0.85);
  assert.equal(g.last!.grade, 'graze'); assert.equal(g.last!.damage, (85 + 20) * 11);
  let a = tough(own(fight(), ['accretion'])); a = play(a, 1); assert.equal(a.anomalies[0].n, 2);
  a = act(a, { type: 'continue' }); a = play(a, 0.5); assert.equal(a.anomalies[0].n, 0); assert.ok(a.last!.notes.some(x => x.includes('scattered')));
  let v = own(fight(fresh(), 2), ['volatile'], { 0: 1.5 }); v = play(v, 0.5); assert.equal(v.anomalies.length, 0);
});
test('Discipline play matters: Tidal Lock chains, Solar Sail slingshots, Constellation rewards variety, family Flux checks the family', () => {
  let s = tough(own(fight(fresh(), 2), ['tidal', 'sail', 'railgun', 'tractor', 'phase'])); s.hazards[0] = 'deadstar';
  hold(s, cats[0]); s = play(s, 0.5); assert.equal(s.last!.flux, 2 + 7, 'First salvo: no chain, no slingshot, one family.');
  s = act(s, { type: 'continue' }); hold(s, cats[0]); s = play(s, 0.5); assert.equal(s.last!.flux, 2 + 4 + 7);
  s = act(s, { type: 'continue' }); hold(s, cats[3]); s = play(s, 0.5); assert.equal(s.last!.flux, 2 + 6 + 7);
  let c = tough(own(fight(fresh(), 2), ['constellation'])); hold(c, cats[0]); c = play(c, 0.3); assert.equal(c.last!.flux, 3);
  c = act(c, { type: 'continue' }); hold(c, cats[1]); c = play(c, 0.3); assert.equal(c.last!.flux, 4);
});
test('Stars carry hazards that change the rules of play', () => {
  const eclipse = fight(own(fresh(), ['pulsar', 'ion']), 2, 'eclipse'); assert.deepEqual(eclipse.fight!.dark, [eclipse.anomalies[0].uid]);
  assert.equal(play(eclipse).last!.flux, 2);
  let mag = tough(own(fight(fresh(), 2, 'magnetar'), [])); hold(mag, cats[0]); mag = act(play(mag, 0.2), { type: 'continue' });
  assert.equal(mag.fight!.lock, cats[0]); assert.ok(mag.fight!.hand.some(c => c.category === cats[0]));
  const other = mag.fight!.hand.findIndex(c => c.category !== cats[0]);
  if (other >= 0) assert.throws(() => act(mag, { type: 'arm', card: other }));
  assert.equal(fight(fresh(), 2, 'deadstar').fight!.jumps, 0);
  assert.equal(own(fight(fresh(), 2, 'neutron'), []).fight && play(own(fight(fresh(), 2, 'neutron'), []), 1.05).last!.grade, 'graze');
  assert.equal(play(own(fight(fresh(), 2, 'whitedwarf'), ['overclock']), 1.5).last!.thrust, 120);
  assert.equal(play(own(fight(fresh(), 2, 'dimmer'), ['pulsar']), 1).last!.flux, 3);
  let col = tough(own(fight(fresh(), 2, 'collapsar'), ['pulsar', 'ion'])); col = play(col, 0.2); assert.deepEqual(col.fight!.dark, [col.anomalies[1].uid]);
  const giant = fresh(); giant.hazards[0] = 'bluegiant'; assert.equal(encounterHull(giant, 0, 2), 900);
});
test('Hulls grow geometrically, past the finale too', () => {
  assert.deepEqual([0, 1, 2, 3].map(systemHull), [300, 800, 2000, 5000]);
  assert.equal(systemHull(4), 13000); assert.equal(systemHull(5), 31000);
  for (let i = 1; i < 10; i++) assert.ok(systemHull(i) / systemHull(i - 1) >= 2.3, 'Two-figure rounding keeps each step near 2.5×.');
});
test('Clearing pays stage, unspent salvos, capped interest and miners, then opens a shop', () => {
  let s = own(fight(), ['miner']); s.stardust = 40; s = play(s, 5);
  assert.equal(s.last!.verdict, 'clear');
  assert.deepEqual(s.last!.payout.map(p => p.amount), [3, 1, 5, 4]); assert.equal(s.stardust, 53);
  let g = own(fight(), ['gasgiant', 'ion', 'pulsar']); g.stardust = 60; g = play(g, 5); assert.equal(g.last!.payout.find(p => p.label === 'Interest')!.amount, 10);
  s = act(s, { type: 'continue' }); assert.equal(s.phase, 'shop'); assert.equal(s.shop!.anomalies.length, 2); assert.equal(s.shop!.goods.length, 2);
  assert.ok(s.shop!.anomalies.every(o => o && !s.anomalies.some(a => a.id === o.id)));
});
test('Shops sell, reroll at a rising price, respect slots and comet space, and Free Berth waives one anomaly', () => {
  let s = act(play(own(fight(), []), 5), { type: 'continue' }); s.stardust = 100;
  s = act(s, { type: 'reroll' }); assert.equal(s.stardust, 97); s = act(s, { type: 'reroll' }); assert.equal(s.stardust, 93); assert.equal(s.shop!.rerollCost, 5);
  const price = s.shop!.anomalies[0]!.price; s = act(s, { type: 'buy', row: 'anomaly', index: 0 }); assert.equal(s.stardust, 93 - price); assert.equal(s.shop!.anomalies[0], null);
  assert.throws(() => act(s, { type: 'buy', row: 'anomaly', index: 0 }));
  const sold = s.anomalies[0]; s = act(s, { type: 'sell', uid: sold.uid }); assert.equal(s.stardust, 93 - price + Math.max(1, Math.floor(price / 2)));
  s.consumables = [{ kind: 'comet', id: 'gold' }, { kind: 'comet', id: 'gold' }]; assert.throws(() => act(s, { type: 'buy', row: 'goods', index: 0 }));
  own(s, ['ion', 'ion', 'ion', 'ion', 'ion']); s.shop!.anomalies = [{ id: 'pulsar', price: 4 }]; assert.throws(() => act(s, { type: 'buy', row: 'anomaly', index: 0 }));
  let f = fresh(); f.signals = ['berth']; f = act(play(own(fight(f), []), 5), { type: 'continue' }); assert.ok(f.shop!.free);
  const before = f.stardust; f = act(f, { type: 'buy', row: 'anomaly', index: 0 }); assert.equal(f.stardust, before); assert.equal(f.shop!.free, false);
  let r = fresh(); r.signals = ['beacon']; r = act(play(own(fight(r), []), 5), { type: 'continue' });
  assert.equal(ANOMALIES.find(a => a.id === r.shop!.anomalies[0]!.id)!.rarity, 'rare');
});
test('Skipping a moon or planet trades its shop for a signal; stars cannot be skipped', () => {
  let s = fresh(); s.skips = ['cache', 'surge']; const dust = s.stardust;
  s = act(s, { type: 'skip' }); assert.equal(s.stardust, dust + 10); assert.equal(s.stage, 1); assert.equal(s.phase, 'map');
  s = act(s, { type: 'skip' }); assert.equal(s.stage, 2); assert.throws(() => act(s, { type: 'skip' }));
  s = act(s, { type: 'engage' }); assert.equal(s.fight!.salvos, 3); assert.equal(s.surge, false);
  let m = fresh(); m.skips = ['starmap', 'cache']; m = act(m, { type: 'skip' }); assert.equal(Object.values(m.levels).reduce((a, b) => a + b, 0), 8);
});
test('Failing a moon or planet costs hull and its reward; failing a star or the last hull ends the voyage', () => {
  let s = own(fight(), []); s = play(s, 0.1); s = act(s, { type: 'continue' }); s = play(s, 0.1);
  assert.equal(s.last!.verdict, 'failed'); assert.equal(s.hull, 2); assert.equal(s.last!.payout.length, 0);
  s = act(s, { type: 'continue' }); assert.equal(s.phase, 'map'); assert.equal(s.stage, 1);
  let star = own(fight(fresh(), 2), []); star = play(act(play(star, 0.1), { type: 'continue' }), 0.1); assert.equal(star.last!.verdict, 'lost');
  assert.equal(act(star, { type: 'continue' }).phase, 'lost');
  let glass = own(fight(fresh('glasswing')), []); glass = play(act(play(glass, 0.1), { type: 'continue' }), 0.1); assert.equal(glass.last!.verdict, 'lost');
  const ok = act(glass, { type: 'continue' }); assert.equal(ok.phase, 'lost'); assert.ok(validRift(ok));
});
test('Black Hole devours on a star and feeds Scrap Halo; one-salvo clears grow Event Horizon and Terraformer levels', () => {
  let s = own(fight(fresh(), 2), ['scrap', 'blackhole', 'pulsar']); s = play(s, 50); assert.equal(s.last!.verdict, 'clear');
  assert.deepEqual(s.anomalies.map(o => o.id), ['scrap', 'blackhole']); assert.equal(s.anomalies[1].n, 1.75); assert.equal(s.anomalies[0].n, 4);
  let t = own(fight(), ['terraformer', 'horizon']); const cat = t.fight!.hand[0].category; t = play(t, 50);
  assert.equal(t.levels[cat], 2); assert.equal(t.anomalies[1].n, 1.4);
});
test('Comets and charts: Halley, Wormhole, Mirror Moon, Golden Comet, Nebula Seed, Aurora, and Observatory holding charts', () => {
  let s = own(fight(), ['accretion'], { 0: 6 }); s.consumables = [{ kind: 'comet', id: 'halley' }, { kind: 'comet', id: 'wormhole' }];
  s = act(act(s, { type: 'use', slot: 0 }), { type: 'use', slot: 0 }); assert.equal(s.fight!.salvos, 3); assert.equal(s.stats.used, 2);
  assert.equal(play(s, 1).last!.flux, (2 * 2) + 6);
  let m = own(fresh(), ['accretion'], { 0: 6 }); m.consumables = [{ kind: 'comet', id: 'mirror' }, { kind: 'comet', id: 'gold' }]; m.stardust = 30;
  m = act(act(m, { type: 'use', slot: 0 }), { type: 'use', slot: 0 }); assert.deepEqual(m.anomalies.map(o => o.n), [6, 6]); assert.equal(m.stardust, 50);
  let a = own(fresh(), []); a.consumables = [{ kind: 'comet', id: 'aurora' }, { kind: 'comet', id: 'seed' }];
  a = act(act(a, { type: 'use', slot: 0 }), { type: 'use', slot: 0 }); assert.ok(Object.values(a.levels).every(l => l === 2)); assert.equal(a.anomalies.length, 1);
  assert.throws(() => act(Object.assign(own(fresh(), []), { consumables: [{ kind: 'comet', id: 'halley' }] }), { type: 'use', slot: 0 }), /encounter/);
  let o = own(fight(), ['observatory']); const c = o.fight!.hand[0].category; o.consumables = [{ kind: 'chart', category: c }, { kind: 'chart', category: c }];
  assert.equal(play(o, 1).last!.flux, 2 * 2.25);
});
test('Every anomaly with a scoring ability fires under some ordinary condition; passive ones change their own rule', () => {
  const passive = new Set(['miner', 'station', 'gasgiant', 'terraformer']);
  for (const a of ANOMALIES) {
    if (passive.has(a.id)) continue;
    let fired = false;
    for (const stage of [0, 2]) for (const ratio of [0.5, 0.9, 1.05, 1.3]) for (const cat of cats) for (const same of [false, true]) {
      let s = fresh(); s.stats.used = 1; s.stats.last = same ? cat : cats[(cats.indexOf(cat) + 1) % 6]; s.stats.chain = 2; s.stardust = 9; s.hull = 2; s.levels[cat] = 2;
      s = fight(s, stage, 'dimmer'); own(s, a.id === 'lens' ? ['pulsar', 'lens'] : a.id === 'binary' ? ['binary', 'pulsar'] : [a.id], { 0: 4 });
      s.consumables = [{ kind: 'chart', category: cat }]; hold(s, cat); if (same) s.fight!.salvos = 1;
      const uid = s.anomalies.find(o => o.id === a.id)!.uid;
      if (stepFor(play(s, ratio), uid)) fired = true;
    }
    assert.ok(fired, `${a.name} never fired`);
  }
  assert.equal(own(fight(Object.assign(fresh(), {})), []).fight!.salvos, 2);
  const st = own(fresh(), ['station']); assert.equal(act(st, { type: 'engage' }).fight!.salvos, 3);
  const w = own(fresh(), ['warp']); assert.equal(act(w, { type: 'engage' }).fight!.jumps, 4);
  assert.equal(VESSELS.length, 4); assert.equal(HAZARDS.length, 8); assert.equal(COMETS.length, 6);
});
test('Jumps replace one target at a cost; the played target is replaced after each salvo', () => {
  let s = fight(); const before = s.fight!.hand.map(c => c.scenario);
  s = act(s, { type: 'jump', card: 1 }); assert.equal(s.fight!.jumps, 2); assert.notEqual(s.fight!.hand[1].scenario, before[1]);
  assert.equal(new Set(s.fight!.hand.map(c => c.scenario)).size, 3);
  s = own(s, []); s = play(s, 0.2); assert.equal(s.last!.verdict, 'continue'); s = act(s, { type: 'continue' }); assert.equal(s.fight!.hand.length, 3);
});
test('Suspend saves and reloads an armed salvo; corrupt saves recover a valid backup without destroying evidence', () => {
  const folder = mkdtempSync(join(testRoot, 'rift-store-')), path = join(folder, RIFT_SAVE), store = new RiftStore(path);
  const s = armed(fight()); store.save({ version: 2, state: s, records: [] }); assert.deepEqual(store.load().save.state, s);
  const next = play(s); store.save({ version: 2, state: next, records: [] }); writeFileSync(path, 'broken');
  assert.deepEqual(store.load().save.state, s); assert.ok(store.load().warning);
  store.save({ version: 2, state: s, records: [] }); assert.ok(readdirSync(folder).some(p => p.includes('.unreadable-')));
  writeFileSync(path, 'broken'); writeFileSync(path + '.bak', 'broken too'); assert.throws(() => store.load()); assert.equal(readFileSync(path, 'utf8'), 'broken');
});
test('Malformed persistence is rejected at structural and active-phase boundaries', () => {
  const s = armed(fight()); assert.ok(validRift(s));
  for (const patch of [{ hull: -1 }, { hull: 9 }, { levels: {} }, { anomalies: [{ uid: 1, id: 'invented', n: 0 }] }, { fight: null }, { stardust: NaN },
    { seen: ['unbooked'] }, { phase: 'won' }, { log: [{}] }, { hazards: [] }, { consumables: [{ kind: 'comet', id: 'x' }, 1, 2] }, { version: 1 }])
    assert.equal(validRift({ ...s, ...patch }), false, JSON.stringify(patch));
  assert.equal(validRift({ ...s, fight: { ...s.fight!, armed: { at: s.fight!.armed!.at, card: 7 } } }), false);
});
test('Duration adapter rejects incomplete/unknown runs and handles local midnight', () => {
  const playedAt = new Date(2026, 9, 23, 0, 0, 30), run = { scenario: 'test', score: 100, coherent: true, playedAt, challengeStart: '23:59:30.000' };
  const r = riftReceipt(run, 60)!; assert.equal(r.at - r.startedAt, 60_000); assert.equal(new Date(r.startedAt).getDate(), 22);
  assert.equal(riftReceipt({ ...run, coherent: false }, 60), null); assert.equal(riftReceipt(run, null), null);
  assert.equal(riftReceipt({ ...run, challengeStart: '00:00:20' }, 60), null); assert.equal(riftReceipt({ ...run, challengeStart: null }, 60), null);
});
test('Service blocks no-folder starts, concurrent voyages and forged score actions, resumes after recreation, and backs up', () => {
  const folder = mkdtempSync(join(testRoot, 'rift-service-')), service = new RiftService(folder);
  assert.throws(() => service.action({ type: 'start', band: 0, vessel: 'drifter' }, null));
  const v = service.action({ type: 'start', band: 0, vessel: 'drifter' }, folder); assert.ok(v.state); assert.equal(v.state.phase, 'map');
  assert.equal(v.derived!.route.length, 3);
  assert.throws(() => service.action({ type: 'start', band: 0, vessel: 'drifter' }, folder)); assert.throws(() => service.action({ type: 'score', score: 9999 }, folder));
  assert.deepEqual(new RiftService(folder).view(folder).state, v.state);
  const engaged = service.action({ type: 'engage' }, folder); assert.equal(engaged.derived!.previews.length, 3);
  assert.throws(() => service.action({ type: 'extract' }, folder));
  service.action({ type: 'abandon' }, folder); const end = service.view(folder);
  assert.equal(end.records.length, 1); assert.equal(end.records[0].outcome, 'lost');
  const backup = createProgressBackup(folder, mkdtempSync(join(testRoot, 'rift-backup-'))); assert.ok(backup.files.includes(RIFT_SAVE));
  const restored = mkdtempSync(join(testRoot, 'rift-restored-')); restoreProgressBackup(backup.folder, restored); assert.equal(new RiftService(restored).view(null).records.length, 1);
});

/**
 * A greedy, build-blind pilot: plays the best-previewed target, buys the rarest affordable
 * anomaly and uses every chart at once. It never orders anomalies or plans a synergy, so it
 * sets a floor on what a person can do rather than a ceiling.
 */
function voyage(vessel: string, seed: number, aim: number, build: boolean) {
  let s = startRift(pool, 0, 'Novice', vessel, seed, clock), noise = (seed * 7919) >>> 0;
  const rnd = () => { noise = (Math.imul(noise, 1103515245) + 12345) >>> 0; return noise / 4294967296; };
  const rank = { common: 0, uncommon: 1, rare: 2 } as const, rarity = (id: string) => rank[ANOMALIES.find(a => a.id === id)!.rarity];
  for (let steps = 0; steps < 600 && !terminal(s); steps++) {
    if (s.phase === 'map') s = act(s, { type: 'engage' });
    else if (s.phase === 'combat') {
      if (build) for (let i = s.consumables.length - 1; i >= 0; i--) { try { s = act(s, { type: 'use', slot: i }); } catch { /* Not usable here. */ } }
      const p = previews(s), lock = s.fight!.lock;
      const best = s.fight!.hand.map((c, i) => i).filter(i => !lock || s.fight!.hand[i].category === lock).sort((a, b) => p[b] - p[a])[0];
      s = play(s, aim * (1 + (rnd() * 2 - 1) * 0.12), best);
    } else if (s.phase === 'result') s = act(s, { type: 'continue' });
    else if (s.phase === 'shop') {
      if (build) {
        s.shop!.anomalies.forEach((o, i) => {
          if (!o || s.stardust < o.price) return;
          if (s.anomalies.length >= s.slots) {
            const weakest = [...s.anomalies].sort((a, b) => rarity(a.id) - rarity(b.id))[0];
            if (rarity(weakest.id) >= rarity(o.id)) return;
            s = act(s, { type: 'sell', uid: weakest.uid });
          }
          s = act(s, { type: 'buy', row: 'anomaly', index: i });
        });
        s.shop!.goods.forEach((o, i) => { if (o && s.stardust >= o.price + 4 && s.consumables.length < 2) s = act(s, { type: 'buy', row: 'goods', index: i }); });
      }
      s = act(s, { type: 'leave' });
    }
  }
  assert.ok(terminal(s) && validRift(s), `${vessel}/${seed} finished in a valid terminal state`);
  return s;
}
test('Simulated voyages: building is required, better aim wins more, and every vessel can finish', () => {
  const rates: Record<string, number> = {};
  for (const build of [false, true]) for (const aim of [0.85, 1, 1.15, 1.3]) {
    let wins = 0; const byVessel: Record<string, number> = {};
    for (const v of VESSELS) for (let seed = 1; seed <= 40; seed++) { const won = voyage(v.id, seed, aim, build).phase === 'won'; wins += +won; byVessel[v.id] = (byVessel[v.id] ?? 0) + +won; }
    rates[`${build}:${aim}`] = wins / (VESSELS.length * 40);
    if (build && aim >= 1.15) for (const v of VESSELS) assert.ok(byVessel[v.id] > 0, `${v.id} never wins at ${aim}`);
  }
  for (const aim of [0.85, 1, 1.15, 1.3]) assert.equal(rates[`false:${aim}`], 0, `Buying nothing never finishes, even at ${aim}× the reference.`);
  assert.ok(rates['true:0.85'] < rates['true:1'] && rates['true:1'] < rates['true:1.15'] && rates['true:1.15'] < rates['true:1.3'], JSON.stringify(rates));
  assert.ok(rates['true:1'] >= 0.25 && rates['true:1.3'] <= 0.9, JSON.stringify(rates));
  console.log(`     greedy-pilot win rates by aim (0.85/1/1.15/1.3): ${[0.85, 1, 1.15, 1.3].map(a => `${Math.round(rates[`true:${a}`] * 100)}%`).join(' / ')}`);
});
test('Winning opens the deep Rift; hulls keep growing and the record is refreshed when it ends', () => {
  const folder = mkdtempSync(join(testRoot, 'rift-deep-'));
  let s = fresh(); s.system = 3; s.stage = 2; while (s.hazards.length < 4) s.hazards.push('collapsar');
  s = own(fight(s, 2), ['pulsar']); s.fight!.hull = 100; s = play(s, 2); assert.equal(s.last!.verdict, 'clear');
  new RiftStore(join(folder, RIFT_SAVE)).save({ version: 2, state: s, records: [] });
  const service = new RiftService(folder);
  let v = service.action({ type: 'continue' }, folder); assert.equal(v.state!.phase, 'won'); assert.equal(v.records[0].outcome, 'won');
  v = service.action({ type: 'deeper' }, folder); assert.equal(v.state!.phase, 'shop'); assert.equal(v.records[0].outcome, 'won');
  v = service.action({ type: 'leave' }, folder); assert.equal(v.state!.system, 4); assert.equal(v.derived!.route[0].hull, 13000);
  v = service.action({ type: 'extract' }, folder); assert.equal(v.records.length, 1); assert.equal(v.records[0].outcome, 'extracted'); assert.equal(v.records[0].system, 5);
});

assert.equal(tests.length, 25, 'The expected validation inventory must run.');
for (const [name, run] of tests) { run(); console.log(`PASS ${name}`); }
console.log(`Rift: ${tests.length}/${tests.length} checks passed. Simulated scores test rules and relative balance, not human difficulty or a live KovaaK's hand-off.`);
