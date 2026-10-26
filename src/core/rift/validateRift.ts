import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ABILITIES, STARTERS, actRift, startRift, receiveRift, terminal, type RiftState, type Receipt } from './engine.ts';
import { RiftStore, validRift } from './store.ts';
import { loadSeason } from '../season/season.ts';
import { riftReceipt, RiftService } from '../../app/rift.ts';
import { createProgressBackup, restoreProgressBackup } from '../../app/progressBackup.ts';

const tests: [string, () => void][] = [];
const testRoot = resolve('.cache/rift-validation'); mkdirSync(testRoot, { recursive: true });
const tmpdir = () => testRoot;
const test = (name: string, run: () => void) => tests.push([name, run]);
const season = loadSeason();
const pool = season.scenarios.filter(s=>s.window===0).map(s=>({scenario:s.scenario,category:s.category,target:s.rankMaxes[0]}));
let clock = Date.now() - 600_000, serial = 0;
const fresh = (kit = 'charge', seed = 42) => startRift(pool,0,'Novice',kit,seed,clock);
const act = (s:RiftState,a:unknown) => actRift(s,a,clock+=1000);
function armed(s=fresh(), lane=0) { return act(act(s,{type:'enter',id:s.map[s.depth][lane].id}),{type:'arm',overdrive:false}); }
function receipt(s:RiftState, ratio=1):Receipt { const start=s.fight!.armed!.at+1000; return {id:`run-${++serial}`,scenario:s.fight!.encounter.scenario,score:s.fight!.encounter.target*ratio,startedAt:start,at:start+60_000}; }
function play(s:RiftState,ratio=1) { const r=receipt(s,ratio); clock=Math.max(clock,r.at); return receiveRift(s,r,clock); }
function reward(s=fresh()) { s=play(armed(s),1.5); assert.equal(s.last!.verdict,'clear'); return act(s,{type:'continue'}); }

