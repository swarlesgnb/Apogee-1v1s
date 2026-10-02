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
    b.onResolve({ filter: /\/\_shared\/(apogee|rateLimit)\.ts$/ }, () => ({ path: 'mock', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: mock, loader: 'js' }));
  } }] });
let handle;
globalThis.Deno = { serve: fn => { handle = fn; } };
await import(pathToFileURL(resolve('.cache/submit-run-test.mjs')).href);
assert.equal(typeof handle, 'function', 'the real handler registered');
const valid = { filename: 'Test - Challenge - 2026.10.01-12.01.00 Stats.csv',
  csv: 'Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits,Accuracy,Damage Done,Damage Possible,Efficiency,Cheated,OverShots\n\nScenario:,Test\nScore:,10\nKills:,1\nHit Count:,1\nMiss Count:,1\nHash:,abc\nChallenge Start:,12:00:00.000\n',
  matchId: 'match', tzOffsetMinutes: 0 };
function reset() {
  const fixture = { scenario: { id: 1, name: 'Test' }, copied: false, rows: [], deadlines: [],
    match: { id: 'match', status: 'open', scenario_ids: [1], created_at: '2026-10-01T12:00:00Z', expires_at: '2026-10-01T12:05:00Z' },
    side: { player_id: 'owner', submitted_at: null } };
  fixture.admin = { from(table) {
    let mutation;
    const query = { select() { return query; }, eq() { return query; }, is() { return query; },
      insert(row) { mutation = row; fixture.rows.push(row); return query; },
      update(row) { mutation = row; fixture.deadlines.push(row); return query; },
      async maybeSingle() { return { data: table === 'matches' ? fixture.match : table === 'match_sides' ? fixture.side : { id: 'run' }, error: null }; },
      then(resolve) { return Promise.resolve({ data: mutation, error: null }).then(resolve); } };
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
f = reset();
const accepted = await submit(valid);
assert.equal(accepted.body.verificationTier, 'consistent');
assert.equal(accepted.body.counted, true);
assert.equal(f.rows.length, 1);
assert.equal(f.rows[0].player_id, 'owner');
assert.equal(f.rows[0].played_at, '2026-10-01T12:01:00.000Z');
cases++;
f = reset();
const timeless = await submit({ ...valid, filename: 'Test Stats.csv' });
assert.equal(timeless.body.verificationTier, 'rejected');
assert.equal(timeless.body.counted, false);
assert.ok(f.rows[0].verification_notes.hardFailures.some(s => s.includes('in_match_window')));
assert.equal(f.deadlines.length, 0, 'missing timestamp cannot reset a ranked deadline to receipt time');
cases++;
f = reset();
const future = await submit({ ...valid, filename: 'Test - Challenge - 2099.10.01-12.01.00 Stats.csv' });
assert.equal(future.body.counted, false);
assert.equal(f.deadlines.length, 0, 'out-of-window timestamp cannot push deadline into the future');
cases++;
console.log(`OK: ${cases} shipped submit-run handler cases with isolated auth/database boundaries`);
