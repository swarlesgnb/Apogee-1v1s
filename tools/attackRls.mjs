/**
 * Attack the RLS policies as a hostile authenticated player.
 *
 * validateSchema stubs auth.uid() to null, which proves the policies COMPILE but can
 * never prove what a signed-in attacker is actually allowed to do. This stub reads the
 * caller's id from a setting instead, so the session can genuinely be somebody.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { dirname, join as pjoin } from "node:path";
import { fileURLToPath } from "node:url";
const root = pjoin(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");

const STUB = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select nullif(current_setting('test.player_id', true), '')::uuid $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`;

const db = new PGlite();
await db.waitReady;
await db.exec(STUB);
for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(migrationsDir, f), "utf8"));
}
await db.exec(readFileSync(join(root, "supabase", "seed.sql"), "utf8"));

let findings = 0;
/**
 * Run one attack and say what actually happened.
 *
 * Counting 'no exception raised' as success is WRONG, and the first draft of this file
 * did exactly that. Under RLS an UPDATE or DELETE with no matching policy does not
 * raise - it simply matches no rows and reports success. That made four properly
 * blocked operations look like holes. The number of rows actually changed is what
 * decides, not the absence of an error.
 */
const attack = async (label, sql, expectBlocked = true) => {
  let affected = 0;
  try {
    const r = await db.query(sql);
    affected = r.affectedRows ?? 0;
  } catch (err) {
    const m = String(err.message).split(String.fromCharCode(10))[0];
    if (expectBlocked) console.log('  ok       ' + label + ' -- refused (' + m.slice(0, 55) + ')');
    else { findings++; console.log('  HOLE     ' + label + ' -- refused but should be allowed: ' + m); }
    return;
  }
  if (affected === 0) {
    if (expectBlocked) console.log('  ok       ' + label + ' -- no error raised, but 0 rows changed');
    else { findings++; console.log('  HOLE     ' + label + ' -- 0 rows changed, expected it to work'); }
    return;
  }
  if (expectBlocked) { findings++; console.log('  HOLE     ' + label + ' -- CHANGED ' + affected + ' row(s)'); }
  else console.log('  ok       ' + label + ' -- ' + affected + ' row(s), as intended');
};

// two players: the attacker, and a victim
const mk = async (steam, name) => {
  const r = await db.query(`insert into auth.users default values returning id`);
  const id = r.rows[0].id;
  await db.exec(`insert into players (id, steam_id, display_name) values ('${id}', '${steam}', '${name}')`);
  return id;
};
const attacker = await mk("76561000000000001", "attacker");
const victim = await mk("76561000000000002", "victim");
const scen = (await db.query(`select id from scenarios limit 1`)).rows[0].id;
// The server has the attacker under review, which is exactly the state they would most
// like to erase (SEC-03 in docs/fleet/security.md).
await db.exec(`update players set flags = '{"under_review": true, "suspect_runs": 3}'::jsonb where id = '${attacker}'`);

await db.exec(`set role authenticated`);
await db.exec(`set test.player_id = '${attacker}'`);
console.log(`\nacting as authenticated player ${attacker}\n`);

console.log("-- inserting runs --");
// Every column the backfill upsert actually sends: RunPayload plus player_id. This one
// must stay ALLOWED - the column grant is only correct if the real client still works,
// and a grant list that has drifted from RunPayload fails the whole 11k-row batch.
await attack("insert an ordinary run for myself, exactly as backfill sends it",
  `insert into runs (player_id, scenario_name, score, accuracy, avg_ttk, kills,
                     hit_count, miss_count, played_at, challenge_start, hash,
                     game_version, avg_fps, resolution, cm360, dpi, fov, csv_sha256,
                     kill_rows, tz_offset_minutes)
   values ('${attacker}', 'x', 100, 0.9, 0.4, 10, 90, 10, now(), null, null,
           null, 240, '2560x1440', 30, 800, 103, 'sha-ordinary', null, -60)`, false);

// The wall clock is derived from played_at and the offset, never named by a client:
// it is half of a run's identity (20261003000026).
await attack("name my own run's wall clock (ended_local)",
  `insert into runs (player_id, scenario_name, score, played_at, csv_sha256, ended_local)
   values ('${attacker}', 'x', 100, now(), 'sha-wall', '2020-01-01 00:00:00')`);

// Granted columns only, so that what refuses this is runs_insert_self and not the
// column grant getting there first - this is the one check in the file that proves the
// ROW policy still does its job.
await attack("insert a run for ANOTHER player",
  `insert into runs (player_id, scenario_name, score, played_at, csv_sha256)
   values ('${victim}', 'x', 100, now(), 'sha-victim')`);

