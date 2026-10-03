/**
 * Drive the shipped social Edge handlers (daily-submit, daily-board, open-duel) against a
 * real Postgres, plus settle-match and list-duels where open challenges reach them.
 *
 *   npm run validate:social-functions
 *
 * Postgres is PGlite with every migration and the seed applied, and the Season 1 pool
 * pushed the way `npm run push:season` writes it. The handlers are bundled from source with
 * esbuild; only the caller's identity, the transport (`handler`, `json`) and the network
 * client are replaced. Everything else is the real code: the shared helpers in apogee.ts
 * and _shared/social.ts, the rate limiter calling the real consume_rate_limit, the
 * migration's constraints and trigger, and src/core. The database client below speaks the
 * subset of PostgREST these handlers use, as SQL, so every filter and write is a real one.
 *
 * Stats files are written by the shared synthetic fixture (tools/fixtures/syntheticStats.ts),
 * which grades Consistent through verifyRun.
 */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

process.env.TZ = 'UTC';
mkdirSync('.cache', { recursive: true });

// ---- the database --------------------------------------------------------------------
const db = new PGlite();
await db.waitReady;
await db.exec(`create schema auth;create table auth.users(id uuid primary key default gen_random_uuid());
create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
grant usage on schema public to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
for (const f of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync('supabase/migrations/' + f, 'utf8'));
await db.exec(readFileSync('supabase/seed.sql', 'utf8'));

const season = JSON.parse(readFileSync('data/seasons/season-1.json', 'utf8'));
for (const s of season.scenarios) await db.query('insert into scenarios(name) values($1) on conflict (name) do nothing', [s.scenario]);
const seasonId = (await db.query(`insert into seasons(name,status,rank_names,windows,window_size) values($1,'draft',$2,$3,$4) returning id`,
  [season.name, season.rankNames, season.windows, season.windowSize])).rows[0].id;
for (const s of season.scenarios) {
  await db.query(`insert into season_scenarios(season_id,scenario_id,category,rank_maxes,family,window_index)
    select $1,id,$2,$3,$4,$5 from scenarios where name=$6`, [seasonId, s.category, s.rankMaxes, s.family ?? null, s.window ?? null, s.scenario]);
}

const players = {};
for (const name of ['ana', 'ben', 'cal', 'dee']) {
  const id = (await db.query('insert into auth.users default values returning id')).rows[0].id;
  await db.query('insert into players(id,steam_id,display_name) values($1,$2,$3)', [id, '7656119' + String(Object.keys(players).length).padStart(10, '0'), name.toUpperCase()]);
  players[name] = id;
}

// ---- a PostgREST-shaped client over PGlite ---------------------------------------------
const ident = (v) => { assert.match(v, /^[a-z_][a-z0-9_]*$/, `identifier ${v}`); return v; };
const norm = (v) => v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : Array.isArray(v) ? v.map(norm)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
const param = (v) => (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) ? JSON.stringify(v) : v;
function splitTop(list) {
  const out = []; let depth = 0, cur = '';
  for (const ch of list) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const singular = (t) => t.replace(/es$/, '').replace(/s$/, '');
function makeAdmin() {
  return {
    from(table) { return new Query(ident(table)); },
    async rpc(name, args) {
      const keys = Object.keys(args);
      try {
        const r = await db.query(`select ${ident(name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(',')}) as r`, keys.map((k) => param(args[k])));
        return { data: norm(r.rows[0].r), error: null };
      } catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
    },
  };
}
class Query {
  constructor(table) { Object.assign(this, { table, op: 'select', cols: '*', where: [], values: [], ordering: [], lim: '', single: false, head: false, count: false, payload: null, returning: null, opts: {} }); }
  select(cols = '*', opts = {}) {
    if (this.op === 'select') { this.cols = cols; this.head = !!opts.head; this.count = opts.count === 'exact'; } else this.returning = cols;
    return this;
  }
  col(c) {
    if (c.includes('.')) { const [t, k] = c.split('.'); return `e_${ident(t)}.${ident(k)}`; }
    return `t.${ident(c)}`;
  }
  push(v) { this.values.push(param(v)); return `$${this.values.length}`; }
  cond(c, op, v) { this.where.push(`${this.col(c)} ${op} ${this.push(v)}`); return this; }
  eq(c, v) { return this.cond(c, '=', v); }
  neq(c, v) { return this.cond(c, '<>', v); }
  lt(c, v) { return this.cond(c, '<', v); }
  lte(c, v) { return this.cond(c, '<=', v); }
  gt(c, v) { return this.cond(c, '>', v); }
  gte(c, v) { return this.cond(c, '>=', v); }
  // As text: PGlite cannot serialise an array parameter for an enum or uuid column it has not typed.
  in(c, v) { this.where.push(`${this.col(c)}::text = any(${this.push(v.map(String))}::text[])`); return this; }
  is(c, v) { assert.ok(v === null || v === true || v === false); this.where.push(`${this.col(c)} is ${v === null ? 'null' : v}`); return this; }
  not(c, op, v) { assert.equal(op, 'is'); assert.equal(v, null); this.where.push(`${this.col(c)} is not null`); return this; }
  or(expr) {
    const parts = expr.split(',').map((p) => {
      const m = /^([a-z_]+)\.(eq|neq|is)\.(.+)$/.exec(p);
      assert.ok(m, `or() clause ${p}`);
      if (m[2] === 'is') { assert.equal(m[3], 'null'); return `${this.col(m[1])} is null`; }
      return `${this.col(m[1])} ${m[2] === 'eq' ? '=' : '<>'} ${this.push(m[3])}`;
    });
    this.where.push(`(${parts.join(' or ')})`);
    return this;
  }
  order(c, o = {}) { this.ordering.push(`${this.col(c)} ${o.ascending === false ? 'desc' : 'asc'}`); return this; }
  limit(n) { assert.ok(Number.isInteger(n)); this.lim = ` limit ${n}`; return this; }
  maybeSingle() { this.single = true; return this; }
  single() { this.single = true; return this; }
  insert(rows, opts = {}) { this.op = 'insert'; this.payload = rows; this.opts = opts; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  projection(cols) {
    const joins = [];
    const items = splitTop(cols).map((item) => {
      const m = /^([a-z_]+)!inner\((.*)\)$/.exec(item);
      if (!m) return item === '*' ? 't.*' : `t.${ident(item)}`;
      const t = ident(m[1]);
      joins.push(`join ${t} e_${t} on e_${t}.id = t.${singular(t)}_id`);
      return `json_build_object(${splitTop(m[2]).map((k) => `'${ident(k)}', e_${t}.${ident(k)}`).join(',')}) as ${t}`;
    });
    return { list: items.join(','), joins: joins.join(' ') };
  }
  async run() {
    const whereSql = this.where.length ? ' where ' + this.where.join(' and ') : '';
    if (this.op === 'select') {
      const p = this.projection(this.cols);
      if (this.head) {
        const r = await db.query(`select count(*)::int as n from ${this.table} t ${p.joins}${whereSql}`, this.values);
        return { data: null, count: r.rows[0].n, error: null };
      }
      const r = await db.query(`select ${p.list} from ${this.table} t ${p.joins}${whereSql}${this.ordering.length ? ' order by ' + this.ordering.join(',') : ''}${this.lim}`, this.values);
      const rows = norm(r.rows);
      return { data: this.single ? rows[0] ?? null : rows, error: null };
    }
    const ret = this.returning ? ' returning ' + this.projection(this.returning).list.replaceAll('t.', '') : '';
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      const out = [];
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => row[k] !== undefined);
        const vals = keys.map((k) => param(row[k]));
        const r = await db.query(`insert into ${this.table} (${keys.map(ident).join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})${ret}`, vals);
        out.push(...r.rows);
      }
      const rowsOut = norm(out);
      return { data: this.returning ? (this.single ? rowsOut[0] ?? null : rowsOut) : null, error: null };
    }
    if (this.op === 'update') {
      const keys = Object.keys(this.payload);
      const base = this.values.length;
      const set = keys.map((k, i) => `${ident(k)} = $${base + i + 1}`).join(',');
      const r = await db.query(`update ${this.table} t set ${set}${whereSql}${ret}`, [...this.values, ...keys.map((k) => param(this.payload[k]))]);
      const rowsOut = norm(r.rows);
      return { data: this.returning ? (this.single ? rowsOut[0] ?? null : rowsOut) : null, error: null };
    }
    if (this.op === 'delete') {
      await db.query(`delete from ${this.table} t${whereSql}`, this.values);
      return { data: null, error: null };
    }
    throw new Error('unknown op ' + this.op);
  }
  then(resolve, reject) {
    return this.run().catch((e) => ({ data: null, error: { code: e.code, message: e.message } })).then(resolve, reject);
  }
}
globalThis.socialAdmin = makeAdmin();

// ---- the handlers ---------------------------------------------------------------------
const FUNCTIONS = ['daily-submit', 'daily-board', 'open-duel', 'settle-match', 'list-duels'];
const shared = resolve('supabase/functions/_shared/apogee.ts').replaceAll('\\', '/');
await build({
  entryPoints: FUNCTIONS.map((f) => `supabase/functions/${f}/index.ts`), outdir: '.cache/social-functions', bundle: true,
  platform: 'node', format: 'esm', entryNames: '[dir]', logLevel: 'error',
  plugins: [{ name: 'isolated-identity-and-transport', setup(b) {
    b.onResolve({ filter: /\/_shared\/apogee\.ts$/ }, (args) => args.namespace === 'test'
      ? { path: resolve('supabase/functions/_shared/apogee.ts'), namespace: 'file' }
      : /functions[\\/][a-z-]+[\\/]index\.ts$/.test(args.importer) ? { path: 'boundary', namespace: 'test' } : undefined);
    b.onResolve({ filter: /\/_shared\/tournament\.ts$/ }, () => ({ path: 'tournament', namespace: 'test' }));
    b.onResolve({ filter: /^jsr:/ }, () => ({ path: 'client', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({ loader: 'js', contents: args.path === 'boundary' ? `
      export * from ${JSON.stringify(shared)};
      import * as real from ${JSON.stringify(shared)};
      export const handler = (fn) => async (req) => {
        try { return await fn(req, globalThis.socialAdmin); }
        catch (e) { if (e instanceof real.HttpError) return { status: e.status, body: { error: e.message } }; throw e; }
      };
      export const requireCaller = async () => ({ playerId: globalThis.caller, steamId: 'x', displayName: globalThis.callerName ?? 'Caller', kovaaksUsername: null });
      export const json = (body, status = 200) => ({ body, status });
    ` : args.path === 'tournament' ? 'export const afterLegSettled = async () => null;'
      : "export function createClient(){ throw new Error('no network in this test'); }" }));
  } }],
});
const handlers = {};
globalThis.Deno = { env: { get: () => '' }, serve: (fn) => { handlers[globalThis.loading] = fn; } };
for (const f of FUNCTIONS) {
  globalThis.loading = f;
  await import(pathToFileURL(resolve(`.cache/social-functions/${f}.js`)).href);
  assert.equal(typeof handlers[f], 'function', `${f} registered`);
}
let keepLimits = false;
async function call(fn, who, body) {
  // The limiter is the real one; it is cleared between cases so the cases test the
  // handlers, and kept for the one case that tests the limiter.
  if (!keepLimits) await db.query('delete from rate_limits');
  globalThis.caller = players[who];
  globalThis.callerName = who.toUpperCase();
  return handlers[fn](new Request(`https://local.invalid/${fn}`, { method: 'POST', body: JSON.stringify(body) }));
}

