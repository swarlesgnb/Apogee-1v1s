/**
 * Drive ranked v2's three Edge Functions, unmodified, against real Postgres.
 *
 *   node tools/validateRankedV2Functions.mjs
 *
 * find-match, settle-match and abandon-match are bundled as they are deployed and
 * run against PGlite with every migration applied. Only what cannot run here is stubbed:
 * who the caller is (requireCaller), the rate limiter, tournament notification and the
 * Supabase client, which is replaced by a small translation of the query-builder calls
 * these functions make into SQL - embedded `matches!inner(...)` reads included - so the
 * queries, the RPCs and the triggers they reach are the real ones.
 *
 * Every rating change is checked against src/core/rating/ranked.ts computed independently
 * here, and every refusal next to the acceptance it could be confused with.
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

mkdirSync(".cache", { recursive: true });
const db = new PGlite();
await db.waitReady;
await db.exec(`create schema auth; create table auth.users(id uuid primary key default gen_random_uuid());
create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
}
await db.exec(readFileSync("supabase/seed.sql", "utf8"));

// ---- a fake Supabase client that is really SQL ------------------------------------------
const RELATIONS = {
  match_sides: { matches: "match_id", players: "player_id" },
  season_scenarios: { scenarios: "scenario_id" },
};
const ident = (v) => { assert.match(v, /^[a-z_]+$/, `identifier ${v}`); return v; };

function parseColumns(text) {
  const out = [];
  let depth = 0, current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(current.trim()); current = ""; } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out.map((c) => {
    const m = /^([a-z_]+)!inner\((.*)\)$/s.exec(c);
    return m ? { relation: m[1], columns: m[2].split(",").map((s) => ident(s.trim())) } : { column: ident(c) };
  });
}

function query(table, mode = "select", payload = null) {
  ident(table);
  let columns = [{ column: "*" }], head = false, single = false, limit = "";
  const values = [], where = [], embedWhere = {}, ordering = [];
  const param = (v) => { values.push(v); return `$${values.length}`; };
  const target = (key) => {
    const [a, b] = key.split(".");
    if (b) return { rel: ident(a), col: ident(b) };
    return { col: ident(a) };
  };
  const add = (key, sql) => {
    const t = target(key);
    if (t.rel) (embedWhere[t.rel] ??= []).push(sql(`r.${t.col}`));
    else where.push(sql(`t.${t.col}`));
    return builder;
  };
  const builder = {
    select(text = "*", opts = {}) {
      if (mode === "select") columns = text === "*" ? [{ column: "*" }] : parseColumns(text);
      head = !!opts.head;
      return builder;
    },
    eq: (k, v) => add(k, (c) => `${c} = ${param(v)}`),
    neq: (k, v) => add(k, (c) => `${c} <> ${param(v)}`),
    lt: (k, v) => add(k, (c) => `${c} < ${param(v)}`),
    gte: (k, v) => add(k, (c) => `${c} >= ${param(v)}`),
    in: (k, v) => add(k, (c) => `${c}::text = any(${param(v.map(String))}::text[])`),
    not: (k, op, v) => { assert.equal(op, "is"); assert.equal(v, null); return add(k, (c) => `${c} is not null`); },
    or(text) {
      const parts = text.split(",").map((p) => {
        const [col, op, ...rest] = p.split(".");
        const value = rest.join(".");
        if (op === "is" && value === "null") return `t.${ident(col)} is null`;
        if (op === "neq") return `t.${ident(col)} <> ${param(value)}`;
        if (op === "eq") return `t.${ident(col)} = ${param(value)}`;
        throw new Error(`or: ${p}`);
      });
      where.push(`(${parts.join(" or ")})`);
      return builder;
    },
    order(k, o = {}) { ordering.push(`t.${ident(k)} ${o.ascending === false ? "desc" : "asc"}`); return builder; },
    limit(n) { assert.ok(Number.isInteger(n)); limit = ` limit ${n}`; return builder; },
    maybeSingle() { single = true; return builder; },
    then(resolve, reject) { return run().then(resolve, reject); },
  };

  async function run() {
    try {
      if (mode === "update") {
        const sets = Object.entries(payload).map(([k, v]) => `${ident(k)} = ${param(v)}`);
        await db.query(`update ${table} t set ${sets.join(", ")}${where.length ? " where " + where.join(" and ") : ""}`, values);
        return { data: null, error: null };
      }
      const rels = RELATIONS[table] ?? {};
      const embeds = columns.filter((c) => c.relation);
      for (const e of embeds) assert.ok(rels[e.relation], `no relation ${table} -> ${e.relation}`);
      const join = (rel, extra = []) =>
        `from ${rel} r where r.id = t.${rels[rel]}${[...extra, ...(embedWhere[rel] ?? [])].map((w) => ` and ${w}`).join("")}`;
      const inner = embeds.map((e) => `exists(select 1 ${join(e.relation)})`);
      const filters = [...where, ...inner];
      const whereSql = filters.length ? ` where ${filters.join(" and ")}` : "";
      if (head) {
        const r = await db.query(`select count(*)::int as n from ${table} t${whereSql}`, values);
        return { data: null, count: r.rows[0].n, error: null };
      }
      const list = columns.map((c) =>
        c.relation
          ? `(select json_build_object(${c.columns.map((x) => `'${x}', r.${x}`).join(", ")}) ${join(c.relation)}) as ${c.relation}`
          : c.column === "*" ? "t.*" : `t.${c.column}`,
      );
      const sql = `select to_json(q) as j from (select ${list.join(", ")} from ${table} t${whereSql}` +
        `${ordering.length ? " order by " + ordering.join(", ") : ""}${limit}) q`;
      const rows = (await db.query(sql, values)).rows.map((r) => r.j);
      return { data: single ? rows[0] ?? null : rows, error: null };
    } catch (e) {
      return { data: null, error: { code: e.code, message: e.message } };
    }
  }
  return builder;
}

const SIGNATURES = {
  ranked_pool_rounds: { table: true, args: { p_window: "int", p_caller: "uuid", p_rating: "numeric", p_players: "int", p_sides_per_player: "int" } },
  open_ranked_match: { args: { p_player: "uuid", p_match: "jsonb", p_sides: "jsonb" } },
  commit_match_result: { args: { p_match_id: "uuid", p_status: "text", p_sides: "jsonb", p_ratings: "jsonb", p_forfeit: "boolean" } },
};
const rpcCalls = [];
const admin = {
  from: (table) => ({
    select: (...a) => query(table).select(...a),
    update: (payload) => query(table, "update", payload),
  }),
  async rpc(name, params) {
    rpcCalls.push(name);
    const sig = SIGNATURES[name];
    assert.ok(sig, `unexpected rpc ${name}`);
    const values = [], args = [];
    for (const [k, type] of Object.entries(sig.args)) {
      if (!(k in params)) continue;
      const v = params[k];
      values.push(type === "jsonb" ? JSON.stringify(v) : v);
      args.push(`${k} => $${values.length}::${type}`);
    }
    try {
      if (sig.table) {
        const r = await db.query(`select to_json(x) as j from ${name}(${args.join(", ")}) x`, values);
        return { data: r.rows.map((row) => row.j), error: null };
      }
      const r = await db.query(`select ${name}(${args.join(", ")}) as r`, values);
      return { data: r.rows[0].r, error: null };
    } catch (e) {
      return { data: null, error: { code: e.code, message: e.message } };
    }
  },
};

// ---- bundle the three functions as deployed ----------------------------------------------
const actualShared = resolve("supabase/functions/_shared/apogee.ts").replaceAll("\\", "/");
const handlers = {};
let loading = null;
globalThis.Deno = { env: { get: () => "" }, serve: (fn) => { handlers[loading] = fn; } };
globalThis.v2Admin = admin;

async function load(name) {
  await build({
    entryPoints: [`supabase/functions/${name}/index.ts`], outfile: `.cache/${name}.mjs`, bundle: true, platform: "node", format: "esm",
    plugins: [{
      name: "boundary",
      setup(b) {
        b.onResolve({ filter: /\/_shared\/apogee\.ts$/ }, (args) =>
          args.namespace === "test" ? { path: resolve("supabase/functions/_shared/apogee.ts"), namespace: "file" }
          : args.importer.replaceAll("\\", "/").endsWith(`${name}/index.ts`) ? { path: "boundary", namespace: "test" }
          : undefined);
        b.onResolve({ filter: /\/_shared\/(rateLimit|tournament)\.ts$/ }, () => ({ path: "optional", namespace: "test" }));
        b.onResolve({ filter: /^jsr:/ }, () => ({ path: "client", namespace: "test" }));
        b.onLoad({ filter: /.*/, namespace: "test" }, (args) => ({
          contents: args.path === "boundary" ? `
            export * from ${JSON.stringify(actualShared)};
            import * as shared from ${JSON.stringify(actualShared)};
            export const json = (body, status = 200) => ({ body, status });
            export const handler = (fn) => async (req) => {
              try { return await fn(req, globalThis.v2Admin); }
              catch (e) { if (e instanceof shared.HttpError) return { body: { error: e.message }, status: e.status }; throw e; }
            };
            export const requireCaller = async () => ({ playerId: globalThis.v2Caller });
          ` : args.path === "optional"
            ? "export const enforceRateLimit = async () => {}; export const afterLegSettled = async () => null;"
            : "export function createClient() { throw new Error('no network in this test'); }",
        }));
      },
    }],
  });
  loading = name;
  await import(pathToFileURL(resolve(`.cache/${name}.mjs`)).href + `?t=${Date.now()}`);
  assert.equal(typeof handlers[name], "function", `${name} registered a handler`);
}
await load("find-match");
await load("settle-match");
await load("abandon-match");

