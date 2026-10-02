import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
const db = new PGlite();
await db.waitReady;
await db.exec(`create schema auth;
create table auth.users(id uuid primary key default gen_random_uuid());
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.player_id',true),'')::uuid$$;
create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
grant usage on schema public to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
const migration = '20261002000021_ranked_run_claims.sql';
for (const file of readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && f < migration).sort()) {
  await db.exec(readFileSync('supabase/migrations/' + file, 'utf8'));
}
await db.exec(readFileSync('supabase/seed.sql', 'utf8'));
const player = (await db.query('insert into auth.users default values returning id')).rows[0].id;
await db.query('insert into players(id,steam_id,display_name) values ($1,$2,$3)', [player, '76561000000000001', 'Replay test']);
const scenario = (await db.query('select id,name from scenarios order by id limit 1')).rows[0];
const match = async seed => (await db.query(`insert into matches(category,status,benchmark_name,difficulty,seed,scenario_ids)
 values ('Clicking','awaiting_runs','Voltaic S5','Intermediate',$1,$2::bigint[]) returning id`, [seed, [scenario.id, scenario.id, scenario.id]])).rows[0].id;
const firstMatch = await match('first'), secondMatch = await match('second');
const instant = '2026-10-01T12:01:00Z';
const insert = async (digest, at = instant, matchId = firstMatch, created = '2026-10-01T12:01:01Z') =>
  (await db.query(`insert into runs(player_id,scenario_name,score,played_at,challenge_start,csv_sha256,match_id,verification_tier,created_at)
   values ($1,$2,10,$3,'12:00:00.000',$4,$5,'consistent',$6) returning *`, [player, scenario.name, at, digest, matchId, created])).rows[0];

// Positive reproduction on the schema before the fix: different byte hashes replay.
await insert('original-bytes');
await insert('whitespace-edited-bytes', instant, secondMatch);
assert.equal((await db.query('select count(*)::int as n from runs')).rows[0].n, 2);
console.log('REPRODUCED: pre-migration schema accepts two byte hashes for the same run in different matches');
await db.exec(readFileSync('supabase/migrations/' + migration, 'utf8'));
assert.equal((await db.query('select count(*)::int as n from runs')).rows[0].n, 2, 'migration preserves historical duplicates');
assert.equal((await db.query('select count(*)::int as n from ranked_run_claims')).rows[0].n, 1);
await assert.rejects(insert('third-byte-hash'), e => e.code === '23505');

const fresh = await insert('new-real-run', '2026-10-01T12:02:00Z');
assert.ok(fresh.match_submitted_at, 'ranked receipt is server-stamped');
assert.ok(new Date(fresh.match_submitted_at).getTime() > new Date(fresh.created_at).getTime(), 'receipt is not the backdated creation time');
await assert.rejects(insert('replay-new-real-run', '2026-10-01T12:02:00Z', secondMatch), e => e.code === '23505');
await assert.rejects(db.query('update runs set match_id=$1 where id=$2', [secondMatch, fresh.id]), e => e.code === '23505');
await db.query("update runs set match_submitted_at='2000-01-01Z' where id=$1", [fresh.id]);
assert.equal(String((await db.query('select match_submitted_at from runs where id=$1', [fresh.id])).rows[0].match_submitted_at), String(fresh.match_submitted_at), 'later updates cannot reorder the receipt');

const history = await insert('history-to-claim', '2026-10-01T12:03:00Z', null, '2000-01-01Z');
assert.equal(history.match_submitted_at, null);
const claimed = (await db.query('update runs set match_id=$1 where id=$2 returning match_submitted_at', [firstMatch, history.id])).rows[0];
assert.ok(new Date(claimed.match_submitted_at).getTime() >= new Date(fresh.match_submitted_at).getTime(), 'claim receipt is later than the first live submission');
const ordered = (await db.query('select id from runs where id=any($1::uuid[]) order by match_submitted_at,id', [[history.id, fresh.id]])).rows;
assert.equal(ordered[0].id, fresh.id, 'old history cannot steal first-attempt priority');
await db.query('delete from runs where id=$1', [fresh.id]);
await assert.rejects(insert('replay-after-delete', '2026-10-01T12:02:00Z', secondMatch), e => e.code === '23505');

await db.exec('set role authenticated');
await db.query("select set_config('test.player_id',$1,false)", [player]);
for (const sql of ['select * from ranked_run_claims', 'delete from ranked_run_claims',
  'select match_submitted_at from runs', "insert into runs(player_id,scenario_name,score,played_at,csv_sha256,match_submitted_at) values ('" + player + "','x',1,now(),'spoof-receipt',now())"]) {
  await assert.rejects(db.exec(sql), e => e.code === '42501', 'clients cannot read or write protected claim/receipt state');
}
await db.exec('reset role');
assert.equal((await db.query('select count(*)::int as n from ranked_run_claims')).rows[0].n, 3, 'blocked attempts did not alter claims');
await db.close();
console.log('OK: replay refusal, legacy evidence preservation, receipt ordering, history claim, tombstones and column privileges');
