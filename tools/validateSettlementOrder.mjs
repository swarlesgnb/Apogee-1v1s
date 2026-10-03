import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
mkdirSync('.cache', { recursive: true });
const mocks = `
export class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
export const handler=fn=>req=>fn(req,globalThis.settlementFixture.admin);
export const requireCaller=async()=>({playerId:'owner'});
export const readJson=req=>req.json();
export const json=(body,status=200)=>({body,status});
export const isCopiedSide=()=>false;
export const enforceRateLimit=async()=>{};
export const afterLegSettled=async()=>null;
export const baselineFor=async()=>{throw new Error('Unexpected baseline calculation');};
export const prepareChallengerRating=async()=>{throw new Error('Unexpected rating calculation');};
export const commitMatchResult=async(_admin,matchId,status,sides,ratings=[])=>{
globalThis.settlementFixture.commits.push({matchId,status,sides,ratings});return {committed:true};};
export const settleShadowMatch=async()=>null;
export const markShadowVoid=async()=>{};
export const shadowResultFor=async()=>null;
export const prepareFlagAnswer=async()=>{throw new Error('Unexpected flag rating');};
export const commitFlagAnswer=async()=>{throw new Error('Unexpected flag commit');};
`;
await build({entryPoints:['supabase/functions/settle-match/index.ts'],outfile:'.cache/settlement-order.mjs',bundle:true,platform:'node',format:'esm',
  plugins:[{name:'isolated-boundaries',setup(b){
    b.onResolve({filter:/\/\_shared\/(apogee|rateLimit|tournament|queue)\.ts$/},()=>({path:'mock',namespace:'test'}));
    b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:mocks}));
  }}]});
let handle;
globalThis.Deno={serve:fn=>{handle=fn;}};
await import(pathToFileURL(resolve('.cache/settlement-order.mjs')).href);
assert.equal(typeof handle,'function');
const fixture={writes:[],commits:[],orders:[],runs:[],admin:{from(table){
  const order=[]; let writing=false;
  const query={select(){return query;},eq(){return query;},in(){return query;},
    order(key,options){order.push([key,options.ascending]);return query;},
    update(row){writing=true;fixture.writes.push([table,row]);return query;},
    async maybeSingle(){return {data:{id:'match',status:'open',scenario_ids:[1,2,3],rated:true}};},
    then(resolve){
      let data=[];
      if(!writing&&table==='match_sides')data=[{player_id:'owner'}];
      if(!writing&&table==='scenarios')data=[{id:1,duration_seconds:60},{id:2,duration_seconds:60},{id:3,duration_seconds:60}];
      if(!writing&&table==='runs'){
        fixture.orders.push(order);
        data=[...fixture.runs].sort((a,b)=>{for(const [key,ascending] of order){const c=String(a[key]).localeCompare(String(b[key]));if(c)return ascending?c:-c;}return 0;});
      }
      return Promise.resolve({data,error:null}).then(resolve);
    }};
  return query;
}}};
globalThis.settlementFixture=fixture;
const first={id:'a',scenario_id:1,scenario_name:'Test',verification_tier:'consistent',score:100,
  played_at:'2026-10-01T12:03:00Z',match_submitted_at:'2026-10-01T12:03:01Z',duration_seconds:60};
const later={...first,id:'b',played_at:'2026-10-01T12:01:00Z',match_submitted_at:'2026-10-01T12:04:00Z',duration_seconds:3};
fixture.runs=[later,first];
const request=()=>new Request('https://local.invalid/settle-match',{method:'POST',body:JSON.stringify({matchId:'match'})});
const result=await handle(request());
assert.equal(result.status,409,'backdating a later abandoned run cannot replace the first completed attempt');
assert.equal(result.body.submitted,1);
assert.equal(fixture.writes.length,0,'uncompleted match has no settlement writes');
assert.deepEqual(fixture.orders[0],[['match_submitted_at',true],['id',true]]);
fixture.runs=[{...first,duration_seconds:3},{...later,duration_seconds:60}];
const abandoned=await handle(request());
assert.equal(abandoned.body.verdict,'void','a genuine first abandoned attempt still voids');
assert.equal(fixture.writes.length,0,'no partial table writes');
assert.equal(fixture.commits.length,1);
assert.equal(fixture.commits[0].status,'void');
assert.deepEqual(fixture.commits[0].ratings,[]);
console.log('OK: shipped settle-match uses server receipt order, with both completion and abandonment controls');
