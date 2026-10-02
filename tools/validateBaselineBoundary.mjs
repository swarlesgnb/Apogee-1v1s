/** Run the shipped baseline query through a small PostgREST adapter into Postgres. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
mkdirSync('.cache', { recursive: true });
await build({ entryPoints: ['supabase/functions/_shared/apogee.ts'], outfile: '.cache/baseline-test.mjs',
  bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'no-network', setup(b) {
    b.onResolve({ filter: /^jsr:/ }, () => ({ path: 'client', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: "export function createClient(){throw new Error('Network is not part of this test')}" }));
  } }] });
globalThis.Deno = { env: { get: () => '' } };
const { baselineFor } = await import(pathToFileURL(resolve('.cache/baseline-test.mjs')).href);
const db = new PGlite();
await db.exec(`create table runs(player_id text,scenario_id int,score numeric,verification_tier text,
played_at timestamptz,created_at timestamptz,match_id text);
create table verified_pbs(player_id text,scenario_id int,score numeric);
insert into runs select 'owner',1,100,'consistent','2026-10-01 10:00Z'::timestamptz + n * interval '1 minute',
'2026-10-01 11:00Z',null from generate_series(1,5) n;
insert into runs select 'owner',1,1,'unverified','2026-10-01 11:00Z'::timestamptz + n * interval '1 second',
'2026-10-01 13:00Z',null from generate_series(1,50) n;`);
const seen = [];
const identifier = name => { assert.match(name, /^[a-z_]+$/); return name; };
const admin = { from(table) {
  identifier(table);
  const values = [], clauses = [], order = [];
  let columns = '*', limit = '', single = false;
  const filter = (column, op, value) => { values.push(value); clauses.push(`${identifier(column)} ${op} $${values.length}`); return query; };
  const query = {
    select(value) { columns = identifier(value); return query; },
    eq(column, value) { return filter(column, '=', value); },
    neq(column, value) { return filter(column, '<>', value); },
    lt(column, value) { return filter(column, '<', value); },
    or(value) { const match = /^match_id\.is\.null,match_id\.neq\.(.+)$/.exec(value); assert.ok(match); values.push(match[1]); clauses.push(`(match_id is null or match_id <> $${values.length})`); return query; },
    order(column, options) { order.push(identifier(column) + (options.ascending ? ' asc' : ' desc')); return query; },
    limit(n) { assert.ok(Number.isInteger(n)); limit = ` limit ${n}`; return query; },
    maybeSingle() { single = true; return query; },
    async then(resolve, reject) {
      try {
        const sql = `select ${columns} from ${table} where ${clauses.join(' and ')}${order.length ? ' order by ' + order.join(',') : ''}${limit}`;
        seen.push(sql);
        const result = await db.query(sql, values);
        return resolve({ data: single ? result.rows[0] ?? null : result.rows, error: null });
      } catch (error) { return reject(error); }
    },
  };
  return query;
} };
const rule = (_name, scores) => ({ scores });
const frozen = await baselineFor(admin, 'owner', 1, 'Test', rule, { at: '2026-10-01T12:00:00Z', matchId: 'current' });
assert.deepEqual(frozen.scores, [100,100,100,100,100], 'backdated uploads received after the match cannot lower its baseline');
const current = await baselineFor(admin, 'owner', 1, 'Test', rule);
assert.equal(current.scores.length, 55, 'ordinary history refresh still includes all uploaded history');
assert.equal(current.scores.filter(n => n === 1).length, 50, 'the malicious rows actually exist');
assert.ok(seen.some(sql => sql.includes('played_at <') && sql.includes('created_at <')));
await db.close();
console.log('OK: shipped baseline query excludes 50 late backdated rows while retaining five legitimate prior runs');
