import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExpedition, rewardCatalog } from './definition.ts';
import { enroll, acceptChallenge, startTrial, syncExpedition, abandonTrial, canStartTrial, preparationReady, savedCheckpoints, trialSteps, challengeOffers } from './engine.ts';
import { migrateExpedition } from './migrate.ts';
import { journeyView } from './journey.ts';
import { bandFit, recommendBand, scenarioIntel } from './intel.ts';
import { ExpeditionStore, validState } from './store.ts';
import { ExpeditionService } from '../../app/expedition.ts';
import type { ChallengeKind, ExpeditionState } from './types.ts';

const def = loadExpedition(), d = def.destinations[0];
let clock = Date.now() - 10000000, serial = 0;
const tick = () => clock += 1000;
const run = (scenario: string, score: number) => ({ id: `journey-${++serial}`, scenario, score, at: tick() });
const sync = (s: ExpeditionState, rows: ReturnType<typeof run>[]) => syncExpedition(s, def, rows, tick());
const prepare = (s: ExpeditionState, id: string, b: number, kind: ChallengeKind = 'score_attack') => {
  s = acceptChallenge(s, def, id, b, [], tick(), kind);
  const c = s.routes[`${id}:${b}`].challenges.find(c => c.kind === kind)!;
  return sync(s, c.steps!.flatMap(st => Array.from({ length: st.required }, () => run(st.scenario, st.target ?? 100))));
};
let s = enroll(def, tick());
for (const b of [0, 2, 3]) assert.ok(canStartTrial(s, def, d.id, b));
assert.ok(!canStartTrial(s, def, d.id, 1));
for (const b of [0, 1, 2, 3]) assert.ok(!canStartTrial(s, def, 'final', b));
assert.throws(() => startTrial(s, def, d.id, 2, tick(), 'prepared'), /preparation/);
assert.equal(journeyView(s, def, 3).ready, true);
assert.equal(journeyView(s, def, 1).ready, false);
console.log('PASS: distinct band entry rules, all bands directly accessible, final passage gated');

const roster = d.bands[0];
s = startTrial(s, def, d.id, 0, tick());
s = sync(s, [run(roster[0].name, roster[0].target), run(roster[1].name, 0), run(roster[2].name, roster[2].target)]);
assert.equal(s.trials.at(-1)!.status, 'active'); assert.equal(s.trials.at(-1)!.results.length, 1);
assert.equal(s.trials.at(-1)!.misses!.length, 1);
const folder = mkdtempSync(join(tmpdir(), 'apogee-journeys-'));
const store = new ExpeditionStore(join(folder, 'checkpoint.json'), def);
store.save(s); s = store.load().state!;
s = abandonTrial(s, tick());
assert.equal(savedCheckpoints(s, d.id, 0).length, 1);
s = startTrial(s, def, d.id, 0, tick());
assert.equal(s.trials.at(-1)!.results.length, 1);
s = sync(s, roster.slice(1).map(sc => run(sc.name, sc.target * 1.2)));
assert.ok(s.rewards[`${d.id}:0:clear`]); assert.ok(!s.rewards[`${d.id}:0:mastery`]);
assert.ok(!s.rewards[`${d.id}:1:clear`]);
assert.equal(journeyView(s, def).cleared, 1);
assert.equal(journeyView(s, def).next, def.destinations[1].id);
s = startTrial(s, def, d.id, 0, tick());
assert.equal(s.trials.at(-1)!.mode, 'strict', 'mastery replay is one clean attempt');
s = sync(s, roster.map(sc => run(sc.name, sc.target * 1.1)));
assert.ok(s.rewards[`${d.id}:0:mastery`]);
console.log('PASS: Novice checkpoints survive misses, wrong-order practice, disk reload and abandonment; mastery needs a fresh clean replay');