await build({ entryPoints: ["src/core/rating/ranked.ts"], outfile: ".cache/ranked-core.mjs", bundle: true, platform: "node", format: "esm" });
const ranked = await import(pathToFileURL(resolve(".cache/ranked-core.mjs")).href);

const call = (name, as, body = {}) => {
  globalThis.v2Caller = as;
  return handlers[name](new Request(`https://local.invalid/${name}`, { method: "POST", body: JSON.stringify(body) }));
};
const find = (as) => call("find-match", as, { category: "Any", window: 1 });
const settle = (as, matchId) => call("settle-match", as, { matchId });
const abandon = (as) => call("abandon-match", as);

// ---- a season, three players, an opponent with banked rounds -----------------------------
const scenarios = (await db.query("select id, name from scenarios order by id limit 4")).rows;
const pool = scenarios.slice(0, 3);
await db.query("update scenarios set duration_seconds = 60 where id = any($1::bigint[])", [pool.map((s) => s.id)]);
const season = (await db.query(`insert into seasons(name, status, windows, window_size) values('Test Season', 'draft', '{Novice,Intermediate}', 5) returning id`)).rows[0].id;
for (const [i, s] of pool.entries()) {
  await db.query(`insert into season_scenarios(season_id, scenario_id, category, family, window_index, rank_maxes)
    values($1, $2, 'Clicking', $3, 1, '{10,20,30,40,50}')`, [season, s.id, "family-" + i]);
}

