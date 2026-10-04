/**
 * The Shadow and Flag screens the video films, written by the shipped handlers and frozen
 * into tools/video/queue.json.
 *
 *   npx tsx tools/video/queueDemo.ts
 *
 * The same harness as tools/validateQueueFlow.ts: find-match, settle-match and queue-board
 * bundled from source and run against every migration in PGlite, with only identity, the
 * rate limiter, tournament notification and HTTP replaced. Every sentence the video shows
 * on these screens ("No one in your band right now", "Shadow beaten", "Flag planted", "Your
 * Static Clicking Flag was answered by kestrel: you won, +N rating") is the server's.
 *
 * What is chosen here, and only this: two players with fixed ids (so the Shadow's seeded
 * percentile is the same on every run), their baselines, the planter's rating (the
 * snapshot's, 1617 ±105, so the sidebar and the Flag agree), the three scores each plays,
 * and a day and a half between the Flag being planted and answered (the flow test moves
 * time the same way, with an update on the rows). The Shadow, the verdicts, the Flag, both
 * rating changes and every line of copy are computed.
 *
 * Frozen and committed, like ghost.json: the video films the same match on any machine.
 * Timestamps are rebased to the moment of filming by the bridge in record.cjs, so clocks
 * and "days left" read as they did here.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { build } from "esbuild";

import { createAdmin } from "../postgrestShim.mjs";

const out = fileURLToPath(new URL("./queue.json", import.meta.url));
mkdirSync(".cache/video", { recursive: true });

const db = new PGlite();
await db.waitReady;
await db.exec(`create schema auth;create table auth.users(id uuid primary key default gen_random_uuid());
create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
grant usage on schema public to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
set timezone to 'UTC';`);
for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
}
await db.exec(readFileSync("supabase/seed.sql", "utf8"));
const q = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows;

// ---- the pool: Season 1's Intermediate Static Clicking three ---------------------------

const CATEGORY = "Static Clicking";
const WINDOW = 1;
const seasonFile = JSON.parse(readFileSync("data/seasons/season-1.json", "utf8")) as { scenarios: { scenario: string; category: string; window: number }[] };
const names = seasonFile.scenarios.filter((x) => x.category === CATEGORY && x.window === WINDOW).map((x) => x.scenario).slice(0, 3);
assert.equal(names.length, 3);
const season = (await q(`insert into seasons(name,status,windows,window_size) values('Season 1','draft','{Novice,Intermediate}',4) returning id`))[0].id;
const ids: number[] = [];
for (const [i, name] of names.entries()) {
  const id = (await q(`insert into scenarios(name,duration_seconds) values($1,60) on conflict (name) do update set duration_seconds = 60 returning id`, [name]))[0].id;
  await q(`insert into season_scenarios(season_id,scenario_id,category,family,window_index) values($1,$2,$3,$4,1)`, [season, id, CATEGORY, `static-${i}`]);
  ids.push(Number(id));
}
const nameOf = new Map((await q(`select id,name from scenarios where id = any($1::bigint[])`, [ids])).map((r) => [Number(r.id), r.name]));
const filler = (await q(`select name from scenarios where id <> all($1::bigint[]) order by id limit 1`, [ids]))[0].name;

let digest = 0;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 86_400_000;
async function player(id: string, name: string, rating: { rating: number; rd: number; played: number }) {
  await q("insert into auth.users(id) values($1)", [id]);
  await q("insert into players(id,steam_id,display_name) values($1,$2,$3)", [id, String(76561190000000000n + BigInt(++digest)), name]);
  // Enough uploaded history to queue (MIN_RUNS_TO_QUEUE), on a scenario outside the pool.
  for (let i = 0; i < 50; i++) {
    await q(`insert into runs(player_id,scenario_name,score,played_at,created_at,csv_sha256,verification_tier)
      values($1,$2,100,$3,$3,$4,'consistent')`, [id, filler, ago((20 + i / 100) * DAY), `fill-${++digest}`]);
  }
  await q(`insert into ratings(player_id,rating,rd,matches_played) values($1,$2,$3,$4)
    on conflict (player_id) do update set rating=excluded.rating, rd=excluded.rd, matches_played=excluded.matches_played`,
  [id, rating.rating, rating.rd, rating.played]);
}
/** Six earlier runs per scenario at each baseline: a full baseline of exactly that score. */
async function history(playerId: string, baselines: number[]) {
  for (const [k, sid] of ids.entries()) {
    for (let i = 0; i < 6; i++) {
      await q(`insert into runs(player_id,scenario_name,score,played_at,created_at,csv_sha256,verification_tier)
        values($1,$2,$3,$4,$4,$5,'consistent')`, [playerId, nameOf.get(sid), baselines[k], ago((4 + i / 100) * DAY), `hist-${++digest}`]);
    }
  }
}
async function play(playerId: string, matchId: string, order: number[], scores: number[]) {
  for (const [i, sid] of order.entries()) {
    await q(`insert into runs(player_id,scenario_name,score,played_at,csv_sha256,verification_tier,match_id,duration_seconds)
      values($1,$2,$3,$4,$5,'consistent',$6,60)`,
    [playerId, nameOf.get(sid), scores[ids.indexOf(sid)], new Date(Date.now() - (3 - i) * 1000).toISOString(), `match-${++digest}`, matchId]);
  }
}

