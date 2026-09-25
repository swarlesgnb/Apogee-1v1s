import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSeason } from "../season/season.ts";
import { loadExpedition, rewardCatalog } from "./definition.ts";
import { abandonTrial, acceptChallenge, canStartTrial, challengeOffers, enroll, routeKey, startTrial, syncExpedition, trialSteps } from "./engine.ts";
import { migrateExpedition } from "./migrate.ts";
import { ExpeditionStore, validState } from "./store.ts";
import { ExpeditionRunReader } from "./runs.ts";
import { ExpeditionService } from "../../app/expedition.ts";
import type { ExpeditionRun, ExpeditionState } from "./types.ts";

// The engine checks below run on v2, whose rules they were written for. What ships is v5,
// so the season it names has to be the season that ships: every finale and route scenario
// exists in the live season with the targets v5 froze. v2 is history, checked against v1.
const def = loadExpedition(2), current = loadExpedition(5), season = loadSeason(), catalog = rewardCatalog(def);
assert.equal(current.destinations.length, 6); assert.deepEqual(current.bands, season.windows);
assert.equal(catalog.length, 115); assert.equal(new Set(catalog.map(r => r.id)).size, catalog.length);
assert.deepEqual(rewardCatalog(current).map(r => r.id), rewardCatalog(loadExpedition(3)).map(r => r.id), "v5 keeps every v3 reward");
for (const d of current.destinations) {
  assert.equal(d.bands.length, 4);
  for (const [b, scenarios] of d.bands.entries()) {
    assert.equal(scenarios.length, 3); assert.equal(new Set(scenarios.map(s => s.family)).size, 3);
    for (const s of [...scenarios, ...d.pool![b]]) {
      const source = season.scenarios.find(row => row.scenario === s.name && row.category === d.category && row.window === b);
      assert.ok(source, `Missing ${s.name}`); assert.equal(s.target, source.rankMaxes[2]); assert.equal(s.finalTarget, source.rankMaxes[3]);
      assert.ok(s.focus.length > 0); assert.ok(s.target > 0 && s.finalTarget >= s.target);
    }
  }
}
for (const destination of current.destinations) for (let band = 0; band < 4; band++) {
  const groups = [destination.discovery![band], destination.circuits![band], destination.bands[band]];
  // Six families is the least any category holds, so Discovery never shares one with the
  // finale; the Mixed circuit gets three of its own only where a category has nine.
  const [discovery, circuit, finale] = groups.map(g => new Set(g.map(s => s.family)));
  const pool = destination.pool![band];
  assert.ok(pool.length >= 6);
  assert.ok([...discovery].every(f => !finale.has(f)), "v5: Discovery and the finale have different families");
  assert.ok([...circuit].every(f => !discovery.has(f)), "v5: the Mixed circuit and Discovery have different families");
  assert.equal([...circuit].some(f => finale.has(f)), pool.length < 9, "v5: the circuit shares the finale's families exactly when there are fewer than nine");
}
console.log("PASS: v5 finales, routes and pools are the live season's scenarios and targets; 115 v2 rewards, every v3 reward kept");
const epoch = new Date("2026-09-20T12:00:00Z").getTime(); let clock = epoch, serial = 0;
const tick = () => clock += 1000;
const run = (scenario: string, score = 100, at = tick()): ExpeditionRun => ({ id: `run-${++serial}`, scenario, score, at });
const d = def.destinations[0], names = d.bands[0].map(s => s.name);
for (const destination of def.destinations) for (let band = 0; band < 4; band++) {
  const groups = [destination.discovery![band], destination.circuits![band], destination.bands[band]];
  assert.equal(new Set(groups.flat().map(s => s.family)).size, 9, "Discovery, circuit and finale have different families");
  assert.deepEqual(destination.bands[band], loadExpedition(1).destinations.find(d => d.id === destination.id)!.bands[band], "finale standards unchanged");
  assert.ok(destination.pool![band].length >= 10);
}
let s = enroll(def, tick());
const old = names.flatMap(name => Array.from({ length: 10 }, (_, i) => run(name, 100, epoch - 20000 + i * 1000)));
s = acceptChallenge(s, def, d.id, 0, old, tick());
const untouched = JSON.stringify(s);
assert.throws(() => acceptChallenge(s, def, d.id, 0, [], tick(), "circuit"), /Finish Discovery/);
let next = syncExpedition(s, def, old, clock);
assert.equal(next.runs.length, 0); assert.equal(Object.keys(next.rewards).length, 0); assert.equal(JSON.stringify(s), untouched);
const independent = acceptChallenge(s, def, d.id, 1, [], tick());
assert.ok(independent.routes[routeKey(d.id, 0)] && independent.routes[routeKey(d.id, 1)]);
const discovery = d.discovery![0].map(sc => run(sc.name));
s = syncExpedition(s, def, [...discovery].reverse(), clock);
assert.ok(s.routes[routeKey(d.id, 0)].challenges[0].completedAt); assert.ok(s.rewards[`${d.id}:relic:0`]);
assert.deepEqual(syncExpedition(s, def, [...discovery, ...discovery], clock), s);
assert.ok(!canStartTrial(s, def, d.id, 0));
assert.throws(() => acceptChallenge(s, def, d.id, 0, old, tick()), /Choose Score attack/);
s = acceptChallenge(s, def, d.id, 0, old, tick(), "steady");
let c = s.routes[routeKey(d.id, 0)].challenges[1];
const subject = c.steps![0].scenario;
assert.equal(c.targets[subject], 95); assert.equal(c.steps![0].source, "personal");
const interrupted = [run(subject, 100), run(subject, 100), run(subject, 90), run(subject, 100)];
s = syncExpedition(s, def, interrupted, clock); c = s.routes[routeKey(d.id, 0)].challenges[1];
assert.equal(c.progress[subject], 1); assert.equal(c.targets[subject], 95);
const before = structuredClone(c);
s = acceptChallenge(s, def, d.id, 0, old.map(r => ({...r,score:9999})), tick(), "circuit");
s = acceptChallenge(s, def, d.id, 0, [], tick(), "steady");
assert.deepEqual(s.routes[routeKey(d.id, 0)].challenges[1], before, "switching resumes frozen progress and target");
s = syncExpedition(s, def, [run(subject, 100), run(subject, 100)], clock);
assert.ok(canStartTrial(s, def, d.id, 0)); assert.ok(!canStartTrial(s, def, "final", 0));
assert.equal(s.routes[routeKey(d.id, 0)].challenges.find(c=>c.kind==='circuit')!.completedAt, null, "one route opens finale while another is unfinished");
console.log("PASS: acceptance boundaries, target freezing, resumable choices, streak reset, one route unlock, independent bands");
for (const kind of ["score_attack", "steady", "circuit"] as const) {
  let cold = enroll(def, tick());
  cold = acceptChallenge(cold, def, d.id, 0, [], tick());
  cold = syncExpedition(cold, def, d.discovery![0].map(sc=>run(sc.name)), clock);
  cold = acceptChallenge(cold, def, d.id, 0, [], tick(), kind);
  const steps = cold.routes[routeKey(d.id, 0)].challenges.at(-1)!.steps!;
  assert.ok(steps.every(step=>step.source==='published' && step.target!>0));
  cold = syncExpedition(cold, def, steps.flatMap(step=>Array.from({length:step.required},()=>run(step.scenario,step.target!))),clock);
  assert.ok(canStartTrial(cold, def, d.id, 0));
  cold = startTrial(cold, def, d.id, 0, tick());
  cold = syncExpedition(cold,def,d.bands[0].map(sc=>run(sc.name,sc.target)),clock);
  assert.equal(cold.runs.length, kind==='score_attack'?7:9);
  assert.equal(cold.trials.at(-1)!.status,'cleared');
}
const personalAttack = challengeOffers(def,d.id,0,old,clock).find(o=>o.kind==='score_attack')!;
assert.equal(personalAttack.steps[0].target,103);
console.log("PASS: every cold-start choice reaches clear in 7 or 9 runs; no calibration; personal score attack target");