// ---- the core, as the client runs it --------------------------------------------------
const tsx = await build({ entryPoints: ['src/core/social/daily.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error' });
const dailyPath = resolve('.cache/social-functions/daily-core.mjs');
(await import('node:fs')).writeFileSync(dailyPath, tsx.outputFiles[0].text);
const core = await import(pathToFileURL(dailyPath).href);
const fixtureOut = await build({ entryPoints: ['tools/fixtures/syntheticStats.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error' });
const fixturePath = resolve('.cache/social-functions/fixture.mjs');
(await import('node:fs')).writeFileSync(fixturePath, fixtureOut.outputFiles[0].text.replace(/if \(process\.argv\[1\][\s\S]*?\n\}\n?$/, ''));
const fixture = await import(pathToFileURL(fixturePath).href);

let passed = 0;
const ok = (label) => { passed++; if (process.env.VERBOSE) console.log('  ok   ' + label); };
const count = async (sql, args = []) => (await db.query(sql, args)).rows[0].n;

const statsDir = mkdtempSync(join(tmpdir(), 'apogee-social-'));
const runFile = (scenario, at, seed = 1, skill = 0.3) => {
  const r = fixture.appendRun(statsDir, { scenario, at: new Date(at), seed, skill });
  return { filename: r.file, csv: r.content, score: r.score, endedAt: r.endedAt };
};

const pool = season.scenarios.map((s) => ({ name: s.scenario, category: s.category, window: s.window ?? 0 }));
const now = Date.now();
let n = core.dailyNumberAt(now);
let { start, end } = core.dailyWindow(n);
// Room for runs inside the day that have already happened.
if (now - start < 20 * 60_000) { n -= 1; ({ start, end } = core.dailyWindow(n)); }
const band = 1;
const draw = core.drawDaily(pool, season.name, n, band);
const [A, B, C] = draw.scenarios;
const inDay = (k) => start + (k + 1) * 60_000;

// ---- daily-submit: refusals first, each leaving nothing behind --------------------------
console.log('daily-submit');
// Ana's history before the day, received before it: six runs on A, two on B, none on C.
const before = async (who, scenario, scores, opts = {}) => {
  for (const [i, s] of scores.entries()) {
    const at = new Date(start - 86_400_000 + i * 60_000).toISOString();
    await db.query(`insert into runs(player_id,scenario_name,score,played_at,created_at,csv_sha256,verification_tier)
      values($1,$2,$3,$4,$5,$6,'consistent')`, [players[who], scenario, s, at, opts.created ?? at, `${who}-${scenario}-${i}-${opts.tag ?? 'x'}`]);
  }
};
// Scores from the fixture's own model for each scenario, so deltas are the size real ones are.
const priorScores = (scenario, k, seed) => Array.from({ length: k }, (_, i) => runFile(scenario, start - 86_400_000 + i * 60_000, seed + i).score);
const aScores = priorScores(A, 6, 100);
const bScores = priorScores(B, 2, 200);
await before('ana', A, aScores);
await before('ana', B, bScores);
// Sandbagging: very low runs dated before the day but uploaded during it. They must not
// reach the baseline.
await before('ana', A, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], { created: new Date(start + 60_000).toISOString(), tag: 'late' });

// A sharper day on A, a duller one on B, and C never played before.
const runs = [runFile(A, inDay(1), 11, 0.42), runFile(B, inDay(2), 12, 0.2), runFile(C, inDay(3), 13)];
const body = (over = {}) => ({ dailyNumber: n, window: band, runs: runs.map(({ filename, csv }) => ({ filename, csv })), timeZone: 'UTC', ...over });
const nothingWritten = async (label) => {
  assert.equal(await count('select count(*)::int as n from daily_results'), 0, `${label}: no board entry`);
  assert.equal(await count("select count(*)::int as n from runs where player_id=$1 and played_at >= $2", [players.ana, new Date(start).toISOString()]), 0, `${label}: no run stored`);
};
const refused = async (label, b, status, who = 'ana') => {
  const r = await call('daily-submit', who, b);
  assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
  await nothingWritten(label);
  ok(`refused ${label} (${status}): ${r.body.error}`);
};
await refused('a daily number given as a string', body({ dailyNumber: String(n) }), 400);
await refused('a band out of range', body({ window: -1 }), 400);
await refused('two runs', body({ runs: body().runs.slice(0, 2) }), 400);
await refused('an unknown time zone', body({ timeZone: 'Mars/Olympus' }), 400);
await refused('tomorrow\'s daily', body({ dailyNumber: core.dailyNumberAt(now) + 1 }), 422);
await refused('a daily two days gone', body({ dailyNumber: core.dailyNumberAt(now) - 2 }), 410);
await refused('the same file twice', body({ runs: [body().runs[0], body().runs[0], body().runs[1]] }), 400);
const notToday = core.drawDaily(pool, season.name, n, 2).scenarios[0];
await refused('a scenario from another band', body({ runs: [body().runs[0], body().runs[1], (({ filename, csv }) => ({ filename, csv }))(runFile(notToday, inDay(4), 14))] }), 422);
await refused('the right three, posted for another band', body({ window: 2 }), 422);
const yesterday = runFile(C, start - 30 * 60_000, 15);
await refused('a run from before the day', body({ runs: [body().runs[0], body().runs[1], { filename: yesterday.filename, csv: yesterday.csv }] }), 422);
await refused('a file that does not parse', body({ runs: [{ filename: 'x.csv', csv: 'nonsense' }, body().runs[1], body().runs[2]] }), 400);

// Not the first run of the day: an earlier run on C is already on the server.
await db.query(`insert into runs(player_id,scenario_name,score,played_at,created_at,csv_sha256,verification_tier)
  values($1,$2,1,$3,$3,'earlier-c','consistent')`, [players.ana, C, new Date(start + 30_000).toISOString()]);
let r = await call('daily-submit', 'ana', body());
assert.equal(r.status, 422, JSON.stringify(r.body));
assert.match(r.body.error, /Not the first run of the day/);
assert.equal(await count('select count(*)::int as n from daily_results'), 0);
await db.query("delete from runs where csv_sha256='earlier-c'");
ok('refused a later attempt when an earlier one on the same scenario is uploaded (422)');

// ---- daily-submit: the entry, and the client agreeing with it --------------------------
r = await call('daily-submit', 'ana', body());
assert.equal(r.status, 200, JSON.stringify(r.body));
const row = (await db.query('select * from daily_results where player_id=$1', [players.ana])).rows[0];
assert.ok(row, 'an entry was written');
// The same day evaluated by the client from the same history, without the late uploads.
const hist = new Map();
const add = (name, score, at) => { if (!hist.has(name)) hist.set(name, { runs: [] }); hist.get(name).runs.push({ score, playedAt: new Date(at) }); };
aScores.forEach((s, i) => add(A, s, start - 86_400_000 + i * 60_000));
bScores.forEach((s, i) => add(B, s, start - 86_400_000 + i * 60_000));
runs.forEach((x, i) => add(draw.scenarios[i], x.score, x.endedAt.getTime()));
const local = core.evaluateDaily(hist, draw);
assert.equal(row.glyphs, core.glyphLetters(local.rounds), `server glyphs ${row.glyphs} vs client`);
assert.ok(Math.abs(Number(row.mean_delta) - local.meanDelta) < 1e-9, `server mean ${row.mean_delta} vs client ${local.meanDelta}`);
assert.equal(row.provisional, local.provisional);
assert.deepEqual(row.prior_runs, [6, 2, 0], 'the late uploads are not prior runs');
assert.deepEqual(row.scenario_names, draw.scenarios, 'the server drew the client\'s three');
assert.equal(Number(row.baselines[2]), 0, 'a first run has no baseline');
assert.equal(r.body.board.players, 1);
assert.equal(r.body.board.you.rank, 1);
assert.equal(r.body.board.you.percentile, null, 'alone: no percentile');
assert.equal(r.body.board.streak, 1);
assert.equal(await count("select count(*)::int as n from runs where player_id=$1 and played_at >= $2", [players.ana, new Date(start).toISOString()]), 3);
ok(`entry written: server glyphs ${row.glyphs} and mean ${(Number(row.mean_delta) * 100).toFixed(2)}% equal the client's; baseline ignores 10 runs uploaded during the day`);

r = await call('daily-submit', 'ana', body());
assert.equal(r.status, 200);
assert.equal(r.body.alreadyPosted, true);
assert.equal(await count('select count(*)::int as n from daily_results'), 1);
assert.equal(await count("select count(*)::int as n from runs where player_id=$1 and played_at >= $2", [players.ana, new Date(start).toISOString()]), 3);
ok('posting the same day again changes nothing (first entry stands)');

// Ben in another zone: his filenames are Chicago wall clocks, and his day is the same day.
process.env.TZ = 'America/Chicago';
const benRuns = [runFile(A, inDay(5), 21), runFile(B, inDay(6), 22), runFile(C, inDay(7), 23)];
process.env.TZ = 'UTC';
await before('ben', A, [400, 400, 400, 400, 400]);
await before('ben', B, [300, 300, 300, 300, 300]);
await before('ben', C, [200, 200, 200, 200, 200]);
r = await call('daily-submit', 'ben', { dailyNumber: n, window: band, timeZone: 'America/Chicago', runs: benRuns.map(({ filename, csv }) => ({ filename, csv })) });
assert.equal(r.status, 200, JSON.stringify(r.body));
const benRow = (await db.query('select played_at, prior_runs from daily_results where player_id=$1', [players.ben])).rows[0];
assert.equal(new Date(benRow.played_at).getTime(), benRuns[2].endedAt.getTime(), 'a Chicago wall clock read in Chicago lands on the real instant');
assert.deepEqual(benRow.prior_runs, [5, 5, 5]);
assert.equal(r.body.board.players, 2);
assert.ok(r.body.board.you.percentile === 0 || r.body.board.you.percentile === 100, JSON.stringify(r.body.board.you));
ok(`a second player in Chicago time is placed against the first (${r.body.board.you.percentile}%)`);

// Band separation: Cal plays band 2's draw.
const draw2 = core.drawDaily(pool, season.name, n, 2);
const calRuns = draw2.scenarios.map((s, i) => runFile(s, inDay(8 + i), 31 + i));
r = await call('daily-submit', 'cal', { dailyNumber: n, window: 2, timeZone: 'UTC', runs: calRuns.map(({ filename, csv }) => ({ filename, csv })) });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.board.players, 1, 'band 2 holds only its own entry');
ok('band 2\'s entry is its own board');

