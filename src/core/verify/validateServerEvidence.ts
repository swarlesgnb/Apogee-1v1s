import assert from 'node:assert/strict';
import { parseStatsFile } from '../stats/parseStatsFile.ts';
import { verifyRun } from './verifyRun.ts';
import { matchServerRecord, type KovaaksScore } from './kovaaksClient.ts';
import { SERVER_TIME_SLOP_MS } from './serverEvidence.ts';

const parsed = parseStatsFile('Test - Challenge - 2026.10.01-12.01.00 Stats.csv', [
  'Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits,Accuracy,Damage Done,Damage Possible,Efficiency,Cheated,OverShots',
  '1,12:00:30.000,Bot,pistol,0.000000s,1,1,1.000000,1.000000,1.000000,1.000000,0,0',
  '', 'Weapon,Shots,Hits,Damage Done,Damage Possible', 'pistol,2,1,1.0,2.0', '',
  'Kills:,1', 'Hit Count:,1', 'Miss Count:,1', 'Score:,10', 'Scenario:,Test',
  'Hash:,ec8acdea37fa767767d705e389db1463', 'Challenge Start:,12:00:00.000', '',
].join('\n'));
assert.ok(parsed.ok);
const run = parsed.run;
const remote: KovaaksScore = { score: 10, hash: run.hash, challengeStart: run.challengeStart,
  epoch: run.playedAt!.getTime(), kills: 1, avgFps: 240, cm360: 40, resolution: null, hasModelOverrides: false };
assert.equal(verifyRun({ run, serverRecord: remote }).tier, 'verified');
assert.equal(matchServerRecord([remote], run), remote);
let cases = 2;
for (const field of ['hash', 'challengeStart'] as const) {
  for (const missing of [null, '', ' ']) {
    const local = { ...run, [field]: missing };
    const server = { ...remote, [field]: missing };
    for (const [r, s] of [[local, remote], [run, server], [local, server]] as const) {
      assert.notEqual(verifyRun({ run: r, serverRecord: s }).tier, 'verified', `${field} missing`);
      assert.equal(matchServerRecord([s], r), null);
      cases += 2;
    }
  }
}
for (const epoch of [null, NaN, Infinity, remote.epoch! - 86400000, remote.epoch! + 86400000,
  remote.epoch! + SERVER_TIME_SLOP_MS + 1]) {
  const server = { ...remote, epoch };
  assert.notEqual(verifyRun({ run, serverRecord: server }).tier, 'verified');
  assert.equal(matchServerRecord([server], run), null);
  cases += 2;
}
for (const delta of [-SERVER_TIME_SLOP_MS, 0, SERVER_TIME_SLOP_MS]) {
  assert.equal(verifyRun({ run, serverRecord: { ...remote, epoch: remote.epoch! + delta } }).tier, 'verified');
  cases++;
}
for (const playedAt of [null, new Date(NaN)]) {
  assert.notEqual(verifyRun({ run: { ...run, playedAt }, serverRecord: remote }).tier, 'verified');
  const missingTime = verifyRun({ run: { ...run, playedAt }, serverRecord: remote,
    consistency: { window: { start: new Date(remote.epoch! - 1000), end: new Date(remote.epoch! + 1000) } } });
  assert.equal(missingTime.tier, 'rejected', 'removing a filename timestamp cannot skip the match window');
  assert.ok(missingTime.report.checks.some(c => c.id === 'in_match_window' && c.status === 'fail'));
  cases += 3;
}
const window = { start: new Date(remote.epoch! - 1000), end: new Date(remote.epoch! + 1000) };
assert.equal(verifyRun({ run, serverRecord: remote, consistency: { window } }).tier, 'verified');
assert.notEqual(verifyRun({ run, serverRecord: { ...remote, epoch: remote.epoch! - 2000 }, consistency: { window } }).tier, 'verified');
assert.equal(verifyRun({ run, serverRecord: null }).tier, 'consistent', 'missing remote data does not reject honest runs');
const old = { ...remote, epoch: remote.epoch! - 86400000 };
assert.equal(matchServerRecord([old, remote], run), remote, 'skip same-time-of-day replay and find the real record');
const mismatch = { ...remote, challengeStart: '12:00:01.000' };
assert.equal(matchServerRecord([mismatch], run), null, 'matching score alone is insufficient');
cases += 5;
console.log(`OK: ${cases} server evidence assertions, including positive controls and stale-record attacks`);