s = startTrial(s, def, d.id, 0, tick());
assert.throws(() => startTrial(s, def, d.id, 0, tick()), /active trial/);
s = syncExpedition(s, def, [run("Unrelated", 5000), run(names[0], d.bands[0][0].target - 1)], clock);
assert.equal(s.trials.at(-1)!.status, "failed");
s = startTrial(s, def, d.id, 0, tick());
s = syncExpedition(s, def, [run(names[1], d.bands[0][1].target * 2)], clock);
assert.equal(s.trials.at(-1)!.status, "failed");
s = startTrial(s, def, d.id, 0, tick());
s = syncExpedition(s, def, [run(names[0], d.bands[0][0].target * 1.2)], clock);
assert.equal(s.trials.at(-1)!.results.length, 1);
s = JSON.parse(JSON.stringify(s));
s = syncExpedition(s, def, d.bands[0].slice(1).map(sc => run(sc.name, sc.target * 1.2)), clock);
assert.equal(s.trials.at(-1)!.status, "cleared"); assert.ok(s.rewards[`${d.id}:0:mastery`]);
const paid = structuredClone(s.rewards);
s = syncExpedition(s, def, [run(names[0], 0, s.trials.at(-1)!.startedAt + 1)], clock);
assert.equal(s.trials.at(-1)!.status, "cleared"); assert.deepEqual(s.rewards, paid);
s = startTrial(s, def, d.id, 0, tick()); s = abandonTrial(s, tick());
assert.equal(s.trials.at(-1)!.status, "abandoned"); assert.deepEqual(s.rewards, paid);
let boundary = structuredClone(s);
delete boundary.rewards[`${d.id}:0:mastery`];
boundary = startTrial(boundary, def, d.id, 0, tick());
boundary.trials.at(-1)!.steps.forEach(step => { step.target = 700; });
boundary = syncExpedition(boundary, def, names.map(name => run(name, 770)), clock);
assert.ok(boundary.rewards[`${d.id}:0:mastery`], "exactly 110% survives binary floating point rounding");
console.log("PASS: deliberate trial starts, ordered failure, unrelated runs, restart continuation, sticky clear, mastery, abandonment");