// ---- daily-board ----------------------------------------------------------------------
console.log('daily-board');
r = await call('daily-board', 'ana', { dailyNumber: n, window: band });
assert.equal(r.status, 200);
assert.equal(r.body.board.players, 2);
assert.ok(!JSON.stringify(r.body).includes(players.ben), 'the board never names another player');
assert.ok(!JSON.stringify(r.body).includes(A), 'the board never repeats the draw');
ok(`ana reads band ${band}: 2 players, her place ${r.body.board.you.rank} of ${r.body.board.ranked}, nobody else's id`);
r = await call('daily-board', 'dee', { dailyNumber: n, window: band });
assert.equal(r.body.board.you, null);
ok('a player with no entry sees the distribution and no place');
r = await call('daily-board', 'ana', { dailyNumber: core.dailyNumberAt(now) + 1, window: band });
assert.equal(r.status, 422);
ok('tomorrow\'s board is refused (422), so it cannot be probed');
r = await call('daily-board', 'ana', { dailyNumber: 'x', window: band });
assert.equal(r.status, 400);
ok('a malformed board read is refused (400)');

// ---- open challenges --------------------------------------------------------------------
console.log('open-duel');
// Eligibility for posting: the queue's bar of uploaded runs.
for (let i = 0; i < 60; i++) {
  await db.query(`insert into runs(player_id,scenario_name,score,played_at,csv_sha256,verification_tier) values($1,'history',1,$2,$3,'consistent')`,
    [players.dee, new Date(start - 3 * 86_400_000 + i * 1000).toISOString(), 'dee-history-' + i]);
}
const category = 'Precise Tracking';
r = await call('open-duel', 'dee', { action: 'create', category, window: band });
assert.equal(r.status, 200, JSON.stringify(r.body));
const code = r.body.duel.code;
assert.match(code, /^[2-9A-HJKMNP-Z]{8}$/);
assert.equal(r.body.seeding, true);
const posted = r.body.matchId;
assert.equal((await db.query('select rated from matches where id=$1', [posted])).rows[0].rated, true, 'the poster\'s own three are an ordinary seeding match');
assert.equal((await db.query('select challenged_id from duels where code=$1', [code])).rows[0].challenged_id, null);
ok(`posted ${code}: a seeding match and a duel with a code and no opponent`);

