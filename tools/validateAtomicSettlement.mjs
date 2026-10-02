import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync,readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const db=new PGlite(); await db.waitReady;
await db.exec(`create schema auth;create table auth.users(id uuid primary key default gen_random_uuid());
create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
grant usage on schema public to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
for(const file of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
await db.exec(readFileSync('supabase/seed.sql','utf8'));
const players=[];
for(let i=1;i<=2;i++){
  const id=(await db.query('insert into auth.users default values returning id')).rows[0].id;
  await db.query('insert into players(id,steam_id,display_name) values($1,$2,$3)',[id,'7656100000000000'+i,'Atomic test '+i]);players.push(id);
}
const scenarios=(await db.query('select id,name from scenarios order by id limit 3')).rows;
let serial=0;
async function match(rated=true){
  const id=(await db.query(`insert into matches(category,status,benchmark_name,difficulty,seed,scenario_ids,rated)
  values('Clicking','awaiting_runs','Voltaic S5','Intermediate',$1,$2::bigint[],$3) returning id`,['atomic-'+(++serial),scenarios.map(s=>s.id),rated])).rows[0].id;
  for(const player of players)await db.query('insert into match_sides(match_id,player_id) values($1,$2)',[id,player]);return id;
}
async function plan(player,change=10){
  const r=(await db.query('select * from ratings where player_id=$1',[player])).rows[0];
  const before={rating:Number(r.rating),rd:Number(r.rd),volatility:Number(r.volatility)};
  return {player_id:player,before,after:{...before,rating:before.rating+change,rd:300},matches_played:r.matches_played,score:change>0?1:0,weight:1};
}
const sides=plans=>plans.map(p=>({player_id:p.player_id,result:p.score===1?'win':'loss',rating_before:p.before.rating,
rating_after:p.after.rating,rd_before:p.before.rd,rd_after:p.after.rd}));
async function commit(id,status,side,ratings=[],forfeit=false){
  return (await db.query('select commit_match_result($1,$2,$3::jsonb,$4::jsonb,$5) as receipt',
    [id,status,JSON.stringify(side),JSON.stringify(ratings),forfeit])).rows[0].receipt;
}
async function snapshot(id){return {
  ratings:(await db.query('select * from ratings order by player_id')).rows,
  sides:(await db.query('select * from match_sides where match_id=$1 order by player_id',[id])).rows,
  match:(await db.query('select status,settled_at from matches where id=$1',[id])).rows,
  history:(await db.query('select * from rating_history order by id')).rows,
};}

const id=await match();const plans=[await plan(players[0]),await plan(players[1],-10)];
const receipts=await Promise.all([commit(id,'settled',sides(plans),plans),commit(id,'settled',sides(plans),plans)]);
assert.equal(receipts.filter(r=>r.committed).length,1);
assert.equal(receipts.filter(r=>r.reason==='already-settled').length,1);
const once=await snapshot(id);
assert.equal(once.history.length,2);assert.ok(once.ratings.every(r=>r.matches_played===1));
assert.ok(once.sides.every(s=>s.submitted_at));
assert.equal((await commit(id,'void',sides(plans))).reason,'already-settled');
assert.deepEqual(await snapshot(id),once,'replays and racing terminal decisions cannot change the committed result');
console.log('PASS: one receipt for overlapping promises, two duel ratings committed once (single-connection Postgres)');

const stale=await match();const staleBefore=await snapshot(stale);
await assert.rejects(commit(stale,'settled',sides(plans),plans),e=>e.code==='40001');
assert.deepEqual(await snapshot(stale),staleBefore,'stale rating calculations roll back every write');

const broken=await match();const next=[await plan(players[0]),await plan(players[1],-10)];
const brokenBefore=await snapshot(broken);
const last=[...players].sort().at(-1);
await db.exec(`create function test_fail_history() returns trigger language plpgsql as $$begin
if new.player_id='${last}'::uuid then raise exception 'planted history failure';end if;return new;end;$$;
create trigger test_fail_history before insert on rating_history for each row execute function test_fail_history();`);
await assert.rejects(commit(broken,'settled',sides(next),next),/planted history failure/);
assert.deepEqual(await snapshot(broken),brokenBefore,'failure after a rating update rolls back both players and the match');
await db.exec('drop trigger test_fail_history on rating_history;drop function test_fail_history();');
assert.equal((await commit(broken,'settled',sides(next),next)).committed,true,'retry after transient failure succeeds');
console.log('PASS: stale proposals and a planted mid-transaction failure leave no partial settlement');

for(const [rated,status] of [[false,'settled'],[true,'void']]){
  const trial=await match(rated), proposal=await plan(players[0]), before=await snapshot(trial);
  await assert.rejects(commit(trial,status,sides([proposal]),[proposal]),/cannot move ratings/);
  assert.deepEqual(await snapshot(trial),before);
  assert.equal((await commit(trial,status,[{player_id:players[0],result:null}])).committed,true);
}
await db.exec('set role authenticated');
await assert.rejects(commit(id,'settled',sides(plans),plans),e=>e.code==='42501');
await db.exec('reset role');

const pending=await match();
for(const [i,s] of scenarios.entries()) await db.query(`insert into runs(player_id,scenario_name,score,played_at,csv_sha256,match_id)
values($1,$2,10,$3,$4,$5)`,[players[0],s.name,`2026-10-02T12:0${i}:00Z`,'complete-'+i,pending]);
const pendingBefore=await snapshot(pending), loss=await plan(players[0],-10);
assert.equal((await commit(pending,'settled',sides([loss]),[loss],true)).reason,'already-played');
assert.deepEqual(await snapshot(pending),pendingBefore,'an expiry or abandon race cannot forfeit three submitted rounds');
const forfeited=await match();
await db.query('update match_sides set match_score=1 where match_id=$1 and player_id=$2',[forfeited,players[1]]);
const forfeitPlans=[await plan(players[0],-10),await plan(players[1],10)];
assert.equal((await commit(forfeited,'settled',sides(forfeitPlans),forfeitPlans,true)).committed,true,'a copied opponent score does not block a real forfeit');
const endedBefore=await snapshot(forfeited);
await assert.rejects(db.query(`insert into runs(player_id,scenario_name,score,played_at,csv_sha256,match_id)
values($1,$2,10,'2026-10-02T14:00Z','late-run',$3)`,[players[0],scenarios[0].name,forfeited]),e=>e.code==='55000');
assert.deepEqual(await snapshot(forfeited),endedBefore);
assert.equal((await db.query("select count(*)::int as n from runs where csv_sha256='late-run'")).rows[0].n,0);
console.log('PASS: unrated/void protection, client denial, completed-run forfeit guard, real forfeit and late-run refusal');

// Drive the actual Edge handler and shared rating helpers against this database.
// Only authentication, transport and tournament notification are stubbed.
await db.exec('delete from runs; update ratings set rating=1500,rd=350,volatility=0.06,matches_played=0;');
const duelMatch=await match();
await db.query(`update match_sides set rating_before=1500,rd_before=350,deltas='{0,0,0}',match_score=0,
submitted_at='2000-01-01Z' where match_id=$1 and player_id=$2`,[duelMatch,players[1]]);
await db.query('update match_sides set rating_before=999,rd_before=50 where match_id=$1 and player_id=$2',[duelMatch,players[0]]);
await db.query(`insert into duels(challenger_id,challenged_id,match_id,answer_match_id,status,expires_at)
values($1,$2,$3,$4,'accepted',now()+interval '1 day')`,[players[1],players[0],id,duelMatch]);
for(const [i,s] of scenarios.entries()){
  await db.query(`insert into runs(player_id,scenario_name,score,played_at,created_at,csv_sha256,verification_tier)
  values($1,$2,100,'2026-10-01Z','2026-10-01Z',$3,'consistent')`,[players[0],s.name,'baseline-'+i]);
  await db.query(`insert into runs(player_id,scenario_name,score,played_at,csv_sha256,verification_tier,match_id,duration_seconds)
  values($1,$2,110,$3,$4,'consistent',$5,60)`,[players[0],s.name,`2026-10-02T16:0${i}:00Z`,'duel-round-'+i,duelMatch]);
}
let handler;
globalThis.Deno={env:{get:()=>''},serve:fn=>{handler=fn;}};
globalThis.atomicPlayer=players[0];
const actualShared=resolve('supabase/functions/_shared/apogee.ts').replaceAll('\\','/');
await build({entryPoints:['supabase/functions/settle-match/index.ts'],outfile:'.cache/atomic-handler.mjs',bundle:true,platform:'node',format:'esm',plugins:[{
  name:'isolated-transport',setup(b){
    b.onResolve({filter:/\/\_shared\/apogee\.ts$/},args=>args.namespace==='test'
      ?{path:resolve('supabase/functions/_shared/apogee.ts'),namespace:'file'}
      :args.importer.replaceAll('\\','/').endsWith('settle-match/index.ts')?{path:'boundary',namespace:'test'}:undefined);
    b.onResolve({filter:/\/\_shared\/(rateLimit|tournament)\.ts$/},()=>({path:'optional',namespace:'test'}));
    b.onResolve({filter:/^jsr:/},()=>({path:'client',namespace:'test'}));
    b.onLoad({filter:/.*/,namespace:'test'},args=>({contents:args.path==='boundary'?`
      export * from ${JSON.stringify(actualShared)};
      import * as shared from ${JSON.stringify(actualShared)};
      globalThis.atomicShared=shared;
      export const handler=fn=>req=>fn(req,globalThis.atomicAdmin);
      export const requireCaller=async()=>({playerId:globalThis.atomicPlayer});
      export const json=(body,status=200)=>({body,status});
    `:args.path==='optional'?'export const enforceRateLimit=async()=>{};export const afterLegSettled=async()=>null;':
      "export function createClient(){throw new Error('No network in this test')}"}));
  }
}]});
const identifier=value=>{assert.match(value,/^[a-z_]+$/);return value;};
let commits=0;
globalThis.atomicAdmin={
  async rpc(name,p){assert.equal(name,'commit_match_result');commits++;
    try{return {data:await commit(p.p_match_id,p.p_status,p.p_sides,p.p_ratings,p.p_forfeit),error:null};}
    catch(error){return {data:null,error:{code:error.code,message:error.message}};}
  },
  from(table){identifier(table);let columns='*',single=false,limit='';const values=[],where=[],ordering=[];
    const condition=(key,operator,value)=>{values.push(value);where.push(`${identifier(key)} ${operator} $${values.length}`);return query;};
    const query={select(value){columns=value.split(',').map(s=>identifier(s.trim())).join(',');return query;},
      eq(k,v){return condition(k,'=',v);},neq(k,v){return condition(k,'<>',v);},lt(k,v){return condition(k,'<',v);},
      in(k,v){values.push(v);where.push(`${identifier(k)}=any($${values.length})`);return query;},
      or(value){const m=/^match_id\.is\.null,match_id\.neq\.(.+)$/.exec(value);assert.ok(m);values.push(m[1]);where.push(`(match_id is null or match_id<>$${values.length}::uuid)`);return query;},
      order(k,o){ordering.push(identifier(k)+(o.ascending?' asc':' desc'));return query;},
      limit(n){assert.ok(Number.isInteger(n));limit=' limit '+n;return query;},maybeSingle(){single=true;return query;},
      async then(resolve,reject){try{const r=await db.query(`select ${columns} from ${table}${where.length?' where '+where.join(' and '):''}${ordering.length?' order by '+ordering.join(','):''}${limit}`,values);
        return resolve({data:single?r.rows[0]??null:r.rows,error:null});}catch(e){return reject(e);}}
    };return query;
  }
};
await import(pathToFileURL(resolve('.cache/atomic-handler.mjs')).href);
assert.equal(typeof handler,'function');
const request=()=>new Request('https://local.invalid/settle-match',{method:'POST',body:JSON.stringify({matchId:duelMatch})});
const settled=await handler(request());
assert.equal(settled.body.verdict,'win');assert.equal(settled.body.ratingWeight,0.5);
const duelHistory=(await db.query('select * from rating_history where match_id=$1 order by player_id',[duelMatch])).rows;
assert.equal(duelHistory.length,2);assert.ok(duelHistory.every(r=>Number(r.weight)===0.5));
const moves=duelHistory.map(r=>Number(r.rating_after)-Number(r.rating_before));
assert.ok(Math.abs(moves[0]+moves[1])<0.000001,'both equally rated duel participants receive symmetric provisional changes');
assert.ok(moves.some(n=>n>0)&&moves.some(n=>n<0));assert.equal(commits,1,'both sides use one commit');
const finished=await snapshot(duelMatch);
assert.equal((await handler(request())).body.alreadySettled,true);
assert.equal(commits,1);assert.deepEqual(await snapshot(duelMatch),finished);
console.log('PASS: actual settlement handler and shared helpers atomically rate both duel sides at half weight and return stored results on retry');

const {forfeitMatch,commitMatchResult,prepareChallengerRating}=globalThis.atomicShared;
const ratingStub=(before,games)=>({...before,rating:before.rating+(games[0].score===1?10:-10)});
const queueForfeit=await match();
const beforeQueue=await snapshot(queueForfeit), commitsBefore=commits;
const queueResult=await forfeitMatch(globalThis.atomicAdmin,queueForfeit,players[0],ratingStub);
assert.equal(queueResult.verdict,'loss');assert.equal(queueResult.rated,true);assert.equal(commits,commitsBefore+1);
const afterQueue=await snapshot(queueForfeit);
assert.equal(afterQueue.history.length,beforeQueue.history.length+1,'queue forfeit rates only the player who left');
assert.deepEqual(afterQueue.ratings.find(r=>r.player_id===players[1]),beforeQueue.ratings.find(r=>r.player_id===players[1]));
assert.equal((await forfeitMatch(globalThis.atomicAdmin,queueForfeit,players[0],ratingStub)).reason,'already-settled');
assert.deepEqual(await snapshot(queueForfeit),afterQueue);
const seedingForfeit=await match();
await db.query('delete from match_sides where match_id=$1 and player_id=$2',[seedingForfeit,players[1]]);
assert.equal((await forfeitMatch(globalThis.atomicAdmin,seedingForfeit,players[0],ratingStub)).reason,'seeding');
assert.equal((await snapshot(seedingForfeit)).match[0].status,'void');
const duelForfeit=await match();
await db.query(`update match_sides set rating_before=1500,rd_before=350,deltas='{0,0,0}',match_score=0,
submitted_at='2000-01-01Z' where match_id=$1 and player_id=$2`,[duelForfeit,players[1]]);
await db.query(`insert into duels(challenger_id,challenged_id,match_id,answer_match_id,status,expires_at)
values($1,$2,$3,$4,'accepted',now()+interval '1 day')`,[players[1],players[0],id,duelForfeit]);
const beforeDuelForfeit=await snapshot(duelForfeit), commitsBeforeForfeit=commits;
assert.equal((await forfeitMatch(globalThis.atomicAdmin,duelForfeit,players[0],ratingStub)).verdict,'loss');
assert.equal(commits,commitsBeforeForfeit+1);
const afterDuelForfeit=await snapshot(duelForfeit);
assert.equal(afterDuelForfeit.history.length,beforeDuelForfeit.history.length+2);
assert.equal(afterDuelForfeit.sides.find(s=>s.player_id===players[1]).result,'win');
assert.deepEqual(afterDuelForfeit.sides.find(s=>s.player_id===players[1]).submitted_at,
  beforeDuelForfeit.sides.find(s=>s.player_id===players[1]).submitted_at,'rating a challenger preserves frozen run-set identity');
for(const receipt of [null,{}, {committed:false}, {committed:false,reason:'unknown'}, {committed:false,reason:'already-played'}]){
  await assert.rejects(commitMatchResult({rpc:async()=>({data:receipt,error:null})},id,'settled',[]),e=>e.status===500);
}
const failedRead={from(){return {select(){return this;},eq(){return this;},maybeSingle:async()=>({data:null,error:{message:'planted read failure'}})};}};
await assert.rejects(prepareChallengerRating(failedRead,id,'win',1,ratingStub),/planted read failure/);
console.log('PASS: actual forfeit helper commits both duel ratings once, preserves queue opponent and run-set identity, voids seeding, and refuses missing receipts and failed reads');
await db.close();