await attack("insert my own run pre-stamped verification_tier = 'verified'",
  `insert into runs (player_id, scenario_id, scenario_name, score, played_at, csv_sha256, verification_tier)
   values ('${attacker}', ${scen}, 'x', 999999, now(), 'sha-tier', 'verified')`);

await attack("insert my own run with verification_notes of my choosing",
  `insert into runs (player_id, scenario_name, score, played_at, csv_sha256, verification_notes)
   values ('${attacker}', 'x', 100, now(), 'sha-notes', '{"reasons": []}'::jsonb)`);

// resolve_scenario_id() overwrites this on insert anyway, so the grant is belt and
// braces - but a check that only passes because of a trigger elsewhere is a check that
// dies quietly the day the trigger changes.
await attack("file my run against a scenario_id of my choosing",
  `insert into runs (player_id, scenario_id, scenario_name, score, played_at, csv_sha256)
   values ('${attacker}', ${scen}, 'not-that-scenario', 100, now(), 'sha-scenario')`);

await attack("name my own duration_seconds, to make a real run look like a crash",
  `insert into runs (player_id, scenario_name, score, played_at, csv_sha256, duration_seconds)
   values ('${attacker}', 'x', 100, now(), 'sha-duration', 3)`);

await attack("attach my own run to an arbitrary match_id",
  `insert into runs (player_id, scenario_id, scenario_name, score, played_at, csv_sha256, match_id)
   values ('${attacker}', ${scen}, 'x', 999999, now(), 'sha-match', gen_random_uuid())`);

// The FK above rejected a RANDOM match id. The question that decides how bad the
// pre-stamped tier is: can the attacker use a REAL match they are legitimately in?
await db.exec("reset role");
const realMatch = (await db.query("insert into matches (category, status, benchmark_name, difficulty, seed, scenario_ids) values ('Clicking', 'awaiting_runs', 'Voltaic S5', 'Intermediate', 'seed-1', array[" + scen + "," + scen + "," + scen + "]::bigint[]) returning id")).rows[0].id;
await db.exec("insert into match_sides (match_id, player_id) values ('" + realMatch + "', '" + attacker + "')");
await db.exec("set role authenticated");
await db.exec("set test.player_id = '" + attacker + "'");
console.log("");
console.log("-- escalation: a REAL match the attacker is in --");
await attack("attach a self-inserted 999999 run to my real match, tier verified",
  "insert into runs (player_id, scenario_name, score, played_at, csv_sha256, match_id, verification_tier)" +
  " values ('" + attacker + "', 'x', 999999, now(), 'sha-escalate', '" + realMatch + "', 'verified')");

// match_id alone is enough to be worth blocking: settle-match reads the match's runs by
// match_id, so an unverified fabrication still reaches the rating, one tier lower.
await attack("attach a self-inserted run to my real match without naming a tier",
  "insert into runs (player_id, scenario_name, score, played_at, csv_sha256, match_id)" +
  " values ('" + attacker + "', 'x', 999999, now(), 'sha-escalate-2', '" + realMatch + "')");

console.log("\n-- rewriting history --");
await attack("backdate the server receipt time of a history upload",
  `insert into runs (player_id, scenario_name, score, played_at, csv_sha256, created_at)
   values ('${attacker}', 'x', 1, now(), 'sha-backdated-receipt', '2000-01-01Z')`);
await attack("update my own run's score after the fact",
  `update runs set score = 999999 where player_id = '${attacker}'`);
await attack("delete my own run",
  `delete from runs where player_id = '${attacker}'`);

console.log("\n-- my own profile --");
// Every column of players is server-owned: steam-auth writes the profile on sign-in, the
// KovaaK's link is written by the function that verified it, and flags are moderation.
// No client path updates the table, so no column is granted (SEC-03, SEC-07).
await attack("rewrite my own steam_id (the anti-cheat join key)",
  `update players set steam_id = '76561000000000099' where id = '${attacker}'`);
await attack("rename myself to an HTML payload other players will see",
  `update players set display_name = '<img src=x onerror=alert(1)>' where id = '${attacker}'`);
await attack("clear my own moderation flags",
  `update players set flags = '{}'::jsonb where id = '${attacker}'`);
await attack("link a KovaaK's account myself",
  `update players set kovaaks_username = 'someones_account' where id = '${attacker}'`);
await attack("rewrite my own avatar and country",
  `update players set avatar_url = 'https://evil.invalid/x.png', country = 'XX' where id = '${attacker}'`);
await attack("create a second profile for myself",
  `insert into players (id, steam_id, display_name) values (gen_random_uuid(), '76561000000000098', 'sock')`);
await attack("delete my own profile", `delete from players where id = '${attacker}'`);