r = await call('open-duel', 'ana', { action: 'view', code });
assert.equal(r.status, 200);
assert.equal(r.body.ready, false);
assert.match(r.body.refusal, /not finished/);
assert.deepEqual(Object.keys(r.body).sort(), ['answered', 'answers', 'band', 'category', 'code', 'expiresAt', 'from', 'ready', 'refusal', 'status', 'unrated', 'yours']);
r = await call('open-duel', 'ana', { action: 'accept', code });
assert.equal(r.status, 409);
ok('before the poster has played: viewable, not answerable (409)');

// The poster plays their three: settle-match scores the seeding side.
const posterScenarios = (await db.query('select scenario_ids from matches where id=$1', [posted])).rows[0].scenario_ids;
const names = new Map((await db.query('select id,name from scenarios where id=any($1)', [posterScenarios])).rows.map((x) => [x.id, x.name]));
const created = (await db.query('select created_at from matches where id=$1', [posted])).rows[0].created_at;
for (const [i, id] of posterScenarios.entries()) {
  await db.query(`insert into runs(player_id,scenario_name,score,played_at,created_at,csv_sha256,verification_tier) values($1,$2,100,$3,$3,$4,'consistent')`,
    [players.dee, names.get(id), new Date(created.getTime() - 86_400_000 + i).toISOString(), 'dee-base-' + i]);
  await db.query(`insert into runs(player_id,scenario_name,score,played_at,csv_sha256,verification_tier,match_id) values($1,$2,104,$3,$4,'consistent',$5)`,
    [players.dee, names.get(id), new Date(created.getTime() + (i + 1) * 60_000).toISOString(), 'dee-match-' + i, posted]);
}
r = await call('settle-match', 'dee', { matchId: posted });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.seeding, true);
ok('the poster plays three; their seeding side settles');

