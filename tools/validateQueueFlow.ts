/**
 * Drive ranked v2's shipped find-match, settle-match and abandon-match, and queue-board,
 * through Shadows and Flags against a real migrated Postgres (PGlite).
 *
 *   npx tsx tools/validateQueueFlow.ts      (part of npm run validate:queue)
 *
 * Only authentication, the rate limiter, tournament notification and the HTTP transport are
 * replaced. Every query the handlers and their shared helpers make runs as SQL against the
 * migrations through tools/postgrestShim.mjs, including ranked v2's ranked_pool_rounds and
 * open_ranked_match, and every write that settles anything goes through the same commit
 * functions production calls.
 *
 * The story, each step asserted:
 *
 *   1. an empty pool: the board says "Shadow" before the player commits, find-match fields
 *      exactly the Shadow the core predicts and freezes its scores, a requeue hands back the
 *      same match and Shadow, and settling decides it best of three on raw score, moves no
 *      rating, and banks the side (never "Nothing was rated")
 *   2. a second player: the board says banked rounds are waiting, find-match draws the
 *      first player's rounds, and settling rates the second player only
 *   3. the first player's next launch: the board tells them who played their banked rounds
 *      and how many rounds they took, once
 *   4. find-match's own planting: the board predicts it, and the seeding match it opens
 *      carries a Shadow too; pressing Abandon on it is a Shadow loss with its own message
 *   5. the ladder: a win moves the next Shadow up a rung, a loss down; letting a Shadow
 *      match expire is a forfeit; a round left early is no result
 *   6. across all of it, no Shadow match ever wrote a rating receipt
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { build } from "esbuild";

import { createAdmin } from "./postgrestShim.mjs";
import { planShadow, type ShadowRecord } from "../src/core/match/shadow.ts";
import { SHADOW_SCORES } from "../src/core/match/shadowScores.ts";

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

// ---- fixtures: a season of real Intermediate scenarios ----------------------------------

const q = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows;
const CATEGORIES = { static: "Static Clicking", precise: "Precise Tracking", speed: "Speed Switching", evasive: "Evasive Switching" } as const;
const seasonFile = JSON.parse(readFileSync("data/seasons/season-1.json", "utf8")) as { scenarios: { scenario: string; category: string; window: number }[] };
const scenarioIds: Record<string, number[]> = {};
const season = (await q(`insert into seasons(name,status,windows,window_size) values('Queue test season','draft','{Novice,Intermediate}',4) returning id`))[0].id;
for (const [key, category] of Object.entries(CATEGORIES)) {
  const names = seasonFile.scenarios.filter((x) => x.category === category && x.window === 1).map((x) => x.scenario).slice(0, 3);
  assert.equal(names.length, 3, `Season 1 has three ${category} scenarios in Intermediate`);
  scenarioIds[category] = [];
  for (const [i, name] of names.entries()) {
    const id = (await q(`insert into scenarios(name,duration_seconds) values($1,60) on conflict (name) do update set duration_seconds = 60 returning id`, [name]))[0].id;
    await q(`insert into season_scenarios(season_id,scenario_id,category,family,window_index) values($1,$2,$3,$4,1)`, [season, id, category, `${key}-${i}`]);
    scenarioIds[category].push(Number(id));
  }
}
const poolIds = Object.values(scenarioIds).flat();
const filler = (await q(`select name from scenarios where id <> all($1::bigint[]) order by id limit 1`, [poolIds]))[0].name;
const nameOf = new Map((await q(`select id,name from scenarios where id = any($1::bigint[])`, [poolIds])).map((r) => [Number(r.id), r.name as string]));

let digest = 0;
const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
async function player(name: string): Promise<string> {
  const id = (await q("insert into auth.users default values returning id"))[0].id;
  await q("insert into players(id,steam_id,display_name) values($1,$2,$3)", [id, String(76561190000000000n + BigInt(++digest)), name]);
  for (let i = 0; i < 50; i++) {
    await q(`insert into runs(player_id,scenario_name,score,played_at,created_at,csv_sha256,verification_tier)
      values($1,$2,100,$3,$3,$4,'consistent')`, [id, filler, days(20 + i / 100), `fill-${++digest}`]);
  }
  return id;
}
/** One run per scenario at the given scores, filed against the match. */
async function play(playerId: string, matchId: string, ids: number[], scores: number[], seconds = 60) {
  for (const [i, sid] of ids.entries()) {
    const n = ++digest;
    const challengeStart = `00:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.${String(n).padStart(3, "0").slice(-3)}`;
    await q(`insert into runs(player_id,scenario_name,score,played_at,csv_sha256,verification_tier,match_id,duration_seconds,challenge_start)
      values($1,$2,$3,$4,$5,'consistent',$6,$7,$8)`,
      [playerId, nameOf.get(sid), scores[i], new Date(Date.now() - (3 - i) * 1000).toISOString(), `match-${n}`, matchId, seconds, challengeStart]);
  }
}
const ratingOf = async (id: string) => Number((await q("select rating from ratings where player_id=$1", [id]))[0]?.rating ?? NaN);
const receipts = async (id: string) => Number((await q("select count(*)::int as n from rating_history where player_id=$1", [id]))[0].n);
const records = async (who: string): Promise<ShadowRecord[]> =>
  (await q("select ordinal,percentile,result from match_shadows where player_id=$1", [who])).map((r) => ({ ordinal: r.ordinal, percentile: r.percentile, result: r.result }));

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
        b.onResolve({ filter: /(\/_shared\/|^\.\/)(rateLimit|tournament)\.ts$/ }, () => ({ path: "optional", namespace: "test" }));
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
(globalThis as any).queueAdmin = createAdmin(db);
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
  const ids: number[] = found.scenarios.map((s: any) => s.id);
  if (found.seeding) {
    assert.equal(board.preview.outcome, found.planting ? "plant" : "shadow", "the board said what find-match then did");
    assert.equal(board.preview.shadow.percentile, found.shadow.percentile, "and named the Shadow find-match fielded");
  } else {
    assert.equal(board.preview.outcome, "opponent", "the board said banked rounds were waiting");
  }
  return { found, ids, board };
}

