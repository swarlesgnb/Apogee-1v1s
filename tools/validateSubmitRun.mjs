/** Exercise the shipped Edge handler with isolated database and identity fixtures. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
mkdirSync('.cache', { recursive: true });
const mock = `
export class HttpError extends Error { constructor(status,message){super(message);this.status=status;} }
export const handler = fn => req => fn(req,globalThis.fixture.admin);
export const requireCaller = async () => ({playerId:'owner',kovaaksUsername:null});
export const readJson = req => req.json();
export const scenarioByName = async () => globalThis.fixture.scenario;
export const isCopiedSide = () => globalThis.fixture.copied;
export const refreshBaseline = async () => {};
export const deadlineAfterRun = date => new Date(date.getTime()+300000);
export const json = (body,status=200) => ({body,status});
export const enforceRateLimit = async () => {};
`;
await build({ entryPoints: ['supabase/functions/submit-run/index.ts'], outfile: '.cache/submit-run-test.mjs',
  bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'isolated-boundaries', setup(b) {
    // `_shared/timeIntegrity.ts` reaches apogee.ts as "./apogee.ts", so both spellings.
    b.onResolve({ filter: /(\/\_shared\/|^\.\/)(apogee|rateLimit)\.ts$/ }, () => ({ path: 'mock', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: mock, loader: 'js' }));
  } }] });
let handle;
globalThis.Deno = { serve: fn => { handle = fn; } };
await import(pathToFileURL(resolve('.cache/submit-run-test.mjs')).href);
assert.equal(typeof handle, 'function', 'the real handler registered');
// Relative to now: a ranked run has to reach the server within its match's deadline
// (src/core/verify/timeIntegrity.ts), so a fixed date would read as a very late one.
const NOW = Date.now();
const pad = n => String(n).padStart(2, '0');
const stamp = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}-${pad(d.getUTCHours())}.${pad(d.getUTCMinutes())}.${pad(d.getUTCSeconds())}`; };
const ended = Math.floor((NOW - 60_000) / 1000) * 1000;
const startedClock = new Date(ended - 60_000).toISOString().slice(11, 23);
const valid = { filename: `Test - Challenge - ${stamp(ended)} Stats.csv`,
  csv: `Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits,Accuracy,Damage Done,Damage Possible,Efficiency,Cheated,OverShots\n\nScenario:,Test\nScore:,10\nKills:,1\nHit Count:,1\nMiss Count:,1\nHash:,abc\nChallenge Start:,${startedClock}\n`,
  matchId: 'match', tzOffsetMinutes: 0 };
function reset() {
  const fixture = { scenario: { id: 1, name: 'Test' }, copied: false, rows: [], deadlines: [], clocks: [],
    match: { id: 'match', status: 'open', scenario_ids: [1], created_at: new Date(NOW - 120_000).toISOString(), expires_at: new Date(NOW + 180_000).toISOString() },
    side: { player_id: 'owner', submitted_at: null, tz_offset_minutes: null, tz_declared_at: null } };
  fixture.admin = { from(table) {
    let mutation, operation = 'select';
    const query = { select() { return query; }, eq() { return query; }, is() { return query; }, neq() { return query; },
      not() { return query; }, gte() { return query; }, lte() { return query; }, or() { return query; },
      order() { return query; }, limit() { return query; },
      insert(row) { operation = 'insert'; mutation = row; fixture.rows.push(row); return query; },
      update(row) {
        operation = 'update'; mutation = row;
        if (table === 'matches') fixture.deadlines.push(row);
        if (table === 'match_sides') fixture.clocks.push(row);
        return query;
      },
      async maybeSingle() {
        if (table === 'runs') {
          // No earlier upload of this performance; the write itself may be planted to fail.
          if (operation === 'select') return { data: null, error: null };
          const error = operation === 'insert' ? fixture.insertError : fixture.claimError;
          return { data: error ? null : { id: 'run' }, error: error ?? null };
        }
        if (table === 'match_sides' && operation === 'update') return { data: { ...fixture.side, ...mutation }, error: null };
        return { data: table === 'matches' ? fixture.match : table === 'match_sides' ? fixture.side : null, error: null };
      },
      // A list read (the clock's recent readings) finds nothing; a write echoes itself.
      then(resolve) { return Promise.resolve({ data: operation === 'select' ? [] : mutation, error: null }).then(resolve); } };
    return query;
  } };
  globalThis.fixture = fixture;
  return fixture;
}
const submit = body => handle(new Request('https://local.invalid/submit-run', { method: 'POST', body: JSON.stringify(body) }));
let cases = 0;
async function refused(label, body, status = 400) {
  await assert.rejects(submit(body), e => e.status === status, label);
  assert.equal(globalThis.fixture.rows.length, 0, `${label}: no run inserted`);
  assert.equal(globalThis.fixture.deadlines.length, 0, `${label}: no deadline changed`);
  cases++;
}
for (const body of [null, { ...valid, csv: 123 }, { ...valid, filename: [] },
  { ...valid, tzOffsetMinutes: 99999 }, { ...valid, tzOffsetMinutes: 0.5 }, { ...valid, tzOffsetMinutes: '0' }]) {
  reset(); await refused('malformed input', body);
}
let f = reset(); f.scenario = null; await refused('unknown scenario cannot enter a ranked match', valid);
f = reset(); f.scenario.id = 2; await refused('scenario outside the match', valid);
f = reset(); f.side = null; await refused('nonparticipant', valid, 403);
f = reset(); f.copied = true; await refused('copied opponent side', valid, 403);
f = reset(); f.match.status = 'settled'; await refused('settled match', valid, 409);
f = reset(); await refused('a ranked run that names no UTC offset', { ...valid, tzOffsetMinutes: undefined });
f = reset(); f.side.tz_offset_minutes = 300; f.side.tz_declared_at = f.match.created_at;
await refused('a ranked run on a different clock from its match', valid, 409);
f = reset(); f.match.expires_at = new Date(NOW - 20 * 60_000).toISOString();
await refused('a ranked run reaching the server long after the deadline', valid, 409);
f = reset();
const accepted = await submit(valid);
assert.equal(accepted.body.verificationTier, 'consistent');
assert.equal(accepted.body.counted, true);
assert.equal(f.rows.length, 1);
assert.equal(f.rows[0].player_id, 'owner');
assert.equal(f.rows[0].played_at, new Date(ended).toISOString());
assert.equal(f.rows[0].tz_offset_minutes, 0, 'the offset the run was read with is stored');
assert.equal(f.clocks[0]?.tz_offset_minutes, 0, 'an unpinned match takes the clock of its first ranked run');
cases++;
f = reset();
const timeless = await submit({ ...valid, filename: 'Test Stats.csv' });
assert.equal(timeless.body.verificationTier, 'rejected');
assert.equal(timeless.body.counted, false);
assert.ok(f.rows[0].verification_notes.hardFailures.some(s => s.includes('in_match_window')));
assert.equal(f.deadlines.length, 0, 'missing timestamp cannot reset a ranked deadline to receipt time');
cases++;
// A far-future timestamp used to be stored as an out-of-window rejection. It is refused
// outright now (nothing from the future), and still cannot push the deadline.
f = reset();
await refused('out-of-window future timestamp cannot push deadline into the future',
  { ...valid, filename: 'Test - Challenge - 2099.10.01-12.01.00 Stats.csv' }, 422);
for(const claim of [false,true]){
  f=reset();
  f.insertError=claim?{code:'23505',message:'history exists'}:{code:'55000',message:'match finished'};
  if(claim) f.claimError={code:'55000',message:'match finished'};
  await assert.rejects(submit(valid),e=>e.status===409 && e.message==='match is already finished');
  assert.equal(f.deadlines.length,0,'a terminal match race does not extend its deadline');
  cases++;
}
console.log(`OK: ${cases} shipped submit-run handler cases with isolated auth/database boundaries`);