let campaign = enroll(def, tick());
for (const [b] of def.bands.entries()) for (const destination of def.destinations) {
  const roster = destination.bands[b];
  for (const kind of ["discovery", "score_attack", "steady", "circuit"] as const) {
    campaign = acceptChallenge(campaign, def, destination.id, b, [], tick(), kind);
    const steps = campaign.routes[routeKey(destination.id,b)].challenges.at(-1)!.steps!;
    campaign = syncExpedition(campaign, def, steps.flatMap(step=>Array.from({length:step.required},()=>run(step.scenario,step.target??100))), clock);
  }
  campaign = startTrial(campaign, def, destination.id, b, tick());
  campaign = syncExpedition(campaign, def, roster.map(sc => run(sc.name, sc.target * 1.2)), clock);
}
for (const [b] of def.bands.entries()) {
  assert.ok(canStartTrial(campaign, def, "final", b));
  campaign = startTrial(campaign, def, "final", b, tick());
  campaign = syncExpedition(campaign, def, trialSteps(def, "final", b).map(sc => run(sc.scenario, sc.target * 1.2)), clock);
  assert.ok(campaign.rewards[`final:${b}:mastery`]);
}
campaign = syncExpedition(campaign, def, Array.from({ length: 500 }, (_, i) => run(`Free training ${i}`, 30)), clock);
assert.equal(Object.keys(campaign.rewards).length, catalog.length);
assert.deepEqual(new Set(Object.keys(campaign.rewards)), new Set(catalog.map(r => r.id)));
assert.ok(validState(campaign, def)); assert.ok(!validState({ ...campaign, routes: { broken: null } }, def));
console.log("PASS: every route and finale in all four bands, all 115 rewards reachable, ordinary-training collections");

const legacy = loadExpedition(1);
const legacyState = {...enroll(def,tick()),version:1 as const,definitionId:legacy.id};
const legacyRoster = legacy.destinations[0].bands[0];
legacyState.routes[routeKey(d.id,0)] = {challenges:[{
  kind:'explore',acceptedAt:tick(),targets:{},calibration:{},progress:{},evidence:[],completedAt:null,
}]};
legacyState.runs = legacyRoster.map(sc=>run(sc.name));
const legacyCopy = JSON.stringify(legacyState);
let migrated = migrateExpedition(legacyState,legacy,def,clock);
assert.ok(validState(migrated,def)); assert.equal(JSON.stringify(legacyState),legacyCopy);
assert.ok(migrated.routes[routeKey(d.id,0)].challenges[0].completedAt);
const earnedAt=tick();
legacyState.routes[routeKey(d.id,0)].challenges[0].completedAt=earnedAt;
legacyState.rewards[`${d.id}:relic:0`]=earnedAt;
legacyState.routes[routeKey(d.id,0)].challenges.push({kind:'consistency',acceptedAt:tick(),targets:{[names[1]]:95},calibration:{},progress:{[names[1]]:2},evidence:[],completedAt:null});
legacyState.runs.push(run(names[1],100),run(names[1],100));
migrated=migrateExpedition(legacyState,legacy,def,clock);
assert.equal(migrated.routes[routeKey(d.id,0)].challenges[1].steps![0].scenario,names[1]);
assert.equal(migrated.routes[routeKey(d.id,0)].challenges[1].progress[names[1]],2);
assert.equal(migrated.routes[routeKey(d.id,0)].challenges[1].targets[names[1]],95);
assert.equal(migrated.rewards[`${d.id}:relic:0`],earnedAt);
legacyState.routes[routeKey(d.id,0)].challenges[1].completedAt=tick();
legacyState.rewards[`${d.id}:ship`]=earnedAt;legacyState.equipped.ship=`${d.id}:ship`;
migrated=migrateExpedition(legacyState,legacy,def,clock);
assert.ok(canStartTrial(migrated,def,d.id,0));assert.equal(migrated.equipped.ship,legacyState.equipped.ship);
console.log("PASS: migration credits old runs, preserves accepted targets, reward timestamps and equipment, completed legacy route opens finale");

