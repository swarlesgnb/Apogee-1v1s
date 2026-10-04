/**
 * Drive the shipped find-match, settle-match and queue-board handlers through Shadows and
 * Flags against a real migrated Postgres (PGlite).
 *
 *   npx tsx tools/validateQueueFlow.ts      (part of npm run validate:queue)
 *
 * Only authentication, the rate limiter, tournament notification and the HTTP transport are
 * replaced. Every query the handlers and their shared helpers make runs as SQL against the
 * migrations through tools/postgrestShim.mjs, and every write that settles anything goes
 * through the same commit functions production calls.
 *
 * The story it plays, each step asserted rather than printed:
 *
 *   1. an empty pool: the queue board says "Shadow" before the player commits, find-match
 *      hands out a Shadow match at exactly the percentile the core predicts, a requeue hands
 *      the same match and Shadow back, and settling it judges the Shadow, moves no rating and
 *      plants a Flag (never "Nothing was rated")
 *   2. a second player: the board says a run set is waiting, find-match draws the Flag, and
 *      settling it rates both players once and closes the Flag
 *   3. the planter's next launch: the board names who answered and how it went, once
 *   4. a third player on the same run set rates only themselves
 *   5. two answerers racing one Flag: exactly one settles it, the other is rated alone
 *   6. an expired Flag rates nobody but its answerer, and closes cleanly
 *   7. letting a Shadow match expire, or pressing Abandon on one, is a Shadow loss and steps
 *      the ladder down; a round left early is no result and leaves it where it was
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { build } from "esbuild";

import { createAdmin } from "./postgrestShim.mjs";
import { planShadow, type ShadowRecord } from "../src/core/match/shadow.ts";
import { SHADOW_DAYS } from "../src/core/match/shadowDays.ts";

mkdirSync(".cache", { recursive: true });

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

// ---- fixtures -------------------------------------------------------------------------

const q = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows;
const CATEGORIES = {
  static: "Static Clicking",
  precise: "Precise Tracking",
  speed: "Speed Switching",
  evasive: "Evasive Switching",
} as const;
const scenarioIds: Record<string, number[]> = {};
const seasonFile = JSON.parse(readFileSync("data/seasons/season-1.json", "utf8")) as { scenarios: { scenario: string; category: string; window: number }[] };
const realNames = (category: string) => seasonFile.scenarios.filter((x) => x.category === category && x.window === 1).map((x) => x.scenario).slice(0, 3);
const season = (await q(`insert into seasons(name,status,windows,window_size) values('Queue test season','draft','{Novice,Intermediate}',4) returning id`))[0].id;
for (const [key, category] of Object.entries(CATEGORIES)) {
  scenarioIds[category] = [];
  const names = realNames(category);
  assert.equal(names.length, 3, `Season 1 has three ${category} scenarios in Intermediate`);
  for (const [i, name] of names.entries()) {
    const id = (await q(`insert into scenarios(name,duration_seconds) values($1,60) on conflict (name) do update set duration_seconds = 60 returning id`, [name]))[0].id;
    await q(`insert into season_scenarios(season_id,scenario_id,category,family,window_index) values($1,$2,$3,$4,1)`,
      [season, id, category, `${key}-${i}`]);
    scenarioIds[category].push(Number(id));
  }
}
const poolIds = Object.values(scenarioIds).flat();
const filler = (await q(`select name from scenarios where id <> all($1::bigint[]) order by id limit 1`, [poolIds]))[0].name;
const nameOf = new Map((await q(`select id,name from scenarios where id = any($1::bigint[])`, [poolIds])).map((r) => [Number(r.id), r.name]));

let digest = 0;
const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
async function player(name: string): Promise<string> {
  const id = (await q("insert into auth.users default values returning id"))[0].id;
  await q("insert into players(id,steam_id,display_name) values($1,$2,$3)", [id, String(76561190000000000n + BigInt(++digest)), name]);
  // Enough uploaded history to queue (MIN_RUNS_TO_QUEUE), on a scenario outside the pool.
  for (let i = 0; i < 50; i++) {
    await q(`insert into runs(player_id,scenario_name,score,played_at,created_at,csv_sha256,verification_tier)
      values($1,$2,100,$3,$3,$4,'consistent')`, [id, filler, days(20 + i / 100), `fill-${++digest}`]);
  }
  return id;
}
/** Six earlier runs at `score` on each scenario of a category: a full baseline of `score`. */
async function history(playerId: string, category: string, score: number) {
  for (const sid of scenarioIds[category]) {
    for (let i = 0; i < 6; i++) {
      await q(`insert into runs(player_id,scenario_name,score,played_at,created_at,csv_sha256,verification_tier)
        values($1,$2,$3,$4,$4,$5,'consistent')`, [playerId, nameOf.get(sid), score, days(3 + i / 100), `hist-${++digest}`]);
    }
  }
}
/** Play the match: one run per scenario at the given scores, filed against it. */
async function play(playerId: string, matchId: string, ids: number[], scores: number[], seconds = 60) {
  for (const [i, sid] of ids.entries()) {
    await q(`insert into runs(player_id,scenario_name,score,played_at,csv_sha256,verification_tier,match_id,duration_seconds)
      values($1,$2,$3,$4,$5,'consistent',$6,$7)`,
      [playerId, nameOf.get(sid), scores[i], new Date(Date.now() - (3 - i) * 1000).toISOString(), `match-${++digest}`, matchId, seconds]);
  }
}
const ratingOf = async (id: string) => Number((await q("select rating from ratings where player_id=$1", [id]))[0].rating);
const receipts = async (id: string) => Number((await q("select count(*)::int as n from rating_history where player_id=$1", [id]))[0].n);

