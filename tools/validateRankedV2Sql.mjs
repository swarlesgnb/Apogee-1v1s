/**
 * Prove ranked v2's two database functions against real Postgres (PGlite), with every
 * migration applied in order.
 *
 *   node tools/validateRankedV2Sql.mjs
 *
 * ranked_pool_rounds must hand back originals and never copies, never the caller, never a
 * tournament leg or another window, and the players nearest the caller's rating first.
 * open_ranked_match must create a match and its sides as one unit, refuse a second while
 * one is open (including two requests at once), and still let a player whose only open
 * side is a copy of their rounds in somebody else's match queue.
 *
 * Every refusal is checked alongside an acceptance it could be confused with, so a
 * function that refused everything, or nothing, fails here.
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

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

const scenarios = (await db.query("select id from scenarios order by id limit 3")).rows.map((r) => r.id);
assert.equal(scenarios.length, 3, "the seed must supply three scenarios");

let steamSerial = 0;
async function player(name, rating) {
  const id = (await db.query("insert into auth.users default values returning id")).rows[0].id;
  await db.query("insert into players(id, steam_id, display_name) values($1, $2, $3)", [id, "765611" + String(++steamSerial).padStart(11, "0"), name]);
  await db.query("insert into ratings(player_id, rating, rd) values($1, $2, 80) on conflict (player_id) do update set rating = excluded.rating, rd = 80", [id, rating]);
  return id;
}

let serial = 0;
/** A match with one side; `copyOf` makes it a copy (submitted before the match existed). */
async function side(owner, { window = 1, rated = true, copy = false, created = "2026-10-01T12:00:00Z", status = "settled" } = {}) {
  const id = (await db.query(
    `insert into matches(category, benchmark_name, difficulty, seed, scenario_ids, status, window_index, rated, created_at)
     values('Any', 'Season 1', 'Intermediate', $1, $2::bigint[], $3, $4, $5, $6) returning id`,
    ["pool-" + ++serial, scenarios, status, window, rated, created],
  )).rows[0].id;
  const submitted = new Date(new Date(created).getTime() + (copy ? -3600_000 : 60_000)).toISOString();
  await db.query(
    `insert into match_sides(match_id, player_id, deltas, scores, match_score, rating_before, rd_before, submitted_at)
     values($1, $2, '{0,0,0}', '{100,100,100}', 0, 1500, 80, $3)`,
    [id, owner, submitted],
  );
  return id;
}

const caller = await player("caller", 1500);
const near = await player("near", 1510);
const far = await player("far", 2400);
const mid = await player("mid", 1650);

const callerOwn = await side(caller);
const nearOriginal = await side(near);
const nearCopy = await side(near, { copy: true });
const nearUnrated = await side(near, { rated: false });
const nearOtherWindow = await side(near, { window: 2 });
const farOriginal = await side(far);
const midOriginal = await side(mid);
for (let i = 0; i < 4; i++) await side(mid, { created: `2026-10-0${2 + i}T12:00:00Z` });

async function pool(players = 40, perPlayer = 20, rating = 1500) {
  return (await db.query("select * from ranked_pool_rounds(1, $1, $2, $3, $4)", [caller, rating, players, perPlayer])).rows;
}

const all = await pool();
const ids = new Set(all.map((r) => r.match_id));
assert.ok(ids.has(nearOriginal) && ids.has(farOriginal) && ids.has(midOriginal), "originals in the window are offered");
assert.ok(!ids.has(nearCopy), "a copy is never offered");
assert.ok(!ids.has(nearUnrated), "a tournament leg is never offered");
assert.ok(!ids.has(nearOtherWindow), "another window is never offered");
assert.ok(!ids.has(callerOwn), "the caller's own rounds are never offered");
assert.ok(all.every((r) => r.scores.length === 3 && r.rating != null), "rows carry scores and the owner's rating");
assert.equal(Number(all.find((r) => r.match_id === nearOriginal).rating_before), 1500, "rating at play time is returned");
console.log("PASS: ranked_pool_rounds offers originals in the window and nothing else");

const two = await pool(2);
assert.deepEqual(new Set(two.map((r) => r.player_id)), new Set([near, mid]), "the two nearest by rating, not the far one");
const fromTop = (await db.query("select distinct player_id from ranked_pool_rounds(1, $1, 2390, 1, 20)", [caller])).rows;
assert.deepEqual(fromTop.map((r) => r.player_id), [far], "nearness is measured from the rating asked about");
const capped = await pool(40, 2);
assert.equal(capped.filter((r) => r.player_id === mid).length, 2, "sides per player are capped");
assert.ok(capped.filter((r) => r.player_id === mid).every((r) => r.submitted_at >= new Date("2026-10-04")), "and are the newest");
console.log("PASS: nearest players first, newest sides each, both bounded");