for (const kind of ['score_attack', 'steady', 'circuit'] as const) {
  let intermediate = prepare(enroll(def, tick()), d.id, 1, kind);
  assert.ok(canStartTrial(intermediate, def, d.id, 1));
  assert.ok(validState(intermediate, def), 'Discovery is not a storage prerequisite');
  intermediate = startTrial(intermediate, def, d.id, 1, tick());
  intermediate = sync(intermediate, [run(d.bands[1][0].name, 0)]);
  assert.equal(intermediate.trials.at(-1)!.status, 'failed');
  assert.ok(canStartTrial(intermediate, def, d.id, 1), 'failure does not take away the route clear');
}
console.log('PASS: every Intermediate route opens finale without Discovery; failed attempts keep route clearance');

let advanced = prepare(enroll(def, tick()), d.id, 2);
assert.ok(preparationReady(advanced, def, d.id, 2));
advanced = startTrial(advanced, def, d.id, 2, tick(), 'prepared');
advanced = sync(advanced, [run(d.bands[2][0].name, 0)]);
assert.equal(advanced.trials.at(-1)!.status, 'active');
assert.equal(advanced.trials.at(-1)!.misses!.length, 1);
assert.deepEqual(sync(advanced, []), advanced, 'rescanning does not consume another retry');
advanced = sync(advanced, d.bands[2].map(sc => run(sc.name, sc.target * 1.2)));
assert.ok(advanced.rewards[`${d.id}:2:clear`]);
assert.ok(!advanced.rewards[`${d.id}:2:mastery`]); assert.ok(!advanced.rewards[`${d.id}:2:direct`]);
advanced = startTrial(advanced, def, d.id, 2, tick(), 'prepared');
advanced = sync(advanced, [run(d.bands[2][0].name, 0), run(d.bands[2][0].name, 0)]);
assert.equal(advanced.trials.at(-1)!.status, 'failed');
advanced = startTrial(advanced, def, d.id, 2, tick(), 'direct');
advanced = sync(advanced, d.bands[2].map(sc => run(sc.name, sc.target * 1.2)));
assert.ok(advanced.rewards[`${d.id}:2:direct`]); assert.ok(advanced.rewards[`${d.id}:2:mastery`]);
assert.ok(validState(advanced, def));
console.log('PASS: Advanced retry budget, repeat scans, fresh retry each attempt, supported vs unassisted clear and mastery');

let expert = startTrial(enroll(def, tick()), def, d.id, 3, tick());
expert = sync(expert, [run('Unrelated practice', 999), run(d.bands[3][1].name, d.bands[3][1].target)]);
assert.equal(expert.trials.at(-1)!.status, 'failed');
assert.equal(expert.trials.at(-1)!.misses!.length, 1);
console.log('PASS: Expert immediate entry, unrelated training ignored, out-of-order trial fails');