// ---- the shipped handlers ---------------------------------------------------------------

const actualShared = resolve("supabase/functions/_shared/apogee.ts").replaceAll("\\", "/");
async function bundle(name: string) {
  const out = `.cache/queue-${name}.mjs`;
  await build({
    entryPoints: [`supabase/functions/${name}/index.ts`], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "error",
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
            : "export function createClient(){ throw new Error('No network in this test'); }",
        }));
      },
    }],
  });
  let fn: any;
  (globalThis as any).Deno = { env: { get: () => "" }, serve: (f: any) => { fn = f; } };
  await import(pathToFileURL(resolve(out)).href + `?${Date.now()}`);
  assert.equal(typeof fn, "function", `${name} registered a handler`);
  return async (caller: string, body: unknown): Promise<{ status: number; body: any }> => {
    (globalThis as any).queueCaller = caller;
    return fn(new Request(`https://local.invalid/${name}`, { method: "POST", body: JSON.stringify(body) }));
  };
}
const rpcLog: { name: string; result: any }[] = [];
(globalThis as any).queueAdmin = createAdmin(db, { onRpc: (name: string, result: any) => rpcLog.push({ name, result }) });
const findMatch = await bundle("find-match");
const settleMatch = await bundle("settle-match");
const queueBoard = await bundle("queue-board");
const abandonMatch = await bundle("abandon-match");

