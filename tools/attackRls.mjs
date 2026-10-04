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
                     kill_rows)
   values ('${attacker}', 'x', 100, 0.9, 0.4, 10, 90, 10, now(), null, null,
           null, 240, '2560x1440', 30, 800, 103, 'sha-ordinary', null)`, false);

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

console.log("\n-- the tables the security model depends on --");
await attack("write my own rating", `update ratings set rating = 9999 where player_id = '${attacker}'`);
await attack("insert a rating row", `insert into ratings (player_id, rating) values ('${victim}', 9999)`);
await attack("write a baseline", `insert into baselines (player_id, scenario_id, value) values ('${attacker}', ${scen}, 1)`);
await attack("write a verified PB", `insert into verified_pbs (player_id, scenario_id, score) values ('${attacker}', ${scen}, 999999)`);
await attack("make myself an admin", `insert into admins (player_id) values ('${attacker}')`);
await attack("edit reference data (scenarios)", `update scenarios set world_record = 1 where id = ${scen}`);
await attack("erase my own rate limit", `delete from rate_limits where player_id = '${attacker}'`);

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

console.log("\n-- the Daily board and open challenges --");
// A board entry and an open challenge somebody else made, the way the functions make them.
await db.exec("reset role");
await db.query(
  `insert into daily_results (daily_number, window_index, player_id, season_name, scenario_names, run_ids,
     scores, baselines, prior_runs, glyphs, mean_delta, provisional, lowest_tier, played_at)
   values (3, 1, $1, 'Season 1', array['a','b','c'], array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()],
     array[1,2,3], array[1,2,3], array[5,5,5], 'ANB', 0.01, false, 'consistent', now())`,
  [victim],
);
await db.query(
  `insert into duels (challenger_id, code, match_id, expires_at) values ($1, 'VCTM2345', $2, now() + interval '7 days')`,
  [victim, realMatch],
);
await db.exec("set role authenticated");
await db.exec("set test.player_id = '" + attacker + "'");

await attack("put myself on a Daily board by writing the entry",
  `insert into daily_results (daily_number, window_index, player_id, season_name, scenario_names, run_ids,
     scores, baselines, prior_runs, glyphs, mean_delta, provisional, lowest_tier, played_at)
   values (3, 1, '${attacker}', 'Season 1', array['a','b','c'], array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()],
     array[9,9,9], array[1,1,1], array[5,5,5], 'AAA', 8, false, 'verified', now())`);
await attack("raise a Daily mean after the fact", `update daily_results set mean_delta = 9`);
await attack("delete somebody's Daily entry", `delete from daily_results`);
await attack("post an open challenge without playing one",
  `insert into duels (challenger_id, code, match_id, expires_at) values ('${attacker}', 'ATTK2345', '${realMatch}', now() + interval '7 days')`);
await attack("turn somebody's open challenge into a named duel to me",
  `update duels set challenged_id = '${attacker}', code = null where code = 'VCTM2345'`);
await attack("record an answer to an open challenge without the function",
  `insert into open_duel_answers (duel_id, player_id, match_id) select id, '${attacker}', match_id from duels where code = 'VCTM2345'`);
await attack("mark an open challenge's answer rated by rewriting its match",
  `update matches set rated = true where rated = false`);
console.log("\n-- crowns and races --");
// A Crown the victim holds and a notice addressed to them, created the way crown_resolve
// would: by the server.
await db.exec("reset role");
const victimReign = (await db.query(
  "insert into crown_reigns (category, window_index, cycle, holder_id, match_id, match_score, lowest_tier) values ('Precise Tracking', 1, 0, $1, $2, 0.05, 'verified') returning id",
  [victim, realMatch],
)).rows[0].id;
await db.query("insert into crowns (category, window_index, reign_id, scenario_ids) values ('Precise Tracking', 1, $1, array[" + scen + "," + scen + "," + scen + "]::bigint[])", [victimReign]);
const victimNotice = (await db.query(
  "insert into crown_notices (player_id, kind, category, window_index, reign_id, other_name) values ($1, 'dethroned', 'Precise Tracking', 1, $2, 'someone') returning id",
  [victim, victimReign],
)).rows[0].id;
const myNotice = (await db.query(
  "insert into crown_notices (player_id, kind, category, window_index, other_name) values ($1, 'defended', 'Precise Tracking', 1, 'victim') returning id",
  [attacker],
)).rows[0].id;
await db.exec("set role authenticated");
await db.exec("set test.player_id = '" + attacker + "'");

await attack("take a Crown by pointing it at a reign of my own",
  `update crowns set reign_id = null where category = 'Precise Tracking'`);
await attack("crown myself by writing a reign",
  `insert into crown_reigns (category, window_index, cycle, holder_id, match_id, match_score, lowest_tier)
   values ('Precise Tracking', 1, 0, '${attacker}', '${realMatch}', 9, 'verified')`);
await attack("rewrite the holder of somebody else's reign",
  `update crown_reigns set holder_id = '${attacker}' where id = '${victimReign}'`);
await attack("pad my defences",
  `update crown_reigns set defences = 99 where holder_id = '${attacker}'`);
await attack("file a challenge naming myself the taker",
  `insert into crown_challenges (match_id, category, window_index, cycle, challenger_id, outcome, decided_at)
   values ('${realMatch}', 'Precise Tracking', 1, 0, '${attacker}', 'took', now())`);
await attack("write a notice into the victim's inbox",
  `insert into crown_notices (player_id, kind, category, window_index) values ('${victim}', 'dethroned', 'Precise Tracking', 1)`);
await attack("mark the victim's notice read so they never see it",
  `update crown_notices set seen_at = now() where id = '${victimNotice}'`);
await attack("delete the victim's notice",
  `delete from crown_notices where id = '${victimNotice}'`);
await attack("even my own notice is not mine to edit",
  `update crown_notices set other_name = 'x' where id = '${myNotice}'`);
await attack("enter a race by writing it",
  `insert into races (inviter_id, invitee_id, category, window_index, benchmark_name, difficulty, seed, scenario_ids, expires_at)
   values ('${attacker}', '${victim}', 'x', 0, 'S', 'N', 's', array[1,2,3]::bigint[], now() + interval '1 hour')`);
await attack("decide a race by writing its result",
  `update races set status = 'finished', result = 'inviter'`);
// The decisions themselves. A SELECT changes no rows, so only a refusal counts here.
for (const [label, sql] of [
  ["open a Crown challenge directly, with no cooldown", `select crown_open_challenge('Precise Tracking', 1, '${attacker}', 's', array[1,2,3]::bigint[], 'S', 'I', 480, 0, 604800)`],
  ["call the Crown decision directly", `select crown_resolve('${realMatch}')`],
  ["lapse every Crown on demand", "select crown_lapse_all(0)"],
  ["reset a Crown on demand", "select crown_reset_off_pool('Precise Tracking', 1, 0)"],
  ["start a race directly", `select race_start(gen_random_uuid(), '${attacker}', 480)`],
  ["call the race decision directly", `select race_resolve('${realMatch}')`],
  ["vacate a Crown through the internal helper", "select crown_vacate('Precise Tracking', 1, 'reset')"],
]) {
  try {
    await db.query(sql);
    findings++;
    console.log("  HOLE     " + label + " -- the call went through");
  } catch (e) {
    console.log("  ok       " + label + " -- refused (" + String(e.message).split(String.fromCharCode(10))[0].slice(0, 55) + ")");
  }
}

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
// Closed outright, not narrowed: list-tournaments builds the only view there is.
await readOthers("a tournament's stored state", `select id, state from tournaments`);
await readOthers("who entered which tournament", `select * from tournament_members`);
await readOthers("which match is which fixture leg", `select * from tournament_legs`);
await readOthers("the receipts behind a bracket", `select * from tournament_receipts`);
// The board is a distribution daily-board builds; its rows and the answers behind open
// challenges are the server's, and another player's challenge code is theirs to post.
await readOthers("the Daily board's rows", `select player_id, mean_delta from daily_results`);
await readOthers("who answered which open challenge", `select duel_id, player_id from open_duel_answers`);
await readOthers("another player's open challenge and its code", `select code from duels where code is not null`);

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

// Crowns are served by list-crowns and races by race-status; the tables behind them are
// closed. A notice is the one exception, and only to its owner.
await readOthers("the Crown tables", `select category, reign_id from crowns`);
await readOthers("who holds which Crown, raw", `select id, holder_id from crown_reigns`);
await readOthers("every challenge and its outcome", `select match_id, outcome from crown_challenges`);
await readOthers("the races table", `select id, inviter_id from races`);
await readOthers("the victim's Crown notices", `select id from crown_notices where player_id = '${victim}'`);
await readOwn("my own Crown notice", `select id, kind, other_name from crown_notices where id = '${myNotice}'`);

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

const ratings = await db.query(`select count(*)::int as n from ratings`);
console.log(`  NOTE   ratings visible to me: ${ratings.rows[0].n} row(s) (policy is 'using (true)')`);

console.log(`\n${findings === 0 ? "no holes found" : `${findings} finding(s)`}`);
await db.close();