const oldDef = loadExpedition(2), v3 = loadExpedition(3), oldRoster = oldDef.destinations[0].bands[0];
let old = enroll(oldDef, tick());
for (const kind of ['discovery', 'score_attack'] as const) {
  old = acceptChallenge(old, oldDef, d.id, 0, [], tick(), kind);
  const c = old.routes[`${d.id}:0`].challenges.at(-1)!;
  old = syncExpedition(old, oldDef, c.steps!.map(st => run(st.scenario, st.target ?? 100)), tick());
}
old = startTrial(old, oldDef, d.id, 0, tick());
old = syncExpedition(old, oldDef, [run(oldRoster[0].name, oldRoster[0].target)], tick());
const before = JSON.stringify(old);
const mid = migrateExpedition(old, oldDef, v3, tick());
assert.equal(JSON.stringify(old), before);
assert.deepEqual(mid.routes, old.routes); assert.deepEqual(mid.rewards, old.rewards); assert.deepEqual(mid.trials, old.trials);
assert.ok(validState(mid, v3));
// v3 -> v4 -> v5 changes the roster twice: rewards and trials carry over whole, and a
// route survives exactly when every scenario it accepted is still offered in its v5 band.
const v4 = loadExpedition(4);
const midBefore = JSON.stringify(mid);
const migrated = migrateExpedition(migrateExpedition(mid, v3, v4, tick()), v4, def, tick());
assert.equal(JSON.stringify(mid), midBefore);
assert.deepEqual(migrated.rewards, old.rewards); assert.deepEqual(migrated.trials, old.trials);
for (const [key, route] of Object.entries(mid.routes)) {
  const [id, band] = key.split(':');
  const offered = new Set(def.destinations.find(x => x.id === id)!.pool![Number(band)].map(s => s.name));
  const playable = route.challenges.every(c => (c.steps ?? []).every(st => offered.has(st.scenario)));
  assert.equal(key in migrated.routes, playable, `${key}: kept exactly when still playable`);
  if (playable) assert.deepEqual(migrated.routes[key], route);
}
assert.ok(validState(migrated, def));
// Checkpoints banked on v3's roster, carried through v4 to v5, which retired every one of
// them. The destination must still start, carrying only the checkpoint still offered.
{
  const v3Roster = v3.destinations[0].bands[0];
  let banked = startTrial(enroll(v3, tick()), v3, d.id, 0, tick());
  banked = syncExpedition(banked, v3, v3Roster.slice(0, 2).map(sc => run(sc.name, sc.target)), tick());
  banked = abandonTrial(banked, tick());
  const moved = migrateExpedition(migrateExpedition(banked, v3, v4, tick()), v4, def, tick());
  const resumed = startTrial(moved, def, d.id, 0, tick());
  assert.ok(validState(resumed, def), 'a destination with checkpoints on a retired scenario still starts');
  const carried = resumed.trials.at(-1)!.results.map(r => r.scenario);
  assert.deepEqual(carried, v3Roster.slice(0, 2).filter((sc, i) => roster[i]?.name === sc.name).map(sc => sc.name));
  assert.ok(v3Roster.slice(0, 2).some((sc, i) => roster[i]?.name !== sc.name), 'the fixture must include a retired checkpoint');
}
const strictStep = migrated.trials.at(-1)!.steps[1].scenario;
const stillStrict = sync(migrated, [run(strictStep, 0)]);
assert.equal(stillStrict.trials.at(-1)!.status, 'failed', 'migrated active trial keeps its contract');
const oldStore = new ExpeditionStore(join(folder, 'expedition-first-light-v2.json'), oldDef);
oldStore.save(old); const bytes = readFileSync(oldStore.path);
const serviceView = new ExpeditionService(folder).view(null);
assert.equal(serviceView.error, null); assert.equal(serviceView.state!.version, 5);
assert.deepEqual(readFileSync(oldStore.path), bytes);
assert.deepEqual(new ExpeditionService(folder).view(null).state, serviceView.state);
console.log('PASS: v2 -> v3 -> v4 -> v5 preserves original bytes, rewards and active strict trials; routes survive where still playable; v5 reloads independently');

const serviceFolder = join(folder, 'actions'), statsFolder = join(folder, 'stats'); mkdirSync(statsFolder);
const service = new ExpeditionService(serviceFolder);
service.action({ type: 'enroll', band: 3, destination: def.destinations[1].id }, statsFolder);
assert.equal(service.view(null).state!.band, 3); assert.equal(service.view(null).state!.selected, def.destinations[1].id);
service.action({ type: 'select', destination: d.id, band: 0 }, statsFolder);
service.action({ type: 'start' }, statsFolder); service.playlist(statsFolder);
const playlistPath = join(folder, 'Saved', 'SaveGames', 'Playlists', 'Apogee Expedition First Light.json');
assert.equal(JSON.parse(readFileSync(playlistPath, 'utf8')).scenarioList.length, 1, 'checkpoint playlist cannot skip ahead after a miss');
service.action({ type: 'abandon' }, statsFolder);
service.action({ type: 'select', destination: d.id, band: 3 }, statsFolder);
service.action({ type: 'start' }, statsFolder); service.playlist(statsFolder);
assert.equal(JSON.parse(readFileSync(playlistPath, 'utf8')).scenarioList.length, 3, 'strict attempt preserves ordered playlist');
const appearanceFolder = join(folder, 'appearance');
new ExpeditionStore(join(appearanceFolder, 'expedition-first-light-v5.json'), def).save(s);
const appearanceService = new ExpeditionService(appearanceFolder);
appearanceService.action({ type: 'equip', reward: `${d.id}:0:clear` }, null);
assert.equal(appearanceService.view(null).state!.equipped.insignia, `${d.id}:0:clear`);
assert.throws(() => appearanceService.action({ type: 'equip', reward: `${d.id}:3:clear` }, null), /earned/);
console.log('PASS: enrollment selection, next-target checkpoint playlist, full strict playlist, earned insignia equipment');