let steam = 0, file = 0, minute = 0;
async function player(name, rating, rd) {
  const id = (await db.query("insert into auth.users default values returning id")).rows[0].id;
  await db.query("insert into players(id, steam_id, display_name) values($1, $2, $3)", [id, "765611" + String(++steam).padStart(11, "0"), name]);
  await db.query("update ratings set rating = $2, rd = $3 where player_id = $1", [id, rating, rd]);
  // History: enough to queue, and a settled baseline of 100 on every pool scenario.
  await db.query(`insert into runs(player_id, scenario_name, score, played_at, created_at, csv_sha256, verification_tier)
    select $1, $2, 50, '2026-01-01'::timestamptz + make_interval(mins => g), '2026-01-01', 'hist-' || $3 || '-' || g, 'consistent'
    from generate_series(1, 50) g`, [id, scenarios[3].name, name]);
  for (const s of pool) {
    await db.query(`insert into runs(player_id, scenario_name, score, played_at, created_at, csv_sha256, verification_tier)
      select $1, $2, 100, '2026-02-01'::timestamptz + make_interval(mins => g), '2026-02-01', 'base-' || $3 || '-' || $2 || '-' || g, 'consistent'
      from generate_series(1, 12) g`, [id, s.name, name]);
  }
  return id;
}
const A = await player("player", 1500, 80);
const B = await player("opponent", 1700, 60);