// ---- open_ranked_match ---------------------------------------------------------------
const matchBody = (seed) => JSON.stringify({
  category: "Any", benchmark_name: "Season 1", difficulty: "Intermediate", window_index: 1, seed,
  scenario_ids: scenarios, expires_at: "2099-01-01T00:00:00Z", engine: 2,
});
const sidesBody = (opponent) => JSON.stringify([
  { player_id: caller, rating_before: 1500, rd_before: 80 },
  ...(opponent ? [{ player_id: opponent, run_ids: [], deltas: [0, 0, 0], scores: [101, 99, 100], match_score: 0,
    provisional: false, rating_before: 1490, rd_before: 70, submitted_at: "2026-10-01T12:01:00Z" }] : []),
]);
const open = (seed, opponent) => db.query("select open_ranked_match($1, $2::jsonb, $3::jsonb) as r", [caller, matchBody(seed), sidesBody(opponent)]).then((q) => q.rows[0].r);

// The caller's rounds sit, copied, in somebody else's open match. That is not a match the
// caller is in, and must not stop them queueing.
const strangers = await side(caller, { copy: true, status: "awaiting_runs", created: "2026-10-09T12:00:00Z" });
const first = await open("v2-a", near);
assert.equal(first.created, true, "a copy of the caller's rounds elsewhere does not block them");
assert.notEqual(first.match_id, strangers);
const made = (await db.query("select * from matches where id = $1", [first.match_id])).rows[0];
assert.equal(made.engine, 2);
assert.equal(made.status, "awaiting_runs");
assert.equal(made.rated, true);
const madeSides = (await db.query("select * from match_sides where match_id = $1 order by rating_before desc", [first.match_id])).rows;
assert.equal(madeSides.length, 2, "both sides are written with the match");
const mine = madeSides.find((s) => s.player_id === caller);
assert.deepEqual([mine.run_ids, mine.deltas, mine.scores, mine.provisional, mine.match_score], [[], [], [], false, null],
  "a side missing keys takes the column defaults, not NULL");
assert.deepEqual(madeSides.find((s) => s.player_id === near).scores.map(Number), [101, 99, 100]);
console.log("PASS: open_ranked_match writes the match and both sides, with defaults where keys are missing");

const second = await open("v2-b", near);
assert.deepEqual([second.created, second.reason, second.match_id], [false, "already-in-match", first.match_id],
  "a second request gets the open match back instead of another");
assert.equal((await db.query("select count(*)::int as n from matches where seed = 'v2-b'")).rows[0].n, 0);

await db.query("update matches set status = 'settled' where id = $1", [first.match_id]);
const racing = await Promise.all([open("race-1"), open("race-2")]);
assert.equal(racing.filter((r) => r.created).length, 1, "two at once create exactly one match");
assert.equal(new Set(racing.map((r) => r.match_id)).size, 1, "and both are answered with it");
console.log("PASS: one open match per player, including two requests at once (single-connection Postgres)");

// Past its deadline, an open match no longer blocks: a finished match the sweep could not
// settle must not keep its player out of the queue for good.
const live = racing.find((r) => r.created).match_id;
await db.query("update matches set expires_at = now() - interval '1 minute' where id = $1", [live]);
const afterExpiry = await open("v2-after-expiry");
assert.equal(afterExpiry.created, true, "an expired open match does not block the next");
await db.query("update matches set expires_at = now() + interval '1 hour' where id = $1", [afterExpiry.match_id]);
assert.equal((await open("v2-blocked")).created, false, "while one in date still does");
console.log("PASS: an expired open match never blocks a new one; a live one always does");

await assert.rejects(
  db.query("select open_ranked_match($1, $2::jsonb, $3::jsonb)", [near, matchBody("v2-c"), sidesBody()]),
  /the caller must have a side/,
);

await db.exec("set role authenticated");
await assert.rejects(db.query("select * from ranked_pool_rounds(1, $1, 1500)", [caller]), (e) => e.code === "42501");
await assert.rejects(db.query("select open_ranked_match($1, $2::jsonb, $3::jsonb)", [caller, matchBody("x"), sidesBody()]), (e) => e.code === "42501");
await db.exec("reset role");
console.log("PASS: a match the caller is not in is refused, and clients cannot call either function");
