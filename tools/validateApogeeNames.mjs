import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { migratedDatabase } from './lib/postgrestOverPglite.mjs';

const {db} = await migratedDatabase(PGlite, readFileSync, readdirSync);
await db.exec(readFileSync('supabase/migrations/20261020000001_apogee_names.sql', 'utf8'));
console.log('PASS migration can be reapplied after a manual SQL-editor deployment');
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
await db.query('insert into auth.users (id,email) values ($1,$2),($3,$4)', [a,'a@example.invalid',b,'b@example.invalid']);
await db.query('insert into players (id,steam_id,display_name) values ($1,$2,$3),($4,$5,$6)', [a,'76561198000000001','Player 000001',b,'76561198000000002','Other player']);
await db.query("select set_config('test.player_id', $1, false)", [a]);
await db.exec('set role authenticated');
assert.equal((await db.query('select public.set_apogee_name($1) as name', ['  Apogee Pilot  '])).rows[0].name, 'Apogee Pilot');
for (const value of ['', ' ', 'x', 'x'.repeat(33), 'line\nbreak', null]) {
  await assert.rejects(db.query('select public.set_apogee_name($1)', [value]), e => e.code === '22023');
}
await assert.rejects(db.query("update players set steam_id = '76561198000000003' where id = $1", [a]), e => e.code === '42501');
console.log('PASS an authenticated player can change only their name; invalid names and direct profile writes are rejected');
await db.exec('reset role');
const profiles = (await db.query('select id,steam_id,display_name,apogee_name from players order by id')).rows;
assert.equal(profiles[0].display_name, 'Apogee Pilot');
assert.equal(profiles[0].steam_id, '76561198000000001');
assert.equal(profiles[1].display_name, 'Other player');
await db.query('update players set display_name = $1, last_seen_at = now() where id = $2', ['Player 000001', a]);
assert.equal((await db.query('select display_name from players where id=$1', [a])).rows[0].display_name, 'Apogee Pilot');
console.log('PASS another player is unchanged, Steam identity is unchanged, and later Steam fallback names cannot overwrite the chosen name');
await db.exec('set role anon');
await assert.rejects(db.query('select public.set_apogee_name($1)', ['Anonymous']), e => e.code === '42501');
await db.exec('reset role');
await db.query("select set_config('test.player_id', '', false)");
await db.exec('set role authenticated');
await assert.rejects(db.query('select public.set_apogee_name($1)', ['No identity']), e => e.code === '28000');
await db.exec('reset role');
await db.close();
console.log('PASS anonymous calls and calls without a player identity cannot edit any profile');