// B banked eight sittings on the pool, each played at 1400 although B is 1700 now.
for (let k = 0; k < 8; k++) {
  const created = `2026-09-${String(10 + k).padStart(2, "0")}T12:00:00Z`;
  const m = (await db.query(`insert into matches(category, benchmark_name, difficulty, seed, scenario_ids, status, window_index, created_at)
    values('Any', 'Test Season', 'Intermediate', $1, $2::bigint[], 'settled', 1, $3) returning id`, ["bank-" + k, pool.map((s) => s.id), created])).rows[0].id;
  await db.query(`insert into match_sides(match_id, player_id, run_ids, deltas, scores, match_score, rating_before, rd_before, submitted_at)
    values($1, $2, array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()], '{0,0,0}', '{100,100,100}', 0, 1400, 60, $3)`,
    [m, B, new Date(new Date(created).getTime() + 60_000).toISOString()]);
}

async function play(matchId, scores, durations = scores.map(() => 60)) {
  const m = (await db.query("select scenario_ids from matches where id = $1", [matchId])).rows[0];
  const names = new Map(scenarios.map((s) => [Number(s.id), s.name]));
  for (const [i, id] of m.scenario_ids.entries()) {
    if (scores[i] === undefined) continue;
    await db.query(`insert into runs(player_id, scenario_name, score, played_at, csv_sha256, verification_tier, match_id, duration_seconds)
      values($1, $2, $3, $4, $5, 'consistent', $6, $7)`,
      [A, names.get(Number(id)), scores[i], new Date(Date.UTC(2026, 9, 1, 0, ++minute)).toISOString(), "match-run-" + ++file, matchId, durations[i]]);
  }
}
const rating = async (id) => {
  const r = (await db.query("select rating, rd, volatility, matches_played from ratings where player_id = $1", [id])).rows[0];
  return { rating: Number(r.rating), rd: Number(r.rd), volatility: Number(r.volatility), played: r.matches_played };
};
const history = async (matchId) => (await db.query("select * from rating_history where match_id = $1", [matchId])).rows;
const at1400 = { rating: 1400, rd: 60, volatility: 0.06 };

// ---- open to everyone --------------------------------------------------------------------
// v2 ran admin-only before it replaced v1. Nobody here is an admin, so a gate left behind
// anywhere would refuse every call below.
assert.equal((await db.query("select count(*)::int as n from admins")).rows[0].n, 0);

// ---- queue: rated as they played, with stakes ----------------------------------------------
const first = await find(A);
assert.equal(first.status, 200, JSON.stringify(first.body));
assert.equal(first.body.engine, 2);
assert.equal(first.body.seeding, undefined, "an opponent was found");
assert.equal(first.body.opponent.rating, 1400, "the opponent is the rating those rounds were played at, not today's 1700");
assert.ok(rpcCalls.includes("ranked_pool_rounds") && rpcCalls.includes("open_ranked_match"));
const before1 = await rating(A);
const expectStakes = ranked.stakes({ before: before1, opponent: at1400, rounds: 3 });
assert.deepEqual(first.body.stakes, expectStakes);
assert.deepEqual(first.body.stakes.map((s) => s.result), ["3-0", "2-1", "1-2", "0-3"]);
assert.ok(first.body.stakes.every((s, i, all) => i === 0 || s.change < all[i - 1].change), "every extra round won is worth more");
assert.ok(first.body.stakes[0].change > 0 && first.body.stakes[3].change < 0);
const copied = (await db.query("select rating_before, rd_before from match_sides where match_id = $1 and player_id = $2", [first.body.matchId, B])).rows[0];
assert.deepEqual([Number(copied.rating_before), Number(copied.rd_before)], [1400, 60], "settlement will read the same rating");
console.log(`PASS: queued against rounds played at 1400 (owner now 1700), stakes ${first.body.stakes.map((s) => `${s.result} ${s.change >= 0 ? "+" : ""}${s.change}`).join(", ")}`);

