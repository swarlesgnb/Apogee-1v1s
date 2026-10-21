import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloudHistoryStore, downloadCloudHistory } from "../src/app/cloudHistory.ts";
import { historyWithCloud, setCloudHistory, validCloudRuns, type CloudRun } from "../src/core/history/cloudHistory.ts";
import { readStatsFolder } from "../src/core/stats/folderCache.ts";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
mkdirSync('.cache', {recursive: true});
const directory = mkdtempSync(join('.cache', "apogee-cloud-history-"));
const store = new CloudHistoryStore(directory);
const row = (i: number): CloudRun => ({id: i.toString().padStart(8, '0'), scenario_name: 'A scenario',
  score: 100 + i, played_at: '2026-01-20T15:42:07Z', csv_sha256: i.toString(16).padStart(64, '0')});
const rows = Array.from({length: 2107}, (_, i) => row(i + 1));
store.save(a, rows);
assert.equal(store.load(a).length, 2107);
assert.deepEqual(store.load(b), []);
console.log('PASS history cache is scoped to the Steam-linked player');
writeFileSync(join(directory, b + '.json'), JSON.stringify({version: 1, playerId: a, runs: rows}));
assert.deepEqual(store.load(b), []);
writeFileSync(join(directory, b + '.json'), '{');
assert.deepEqual(store.load(b), []);
assert.throws(() => store.save('../escape', rows));
assert.equal(validCloudRuns([{...row(1), score: null}]), false);
assert.equal(validCloudRuns([{...row(1), played_at: 'not a date'}]), false);
console.log('PASS corrupt, foreign and invalid cache data is refused');
setCloudHistory([rows[0], rows[1], rows[1]]);
const local = [{file: 'actual-Stats.csv', run: {scenario: 'A scenario', score: rows[0].score,
  playedAt: new Date(rows[0].played_at), challengeStart: null, coherent: true, csvSha256: rows[0].csv_sha256}}];
const combined = historyWithCloud(local);
assert.equal(combined.length, 2);
assert.equal(combined[0].coherent, true);
assert.equal(combined[1].coherent, false);
assert.deepEqual(readStatsFolder(directory), []);
setCloudHistory([]);
assert.equal(historyWithCloud(local).length, 1);
console.log('PASS CSV hashes prevent double-counting; cloud runs never enter the file reader; sign-out clears history');
let pages = 0;
const fake = {from() {
  let cursor = ''; let player = ''; let size = 0;
  const query = {
    select() {return query;}, eq(_key: string, value: string) {player = value; return query;},
    lte() {return query;}, order() {return query;}, limit(n: number) {size = n; return query;},
    gt(_key: string, value: string) {cursor = value; return query;},
    then(resolve: (value: unknown) => void) {
      assert.equal(player, a); pages++;
      resolve({data: rows.filter(r => r.csv_sha256 > cursor).slice(0, size), error: null});
    },
  }; return query;
}};
const downloaded = await downloadCloudHistory(fake as never, a);
assert.deepEqual(downloaded, rows);
assert.equal(pages, 4);
store.save(a, downloaded);
assert.equal(store.load(a).length, 2107);
console.log('PASS all 2,107 runs survive pagination and cache reload, beyond the server row limit');
const failing = {from() {const q = {select(){return q;},eq(){return q;},lte(){return q;},order(){return q;},limit(){return q;},then(resolve: (value: unknown) => void){resolve({data:null,error:{message:'offline'}});}};return q;}};
await assert.rejects(downloadCloudHistory(failing as never, a), /offline/);
assert.equal(store.load(a).length, 2107);
console.log('PASS a failed download leaves the last complete history cache intact');