console.log("\n-- the tables the security model depends on --");
await attack("write my own rating", `update ratings set rating = 9999 where player_id = '${attacker}'`);
await attack("insert a rating row", `insert into ratings (player_id, rating) values ('${victim}', 9999)`);
await attack("write a baseline", `insert into baselines (player_id, scenario_id, value) values ('${attacker}', ${scen}, 1)`);
await attack("write a verified PB", `insert into verified_pbs (player_id, scenario_id, score) values ('${attacker}', ${scen}, 999999)`);
await attack("make myself an admin", `insert into admins (player_id) values ('${attacker}')`);
await attack("edit reference data (scenarios)", `update scenarios set world_record = 1 where id = ${scen}`);
await attack("erase my own rate limit", `delete from rate_limits where player_id = '${attacker}'`);
await attack("free a ranked performance for replay", `delete from ranked_run_fingerprints where player_id = '${attacker}'`);
await attack("pre-claim a ranked performance",
  `insert into ranked_run_fingerprints (player_id, scenario_id, challenge_start, score, first_run_id)
   values ('${attacker}', ${scen}, '10:00:00.000', 1, gen_random_uuid())`);
await attack("pin my match clock to an offset of my choosing",
  `update match_sides set tz_offset_minutes = 300 where player_id = '${attacker}'`);
await attack("forget a Steam sign-in nonce so it can be replayed", `delete from steam_openid_nonces`);
await attack("plant a Steam sign-in attempt",
  `insert into steam_signin_attempts (state_hash, port) values ('x', 50000)`);

console.log("\n-- tournaments --");
// A tournament somebody else hosts, created the way tournament-action does: by the server.
await db.exec("reset role");
const cupId = (await db.query("select gen_random_uuid() as id")).rows[0].id;
const cupState = JSON.stringify({
  schemaVersion: 1, id: cupId, revision: 0,
  config: { name: "Victim Cup", groupCount: 2, groupSize: 3, qualifiers: 1, seeding: "seeded", randomSeed: "r" },
  phase: "registration", entrants: [], groups: [], fixtures: [],
});
await db.query(
  "insert into tournaments (id, host_id, name, category, window_index, window_name, state) values ($1, $2, 'Victim Cup', 'Any', 0, 'Intermediate', $3::jsonb)",
  [cupId, victim, cupState],
);
await db.exec("set role authenticated");
await db.exec("set test.player_id = '" + attacker + "'");

await attack("host a tournament by inserting it directly",
  `insert into tournaments (host_id, name, category, window_index, window_name, state)
   values ('${attacker}', 'Mine', 'Any', 0, 'Intermediate', '{}'::jsonb)`);
await attack("rewrite somebody else's tournament state",
  `update tournaments set phase = 'completed' where id = '${cupId}'`);
await attack("enter myself by writing the member row",
  `insert into tournament_members (tournament_id, player_id, seed, checked_in) values ('${cupId}', '${attacker}', 1, true)`);
await attack("claim a fixture leg against a match of my choosing",
  `insert into tournament_legs (tournament_id, fixture_id, attempt, leg, player_id, match_id)
   values ('${cupId}', 'f', 1, 2, '${attacker}', '${realMatch}')`);
await attack("file my own receipt, naming myself the winner",
  `insert into tournament_receipts (tournament_id, receipt_id, fixture_id, attempt, match_id, outcome)
   values ('${cupId}', 'mine', 'f', 1, gen_random_uuid(), '{"kind":"win","winnerId":"${attacker}"}'::jsonb)`);
await attack("call the aggregate commit directly",
  `select tournament_commit('${cupId}', 0, '{}'::jsonb, null, null, null, 'result', null, '{}'::jsonb)`);
await attack("call the leg reservation directly",
  `select tournament_open_leg('${cupId}', 'f', 1, '${attacker}', 's', array[1,2,3]::bigint[], 'Any', 'S', 'I', 0, 480)`);
await attack("mark my real match unrated so a loss costs nothing",
  `update matches set rated = false where id = '${realMatch}'`);

console.log("\n-- reading other people --");
const readOthers = async (label, sql) => {
  try {
    const r = await db.query(sql);
    console.log(`  ${r.rows.length > 0 ? "SEES " : "ok   "}  ${label}: ${r.rows.length} row(s)`);
    if (r.rows.length > 0) findings++;
  } catch (e) { console.log(`  ok     ${label}: blocked`); }
};
// Name only granted columns. `select *` here reported "blocked" against players and
// runs because the STAR hit a column privilege, which looks identical to RLS refusing
// the row and would keep saying "ok" even if the policy were dropped entirely.
await readOthers("another player's profile row", `select id, steam_id from players where id = '${victim}'`);
await readOthers("another player's runs", `select id, score from runs where player_id = '${victim}'`);
await readOthers("another player's baselines", `select * from baselines where player_id = '${victim}'`);
// The ladder is public; the table is not. A world-readable ratings table was an ordered
// list of every player_id (SEC-06). list-duels, find-match and apex-board serve it.
await readOthers("every other player_id and rating via ratings",
  `select player_id, rating from ratings where player_id <> '${attacker}'`);