const again = await find(A);
assert.deepEqual([again.body.matchId, again.body.resumed, again.body.engine], [first.body.matchId, true, 2]);
assert.deepEqual(again.body.stakes, expectStakes, "a resumed match shows the same stakes");
assert.equal((await db.query("select count(*)::int as n from matches where engine = 2")).rows[0].n, 1);
console.log("PASS: queueing again hands the open match back instead of a second");

// ---- settle 2-1 by rounds ----------------------------------------------------------------
await play(first.body.matchId, [110, 90, 105]);
const won = await settle(A, first.body.matchId);
assert.equal(won.status, 200, JSON.stringify(won.body));
assert.deepEqual([won.body.verdict, won.body.ratingModel, won.body.roundTally], ["win", "rounds", { won: 2, lost: 1, tied: 0 }]);
assert.deepEqual(won.body.rounds.map((r) => r.result), ["won", "lost", "won"]);
const expected1 = ranked.rateResult({ before: before1, opponent: at1400, tally: { won: 2, lost: 1, tied: 0 }, model: "rounds" });
const after1 = await rating(A);
assert.ok(Math.abs(after1.rating - expected1.after.rating) < 1e-6 && Math.abs(after1.rd - expected1.after.rd) < 1e-6,
  `${after1.rating} vs ${expected1.after.rating}`);
assert.equal(after1.played, before1.played + 1, "one match, however many games it counted as");
assert.equal(won.body.ratingChange, expectStakes[1].change, "the 2-1 stake shown was the change applied");
const h1 = await history(first.body.matchId);
assert.equal(h1.length, 1);
assert.ok(Math.abs(Number(h1[0].result) - 2 / 3) < 1e-9, "the receipt records two games in three");
assert.equal((await settle(A, first.body.matchId)).body.alreadySettled, true);
assert.equal((await history(first.body.matchId)).length, 1, "settling twice rates once");
console.log(`PASS: a 2-1 settles as three games against 1400 (${won.body.ratingChange >= 0 ? "+" : ""}${won.body.ratingChange}), exactly what was shown`);