r = await call('open-duel', 'dee', { action: 'accept', code });
assert.equal(r.status, 409);
assert.match(r.body.error, /your own open challenge/);
r = await call('open-duel', 'dee', { action: 'view', code });
assert.equal(r.body.yours, true);
ok('the poster cannot answer their own challenge (409)');

const ratingsBefore = (await db.query('select player_id, rating, rd, matches_played from ratings order by player_id')).rows;
r = await call('open-duel', 'ana', { action: 'accept', code });
assert.equal(r.status, 200, JSON.stringify(r.body));
const answer = r.body.matchId;
assert.equal((await db.query('select rated from matches where id=$1', [answer])).rows[0].rated, false, 'an answer is unrated');
assert.equal(r.body.duel.unrated, true);
assert.equal(r.body.opponent.displayName, 'DEE');
assert.ok(!('match_score' in r.body.opponent) && !JSON.stringify(r.body).includes('0.04'), 'the poster\'s score is not sent');
ok(`ana answers: match ${answer.slice(0, 8)} is unrated`);

r = await call('open-duel', 'ana', { action: 'accept', code });
assert.equal(r.status, 409);
assert.match(r.body.error, /already answered/);
assert.equal(await count('select count(*)::int as n from open_duel_answers'), 1);
ok('a second answer from the same player is refused (409), and no second match is made');