await readOthers("the ranked replay claims", `select * from ranked_run_fingerprints`);
await readOthers("Steam sign-in nonces", `select * from steam_openid_nonces`);
// Closed outright, not narrowed: list-tournaments builds the only view there is.
await readOthers("a tournament's stored state", `select id, state from tournaments`);
await readOthers("who entered which tournament", `select * from tournament_members`);
await readOthers("which match is which fixture leg", `select * from tournament_legs`);
await readOthers("the receipts behind a bracket", `select * from tournament_receipts`);

// A match the attacker has no side in. The participant policies used to query
// match_sides from inside match_sides' own policy, which Postgres refuses as infinite
// recursion - so these two printed "blocked" for the wrong reason, and so did the
// attacker's reads of their OWN match, which nothing here checked.
await db.exec("reset role");
const victimMatch = (await db.query("insert into matches (category, status, benchmark_name, difficulty, seed, scenario_ids) values ('Clicking', 'awaiting_runs', 'Voltaic S5', 'Intermediate', 'seed-2', array[" + scen + "," + scen + "," + scen + "]::bigint[]) returning id")).rows[0].id;
await db.exec("insert into match_sides (match_id, player_id) values ('" + victimMatch + "', '" + victim + "')");
await db.exec("set role authenticated");
await db.exec("set test.player_id = '" + attacker + "'");
await readOthers("a match I have no side in", `select id from matches where id = '${victimMatch}'`);
await readOthers("the sides of a match I have no side in", `select player_id from match_sides where match_id = '${victimMatch}'`);

// The other direction: a participant must be able to read their own match, or the
// client cannot restore it after a restart. An error here is a failure, not a pass.
const readOwn = async (label, sql) => {
  try {
    const r = await db.query(sql);
    if (r.rows.length > 0) console.log(`  ok     ${label}: ${r.rows.length} row(s)`);
    else { findings++; console.log(`  BROKEN ${label}: 0 rows`); }
  } catch (e) { findings++; console.log(`  BROKEN ${label}: ${String(e.message).split("\n")[0]}`); }
};
await readOwn("my own match", `select id from matches where id = '${realMatch}'`);
await readOwn("my own side", `select player_id from match_sides where match_id = '${realMatch}'`);
// The client's two real reads of the narrowed tables, exactly as they are written.
await readOwn("my own profile, as session.ts reads it",
  `select id, steam_id, display_name, avatar_url, kovaaks_username from players where id = '${attacker}'`);
await readOwn("my own rating, as fetchStanding reads it",
  `select rating, rd, matches_played from ratings where player_id = '${attacker}'`);

// `attack` counts changed rows, and a SELECT changes none, so it would pass this even if
// the call went through. Only a refusal counts.
try {
  await db.query(`select consume_rate_limit('${victim}', 'find-match', 1, '1 hour'::interval)`);
  findings++;
  console.log("  HOLE   spend another player's rate limit: the call went through");
} catch { console.log("  ok     spend another player's rate limit: refused"); }

// Column privileges, on rows RLS does hand over.
const readOwnColumn = async (label, column) => {
  try {
    await db.query(`select ${column} from runs where player_id = '${attacker}'`);
    findings++;
    console.log(`  HOLE   my own runs.${column}: readable (${label})`);
  } catch { console.log(`  ok     my own runs.${column}: refused (${label})`); }
};
await readOwnColumn("names the check that caught the run", "verification_notes");

// After every attack above, as the service role: the profile is as the server left it,
// and moderation can still write it.
await db.exec("reset role");
const profile = (await db.query(`select steam_id, display_name, flags from players where id = '${attacker}'`)).rows[0];
if (profile.steam_id !== "76561000000000001" || profile.display_name !== "attacker" || profile.flags?.under_review !== true) {
  findings++;
  console.log(`  HOLE   my profile changed: ${JSON.stringify(profile)}`);
} else console.log("  ok     my profile is exactly as the server wrote it, flags included");
try {
  await db.query(`update players set flags = '{"under_review": false}'::jsonb where id = '${attacker}'`);
  console.log("  ok     the server can still write moderation flags");
} catch (e) { findings++; console.log(`  BROKEN the server cannot write flags: ${e.message}`); }

console.log(`\n${findings === 0 ? "no holes found" : `${findings} finding(s)`}`);
await db.close();