// ---- leaving early: free once a week, then the round -------------------------------------
const second = (await find(A)).body;
assert.ok(second.matchId && second.matchId !== first.body.matchId && second.opponent, "a fresh contested match");
await play(second.matchId, [110], [20]);
const before2 = await rating(A);
const freeVoid = await settle(A, second.matchId);
assert.deepEqual([freeVoid.body.verdict, freeVoid.body.freeAbandon?.used], ["void", true], JSON.stringify(freeVoid.body));
assert.match(freeVoid.body.message, /this week's free one/);
assert.deepEqual(await rating(A), before2, "the free void moves nothing");
const voided = (await db.query("select status, void_reason from matches where id = $1", [second.matchId])).rows[0];
assert.deepEqual([voided.status, voided.void_reason], ["void", "abandoned"]);

const third = (await find(A)).body;
assert.ok(third.opponent);
await play(third.matchId, [110], [20]);
const pending = await settle(A, third.matchId);
assert.equal(pending.status, 409, "not voided this time: the other rounds are still to play");
assert.equal(pending.body.lostRound, scenarios.find((s) => Number(s.id) === Number(third.scenarios[0].id)).name);
assert.equal(pending.body.remaining.length, 2);
await play(third.matchId, [undefined, 120, 130]);
const before3 = await rating(A);
const lostOne = await settle(A, third.matchId);
assert.equal(lostOne.status, 200, JSON.stringify(lostOne.body));
assert.deepEqual([lostOne.body.verdict, lostOne.body.roundTally], ["win", { won: 2, lost: 1, tied: 0 }]);
assert.equal(lostOne.body.rounds[0].result, "lost", "the round that was left is lost, whatever its partial score (110 > 100)");
assert.match(lostOne.body.rounds[0].excludedReason, /round is lost/);
const expected3 = ranked.rateResult({ before: before3, opponent: at1400, tally: { won: 2, lost: 1, tied: 0 }, model: "rounds" });
assert.ok(Math.abs((await rating(A)).rating - expected3.after.rating) < 1e-6);
console.log("PASS: the first early exit in a week voids for free; the second loses that round and the match plays on");

// ---- forfeit: every round lost -------------------------------------------------------------
const fourth = (await find(A)).body;
assert.ok(fourth.opponent);
const before4 = await rating(A);
const forfeit = await abandon(A);
assert.deepEqual([forfeit.body.verdict, forfeit.body.reason, forfeit.body.rated], ["loss", "forfeit", true], JSON.stringify(forfeit.body));
const expected4 = ranked.rateForfeit({ before: before4, opponent: at1400, rounds: 3, model: "rounds" });
assert.ok(Math.abs((await rating(A)).rating - expected4.after.rating) < 1e-6);
assert.equal(forfeit.body.ratingChange, fourth.stakes[3].change, "a forfeit costs exactly the 0-3 stake");
assert.equal(Number((await history(fourth.matchId))[0].result), 0);
console.log(`PASS: abandoning costs the 0-3 stake (${forfeit.body.ratingChange}), never less than losing every round`);

// ---- the sweep settles a finished match nobody settled -------------------------------------
const fifth = (await find(A)).body;
assert.ok(fifth.opponent);
await play(fifth.matchId, [120, 120, 120]);
await db.query("update matches set expires_at = now() - interval '1 minute' where id = $1", [fifth.matchId]);
const before5 = await rating(A);
const afterSweep = await find(A);
const swept = (await db.query("select status from matches where id = $1", [fifth.matchId])).rows[0];
assert.equal(swept.status, "settled", "the expired, finished match was settled rather than left open");
assert.notEqual(afterSweep.body.matchId, fifth.matchId, "and the queue moved on to a new match");
const expected5 = ranked.rateResult({ before: before5, opponent: at1400, tally: { won: 3, lost: 0, tied: 0 }, model: "rounds" });
assert.ok(Math.abs((await rating(A)).rating - expected5.after.rating) < 1e-6, "rated as the 3-0 it was");
console.log("PASS: an expired match with every run in is settled by the sweep, as a 3-0, instead of staying open");

// The new match from that queue is left to a forfeit, to clear the way for v1 matches.
assert.equal((await abandon(A)).status, 200);

// ---- a match from before v2 keeps v1's rules ----------------------------------------
async function v1Match(opponentRating) {
  const m = (await db.query(`insert into matches(category, benchmark_name, difficulty, seed, scenario_ids, status, window_index, expires_at)
    values('Any', 'Test Season', 'Intermediate', $1, $2::bigint[], 'awaiting_runs', 1, now() + interval '1 hour') returning id`,
    ["v1-" + ++file, pool.map((s) => s.id)])).rows[0].id;
  await db.query("insert into match_sides(match_id, player_id) values($1, $2)", [m, A]);
  await db.query(`insert into match_sides(match_id, player_id, deltas, scores, match_score, rating_before, rd_before, submitted_at)
    values($1, $2, '{0,0,0}', '{100,100,100}', 0, $3, 60, '2026-01-01')`, [m, B, opponentRating]);
  return m;
}
const legacy = await v1Match(1700);
await play(legacy, [110, 90, 105]);
const before6 = await rating(A);
const legacyWon = await settle(A, legacy);
assert.deepEqual([legacyWon.body.engine, legacyWon.body.ratingModel, legacyWon.body.verdict], [1, "match", "win"]);
const expected6 = ranked.rateResult({ before: before6, opponent: { rating: 1700, rd: 60, volatility: 0.06 }, tally: { won: 2, lost: 1, tied: 0 }, model: "match" });
assert.ok(Math.abs((await rating(A)).rating - expected6.after.rating) < 1e-6, "one game, as settle-match rates it");
assert.equal(Number((await history(legacy))[0].result), 1, "and the receipt says one win");

const legacyLeft = await v1Match(1700);
await play(legacyLeft, [110], [20]);
const legacyVoid = await settle(A, legacyLeft);
assert.equal(legacyVoid.body.verdict, "void");
assert.equal(legacyVoid.body.freeAbandon, null, "a v1 match voids as it always has, spending nothing");
assert.equal((await db.query("select void_reason from matches where id = $1", [legacyLeft])).rows[0].void_reason, null);
console.log("PASS: a match from before v2 is rated as one game and voids for free, as it would have been then");