r = await call('open-duel', 'ben', { action: 'accept', code });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(await count('select count(*)::int as n from open_duel_answers'), 2);
ok('a second player answers the same code with a match of their own');

// The database holds the rule as well as the function.
await assert.rejects(db.query(`insert into open_duel_answers(duel_id,player_id,match_id) select id,$1,match_id from duels where code=$2`, [players.cal, code]), /unrated match/);
await assert.rejects(db.query(`insert into matches(category,status,benchmark_name,difficulty,seed,scenario_ids,rated) values('x','awaiting_runs','s','d','seed-guard','{1,2,3}',false) returning id`)
  .then((m) => db.query('insert into open_duel_answers(duel_id,player_id,match_id) select id,$1,$2 from duels where code=$3', [players.dee, m.rows[0].id, code])), /own open challenge/);
await assert.rejects(db.query(`insert into duels(challenger_id,challenged_id,code,match_id,expires_at) values($1,$2,'ABCD2345',$3,now())`, [players.ana, players.ben, posted]), /duels_named_or_open/);
await assert.rejects(db.query(`insert into duels(challenger_id,code,match_id,expires_at) values($1,'abcd1234',$2,now())`, [players.ana, posted]), /duels_code_shape/);
ok('the database refuses an answer on a rated match, the poster\'s own answer, a duel both named and coded, and a bad code');