const WINDOW = 1;
const ok = (r: { status: number; body: any }, label: string) => {
  assert.equal(r.status, 200, `${label}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
/** Queue, after asking the board what queueing would do; the two must agree. */
async function queue(who: string, category: string) {
  const board = ok(await queueBoard(who, { category, window: WINDOW }), "queue-board preview");
  const found = ok(await findMatch(who, { category, window: WINDOW }), "find-match");
  const ids = found.scenarios.map((s: any) => s.id);
  if (found.seeding) {
    assert.equal(board.preview.outcome, "shadow", "the board said Shadow before the player committed");
    assert.equal(board.preview.shadow.percentile, found.shadow.percentile, "and named the Shadow find-match fielded");
    assert.match(board.preview.line, /You'll face a Shadow now .*your run set stays planted as a Flag/);
  } else {
    assert.equal(board.preview.outcome, "opponent", "the board said a run set was waiting");
  }
  return { found, ids, board };
}
async function records(who: string): Promise<ShadowRecord[]> {
  return (await q("select ordinal,percentile,result from match_shadows where player_id=$1", [who]))
    .map((r) => ({ ordinal: r.ordinal, percentile: r.percentile, result: r.result }));
}

const A = await player("mira"), B = await player("kestrel"), C = await player("juno"), D = await player("rook");
await history(A, CATEGORIES.static, 100);
await history(A, CATEGORIES.precise, 200);
await history(B, CATEGORIES.static, 100);
await history(C, CATEGORIES.static, 100);
let checks = 0;
/** Real handler payloads, photographed by tools/queueUi.cjs. */
const screens: Record<string, unknown> = {};
const pass = (label: string) => { checks++; console.log(`  ok   ${label}`); };

// ---- 1. empty pool: a Shadow, and a Flag ------------------------------------------------
const expected = planShadow(SHADOW_DAYS, A, [], CATEGORIES.static);
const first = await queue(A, CATEGORIES.static);
screens.planShadow = first.board;
screens.matchShadow = first.found;
assert.equal(first.found.seeding, true);
assert.equal(first.found.opponent, null);
assert.equal(first.found.shadow.percentile, expected.percentile, "the Shadow is the one the core predicts from server data");
assert.equal(first.found.shadow.rung, 2, "the first Shadow sits on the median rung");
assert.ok(Math.abs(first.found.shadow.percentile - 50) <= 3);
assert.equal(first.found.flag.willPlant, true);
assert.equal("quantiles" in first.found.shadow || "shadowScore" in first.found.shadow, false, "the client is not told the Shadow's score before playing");
const row = (await q("select * from match_shadows where match_id=$1", [first.found.matchId]))[0];
assert.deepEqual(row.quantiles.map(Number), expected.quantiles, "the Shadow is frozen at creation");
pass(`empty pool: Shadow match at percentile ${first.found.shadow.percentile}, predicted by the board and frozen in match_shadows`);

const again = ok(await findMatch(A, { category: CATEGORIES.static, window: WINDOW }), "requeue");
assert.equal(again.matchId, first.found.matchId);
assert.equal(again.resumed, true);
assert.equal(again.shadow.percentile, first.found.shadow.percentile, "requeueing hands back the same Shadow");
assert.equal((await q("select count(*)::int as n from match_shadows where player_id=$1", [A]))[0].n, 1);
pass("requeueing returns the open match and its Shadow; the one-open-match rule holds");

const ratingBefore = await ratingOf(A);
await play(A, first.found.matchId, first.ids, [110, 110, 110]);
const settledA = ok(await settleMatch(A, { matchId: first.found.matchId }), "settle Shadow match");
screens.resultShadowWin = settledA;
screens.boardAfterFirst = ok(await queueBoard(A, {}), "board after first Shadow");
assert.equal(settledA.seeding, true);
assert.equal(settledA.rated, false);
assert.equal(settledA.verdict, null, "the ladder records no verdict for a match with nobody on the other side");
assert.equal(settledA.shadow.verdict, "win");
assert.ok(Math.abs(settledA.yourMatchScore - 0.1) < 1e-9);
assert.ok(settledA.shadow.shadowScore < 0.1 && settledA.shadow.shadowScore > 0);
assert.ok(!/Nothing was rated/.test(settledA.explanation + settledA.message), "never 'Nothing was rated'");
assert.match(settledA.explanation, /^You beat an? \d+(st|nd|rd|th)-percentile day: \+10\.0% vs \+\d\.\d% against baselines\./);
assert.match(settledA.explanation, /Shadows move no rating\./);
assert.equal(settledA.flag.status, "open");
assert.match(settledA.flag.line, /^Flag planted: Intermediate band, Static Clicking\. It settles when someone answers it \(up to 7 days\)\.$/);
assert.ok(settledA.rounds.every((r: any) => Number.isFinite(r.opponentDelta)), "each round shows the Shadow's delta");
assert.equal(await ratingOf(A), ratingBefore, "a Shadow moves no rating");
assert.equal(await receipts(A), 0);
const flag1 = (await q("select * from flags where match_id=$1", [first.found.matchId]))[0];
const sideA = (await q("select player_id, submitted_at from match_sides where match_id=$1", [first.found.matchId]))[0];
assert.equal(flag1.run_set_id, `${A}@${new Date(sideA.submitted_at).toISOString()}`, "the flag carries runSetId() of the planted side");
assert.equal(new Date(flag1.expires_at).getTime() - new Date(flag1.planted_at).getTime(), 7 * 86_400_000);
pass(`settled: ${settledA.explanation}`);

const repeat = ok(await settleMatch(A, { matchId: first.found.matchId }), "settle again");
assert.equal(repeat.alreadySettled, true);
assert.equal(repeat.shadow.verdict, "win", "a repeated settle returns the stored Shadow result");
assert.equal((await q("select count(*)::int as n from flags"))[0].n, 1);
pass("settling twice returns the stored result and plants nothing twice");

// ---- 2. a second player answers the Flag ------------------------------------------------
const answer = await queue(B, CATEGORIES.static);
screens.planOpponent = answer.board;
screens.matchAnswer = answer.found;
assert.ok(!answer.found.seeding, "a contested match, not a seeding one");
assert.equal(answer.found.opponent.displayName, "mira");
assert.equal(answer.found.flag.answering, true);
assert.deepEqual(answer.ids, first.ids, "the answer is played on the planter's three");
await play(B, answer.found.matchId, answer.ids, [95, 95, 95]);
const aBefore = await ratingOf(A), bBefore = await ratingOf(B);
const settledB = ok(await settleMatch(B, { matchId: answer.found.matchId }), "settle answer");
screens.resultAnswer = settledB;
assert.equal(settledB.verdict, "loss");
assert.equal(settledB.rated, true);
assert.equal(settledB.flag.answered, true);
assert.ok(await ratingOf(A) > aBefore, "the planter is rated: they won");
assert.ok(await ratingOf(B) < bBefore, "the answerer is rated: they lost");
assert.equal(await receipts(A), 1);
assert.equal(await receipts(B), 1);
const flagAfter = (await q("select * from flags where id=$1", [flag1.id]))[0];
assert.equal(flagAfter.status, "answered");
assert.equal(flagAfter.answered_by, B);
assert.equal(flagAfter.answer_match_id, answer.found.matchId);
const planterSide = (await q("select submitted_at, result from match_sides where match_id=$1 and player_id=$2", [answer.found.matchId, A]))[0];
assert.equal(planterSide.result, "win");
assert.ok(new Date(planterSide.submitted_at) < new Date(answer.found.expiresAt), "rating the planter keeps the run set's identity");
pass(`second player answered the Flag: rated both sides (A ${Math.round(aBefore)}→${Math.round(await ratingOf(A))}, B ${Math.round(bBefore)}→${Math.round(await ratingOf(B))})`);

// ---- 3. the planter's next launch -------------------------------------------------------
const news = ok(await queueBoard(A, {}), "planter board");
screens.planterNews = news;
assert.deepEqual(news.news, [flag1.id]);
assert.equal(news.flags[0].status, "answered");
assert.equal(news.flags[0].verdict, "win");
assert.equal(news.flags[0].answeredBy, "kestrel");
assert.ok(news.flags[0].ratingChange > 0);
assert.match(news.flags[0].line, /^Your Static Clicking Flag was answered by kestrel: you won, \+\d+ rating\.$/);
assert.equal(news.shadow.streak, 1);
assert.equal(news.shadow.next.rung, 3, "a Shadow win moves the next one a rung up");
const acked = ok(await queueBoard(A, { ack: [flag1.id] }), "ack");
assert.deepEqual(acked.news, []);
assert.equal(ok(await queueBoard(B, { ack: [flag1.id] }), "foreign ack").news.length, 0);
assert.ok((await q("select seen_at from flags where id=$1", [flag1.id]))[0].seen_at, "acknowledged once, by its planter");
pass(`planter's board on next launch: "${news.flags[0].line}", then quiet once acknowledged`);

// ---- 4. later answers rate only the answerer ---------------------------------------------
await q("update ratings set rating=(select rating from ratings where player_id=$1) where player_id=$2", [A, C]);
const third = await queue(C, CATEGORIES.static);
assert.equal(third.found.opponent.displayName, "mira", "drew the planter's run set again");
assert.equal(third.found.flag, null, "an answered flag is not offered as a flag");
await play(C, third.found.matchId, third.ids, [99, 99, 99]);
const aMid = await ratingOf(A);
ok(await settleMatch(C, { matchId: third.found.matchId }), "settle third");
assert.equal(await receipts(A), 1, "the planter's run set has had its one rating");
assert.equal(await ratingOf(A), aMid);
assert.equal(await receipts(C), 1);
pass("a third player on the same run set is rated alone: one rating per run set for its owner");

// ---- 5. two answerers racing one Flag ---------------------------------------------------
const expectedSecond = planShadow(SHADOW_DAYS, A, await records(A), CATEGORIES.precise);
const tracking = await queue(A, CATEGORIES.precise);
assert.equal(tracking.found.seeding, true);
assert.equal(tracking.found.shadow.ordinal, 1);
assert.equal(tracking.found.shadow.percentile, expectedSecond.percentile);
assert.equal(tracking.found.shadow.skill, "Tracking");
await play(A, tracking.found.matchId, tracking.ids, [190, 190, 190]);
const lost = ok(await settleMatch(A, { matchId: tracking.found.matchId }), "settle second Shadow");
screens.resultShadowLoss = lost;
assert.equal(lost.shadow.verdict, "loss");
assert.match(lost.explanation, /-percentile day beat you: −5\.0% vs \+\d\.\d% against baselines\./);
assert.equal(lost.flag.status, "open", "a lost Shadow still plants the run set");
const flag2 = (await q("select * from flags where match_id=$1", [tracking.found.matchId]))[0];
const raceB = await queue(B, CATEGORIES.precise), raceD = await queue(D, CATEGORIES.precise);
assert.equal(raceB.found.flag.answering, true);
assert.equal(raceD.found.flag.answering, true);
await play(B, raceB.found.matchId, raceB.ids, [50, 50, 50]);
await play(D, raceD.found.matchId, raceD.ids, [50, 50, 50]);
const receiptsA = await receipts(A);
rpcLog.length = 0;
// Settled concurrently: both read the flag as open before either commits, so the loser
// reaches commit_flag_answer, is refused 'flag-closed' and settles again without it.
const [dSettled, bSettled] = (await Promise.all([
  settleMatch(D, { matchId: raceD.found.matchId }), settleMatch(B, { matchId: raceB.found.matchId }),
])).map((r, i) => ok(r, `race settle ${i}`));
const winner = (await q("select answered_by from flags where id=$1", [flag2.id]))[0].answered_by;
assert.ok(winner === D || winner === B);
assert.equal([dSettled, bSettled].filter((s) => s.flag?.answered).length, 1, "exactly one answer settles the flag");
assert.equal((winner === D ? dSettled : bSettled).flag?.answered, true);
assert.ok(dSettled.rated && bSettled.rated);
assert.equal(await receipts(A), receiptsA + 1, "the planter is rated exactly once for the race");
assert.equal(await receipts(B) + await receipts(D), 3, "both answerers are rated for their own match");
const reclaim = (await q(`select commit_flag_answer($1, $2, 'settled', '[]'::jsonb, '[]'::jsonb) as r`,
  [flag2.id, winner === D ? raceB.found.matchId : raceD.found.matchId]))[0].r;
assert.deepEqual(reclaim, { committed: false, reason: "flag-closed" }, "an answered flag refuses a second claim");
const claims = rpcLog.filter((r) => r.name === "commit_flag_answer").map((r) => r.result.committed ? "committed" : r.result.reason);
assert.deepEqual(claims.sort(), ["committed", "flag-closed"], "both answers tried to claim the flag; the loser was refused and settled again");
pass(`two answerers racing one Flag: ${winner === D ? "D" : "B"} settled it rated for both, the other was rated alone`);

// ---- 6. an expired Flag ---------------------------------------------------------------
const speed = await queue(A, CATEGORIES.speed);
await play(A, speed.found.matchId, speed.ids, [100, 100, 100]);
const speedSettled = ok(await settleMatch(A, { matchId: speed.found.matchId }), "settle third Shadow");
assert.equal(speedSettled.shadow.comparable, 0, "no earlier runs on these three");
assert.equal(speedSettled.shadow.verdict, "draw");
assert.match(speedSettled.explanation, /^None of these 3 scenarios had earlier runs/);
const flag3 = (await q("select * from flags where match_id=$1", [speed.found.matchId]))[0];
await q("update flags set planted_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id=$1", [flag3.id]);
const late = await queue(B, CATEGORIES.speed);
assert.equal(late.found.opponent.displayName, "mira");
assert.equal(late.found.flag, null, "an expired flag is not offered");
await play(B, late.found.matchId, late.ids, [100, 100, 100]);
const receiptsBeforeLate = await receipts(A);
ok(await settleMatch(B, { matchId: late.found.matchId }), "settle late answer");
assert.equal(await receipts(A), receiptsBeforeLate, "an expired flag rates nobody but its answerer");
const closed = ok(await queueBoard(A, {}), "board after expiry");
screens.boardLater = closed;
const expiredFlag = closed.flags.find((f: any) => f.id === flag3.id);
assert.equal(expiredFlag.status, "expired");
assert.match(expiredFlag.line, /expired unanswered/);
assert.equal((await q("select status from flags where id=$1", [flag3.id]))[0].status, "expired");
pass("an expired Flag closes on the planter's next read and rated only its late answerer");

// ---- 7. a Shadow match let expire, and one with a round left early ------------------------
const rungBefore = ok(await queueBoard(A, {}), "board").shadow.next.rung;
const evasive = await queue(A, CATEGORIES.evasive);
await q("update matches set expires_at = now() - interval '1 minute' where id=$1", [evasive.found.matchId]);
const next = ok(await findMatch(A, { category: CATEGORIES.evasive, window: WINDOW }), "requeue after expiry");
assert.notEqual(next.matchId, evasive.found.matchId, "the expired match was retired");
assert.equal((await q("select result from match_shadows where match_id=$1", [evasive.found.matchId]))[0].result, "forfeit");
assert.equal(next.shadow.rung, Math.max(0, rungBefore - 1), "letting a Shadow match expire is a Shadow loss");
assert.equal((await q("select count(*)::int as n from flags where match_id=$1", [evasive.found.matchId]))[0].n, 0);
pass(`an expired Shadow match is a forfeit: the ladder steps down to rung ${next.shadow.rung} and nothing is planted`);

await play(A, next.matchId, next.scenarios.map((s: any) => s.id), [100, 100, 100], 10);
const voided = ok(await settleMatch(A, { matchId: next.matchId }), "settle abandoned round");
assert.equal(voided.verdict, "void");
assert.equal((await q("select result from match_shadows where match_id=$1", [next.matchId]))[0].result, "void");
assert.equal(ok(await queueBoard(A, {}), "board").shadow.next.rung, next.shadow.rung, "a void leaves the ladder where it was");
pass("a round left early voids the Shadow match: no result, the ladder holds");

const pressed = await queue(A, CATEGORIES.evasive);
assert.equal(pressed.found.seeding, true);
const left = ok(await abandonMatch(A, {}), "abandon a Shadow match");
assert.equal(left.rated, false);
assert.equal(left.shadow, true);
assert.match(left.message, /^Shadow match abandoned\. It counts as a loss to an? \d+(st|nd|rd|th)-percentile day; nothing was rated and no Flag was planted\./);
assert.ok(!/no opponent/.test(left.message));
assert.equal((await q("select result from match_shadows where match_id=$1", [pressed.found.matchId]))[0].result, "forfeit");
assert.equal(ok(await queueBoard(A, {}), "board").shadow.next.rung, Math.max(0, next.shadow.rung - 1), "pressing Abandon costs the same rung as letting it expire");
pass(`pressing Abandon on a Shadow match: "${left.message}"`);

const shadowReceipts = (await q("select count(*)::int as n from rating_history where match_id in (select match_id from match_shadows)"))[0].n;
assert.equal(shadowReceipts, 0, "no Shadow match ever wrote a rating receipt");
pass("across every Shadow match played here, no rating receipt was written");

mkdirSync(".cache/queue-ui", { recursive: true });
writeFileSync(".cache/queue-ui/screens.json", JSON.stringify(screens, null, 1));

await db.close();
console.log(`\nOK: ${checks} queue-flow checks against the shipped handlers and migrations`);