const A = await player("mira"), B = await player("kestrel"), C = await player("juno");
let checks = 0;
const pass = (label: string) => { checks++; console.log(`  ok   ${label}`); };
/** Real handler payloads, photographed by tools/queueUi.cjs. */
const screens: Record<string, unknown> = {};

// ---- 1. empty pool: a Shadow ------------------------------------------------------------
const first = await queue(A, CATEGORIES.static);
const predicted = planShadow(SHADOW_SCORES, A, [], first.ids.map((id) => nameOf.get(id)!));
assert.equal(first.found.seeding, true);
assert.equal(first.found.opponent, null);
assert.equal(first.found.shadow.percentile, predicted.percentile, "the Shadow is the one the core predicts from server data");
assert.equal(first.found.shadow.rung, 0);
assert.ok(first.found.shadow.percentile >= 50 && first.found.shadow.percentile <= 54);
assert.ok(!("scores" in first.found.shadow), "the client is not told the Shadow's scores before playing");
assert.match(first.board.preview.line, /^No one in your band right now\. You'll face a Shadow now \(an? \d+(st|nd|rd|th)-percentile score on each\), and your three runs join the bank/);
assert.equal(first.board.preview.scored, 3, "the board says how many scenarios the Shadow has a score on");
const row = (await q("select * from match_shadows where match_id=$1", [first.found.matchId]))[0];
assert.deepEqual(row.scores.map(Number), predicted.scores, "the Shadow's scores are frozen at creation");
assert.ok(predicted.scores.every((s) => typeof s === "number"));
screens.planShadow = first.board;
screens.matchShadow = first.found;
pass(`empty pool: ${first.found.shadow.label}, predicted by the board and frozen: ${predicted.scores.join(" · ")}`);

const again = ok(await findMatch(A, { category: CATEGORIES.static, window: WINDOW }), "requeue");
assert.equal(again.matchId, first.found.matchId);
assert.equal(again.resumed, true);
assert.equal(again.shadow.percentile, first.found.shadow.percentile, "requeueing hands back the same Shadow");
assert.equal((await q("select count(*)::int as n from match_shadows where player_id=$1", [A]))[0].n, 1);
pass("requeueing returns the open match and its Shadow; the one-open-match rule holds");

const s = predicted.scores as number[];
const aScores = [Math.round(s[0] + 40), Math.round(s[1] - 40), Math.round(s[2] + 40)];
const ratingBefore = await ratingOf(A);
await play(A, first.found.matchId, first.ids, aScores);
const settledA = ok(await settleMatch(A, { matchId: first.found.matchId }), "settle Shadow match");
assert.equal(settledA.seeding, true);
assert.equal(settledA.rated, false);
assert.equal(settledA.verdict, null, "the ladder records no verdict for a match with nobody on the other side");
assert.equal(settledA.shadow.verdict, "win");
assert.deepEqual(settledA.shadow.tally, { won: 2, lost: 1, tied: 0 });
assert.deepEqual(settledA.rounds.map((r: any) => r.result), ["won", "lost", "won"]);
assert.deepEqual(settledA.rounds.map((r: any) => r.opponentScore), predicted.scores, "each round shows the Shadow's score");
assert.ok(!/Nothing was rated|no opponent/.test(settledA.explanation + settledA.message), "never 'Nothing was rated'");
assert.match(settledA.explanation, /^You beat the Shadow 2–1 on rounds: an? \d+(st|nd|rd|th)-percentile score on each\. Shadows move no rating\. Your three runs are now in the bank/);
assert.equal(await ratingOf(A), ratingBefore, "a Shadow moves no rating");
assert.equal(await receipts(A), 0);
const banked = (await q("select scores, match_score, submitted_at from match_sides where match_id=$1", [first.found.matchId]))[0];
assert.deepEqual(banked.scores.map(Number), aScores, "the side is stored with its raw scores, ready for the bank");
screens.resultShadowWin = settledA;
pass(`settled: ${settledA.explanation}`);

const repeat = ok(await settleMatch(A, { matchId: first.found.matchId }), "settle again");
assert.equal(repeat.alreadySettled, true);
assert.equal(repeat.shadow.verdict, "win", "a repeated settle returns the stored Shadow result");
pass("settling twice returns the stored result");

// ---- 2. a second player draws the banked rounds ------------------------------------------
const answer = await queue(B, CATEGORIES.static);
assert.ok(!answer.found.seeding, "a contested match");
assert.equal(answer.found.opponent.displayName, "mira");
assert.match(answer.board.preview.line, /^Banked rounds near your rating are waiting in Intermediate · Static Clicking\./);
const aByScenario = new Map(first.ids.map((id, i) => [id, aScores[i]]));
const bScores = answer.ids.map((id: number, i: number) => (aByScenario.get(id) as number) + (i < 2 ? 25 : -25));
await play(B, answer.found.matchId, answer.ids, bScores);
const aBefore = await ratingOf(A);
const settledB = ok(await settleMatch(B, { matchId: answer.found.matchId }), "settle answer");
assert.equal(settledB.verdict, "win");
assert.deepEqual(settledB.roundTally, { won: 2, lost: 1, tied: 0 });
assert.equal(await ratingOf(A), aBefore, "ranked v2 rates the player who played, not the owner of the rounds");
assert.equal(await receipts(A), 0);
assert.equal(await receipts(B), 1);
pass("second player drew the banked rounds and took 2 of 3: rated alone, as ranked v2 intends");

// ---- 3. the first player's next launch --------------------------------------------------
const news = ok(await queueBoard(A, {}), "owner board");
assert.equal(news.news.length, 1);
assert.equal(news.news[0].line, "kestrel played your banked rounds and took 2 of 3.");
assert.equal(news.news[0].matchId, answer.found.matchId);
assert.ok(news.newsThrough);
assert.equal(news.shadow.next.rung, 1, "a Shadow win moves the next one a rung up");
assert.equal(news.shadow.standing.highestBeaten, first.found.shadow.percentile);
screens.ownerNews = news;
const acked = ok(await queueBoard(A, { ack: news.newsThrough }), "ack");
assert.deepEqual(acked.news, [], "said once");
assert.equal(ok(await queueBoard(A, {}), "after ack").news.length, 0);
assert.equal(ok(await queueBoard(B, {}), "player board").news.length, 0, "nobody has played kestrel's rounds");
pass(`owner's board on next launch: "${news.news[0].line}", then quiet once acknowledged`);

// ---- 4. find-match's own planting, and pressing Abandon ----------------------------------
// juno plays a Static match (rated) so the bank holds juno's Static rounds; kestrel, who has
// just played all three Static scenarios, then queues Any: the best offer is mostly what
// kestrel just played, and the window has fresh ones, so find-match plants.
const jMatch = await queue(C, CATEGORIES.static);
assert.ok(!jMatch.found.seeding);
await play(C, jMatch.found.matchId, jMatch.ids, jMatch.ids.map(() => 1000));
ok(await settleMatch(C, { matchId: jMatch.found.matchId }), "juno settles");
const planted = await queue(B, "Any");
assert.equal(planted.found.seeding, true);
assert.equal(planted.found.planting, true, "find-match planted fresh scenarios");
assert.ok(planted.found.shadow, "and the seeding match it opened carries a Shadow");
assert.match(planted.board.preview.line, /^The players near your rating have banked mostly scenarios you just played, so this is three fresh ones\. You'll face a Shadow now/);
screens.planPlant = planted.board;
const left = ok(await abandonMatch(B, {}), "abandon a Shadow match");
assert.equal(left.rated, false);
assert.equal(left.shadow, true);
assert.match(left.message, /^Shadow match abandoned\. It counts as a loss to an? \d+(st|nd|rd|th)-percentile score on each; nothing was rated/);
assert.equal((await q("select result from match_shadows where match_id=$1", [planted.found.matchId]))[0].result, "forfeit");
pass(`planting predicted and Shadowed; pressing Abandon: "${left.message}"`);

// ---- 5. the ladder ----------------------------------------------------------------------
const recs = await records(A);
const expectedSecond = planShadow(SHADOW_SCORES, A, recs, []);
const second = await queue(A, CATEGORIES.precise);
assert.equal(second.found.shadow.percentile, expectedSecond.percentile);
assert.equal(second.found.shadow.rung, 1);
const s2 = (await q("select scores from match_shadows where match_id=$1", [second.found.matchId]))[0].scores.map(Number);
await play(A, second.found.matchId, second.ids, s2.map((v: number) => Math.round(v - 30)));
const lost = ok(await settleMatch(A, { matchId: second.found.matchId }), "settle second Shadow");
assert.equal(lost.shadow.verdict, "loss");
assert.match(lost.explanation, /^The Shadow took it 3–0 on rounds/);
screens.resultShadowLoss = lost;
const boardLater = ok(await queueBoard(A, {}), "board later");
assert.equal(boardLater.shadow.next.rung, 0, "a loss steps the ladder back down");
assert.equal(boardLater.shadow.standing.lostAbove, second.found.shadow.percentile);
screens.boardLater = boardLater;
pass(`a win took the ladder up to ${second.found.shadow.label}, a 0–3 loss brought it back down`);

const speed = await queue(A, CATEGORIES.speed);
await q("update matches set expires_at = now() - interval '1 minute' where id=$1", [speed.found.matchId]);
const after = ok(await findMatch(A, { category: CATEGORIES.evasive, window: WINDOW }), "queue after expiry");
assert.notEqual(after.matchId, speed.found.matchId, "the expired match was retired");
assert.equal((await q("select result from match_shadows where match_id=$1", [speed.found.matchId]))[0].result, "forfeit");
assert.equal(after.shadow.rung, 0, "letting a Shadow match expire is a Shadow loss (the bottom rung holds)");
pass("an expired Shadow match is a forfeit");

await play(A, after.matchId, after.scenarios.map((x: any) => x.id), [1000, 1000, 1000], 10);
const voided = ok(await settleMatch(A, { matchId: after.matchId }), "settle abandoned round");
assert.equal(voided.verdict, "void");
assert.equal((await q("select result from match_shadows where match_id=$1", [after.matchId]))[0].result, "void");
pass("a round left early voids the Shadow match: no result, not a loss");

// ---- 6. no rating, anywhere ---------------------------------------------------------------
const shadowReceipts = (await q("select count(*)::int as n from rating_history where match_id in (select match_id from match_shadows)"))[0].n;
assert.equal(shadowReceipts, 0, "no Shadow match ever wrote a rating receipt");
pass("across every Shadow match played here, no rating receipt was written");

mkdirSync(".cache/queue-ui", { recursive: true });
writeFileSync(".cache/queue-ui/screens.json", JSON.stringify(screens, null, 1));
await db.close();
console.log(`\nOK: ${checks} queue-flow checks against ranked v2's shipped handlers and the migrations`);