// Ana plays her three into the answer and settles: no rating moves.
const answerCreated = (await db.query('select created_at from matches where id=$1', [answer])).rows[0].created_at;
for (const [i, id] of posterScenarios.entries()) {
  await db.query(`insert into runs(player_id,scenario_name,score,played_at,created_at,csv_sha256,verification_tier) values($1,$2,100,$3,$3,$4,'consistent')`,
    [players.ana, names.get(id), new Date(answerCreated.getTime() - 86_400_000 + i).toISOString(), 'ana-base-' + i]);
  await db.query(`insert into runs(player_id,scenario_name,score,played_at,csv_sha256,verification_tier,match_id) values($1,$2,110,$3,$4,'consistent',$5)`,
    [players.ana, names.get(id), new Date(answerCreated.getTime() + (i + 1) * 60_000).toISOString(), 'ana-answer-' + i, answer]);
}
r = await call('settle-match', 'ana', { matchId: answer });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.rated, false);
assert.equal(r.body.verdict, 'win');
assert.match(r.body.explanation, /Unrated: this was an open challenge\./);
assert.equal(r.body.ratingChange, 0);
assert.deepEqual((await db.query('select player_id, rating, rd, matches_played from ratings order by player_id')).rows, ratingsBefore, 'no rating moved');
assert.equal(await count('select count(*)::int as n from rating_history where match_id=$1', [answer]), 0);
ok('ana settles her answer: a win on deltas, explained as an open challenge, and no rating or history row moved');