test('Real season: all four bands supply six disciplines and positive frozen references',()=>{
  assert.equal(season.windows?.length,4);
  for(let band=0;band<4;band++){
    const p=season.scenarios.filter(s=>s.window===band).map(s=>({scenario:s.scenario,category:s.category,target:s.rankMaxes[0]}));
    assert.equal(new Set(p.map(p=>p.category)).size,6);
    const s=startRift(p,band,season.windows![band],'charge',9,clock);
    assert.ok(validRift(s)); assert.equal(s.map.flat().length,22);
    assert.ok(s.map.flat().every(e=>p.some(p=>p.scenario===e.scenario&&p.target===e.target)));
  }
});
test('Seeds reproduce routes; different seeds vary routes; boss rules are announced at sectors 4 and 8',()=>{
  assert.deepEqual(fresh().map,fresh().map); assert.notDeepEqual(fresh().map,fresh('charge',43).map);
  const s=fresh(); assert.equal(s.map[3][0].boss,'warden');assert.equal(s.map[7][0].boss,'collapse');
  s.map.forEach(routes=>assert.equal(new Set(routes.map(e=>e.category)).size,routes.length));
  const target=s.map[0][0].target; const changed=pool.map(p=>({...p,target:p.target*2}));assert.ok(changed.length);assert.equal(s.map[0][0].target,target);
});
test('Invalid starts and out-of-phase actions refuse without mutating progress',()=>{
  assert.throws(()=>startRift([],0,'Novice','charge',1,clock));assert.throws(()=>startRift(pool,0,'Novice','missing',1,clock));
  const s=fresh(),before=JSON.stringify(s);for(const type of ['buy','repair','arm','take','continue','leave','unknown']) assert.throws(()=>act(s,{type}));
  assert.equal(JSON.stringify(s),before);
});
test('First matching complete receipt settles once; wrong names, stale starts, invalid and future scores never settle',()=>{
  const s=armed(),r=receipt(s);
  for(const patch of [{scenario:'other'},{score:NaN},{score:Infinity},{score:-1},{at:NaN},{startedAt:NaN},{startedAt:s.fight!.armed!.at-1},{at:r.at+10000},{id:''}])
    assert.equal(receiveRift(s,{...r,...patch},r.at),s);
  const next=receiveRift(s,r,r.at);assert.equal(next.phase,'result');assert.equal(next.log.length,1);assert.equal(next.seen[0],r.id);
  assert.equal(receiveRift(next,r,r.at),next);assert.equal(s.log.length,0);assert.equal(s.fight!.round,0);
});
test('Arming fixes Overdrive; launch retries cannot reroll its choice or spend resources',()=>{
  let s=fresh();s.charge=3;s=act(s,{type:'enter',id:s.map[0][2].id});s=act(s,{type:'arm',overdrive:true});
  assert.equal(s.charge,3);assert.throws(()=>act(s,{type:'arm',overdrive:false}));
  s=play(s,1);assert.equal(s.last!.damage,175);assert.equal(s.charge,1);assert.equal(s.last!.receipt.score,s.fight!.encounter.target);
});
test('Charge, Prism, Overdrive and Afterglow combine with explicit caps',()=>{
  let s=fresh();s.abilities=['capacitor','prism','overdrive','afterglow','battery'];s.charge=5;s.shield=5;s.lastCategory='other';
  s=act(s,{type:'enter',id:s.map[0][2].id});s=act(s,{type:'arm',overdrive:true});s=play(s,1);
  assert.equal(s.last!.damage,225);assert.equal(s.shield,6);assert.equal(s.charge,2);
  assert.ok(s.last!.effects.some(e=>e.startsWith('Prism')));assert.ok(s.last!.effects.some(e=>e.startsWith('Afterglow')));
});
test('Momentum rewards successful streaks, Echo repeats bounded damage, and a miss resets the streak',()=>{
  let s=fresh('momentum');s.abilities=['momentum','echo'];s.streak=2;s.lastDamage=250;
  s=play(armed(s),1);assert.equal(s.last!.damage,170);assert.equal(s.streak,3);
  let t=fresh('momentum');t.streak=3;t=play(armed(t),.5);assert.equal(t.last!.damage,50);assert.equal(t.streak,0);
});
test('Salvage risk trades survivability for power; Giantkiller is restricted to elite/boss encounters',()=>{
  let s=play(armed(fresh('salvage'),2),1);assert.equal(s.last!.damage,135);assert.equal(s.last!.retaliation,4);assert.equal(s.hull,8);
  s=act(s,{type:'continue'});s=act(s,{type:'arm',overdrive:false});s=play(s,1);assert.equal(s.salvage,40);
  let t=fresh();t.abilities=['bounty','leech'];t.hull=8;t=play(armed(t,2),1.5);assert.equal(t.last!.damage,185);assert.equal(t.hull,9);
});
test('Shield absorbs retaliation and Warden opening attack is visible in the resolution',()=>{
  let s=fresh();s.depth=3;s.shield=3;s=play(armed(s),.5);
  assert.equal(s.last!.retaliation,6);assert.equal(s.last!.absorbed,3);assert.equal(s.last!.hullLost,3);assert.equal(s.hull,9);
});
test('Running out of rounds retreats with breach damage; lethal retaliation ends the voyage',()=>{
  let s=play(armed(),0);s=act(s,{type:'continue'});s=act(s,{type:'arm',overdrive:false});s=play(s,0);
  assert.equal(s.last!.verdict,'retreat');assert.equal(s.hull,6);s=act(s,{type:'continue'});assert.equal(s.depth,1);assert.equal(s.phase,'route');
  let t=fresh();t.hull=1;t=play(armed(t),0);assert.equal(t.last!.verdict,'lost');t=act(t,{type:'continue'});assert.equal(t.phase,'lost');assert.ok(validRift(t));
});
test('Final boss escalates attacks and ends a voyage when its round budget expires',()=>{
  let s=fresh();s.depth=7;s.shield=6;
  s=armed(s);for(let i=0;i<3;i++){s=play(s,0);assert.equal(s.last!.retaliation,4+i);if(i<2){s=act(s,{type:'continue'});s=act(s,{type:'arm',overdrive:false});}}
  assert.equal(s.last!.verdict,'lost');assert.ok(s.hull>0);s=act(s,{type:'continue'});assert.equal(s.phase,'lost');
});
test('Reward choices exclude equipped abilities; a full build requires replacement; reroll has a real cost and limit',()=>{
  let s=reward();assert.equal(s.offers.length,3);assert.ok(s.offers.every(id=>!s.abilities.includes(id)));
  const before=s.salvage;s=act(s,{type:'reroll'});assert.equal(s.salvage,before-8);assert.throws(()=>act(s,{type:'reroll'}));
  s.abilities=ABILITIES.map(a=>a.id).filter(id=>!s.offers.includes(id)).slice(0,5);
  assert.throws(()=>act(s,{type:'take',id:s.offers[0]}));const wanted=s.offers[0],removed=s.abilities[0];s=act(s,{type:'take',id:wanted,replace:removed});
  assert.equal(s.abilities.length,5);assert.ok(s.abilities.includes(wanted));assert.ok(!s.abilities.includes(removed));assert.equal(s.depth,1);
});
test('Shop charges once, repairs are bounded, and buying Deep Cell grants Charge without exceeding capacity',()=>{
  let s=fresh();s.phase='shop';s.depth=3;s.shop=['battery','prism'];s.salvage=50;s.hull=10;
  s=act(s,{type:'buy',id:'battery'});assert.equal(s.charge,2);assert.equal(s.salvage,32);assert.throws(()=>act(s,{type:'buy',id:'battery'}));
  s=act(s,{type:'repair'});assert.equal(s.hull,12);assert.equal(s.salvage,20);assert.throws(()=>act(s,{type:'repair'}));
  s=act(s,{type:'leave'});assert.equal(s.phase,'route');
});
test('Suspend saves and reloads an armed round; corrupt saves recover a valid backup without destroying evidence',()=>{
  const folder=mkdtempSync(join(tmpdir(),'rift-store-')),path=join(folder,'rift-v1.json'),store=new RiftStore(path);
  const s=armed();store.save({version:1,state:s,records:[]});assert.deepEqual(store.load().save.state,s);
  const next=play(s);store.save({version:1,state:next,records:[]});writeFileSync(path,'broken');
  assert.deepEqual(store.load().save.state,s);assert.ok(store.load().warning);
  store.save({version:1,state:s,records:[]});assert.ok(readdirSync(folder).some(p=>p.includes('.unreadable-')));
  writeFileSync(path,'broken');writeFileSync(path+'.bak','broken too');assert.throws(()=>store.load());assert.equal(readFileSync(path,'utf8'),'broken');
});
test('Malformed persistence is rejected at structural and active-phase boundaries',()=>{
  const s=armed();assert.ok(validRift(s));
  for(const patch of [{charge:6},{hull:-1},{map:[]},{abilities:['invented']},{fight:null},{lastDamage:NaN},{seen:['unbooked']},{phase:'won'},{log:[{}]}]) assert.equal(validRift({...s,...patch}),false);
});
test('Duration adapter rejects incomplete/unknown runs and handles local midnight',()=>{
  const playedAt=new Date(2026,9,23,0,0,30),run={scenario:'test',score:100,coherent:true,playedAt,challengeStart:'23:59:30.000'};
  const r=riftReceipt(run,60)!;assert.equal(r.at-r.startedAt,60_000);assert.equal(new Date(r.startedAt).getDate(),22);
  assert.equal(riftReceipt({...run,coherent:false},60),null);assert.equal(riftReceipt(run,null),null);
  assert.equal(riftReceipt({...run,challengeStart:'00:00:20'},60),null);assert.equal(riftReceipt({...run,challengeStart:null},60),null);
});
test('Service blocks no-folder starts, concurrent voyages and forged score actions, and resumes after recreation',()=>{
  const folder=mkdtempSync(join(tmpdir(),'rift-service-')),service=new RiftService(folder);
  assert.throws(()=>service.action({type:'start',band:0,starter:'charge'},null));
  const v=service.action({type:'start',band:0,starter:'charge'},folder);assert.ok(v.state);assert.equal(v.state.phase,'route');
  assert.throws(()=>service.action({type:'start',band:0,starter:'charge'},folder));assert.throws(()=>service.action({type:'score',score:9999},folder));
  assert.deepEqual(new RiftService(folder).view(folder).state,v.state);
  const end=service.action({type:'extract'},folder);assert.equal(end.records.length,1);assert.equal(end.records[0].outcome,'extracted');
  const backup=createProgressBackup(folder,mkdtempSync(join(tmpdir(),'rift-backup-')));assert.ok(backup.files.includes('rift-v1.json'));
  const restored=mkdtempSync(join(tmpdir(),'rift-restored-'));restoreProgressBackup(backup.folder,restored);assert.equal(new RiftService(restored).view(null).records.length,1);
});
test('All three starter builds complete generated voyages through rewards, shops and both bosses',()=>{
  for(const kit of STARTERS) for(const seed of [1,17,42,999]) {
    let s=fresh(kit.id,seed),steps=0;
    while(!terminal(s)&&steps++<100){
      assert.ok(validRift(s),`${kit.id}/${seed}/${s.phase}`);
      if(s.phase==='route')s=act(s,{type:'enter',id:s.map[s.depth][0].id});
      else if(s.phase==='combat'){s=act(s,{type:'arm',overdrive:s.abilities.includes('overdrive')&&s.charge>0});s=play(s,1.5);}
      else if(s.phase==='result')s=act(s,{type:'continue'});
      else if(s.phase==='reward')s=act(s,{type:'take',id:s.offers[0],...(s.abilities.length===5?{replace:s.abilities.at(-1)}:{})});
      else if(s.phase==='shop'){if(s.hull<12&&s.salvage>=12)s=act(s,{type:'repair'});s=act(s,{type:'leave'});}
    }
    assert.equal(s.phase,'won',`${kit.id}/${seed}`);assert.equal(s.log.filter(r=>r.verdict==='clear').length,8);assert.ok(validRift(s));assert.ok(steps<100);
  }
});

assert.equal(tests.length,18,'The expected validation inventory must run.');
for(const [name,run] of tests){run();console.log(`PASS ${name}`);}
console.log(`Rift: ${tests.length}/${tests.length} checks passed. Simulated scores test rules, not human difficulty or a live KovaaK's hand-off.`);