const folder = mkdtempSync(join(tmpdir(), "apogee-expedition-"));
const store = new ExpeditionStore(join(folder, "save.json"), def);
store.save(s); store.save(campaign);
assert.deepEqual(store.load().state, campaign);
writeFileSync(store.path, "{partial");
assert.deepEqual(store.load().state, s); assert.ok(store.load().warning);
store.save(s); assert.ok(readdirSync(folder).some(n => n.includes("unreadable")));
writeFileSync(store.path, "{partial"); writeFileSync(store.path + ".bak", "{partial");
assert.throws(() => store.load(), /preserved/);
assert.equal(readFileSync(store.path, "utf8"), "{partial");
assert.throws(() => store.save({ ...s, definitionId: "another-version" }), /validation/);
console.log("PASS: atomic persistence, backup recovery, corruption preservation, content version guards");

const stats = join(folder, "stats"); mkdirSync(stats);
const filename = "Expedition Test - Challenge - 2026.09.20-12.00.00 Stats.csv";
const csv = "Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits\n\nKills:,0\nScore:,100\nScenario:,Expedition Test\nChallenge Start:,11:59:00.000\n";
writeFileSync(join(stats, filename), "Kills:,10");
const reader = new ExpeditionRunReader(); assert.equal(reader.read(stats).length, 0);
writeFileSync(join(stats, filename), csv); assert.equal(reader.read(stats).length, 0, "fresh files must settle before parsing");
utimesSync(join(stats, filename), new Date(0), new Date(0)); assert.equal(reader.read(stats).length, 1);
writeFileSync(join(stats, "Copy - Challenge - 2026.09.20-12.00.00 Stats.csv"), csv);
utimesSync(join(stats, "Copy - Challenge - 2026.09.20-12.00.00 Stats.csv"), new Date(0), new Date(0));
assert.equal(reader.read(stats).length, 1);
assert.equal(reader.read(stats).length, 1);
console.log("PASS: partial write retry, repeat scans and copied-run deduplication");

const migrationFolder=join(folder,"migration");mkdirSync(migrationFolder);
const legacyStore=new ExpeditionStore(join(migrationFolder,"expedition-first-light-v1.json"),legacy);
legacyStore.save(legacyState);const original=readFileSync(legacyStore.path,"utf8");
const upgraded=new ExpeditionService(migrationFolder).view(null);
assert.equal(upgraded.error,null);assert.equal(upgraded.state?.version,5);assert.equal(readFileSync(legacyStore.path,"utf8"),original);
assert.deepEqual(new ExpeditionService(migrationFolder).view(null).state,upgraded.state);
console.log("PASS: service migration leaves original save untouched and reloads v5 independently");
const service = new ExpeditionService(join(folder, "service"));
assert.equal(service.view(null).state, null); assert.throws(() => service.action({ type: "enroll" }, null), /stats folder/);
const enrolled = service.action({ type: "enroll" }, stats); assert.ok(enrolled.state);
assert.throws(() => service.action({ type: "equip", reward: catalog[0].id }, stats), /earned/);
assert.throws(() => service.action({ type: "select", destination: "nonsense" }, stats), /destination/);
service.action({ type: "accept" }, stats);
const playlist = service.playlist(stats); assert.ok(playlist.scenario); assert.ok(playlist.note.includes(playlist.scenario) && /appears here by itself/.test(playlist.note), "launch note names the scenario and says the result comes back on its own");
assert.ok(readdirSync(join(folder, "Saved", "SaveGames", "Playlists")).includes("Apogee Expedition First Light.json"));
const recovered = new ExpeditionService(join(folder, "service")); assert.ok(recovered.view(stats).state?.routes);
console.log("PASS: service actions, missing folder, unearned cosmetics, playlist namespace, restart");
console.log("Expedition validation passed.");