r = await call('open-duel', 'dee', { action: 'mine' });
assert.equal(r.status, 200);
assert.equal(r.body.challenges[0].answers, 2);
assert.equal(r.body.challenges[0].beatYou, 1);
ok(`the poster's list: ${JSON.stringify(r.body.challenges[0])}`);

// list-duels with an open challenge in the table: named duels only, and no error.
r = await call('list-duels', 'dee', {});
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.outgoing.length, 0, 'an open challenge is not in the named outbox');
ok('list-duels still answers, without the open challenge');

// Two answers from one player racing (a double click): one match survives, one answer row.
r = await call('open-duel', 'dee', { action: 'create', category: 'Speed Switching', window: band });
assert.equal(r.status, 200, JSON.stringify(r.body));
const code2 = r.body.duel.code;
const posted2 = r.body.matchId;
const ids2 = (await db.query('select scenario_ids, created_at from matches where id=$1', [posted2])).rows[0];
const names2 = new Map((await db.query('select id,name from scenarios where id=any($1)', [ids2.scenario_ids])).rows.map((x) => [x.id, x.name]));
for (const [i, id] of ids2.scenario_ids.entries()) {
  await db.query(`insert into runs(player_id,scenario_name,score,played_at,csv_sha256,verification_tier,match_id) values($1,$2,100,$3,$4,'consistent',$5)`,
    [players.dee, names2.get(id), new Date(ids2.created_at.getTime() + (i + 1) * 60_000).toISOString(), 'dee-second-' + i, posted2]);
}
assert.equal((await call('settle-match', 'dee', { matchId: posted2 })).status, 200);
await db.query('delete from rate_limits');
keepLimits = true;
const raced = await Promise.all([call('open-duel', 'cal', { action: 'accept', code: code2 }), call('open-duel', 'cal', { action: 'accept', code: code2 })]);
keepLimits = false;
assert.deepEqual(raced.map((x) => x.status).sort(), [200, 409], JSON.stringify(raced.map((x) => x.body)));
assert.equal(await count('select count(*)::int as n from open_duel_answers a join duels d on d.id=a.duel_id where d.code=$1', [code2]), 1);
assert.equal(await count(`select count(*)::int as n from match_sides s join matches m on m.id=s.match_id
  where s.player_id=$1 and m.status='awaiting_runs'`, [players.cal]), 1, 'the losing request left no match behind');
ok(`two racing answers from one player leave one answer and one match (the other: ${raced.find((x) => x.status === 409).body.error})`);

r = await call('open-duel', 'ana', { action: 'cancel', code });
assert.equal(r.status, 403);
r = await call('open-duel', 'dee', { action: 'cancel', code });
assert.equal(r.status, 200);
r = await call('open-duel', 'cal', { action: 'accept', code });
assert.equal(r.status, 410);
ok('only the poster can take it back; after that it is closed (410)');

for (const bad of ['ABC', 'ABCD1234', "'; drop table duels;--", null, 7, 'abcd2345x']) {
  r = await call('open-duel', 'cal', { action: 'view', code: bad });
  assert.equal(r.status, 400, `code ${JSON.stringify(bad)}`);
}
r = await call('open-duel', 'cal', { action: 'view', code: 'ZZZZ2222' });
assert.equal(r.status, 404);
r = await call('open-duel', 'cal', { action: 'launch-missiles' });
assert.equal(r.status, 400);
ok('malformed codes (400), an unknown code (404) and an unknown action (400) are refused');

// The rate limit is the real one: open-duel allows 20 calls in five minutes.
let limited = null;
keepLimits = true;
for (let i = 0; i < 25 && !limited; i++) {
  r = await call('open-duel', 'cal', { action: 'view', code: 'ZZZZ2222' });
  if (r.status === 429) limited = i;
}
assert.ok(limited !== null, 'the 21st call in the window is refused');
ok("open-duel is rate limited by the shared helper: a call past 20 in five minutes is refused (429)");

rmSync(statsDir, { recursive: true, force: true });
await db.close();
console.log(`\nOK: ${passed} social function checks against Postgres, through the shipped handlers`);