let campaign = enroll(def, tick());
for (let b = 0; b < 4; b++) {
  for (const dest of def.destinations) {
    for (const kind of ['discovery', 'score_attack', 'steady', 'circuit'] as const) campaign = prepare(campaign, dest.id, b, kind);
    campaign = startTrial(campaign, def, dest.id, b, tick(), 'direct');
    campaign = sync(campaign, dest.bands[b].map(sc => run(sc.name, sc.target * 1.2)));
  }
  assert.ok(canStartTrial(campaign, def, 'final', b));
  if (b === 2) assert.ok(preparationReady(campaign, def, 'final', b));
  campaign = startTrial(campaign, def, 'final', b, tick(), 'direct');
  campaign = sync(campaign, trialSteps(def, 'final', b).map(st => run(st.scenario, st.target * 1.2)));
}
campaign = sync(campaign, Array.from({ length: 500 }, (_, i) => run(`Training ${i}`, 100)));
assert.deepEqual(new Set(Object.keys(campaign.rewards)), new Set(rewardCatalog(def).map(r => r.id)));
assert.equal(rewardCatalog(def).length, 122); assert.ok(validState(campaign, def));
assert.ok(challengeOffers(def, d.id, 2, [], tick()).every(o => !o.purpose.includes('open the finale')));
console.log('PASS: all four complete journeys, every final passage, 122 reachable rewards, band-appropriate contract copy');

// An unopened final passage must not claim its Advanced support is ready.
assert.ok(!preparationReady(enroll(def, tick()), def, 'final', 2));
const broken = structuredClone(campaign); broken.trials[0].mode = 'prepared';
assert.ok(!validState(broken, def), 'invalid mode/band combinations rejected');

// The deck quotes these numbers beside every target and in the difficulty suggestion.
const nov = def.destinations.flatMap(x => x.bands[0]), inter = def.destinations.flatMap(x => x.bands[1]);
assert.equal(recommendBand(def, bandFit(def, scenarioIntel(def, []))).band, 0, 'no history suggests the gentlest band');
const scout = [run(nov[0].name, nov[0].target * .5), run(nov[0].name, nov[0].target * 1.1), run(nov[0].name, nov[0].target * .9), run('Unrelated scenario', 1e9)];
const intel = scenarioIntel(def, [...scout, scout[0]]);
assert.deepEqual(Object.keys(intel), [nov[0].name], 'only expedition scenarios, duplicates counted once');
assert.equal(intel[nov[0].name].runs, 3); assert.equal(intel[nov[0].name].best, nov[0].target * 1.1);
assert.equal(intel[nov[0].name].last, nov[0].target * .9); assert.equal(intel[nov[0].name].median, nov[0].target * .9);
const beating = (rows: typeof nov, n: number, factor: number) => rows.slice(0, n).map(s => run(s.name, s.target * factor));
let fit = bandFit(def, scenarioIntel(def, [...beating(nov, 4, 1.05), ...beating(inter, 4, .8)]));
assert.deepEqual(fit[0], { played: 4, met: 4, total: 18 }); assert.deepEqual(fit[1], { played: 4, met: 0, total: 18 });
assert.equal(recommendBand(def, fit).band, 0, 'a band met at half or better, with too few plays to step up, is suggested itself');
fit = bandFit(def, scenarioIntel(def, beating(nov, 10, 1.05)));
const step = recommendBand(def, fit);
assert.equal(step.band, 1, 'a band met almost everywhere points one higher'); assert.match(step.reason, /10 of 10/);
fit = bandFit(def, scenarioIntel(def, [...beating(nov, 10, 1.05), ...beating(inter, 4, 1.05)]));
assert.equal(recommendBand(def, fit).band, 1, 'the highest band that is a real test wins');
console.log('PASS: scenario intel dedupes and ignores unrelated runs; band fit counts played and met targets; suggestion rule');
console.log('Journey validation passed.');