// ---- the shipped handlers (validateQueueFlow.ts's bundling, unchanged) ------------------

const actualShared = resolve("supabase/functions/_shared/apogee.ts").replaceAll("\\", "/");
async function bundle(name: string) {
  const file = `.cache/video/queue-${name}.mjs`;
  await build({
    entryPoints: [`supabase/functions/${name}/index.ts`], outfile: file, bundle: true, platform: "node", format: "esm", logLevel: "error",
    plugins: [{
      name: "isolated-transport",
      setup(b) {
        b.onResolve({ filter: /\/_shared\/apogee\.ts$/ }, (args) =>
          args.namespace === "test" ? { path: resolve("supabase/functions/_shared/apogee.ts"), namespace: "file" }
            : /functions\/[a-z-]+\/index\.ts$/.test(args.importer.replaceAll("\\", "/")) ? { path: "boundary", namespace: "test" } : undefined);
        b.onResolve({ filter: /\/_shared\/(rateLimit|tournament)\.ts$/ }, () => ({ path: "optional", namespace: "test" }));
        b.onResolve({ filter: /^jsr:/ }, () => ({ path: "client", namespace: "test" }));
        b.onLoad({ filter: /.*/, namespace: "test" }, (args) => ({
          contents: args.path === "boundary" ? `
            export * from ${JSON.stringify(actualShared)};
            import * as shared from ${JSON.stringify(actualShared)};
            export const handler = fn => async req => {
              try { return await fn(req, globalThis.queueAdmin); }
              catch (e) { if (e instanceof shared.HttpError) return { status: e.status, body: { error: e.message } }; throw e; }
            };
            export const requireCaller = async () => ({ playerId: globalThis.queueCaller });
            export const json = (body, status = 200) => ({ body, status });`
            : args.path === "optional" ? "export const enforceRateLimit = async () => {}; export const afterLegSettled = async () => null;"
            : "export function createClient(){ throw new Error('No network in this harness'); }",
        }));
      },
    }],
  });
  let fn: any;
  (globalThis as any).Deno = { env: { get: () => "" }, serve: (f: any) => { fn = f; } };
  await import(pathToFileURL(resolve(file)).href + `?${Date.now()}`);
  assert.equal(typeof fn, "function", `${name} registered a handler`);
  return async (caller: string, body: unknown): Promise<any> => {
    (globalThis as any).queueCaller = caller;
    const r = await fn(new Request(`https://local.invalid/${name}`, { method: "POST", body: JSON.stringify(body) }));
    assert.equal(r.status, 200, `${name}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
}
(globalThis as any).queueAdmin = createAdmin(db, {});
const findMatch = await bundle("find-match");
const settleMatch = await bundle("settle-match");
const queueBoard = await bundle("queue-board");

// ---- the story --------------------------------------------------------------------------

// The viewer, at the snapshot's rating, and the player who answers the Flag a day and a
// half later. Fixed ids: the Shadow is seeded from `shadow:<player id>:<ordinal>`.
const ME = "00000000-0000-4000-8000-00000000a1a1";
const KESTREL = "00000000-0000-4000-8000-00000000b2b2";
await player(ME, "vega", { rating: 1617, rd: 105, played: 41 });
await player(KESTREL, "kestrel", { rating: 1655, rd: 92, played: 57 });
const MY_BASE = [3120, 2870, 2640];
const KESTREL_BASE = [3340, 3010, 2715];
await history(ME, MY_BASE);
await history(KESTREL, KESTREL_BASE);
const scores = (base: number[], gains: number[]) => base.map((b, i) => Math.round(b * (1 + gains[i])));

const screens: Record<string, unknown> = {};

// 1. Nobody in the band: the board says what will happen, then the Shadow match.
screens.planShadow = await queueBoard(ME, { category: CATEGORY, window: WINDOW });
const shadowMatch = await findMatch(ME, { category: CATEGORY, window: WINDOW });
assert.equal(shadowMatch.seeding, true, "an empty pool hands out a Shadow match");
screens.matchShadow = shadowMatch;
const order = shadowMatch.scenarios.map((s: { id: number }) => s.id);

// 2. Played, settled: the Shadow judged, no rating moved, a Flag planted.
await play(ME, shadowMatch.matchId, order, scores(MY_BASE, [0.041, 0.016, -0.007]));
screens.resultShadow = await settleMatch(ME, { matchId: shadowMatch.matchId });
assert.equal((screens.resultShadow as any).shadow.verdict, "win");
screens.boardAfterShadow = await queueBoard(ME, {});

// A day and a half passes before anybody else queues in the band.
const SHIFT = "interval '1 day 14 hours'";
await q(`update flags set planted_at = planted_at - ${SHIFT}, expires_at = expires_at - ${SHIFT} where match_id=$1`, [shadowMatch.matchId]);
// Only the Flag's own clock: the planted side's submitted_at is part of the run set's
// identity (runSetId), so it stays as settle-match wrote it.

// 3. Kestrel queues the same band: the Flag is the run set waiting, and it settles rated.
screens.planOpponent = await queueBoard(KESTREL, { category: CATEGORY, window: WINDOW });
const answer = await findMatch(KESTREL, { category: CATEGORY, window: WINDOW });
assert.equal(answer.flag?.answering, true, "the answer is drawn against the planted Flag");
screens.matchAnswer = answer;
await play(KESTREL, answer.matchId, answer.scenarios.map((s: { id: number }) => s.id), scores(KESTREL_BASE, [0.019, -0.012, 0.004]));
screens.resultAnswer = await settleMatch(KESTREL, { matchId: answer.matchId });
assert.equal((screens.resultAnswer as any).rated, true);

// 4. The planter's next launch: the news, once.
screens.planterNews = await queueBoard(ME, {});
const news = screens.planterNews as any;
assert.equal(news.news.length, 1, "the answered Flag is news");
assert.match(news.flags[0].line, /^Your Static Clicking Flag was answered by kestrel: you won, \+\d+ rating\.$/);

writeFileSync(out, JSON.stringify({
  about: "Written by tools/video/queueDemo.ts from the shipped find-match, settle-match and queue-board handlers on PGlite. Do not edit by hand; re-run the generator.",
  generatedAt: new Date().toISOString(),
  ...screens,
}, null, 1) + "\n");
console.log(`wrote ${out}`);
console.log(`  plan     ${news ? (screens.planShadow as any).preview.line : ""}`);
console.log(`  result   ${(screens.resultShadow as any).explanation}`);
console.log(`  answer   ${(screens.resultAnswer as any).explanation}`);
console.log(`  news     ${news.flags[0].line}`);
