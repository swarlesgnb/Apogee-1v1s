/**
 * Execute the migrations and seed against a real Postgres, with no Docker and no cloud
 * project.
 *
 * The schema is the one artefact that had never actually run. It could have contained
 * a syntax error, a bad constraint, or a policy referencing a column that does not
 * exist, and nobody would have found out until the first `supabase db push` failed
 * against a live project.
 *
 * PGlite is Postgres compiled to WASM, so it runs in-process. Supabase's own `auth`
 * schema is not present, so a minimal `auth.users` table and `auth.uid()` are created
 * first: those are the only Supabase-provided objects the migration depends on, and
 * stubbing them is what lets the rest be verified honestly.
 *
 *   npx tsx tools/validateSchema.ts
 */

import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addEntrant,
  createTournament,
  getReadyFixtures,
  recordResult,
  startTournament,
  type Tournament,
} from "../src/core/tournament/tournament.ts";
import { receiptFor } from "../src/core/tournament/policy.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");
const seedPath = join(root, "supabase", "seed.sql");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

/** The Supabase-provided objects the migration references. */
const AUTH_STUB = `
  create schema if not exists auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique
  );
  -- Supabase derives this from the request JWT. A stub returning null is enough to
  -- prove the policies compile and reference real columns.
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select null::uuid $$;

  -- The three roles PostgREST switches into, and the blanket table grant Supabase
  -- hands them on every new table. Both halves matter: a migration that narrows a
  -- privilege has nothing to narrow unless the permissive default is here too, so
  -- without this the column grants would appear to work while testing nothing.
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
`;

async function main(): Promise<void> {
  const db = new PGlite();
  await db.waitReady;

  const version = await db.query<{ version: string }>("select version()");
  console.log(`postgres: ${version.rows[0].version.split(",")[0]}\n`);

  console.log("── applying schema ──────────────────────────────");

  await db.exec(AUTH_STUB);
  check("auth schema stub created", true);

  // gen_random_uuid() must be available without an extension, which is what lets the
  // migration drop its pgcrypto dependency.
  const uuid = await db.query<{ id: string }>("select gen_random_uuid() as id");
  check("gen_random_uuid is built in", typeof uuid.rows[0].id === "string");

  const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const name of migrations) {
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    try {
      await db.exec(sql);
      check(`migration ${name} applied`, true, `${sql.split("\n").length} lines`);
    } catch (err) {
      check(`migration ${name} applied`, false, err instanceof Error ? err.message : String(err));
      console.error("\nSchema does not apply. Stopping.");
      process.exit(1);
    }
  }

  try {
    const seed = readFileSync(seedPath, "utf8");
    await db.exec(seed);
    check("seed.sql applied", true);
  } catch (err) {
    check("seed.sql applied", false, err instanceof Error ? err.message : String(err));
  }

  console.log("\n── structure ────────────────────────────────────");

  const tables = await db.query<{ tablename: string; rowsecurity: boolean }>(
    `select tablename, rowsecurity from pg_tables
     where schemaname = 'public' order by tablename`,
  );
  console.log(`  ${tables.rows.length} tables in public`);

  const unsecured = tables.rows.filter((t) => !t.rowsecurity).map((t) => t.tablename);
  check("row level security on every table", unsecured.length === 0,
    unsecured.length ? `unsecured: ${unsecured.join(", ")}` : `${tables.rows.length} tables`);

  const policies = await db.query<{
    tablename: string;
    policyname: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>(
    // `with_check` as well as `qual`: a policy can read narrowly and write widely, and
    // the two are different columns. friendships is the first table here a client may
    // write to, so the write half now has to be asserted rather than assumed.
    `select tablename, policyname, cmd, qual, with_check from pg_policies
     where schemaname = 'public' order by tablename, policyname`,
  );
  check("policies were created", policies.rows.length > 0, `${policies.rows.length} policies`);

  // The rule the whole security model rests on: clients may read these, never write.
  const protectedTables = [
    "ratings",
    "matches",
    "match_sides",
    "baselines",
    "verified_pbs",
    // The apex board is public to read and self-reportable by nobody. A write policy
    // here would let a client post its own standing on a leaderboard.
    "apex_standing",
    "scenario_boards",
    // A duel names two players and points at their matches. A client write policy here
    // would let one of them forge an accepted duel and mint a contested match out of
    // somebody else's run set.
    "duels",
  ];
  const writable = policies.rows.filter(
    (p) => protectedTables.includes(p.tablename) && p.cmd.toUpperCase() !== "SELECT",
  );
  check("no client write policy on rating or match tables", writable.length === 0,
    writable.length ? writable.map((p) => `${p.tablename}:${p.cmd}`).join(", ") : "read-only");

  // The check above filters by table name, so it passes trivially for a table that is
  // not there at all - which is exactly how a dropped or reordered migration would hide.
  // These two assert the apex board's tables are present AND that each reads the way it
  // is supposed to, which are different questions with different answers.
  //
  // scenario_boards is reference data about scenarios and is world-readable.
  // apex_standing is per-player and is NOT: a leaderboard being public does not make the
  // population enumerable, which is the lesson of 20260817000004, and the board is served
  // by the apex-board function instead. Asserting the USING expression rather than
  // counting policies is what would catch a later migration quietly re-opening it.
  const readPolicy = (table: string) =>
    policies.rows.filter((p) => p.tablename === table && p.cmd.toUpperCase() === "SELECT");

  const boards = readPolicy("scenario_boards");
  check(
    "scenario_boards is world-readable reference data",
    boards.length === 1 && /true/i.test(boards[0].qual ?? ""),
    boards.length ? `${boards[0].policyname}: ${boards[0].qual}` : "no select policy",
  );

  const standing = readPolicy("apex_standing");
  check(
    "apex_standing is readable only by its own player",
    standing.length === 1 && /auth\.uid\(\)/.test(standing[0].qual ?? ""),
    standing.length ? `${standing[0].policyname}: ${standing[0].qual}` : "no select policy",
  );
  // ---- duels ---------------------------------------------------------------------
  //
  // The protected-list check above passes trivially for a table that is not there, so
  // presence is asserted separately from behaviour. Both matter and they fail for
  // different reasons.
  const duelTables = await db.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'
       and tablename in ('duels', 'friendships') order by tablename`,
  );
  check("the duel tables exist", duelTables.rows.length === 2,
    duelTables.rows.map((t) => t.tablename).join(", ") || "neither");

  const duelRead = policies.rows.filter((p) => p.tablename === "duels");
  check(
    "a duel is readable only by the two players it names",
    duelRead.length === 1 &&
      duelRead[0].cmd.toUpperCase() === "SELECT" &&
      /auth\.uid\(\)/.test(duelRead[0].qual ?? ""),
    duelRead.length ? `${duelRead[0].policyname}: ${duelRead[0].cmd}` : "no policy",
  );

  // friendships is the exception: client-writable, because it decides nothing. What has
  // to hold is that it is scoped to the caller - a widening here would let anybody write
  // anybody's list, and the protected-list check will never catch it because the table
  // is deliberately not on that list.
  const friendPolicies = policies.rows.filter((p) => p.tablename === "friendships");
  check(
    "a friends list is writable only by its owner",
    friendPolicies.length === 1 &&
      /auth\.uid\(\) = player_id/.test(friendPolicies[0].qual ?? "") &&
      /auth\.uid\(\) = player_id/.test(friendPolicies[0].with_check ?? ""),
    friendPolicies.length
      ? `${friendPolicies[0].cmd} using(${friendPolicies[0].qual}) check(${friendPolicies[0].with_check})`
      : "no policy",
  );

  // The partial index is the whole duplicate rule, and it is exactly the kind of thing
  // somebody later "fixes" into a plain unique constraint - which would block every
  // rematch for good. Assert it is partial, not merely unique.
  const duelIdx = await db.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'duels' order by indexname`,
  );
  const oneOpen = duelIdx.rows.find((i) => i.indexname === "duels_one_open_idx");
  check(
    "only one duel at a time may be open between the same two players",
    !!oneOpen && /UNIQUE/i.test(oneOpen.indexdef) && /WHERE/i.test(oneOpen.indexdef),
    oneOpen?.indexdef ?? "missing",
  );
  check("the inbox has an index",
    duelIdx.rows.some((i) => i.indexname === "duels_inbox_idx"),
    duelIdx.rows.map((i) => i.indexname).join(", "));

  // ---- duels, against the real constraints -------------------------------------
  //
  // The rules above are read off the catalogue, which says what was declared. These say
  // what actually happens, and they are the half that catches a constraint written the
  // way it was meant rather than the way it reads.
  const duelPlayers: string[] = [];
  for (const [i, name] of ["duel one", "duel two"].entries()) {
    const u = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('duel${i}@arena.invalid') returning id`,
    );
    const id = u.rows[0].id;
    duelPlayers.push(id);
    await db.exec(
      `insert into players (id, steam_id, display_name)
       values ('${id}', '7656119900000002${i}', '${name}')`,
    );
  }
  const [duelA, duelB] = duelPlayers;

  const duelMatch = await db.query<{ id: string }>(
    `insert into matches
       (mode, category, benchmark_name, difficulty, window_index, seed, scenario_ids, status)
     values ('async', 'Static Clicking', 'Season 1', 'Intermediate', 1, 'duel-seed',
             '{1,2,3}', 'settled')
     returning id`,
  );
  const duelMatchId = duelMatch.rows[0].id;

  /** Ran and threw, which for a constraint is the passing case. */
  const refused = async (write: () => Promise<unknown>): Promise<boolean> => {
    try {
      await write();
      return false;
    } catch {
      return true;
    }
  };

  const sendDuel = (from: string, to: string, status = "open") =>
    db.exec(
      `insert into duels (challenger_id, challenged_id, match_id, status, expires_at)
       values ('${from}', '${to}', '${duelMatchId}', '${status}', now() + interval '7 days')`,
    );

  check("a duel to yourself is refused", await refused(() => sendDuel(duelA, duelA)));

  await sendDuel(duelA, duelB);
  check("a second open duel to the same player is refused",
    await refused(() => sendDuel(duelA, duelB)));

  // The other half of the partial index, and the reason it is partial. Without this a
  // plain unique constraint would pass the check above and block every rematch forever.
  await db.exec(
    `update duels set status = 'declined' where challenger_id = '${duelA}'`,
  );
  let rematch = true;
  try {
    await sendDuel(duelA, duelB);
  } catch {
    rematch = false;
  }
  check("but one is allowed again once the last was answered", rematch);

  // The reverse pairing is a different duel. Two people may each have one out.
  let bothWays = true;
  try {
    await sendDuel(duelB, duelA);
  } catch {
    bothWays = false;
  }
  check("and each player may have one out to the other at once", bothWays);

  const beforeDelete = await db.query<{ n: string }>(`select count(*) as n from duels`);
  await db.exec(`delete from matches where id = '${duelMatchId}'`);
  const afterDelete = await db.query<{ n: string }>(`select count(*) as n from duels`);
  check("deleting the match a duel points at removes the duel",
    Number(beforeDelete.rows[0].n) > 0 && Number(afterDelete.rows[0].n) === 0,
    `${beforeDelete.rows[0].n} then ${afterDelete.rows[0].n}`);

  check("a friendship with yourself is refused",
    await refused(() =>
      db.exec(`insert into friendships (player_id, friend_id) values ('${duelA}', '${duelA}')`)));

  await db.exec(
    `insert into friendships (player_id, friend_id) values ('${duelA}', '${duelB}')`,
  );
  check("the same friend cannot be added twice",
    await refused(() =>
      db.exec(`insert into friendships (player_id, friend_id) values ('${duelA}', '${duelB}')`)));


  // ---- what rateChallenger stands on -------------------------------------------
  //
  // The function itself is an Edge Function: tsc never sees it and there is no Deno
  // here to run it. What can be checked is the contract underneath, which is where a
  // typo would actually bite, and it is all SQL.
  const answerMatch = await db.query<{ id: string }>(
    `insert into matches
       (mode, category, benchmark_name, difficulty, window_index, seed, scenario_ids, status)
     values ('async', 'Static Clicking', 'Season 1', 'Intermediate', 1, 'answer-seed',
             '{1,2,3}', 'settled')
     returning id`,
  );
  const answerId = answerMatch.rows[0].id;
  const seedMatch = await db.query<{ id: string }>(
    `insert into matches
       (mode, category, benchmark_name, difficulty, window_index, seed, scenario_ids, status)
     values ('async', 'Static Clicking', 'Season 1', 'Intermediate', 1, 'sent-seed',
             '{1,2,3}', 'settled')
     returning id`,
  );
  await db.exec(
    `insert into duels (challenger_id, challenged_id, match_id, answer_match_id, status, expires_at)
     values ('${duelA}', '${duelB}', '${seedMatch.rows[0].id}', '${answerId}', 'accepted',
             now() + interval '7 days')`,
  );

  const foundByAnswer = await db.query<{ challenger_id: string }>(
    `select challenger_id from duels where answer_match_id = '${answerId}'`,
  );
  check("a settled match can be traced back to the duel that made it",
    foundByAnswer.rows.length === 1 && foundByAnswer.rows[0].challenger_id === duelA,
    `${foundByAnswer.rows.length} row(s)`);

  const poolMatch = await db.query<{ n: string }>(
    `select count(*) as n from duels where answer_match_id = '${seedMatch.rows[0].id}'`,
  );
  check("and an ordinary pool match traces back to nothing",
    Number(poolMatch.rows[0].n) === 0);

  // The idempotency guard has to be `result is null` on the side, because rating_history
  // deliberately accepts a second row for the same player and match - it is a log, and a
  // log that refused duplicates could not record two meetings. Assert that, so nobody
  // later "hardens" it with a unique constraint and silently turns the real guard into a
  // second one that is doing nothing.
  await db.exec(
    `insert into match_sides (match_id, player_id, deltas, match_score)
     values ('${answerId}', '${duelA}', '{0.01,0.02,0.03}', 0.02)`,
  );
  let logAcceptsDuplicates = true;
  try {
    for (let i = 0; i < 2; i++) {
      await db.exec(
        `insert into rating_history
           (player_id, match_id, rating_before, rating_after, rd_before, rd_after, result, weight)
         values ('${duelA}', '${answerId}', 1500, 1512, 200, 195, 1, 1)`,
      );
    }
  } catch {
    logAcceptsDuplicates = false;
  }
  check("rating history takes a second row, so the guard cannot live there",
    logAcceptsDuplicates);

  const sideResult = await db.query<{ result: string | null }>(
    `select result from match_sides where match_id = '${answerId}' and player_id = '${duelA}'`,
  );
  check("a challenger's side starts with no result, which is what the guard reads",
    sideResult.rows.length === 1 && sideResult.rows[0].result === null,
    String(sideResult.rows[0]?.result));

  const answerIdx = await db.query<{ indexname: string }>(
    `select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'duels' and indexname = 'duels_answer_idx'`,
  );
  check("the lookup settlement makes on every match is indexed",
    answerIdx.rows.length === 1);

  // ---- the apex board's data contract ------------------------------------------------
  //
  // `apex-board` is the least-verifiable code in the repo: an Edge Function, so tsc never
  // sees it, and there is no Deno here to run it. What CAN be verified is the contract it
  // depends on - that the table stores what it thinks, that the ordering and the rank
  // arithmetic behave, and that the join to a display name resolves. Those are the parts a
  // typo would break, and they are all SQL, which this file already has a real Postgres for.

  const apexPlayers: string[] = [];
  for (const [i, name] of ["apex one", "apex two", "apex three"].entries()) {
    const u = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('apex${i}@arena.invalid') returning id`,
    );
    const id = u.rows[0].id;
    apexPlayers.push(id);
    await db.exec(
      `insert into players (id, steam_id, display_name)
       values ('${id}', '7656119800000001${i}', '${name}')`,
    );
  }

  // Two tied at the top, one behind: the shape that makes rank arithmetic interesting.
  const apexPoints = [12.5, 12.5, 4.25];
  for (const [i, id] of apexPlayers.entries()) {
    await db.exec(
      `insert into apex_standing (player_id, category, points, graded, family_count)
       values ('${id}', 'Overall', ${apexPoints[i]}, 6, 22)`,
    );
  }

  // The page query, verbatim in shape: ordered by points, joined for a name.
  const page = await db.query<{ display_name: string; points: string }>(
    `select p.display_name, a.points
       from apex_standing a join players p on p.id = a.player_id
      where a.category = 'Overall'
      order by a.points desc
      limit 50`,
  );
  check(
    "the board pages in descending order, with a name attached",
    page.rows.length === 3 &&
      Number(page.rows[0].points) === 12.5 &&
      Number(page.rows[2].points) === 4.25 &&
      page.rows.every((r) => r.display_name.startsWith("apex ")),
    page.rows.map((r) => `${r.display_name} ${r.points}`).join(", "),
  );

  // "How many are strictly above me, plus one" - which is competition ranking: tied
  // players share a place and the next one skips. Asserted because the alternative
  // reading, dense ranking, is a plausible thing for somebody to 'fix' this into, and
  // it would quietly tell the second-placed of two tied players they were third.
  const ranks: number[] = [];
  for (const [i, id] of apexPlayers.entries()) {
    const above = await db.query<{ n: string }>(
      `select count(*) as n from apex_standing
        where category = 'Overall' and points > ${apexPoints[i]}`,
    );
    void id;
    ranks.push(Number(above.rows[0].n) + 1);
  }
  check(
    "tied players share a place and the next one skips it",
    ranks[0] === 1 && ranks[1] === 1 && ranks[2] === 3,
    ranks.join(", "),
  );

  // One standing per player per category, or a refresh would append rather than replace.
  let apexDuplicate = false;
  try {
    await db.exec(
      `insert into apex_standing (player_id, category, points)
       values ('${apexPlayers[0]}', 'Overall', 1)`,
    );
  } catch {
    apexDuplicate = true;
  }
  check("a player has one standing per category, not a history", apexDuplicate);

  let negativePoints = false;
  try {
    await db.exec(
      `insert into apex_standing (player_id, category, points)
       values ('${apexPlayers[0]}', 'Clicking', -1)`,
    );
  } catch {
    negativePoints = true;
  }
  check("a negative standing is refused", negativePoints);

  // Deleting a player must take their standing with them, or the board would keep
  // serving a name that no longer exists.
  await db.exec(`delete from players where id = '${apexPlayers[2]}'`);
  const orphaned = await db.query<{ n: string }>(
    `select count(*) as n from apex_standing where player_id = '${apexPlayers[2]}'`,
  );
  check("a deleted player leaves no standing behind", Number(orphaned.rows[0].n) === 0);

  // refresh-apex's write is an upsert on (player_id, category). The primary key check
  // above proves a plain insert is refused; this proves the upsert REPLACES rather than
  // failing, which is the other half and the one a wrong conflict target breaks. A
  // refresh that errors instead of updating would look like a rate limit to the client.
  await db.exec(
    `insert into apex_standing (player_id, category, points, graded, family_count)
     values ('${apexPlayers[0]}', 'Overall', 19.75, 9, 22)
     on conflict (player_id, category) do update
       set points = excluded.points,
           graded = excluded.graded,
           updated_at = now()`,
  );
  const refreshed = await db.query<{ points: string; graded: number; n: string }>(
    `select points, graded, (select count(*) from apex_standing
                              where player_id = '${apexPlayers[0]}') as n
       from apex_standing
      where player_id = '${apexPlayers[0]}' and category = 'Overall'`,
  );
  check(
    "a refresh replaces a player's standing rather than adding one",
    Number(refreshed.rows[0]?.points) === 19.75 && Number(refreshed.rows[0]?.n) === 1,
    `${refreshed.rows[0]?.points} across ${refreshed.rows[0]?.n} row(s)`,
  );

  // scenario_boards carries both samplings as jsonb, and refresh-apex reads them straight
  // back into the shapes apex.ts expects. A jsonb column that silently reordered or
  // stringified them would place every score wrongly and nothing would error.
  const boardScenario = await db.query<{ id: string }>(
    `select id from scenarios order by id limit 1`,
  );
  if (boardScenario.rows.length === 1) {
    await db.exec(
      `insert into scenario_boards
         (scenario_id, board_total, apex_points, percentile_points, sampled_at)
       values ('${boardScenario.rows[0].id}', 60383,
               '[{"rank":1,"score":53},{"rank":2,"score":53},{"rank":500,"score":31}]',
               '[{"topFraction":0.001,"score":49},{"topFraction":0.5,"score":18}]',
               now())`,
    );
    const stored = await db.query<{ apex_points: { rank: number; score: number }[] }>(
      `select apex_points from scenario_boards
        where scenario_id = '${boardScenario.rows[0].id}'`,
    );
    const pts = stored.rows[0]?.apex_points ?? [];
    check(
      "a sampled board round-trips through jsonb in order",
      pts.length === 3 && pts[0].rank === 1 && pts[2].rank === 500 && pts[2].score === 31,
      JSON.stringify(pts),
    );

    let zeroTotal = false;
    try {
      await db.exec(
        `insert into scenario_boards (scenario_id, board_total, sampled_at)
         values ('${boardScenario.rows[0].id}', 0, now())`,
      );
    } catch {
      zeroTotal = true;
    }
    // Every fraction this table serves divides by board_total.
    check("a board with no entries is refused", zeroTotal);
  }

  // And the index the board query is written for.
  const apexIdx = await db.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
      where tablename = 'apex_standing' and indexname = 'apex_standing_board_idx'`,
  );
  check(
    "the board's ordering is indexed",
    apexIdx.rows.length === 1 && /points DESC/i.test(apexIdx.rows[0].indexdef),
    apexIdx.rows[0]?.indexdef ?? "missing",
  );

  // ---- tournaments ---------------------------------------------------------------
  //
  // The two functions below are where every tournament rule the database can hold is
  // held: the compare-and-swap on the aggregate, and the leg reservation with its
  // one-match check. Both are driven here against the real constraints, including the
  // refusals, because a refusal nobody has watched fire is a refusal nobody knows works.
  //
  // What PGlite cannot show is two connections at once, so the concurrency claims rest on
  // the row lock and the conditional UPDATE rather than on a race run here. The stale write
  // below is the sequential shadow of that race: the second writer arriving after the first.
  console.log("\n── tournaments ──────────────────────────────────");

  const tournamentTables = [
    "tournaments", "tournament_members", "tournament_legs", "tournament_receipts", "tournament_log",
  ];
  const tPresent = await db.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' and tablename = any($1::text[])`,
    [tournamentTables],
  );
  check("the five tournament tables exist", tPresent.rows.length === 5,
    tPresent.rows.map((t) => t.tablename).join(", ") || "none");

  const tPolicies = policies.rows.filter((p) => tournamentTables.includes(p.tablename));
  check("no client policy of any kind on them", tPolicies.length === 0,
    tPolicies.map((p) => `${p.tablename}:${p.cmd}`).join(", ") || "none");

  const tGrants = await db.query<{ n: number }>(
    `select count(*)::int as n from information_schema.role_table_grants
      where table_name = any($1::text[]) and grantee in ('anon', 'authenticated')`,
    [tournamentTables],
  );
  check("and no table grant to anon or authenticated", tGrants.rows[0].n === 0, `${tGrants.rows[0].n} grants`);

  // Revoking from anon and authenticated alone is not enough for a function: both inherit
  // PUBLIC's default EXECUTE. has_function_privilege follows that inheritance, which is
  // why it is the question asked rather than the grant table.
  for (const [label, signature] of [
    ["tournament_commit", "tournament_commit(uuid, bigint, jsonb, jsonb, jsonb, uuid, text, uuid, jsonb)"],
    ["tournament_open_leg", "tournament_open_leg(uuid, text, integer, uuid, text, bigint[], text, text, text, integer, integer)"],
  ] as const) {
    const who = await db.query<{ anon: boolean; authed: boolean; service: boolean }>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as authed,
              has_function_privilege('service_role', $1, 'EXECUTE') as service`,
      [signature],
    );
    const r = who.rows[0];
    check(`${label} is callable by the service role and nobody else`, !r.anon && !r.authed && r.service,
      `anon ${r.anon}, authenticated ${r.authed}, service ${r.service}`);
  }

  const defaultRated = await db.query<{ rated: boolean }>(
    `insert into matches (mode, category, benchmark_name, difficulty, seed, scenario_ids, status)
     values ('async', 'Any', 'Season 1', 'Intermediate', 'rated-default', '{1,2,3}', 'awaiting_runs')
     returning rated`,
  );
  check("a match is rated unless the server says otherwise", defaultRated.rows[0].rated === true);

  const tPlayers: string[] = [];
  for (let i = 0; i < 7; i++) {
    const u = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('cup${i}@arena.invalid') returning id`,
    );
    tPlayers.push(u.rows[0].id);
    await db.exec(
      `insert into players (id, steam_id, display_name)
       values ('${u.rows[0].id}', '76561197000000${String(i).padStart(3, "0")}', 'cup ${i}')`,
    );
  }

  const tId = crypto.randomUUID();
  let tState = createTournament(tId, {
    name: "Schema Cup", groupCount: 2, groupSize: 3, qualifiers: 1, seeding: "seeded", randomSeed: "schema",
  });
  for (let i = 0; i < 6; i++) {
    tState = addEntrant(tState, { id: tPlayers[i], name: `cup ${i}`, seed: i + 1, checkedIn: true });
  }
  tState = startTournament(tState);

  const insertTournament = (id: string, host: string, state: Tournament, revision = state.revision) =>
    db.query(
      `insert into tournaments (id, host_id, name, category, window_index, window_name, phase, revision, state)
       values ($1, $2, $3, 'Any', 0, 'Intermediate', $4::tournament_phase, $5, $6::jsonb)`,
      [id, host, state.config.name, state.phase, revision, JSON.stringify(state)],
    );

  check("a row whose columns disagree with its own document is refused",
    await refused(() => insertTournament(tId, tPlayers[0], tState, tState.revision + 5)));
  await insertTournament(tId, tPlayers[0], tState);

  const tScenarios = (await db.query<{ id: number }>(`select id from scenarios order by id limit 3`)).rows.map((r) => r.id);

  /** The code and message of a refusal, or null if it went through. */
  const sqlRefusal = async (run: () => Promise<unknown>): Promise<string | null> => {
    try {
      await run();
      return null;
    } catch (err) {
      return `${(err as { code?: string }).code ?? ""} ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  const openLeg = (fixtureId: string, attempt: number, player: string) =>
    db.query<{ r: { matchId: string; leg: number; created: boolean } }>(
      `select tournament_open_leg($1::uuid, $2, $3, $4::uuid, $5, $6::bigint[], 'Any', 'Season 1',
                                  'Intermediate', 0, 480) as r`,
      [tId, fixtureId, attempt, player, crypto.randomUUID(), tScenarios],
    ).then((q) => q.rows[0].r);

  const [fixtureOne, fixtureTwo] = getReadyFixtures(tState);
  const [pA, pB] = [fixtureOne.playerA, fixtureOne.playerB];
  const bystander = tPlayers.slice(0, 6).find((p) => p !== pA && p !== pB)!;

  const notTheirs = await sqlRefusal(() => openLeg(fixtureOne.id, 1, bystander));
  check("somebody not in the fixture cannot open a leg of it", /TN403/.test(notTheirs ?? ""), notTheirs ?? "went through");

  const staleAttempt = await sqlRefusal(() => openLeg(fixtureOne.id, 2, pA));
  check("an attempt that is not the fixture's current one is refused", /TN409/.test(staleAttempt ?? ""),
    staleAttempt ?? "went through");

  const legOne = await openLeg(fixtureOne.id, 1, pA);
  const legOneMatch = await db.query<{ rated: boolean; status: string; sides: number }>(
    `select m.rated, m.status::text as status,
            (select count(*)::int from match_sides s where s.match_id = m.id) as sides
       from matches m where m.id = $1`,
    [legOne.matchId],
  );
  check("the first press opens a one-sided, unrated first leg",
    legOne.created && legOne.leg === 1 && legOneMatch.rows[0]?.rated === false &&
      legOneMatch.rows[0]?.sides === 1 && legOneMatch.rows[0]?.status === "awaiting_runs",
    JSON.stringify({ ...legOne, ...legOneMatch.rows[0] }));

  const again = await openLeg(fixtureOne.id, 1, pA);
  check("pressing it again hands back the same match", !again.created && again.matchId === legOne.matchId);

  const early = await sqlRefusal(() => openLeg(fixtureOne.id, 1, pB));
  check("the other player cannot answer while the first leg is being played", /TN409/.test(early ?? ""),
    early ?? "went through");

  await db.exec(
    `update match_sides set deltas = '{0.01,0.03,0.05}', match_score = 0.03,
            submitted_at = now()
      where match_id = '${legOne.matchId}' and player_id = '${pA}'`,
  );
  await db.exec(`update matches set status = 'settled' where id = '${legOne.matchId}'`);

  const legTwo = await openLeg(fixtureOne.id, 1, pB);
  const legTwoCheck = await db.query<{ same: boolean; frozen: string | null; sides: number; rated: boolean }>(
    `select (select scenario_ids from matches where id = $1) = (select scenario_ids from matches where id = $2) as same,
            (select deltas::text from match_sides where match_id = $1 and player_id = $3) as frozen,
            (select count(*)::int from match_sides where match_id = $1) as sides,
            (select rated from matches where id = $1) as rated`,
    [legTwo.matchId, legOne.matchId, pA],
  );
  const l2 = legTwoCheck.rows[0];
  check("once it has settled, the answer is built from it: same three, their frozen side, unrated",
    legTwo.created && legTwo.leg === 2 && l2.same && l2.frozen === "{0.01,0.03,0.05}" && l2.sides === 2 && l2.rated === false,
    JSON.stringify(l2));

  // A player already in another live match cannot open a leg. The same rule as the queue.
  const [pC] = [fixtureTwo.playerA];
  const elsewhere = await db.query<{ id: string }>(
    `insert into matches (mode, category, benchmark_name, difficulty, seed, scenario_ids, status, expires_at)
     values ('async', 'Any', 'Season 1', 'Intermediate', 'busy', '{1,2,3}', 'awaiting_runs', now() + interval '1 hour')
     returning id`,
  );
  await db.exec(`insert into match_sides (match_id, player_id) values ('${elsewhere.rows[0].id}', '${pC}')`);
  const busy = await sqlRefusal(() => openLeg(fixtureTwo.id, 1, pC));
  check("a player with another live match cannot open a leg", /TN409/.test(busy ?? "") && /current match/.test(busy ?? ""),
    busy ?? "went through");

  check("a second first leg for the same attempt is refused by the key",
    await refused(() => db.exec(
      `insert into tournament_legs (tournament_id, fixture_id, attempt, leg, player_id, match_id)
       values ('${tId}', '${fixtureOne.id}', 1, 1, '${pB}', '${elsewhere.rows[0].id}')`)));

  // The second leg settles as a win for its player; fold it in the way the server does.
  await db.exec(
    `update match_sides set result = 'win', match_score = 0.04 where match_id = '${legTwo.matchId}' and player_id = '${pB}'`,
  );
  await db.exec(`update matches set status = 'settled' where id = '${legTwo.matchId}'`);

  const receipt = receiptFor(fixtureOne.id, 1, legTwo.matchId, { kind: "win", winnerId: pB });
  const decided = recordResult(tState, receipt);
  const commitTo = (expected: number, next: Tournament) =>
    db.query<{ r: string | null }>(
      `select tournament_commit($1::uuid, $2::bigint, $3::jsonb, $4::jsonb, $5::jsonb, $6::uuid,
                                'result', null, '{}'::jsonb) as r`,
      [
        tId, expected, JSON.stringify(next),
        JSON.stringify(next.entrants.map((e) => ({ player_id: e.id, seed: e.seed, checked_in: e.checkedIn }))),
        JSON.stringify({ ...receipt, matchId: legTwo.matchId }),
        legTwo.matchId,
      ],
    ).then((q) => q.rows[0].r);

  const committed = await commitTo(tState.revision, decided);
  const afterCommit = await db.query<{ revision: string; members: number; ingested: boolean; receipts: number; logged: number }>(
    `select (select revision from tournaments where id = $1)::text as revision,
            (select count(*)::int from tournament_members where tournament_id = $1) as members,
            (select ingested_at is not null from tournament_legs where match_id = $2) as ingested,
            (select count(*)::int from tournament_receipts where tournament_id = $1) as receipts,
            (select count(*)::int from tournament_log where tournament_id = $1) as logged`,
    [tId, legTwo.matchId],
  );
  const ac = afterCommit.rows[0];
  check("a commit moves the revision and lands its members, receipt, leg and log line together",
    Number(committed) === decided.revision && Number(ac.revision) === decided.revision &&
      ac.members === 6 && ac.ingested && ac.receipts === 1 && ac.logged === 1,
    JSON.stringify({ committed, ...ac }));

  const stale = await commitTo(tState.revision, decided);
  check("a writer holding the old revision gets nothing written", stale === null, String(stale));

  check("a state that does not move the revision forward is refused",
    await refused(() => commitTo(decided.revision, decided)));

  const afterStale = await db.query<{ receipts: number }>(
    `select count(*)::int as receipts from tournament_receipts where tournament_id = $1`, [tId],
  );
  check("and the refused writes left no second receipt behind", afterStale.rows[0].receipts === 1);

  check("a receipt cannot be edited after the fact",
    await refused(() => db.exec(`update tournament_receipts set outcome = '{"kind":"void"}' where tournament_id = '${tId}'`)));
  check("a second receipt for the same match is refused",
    await refused(() => db.exec(
      `insert into tournament_receipts (tournament_id, receipt_id, fixture_id, attempt, match_id, outcome)
       values ('${tId}', 'other', '${fixtureOne.id}', 1, '${legTwo.matchId}', '{"kind":"win"}')`)));
  check("two players cannot hold the same seed",
    await refused(() => db.exec(`update tournament_members set seed = 1 where tournament_id = '${tId}'`)));

  const decidedFixture = await sqlRefusal(() => openLeg(fixtureOne.id, 1, pA));
  check("a decided fixture opens nothing", /TN409/.test(decidedFixture ?? ""), decidedFixture ?? "went through");

  let hostAgain = createTournament(crypto.randomUUID(), {
    name: "Second Cup", groupCount: 2, groupSize: 3, qualifiers: 1, seeding: "seeded", randomSeed: "x",
  });
  check("a host cannot run two live tournaments at once",
    await refused(() => insertTournament(hostAgain.id, tPlayers[0], hostAgain)));
  hostAgain = createTournament(crypto.randomUUID(), { ...hostAgain.config });
  await insertTournament(hostAgain.id, tPlayers[6], hostAgain);
  check("but somebody else can", true);

  await db.exec(`delete from tournaments where id = '${tId}'`);
  const leftovers = await db.query<{ n: number }>(
    `select ((select count(*) from tournament_members where tournament_id = $1) +
             (select count(*) from tournament_legs where tournament_id = $1) +
             (select count(*) from tournament_receipts where tournament_id = $1) +
             (select count(*) from tournament_log where tournament_id = $1))::int as n`,
    [tId],
  );
  check("deleting a tournament leaves nothing of it behind", leftovers.rows[0].n === 0, `${leftovers.rows[0].n} rows`);

  // Runs must be append-only.
  const runPolicies = policies.rows.filter((p) => p.tablename === "runs");
  const runCmds = new Set(runPolicies.map((p) => p.cmd.toUpperCase()));
  check("runs are append-only", !runCmds.has("UPDATE") && !runCmds.has("DELETE"),
    [...runCmds].join(", "));

  // And append-only is not enough on its own. `runs` has to stay client-insertable for
  // backfill, so RLS lets a player write rows there - and RLS answers "which rows",
  // never "which columns". A client that can name verification_tier on its own insert
  // has bypassed every check in src/core/verify, so the ban lives in column privileges
  // (20260825000013) and is asserted here rather than trusted.
  const runInsertable = new Set(
    (await db.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
       where table_name = 'runs' and privilege_type = 'INSERT'
         and grantee in ('anon', 'authenticated')`,
    )).rows.map((r) => r.column_name),
  );
  const mustNotInsert = ["verification_tier", "verification_notes", "match_id",
                         "scenario_id", "duration_seconds"];
  const leaked = mustNotInsert.filter((c) => runInsertable.has(c));
  check("clients cannot set a run's tier, match or duration", leaked.length === 0,
    leaked.length ? `insertable: ${leaked.join(", ")}` : `${runInsertable.size} columns granted`);

  // The other half of the same fact: the grant has to still cover everything backfill
  // sends, or the first-run upload of ~11k rows fails the whole batch. This is the check
  // that catches a field added to RunPayload and not to the migration.
  const backfillColumns = ["player_id", "scenario_name", "score", "accuracy", "avg_ttk",
    "kills", "hit_count", "miss_count", "played_at", "challenge_start", "hash",
    "game_version", "avg_fps", "resolution", "cm360", "dpi", "fov", "csv_sha256",
    "kill_rows"];
  const missing = backfillColumns.filter((c) => !runInsertable.has(c));
  check("backfill can still insert every column it sends", missing.length === 0,
    missing.length ? `not granted: ${missing.join(", ")}` : `${backfillColumns.length} columns`);

  // Moderation state must not be readable by its subject - the players.flags argument
  // from 20260817000004, one table over. verification_notes names the exact check that
  // caught a run, which is a recipe for the next attempt.
  const notesReadable = await db.query<{ n: number }>(
    `select count(*)::int as n from information_schema.column_privileges
     where table_name = 'runs' and column_name = 'verification_notes'
       and privilege_type = 'SELECT' and grantee in ('anon', 'authenticated')`,
  );
  check("a player cannot read which check caught their run",
    notesReadable.rows[0].n === 0, `${notesReadable.rows[0].n} grants`);

  console.log("\n── behaviour ────────────────────────────────────");

  // A player row must automatically get a rating row.
  const user = await db.query<{ id: string }>(
    `insert into auth.users (email) values ('steam_76561198000000000@arena.invalid')
     returning id`,
  );
  const userId = user.rows[0].id;

  await db.exec(
    `insert into players (id, steam_id, display_name)
     values ('${userId}', '76561198000000000', 'test player')`,
  );

  const rating = await db.query(`select * from ratings where player_id = '${userId}'`);
  check("inserting a player creates their rating row", rating.rows.length === 1);

  // The SteamID format constraint must reject nonsense.
  let rejected = false;
  try {
    const other = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('bad@arena.invalid') returning id`,
    );
    await db.exec(
      `insert into players (id, steam_id, display_name)
       values ('${other.rows[0].id}', 'not-a-steam-id', 'bad')`,
    );
  } catch {
    rejected = true;
  }
  check("a malformed SteamID is rejected", rejected);

  // A run must resolve its scenario server-side from the name alone.
  await db.exec(
    `insert into runs (player_id, scenario_name, score, played_at, csv_sha256)
     values ('${userId}', 'VT Frogtagon Intermediate S5', 1130, now(), repeat('a', 64))`,
  );
  const resolved = await db.query<{ scenario_id: number | null; name: string }>(
    `select r.scenario_id, s.name from runs r
     left join scenarios s on s.id = r.scenario_id where r.player_id = '${userId}'`,
  );
  check("the scenario id is resolved by the server",
    resolved.rows[0]?.scenario_id != null,
    resolved.rows[0]?.name ?? "unresolved");

  // Replay protection: the same file cannot be submitted twice.
  let duplicateBlocked = false;
  try {
    await db.exec(
      `insert into runs (player_id, scenario_name, score, played_at, csv_sha256)
       values ('${userId}', 'VT Frogtagon Intermediate S5', 9999, now(), repeat('a', 64))`,
    );
  } catch {
    duplicateBlocked = true;
  }
  check("the same stats file cannot be uploaded twice", duplicateBlocked);

  // Pressure scenarios subtract for misses, so a genuine run can finish below zero.
  // The original constraint required score >= 0 and rejected them, which only showed
  // up partway through a real backfill. Every insert this file tested was positive,
  // which is exactly why it slipped through.
  let negativeAccepted = true;
  try {
    await db.exec(
      `insert into runs (player_id, scenario_name, score, played_at, csv_sha256)
       values ('${userId}', 'darkPressure', -500, now(), repeat('c', 64))`,
    );
  } catch {
    negativeAccepted = false;
  }
  check("a legitimately negative score is accepted", negativeAccepted,
    "pressure scenarios subtract for misses");

  // The bound still has to catch nonsense.
  let absurdRejected = false;
  try {
    await db.exec(
      `insert into runs (player_id, scenario_name, score, played_at, csv_sha256)
       values ('${userId}', 'darkPressure', 999999999, now(), repeat('d', 64))`,
    );
  } catch {
    absurdRejected = true;
  }
  check("an absurd score is still rejected", absurdRejected);

  // An unknown scenario is kept, not dropped.
  await db.exec(
    `insert into runs (player_id, scenario_name, score, played_at, csv_sha256)
     values ('${userId}', 'Some Custom Scenario', 500, now(), repeat('b', 64))`,
  );
  const unknown = await db.query<{ scenario_id: number | null }>(
    `select scenario_id from runs where csv_sha256 = repeat('b', 64)`,
  );
  check("a run on an unknown scenario is still stored",
    unknown.rows.length === 1 && unknown.rows[0].scenario_id === null);

  // ---- a published season is frozen ------------------------------------------------
  //
  // The whole promise of a season is that the target does not move while somebody is
  // grinding toward it, so the freeze is worth more than a comment claiming it. These
  // run against the trigger, not the application, because that is where the guarantee
  // has to live to be worth anything.
  console.log("\n── seasons ─────────────────────────────────────");

  await db.exec(`
    insert into seasons (id, name, status, rank_names)
    values ('11111111-1111-1111-1111-111111111111', 'Draft season', 'draft',
            array['Bronze','Silver','Gold'])
  `);

  const seasonScenarioId = (
    await db.query<{ id: number }>(
      "select id from scenarios where name = 'VT Frogtagon Intermediate S5'",
    )
  ).rows[0]?.id;

  await db.exec(`
    insert into season_scenarios (season_id, scenario_id, category, rank_maxes)
    values ('11111111-1111-1111-1111-111111111111', ${seasonScenarioId}, 'Clicking',
            array[100, 200, 300]::numeric[])
  `);

  let draftEditable = true;
  try {
    await db.exec(
      "update seasons set name = 'Renamed' where id = '11111111-1111-1111-1111-111111111111'",
    );
  } catch {
    draftEditable = false;
  }
  check("a draft season can be edited", draftEditable);

  await db.exec(`
    update seasons set status = 'published', published_at = now()
    where id = '11111111-1111-1111-1111-111111111111'
  `);

  let publishedLocked = false;
  try {
    await db.exec(`
      update seasons set rank_names = array['Wood']
      where id = '11111111-1111-1111-1111-111111111111'
    `);
  } catch {
    publishedLocked = true;
  }
  check("a published season cannot be edited", publishedLocked);

  let thresholdsLocked = false;
  try {
    await db.exec(`
      update season_scenarios set rank_maxes = array[1,2,3]::numeric[]
      where season_id = '11111111-1111-1111-1111-111111111111'
    `);
  } catch {
    thresholdsLocked = true;
  }
  check("published thresholds cannot be moved", thresholdsLocked);

  let poolLocked = false;
  try {
    await db.exec(
      "delete from season_scenarios where season_id = '11111111-1111-1111-1111-111111111111'",
    );
  } catch {
    poolLocked = true;
  }
  check("a scenario cannot be dropped from a published season", poolLocked);

  let deleteBlocked = false;
  try {
    await db.exec("delete from seasons where id = '11111111-1111-1111-1111-111111111111'");
  } catch {
    deleteBlocked = true;
  }
  check("a published season cannot be deleted", deleteBlocked);

  // Retiring a season changes which one is current without changing what any past rank
  // meant, so it has to stay possible.
  let archivable = true;
  try {
    await db.exec(`
      update seasons set status = 'archived'
      where id = '11111111-1111-1111-1111-111111111111'
    `);
  } catch {
    archivable = false;
  }
  check("a published season can still be archived", archivable);

  console.log("\n── seeded reference data ────────────────────────");

  const counts = await db.query<{ scenarios: number; memberships: number }>(
    `select (select count(*) from scenarios)::int as scenarios,
            (select count(*) from benchmark_scenarios)::int as memberships`,
  );
  const { scenarios, memberships } = counts.rows[0];
  check("scenarios were seeded", scenarios > 200, `${scenarios}`);
  check("benchmark memberships were seeded", memberships > 200, `${memberships}`);

  const s5 = await db.query<{ n: number }>(
    `select count(*)::int as n from benchmark_scenarios
     where benchmark_name = 'Voltaic S5' and difficulty = 'Intermediate'`,
  );
  check("Voltaic S5 Intermediate has 18 scenarios", s5.rows[0].n === 18, `${s5.rows[0].n}`);

  const thresholds = await db.query<{ name: string; rank_maxes: number[] }>(
    `select s.name, bs.rank_maxes from benchmark_scenarios bs
     join scenarios s on s.id = bs.scenario_id
     where bs.benchmark_name = 'Voltaic S5' and bs.difficulty = 'Intermediate'
       and s.name = 'VT Pasu Intermediate S5'`,
  );
  check("thresholds survived the round trip",
    JSON.stringify(thresholds.rows[0]?.rank_maxes?.map(Number)) === "[770,850,930,980]",
    JSON.stringify(thresholds.rows[0]?.rank_maxes));

  const subcats = await db.query<{ sub_category: string; n: number }>(
    `select sub_category, count(*)::int as n from scenarios
     where sub_category is not null group by sub_category order by sub_category`,
  );
  // Read from the pool rather than written down. This was a literal nine, which was
  // Voltaic's count and stopped being ours the moment the pool declared eleven - and the
  // failure it produced was a seed that was entirely correct.
  const poolFile = JSON.parse(readFileSync(join(root, "data", "pool.json"), "utf8")) as {
    subCategories?: Record<string, string[]>;
  };
  const declared = new Set(Object.values(poolFile.subCategories ?? {}).flat());
  const seeded = new Set(subcats.rows.map((r) => r.sub_category));
  const absent = [...declared].filter((sub) => !seeded.has(sub));
  check(
    `every sub-skill the pool declares reaches the database (${declared.size})`,
    absent.length === 0,
    absent.length > 0 ? `missing ${absent.join(", ")}` : [...seeded].sort().join(", "),
  );

  // One end-to-end spot check that the sub-skill on a row is the right sub-skill, not
  // merely a non-null one. Voltaic S5 Intermediate is the case with a published answer:
  // Voltaic's own sheet puts PGT and Snake Track in precise tracking and nothing else,
  // and an earlier hand-derived mapping had exactly this pair wrong (PLAN.md §3).
  //
  // The name is read from the pool rather than written here, because the sub-skills were
  // renamed to their two-word form once the pool stopped being Voltaic's alone.
  const preciseTracking =
    (poolFile.subCategories?.Tracking ?? []).find((sub) => sub.startsWith("Precise")) ??
    "Precise Tracking";
  const precise = await db.query<{ name: string }>(
    `select s.name from scenarios s
     join benchmark_scenarios bs on bs.scenario_id = s.id
     where bs.benchmark_name = 'Voltaic S5' and bs.difficulty = 'Intermediate'
       and s.sub_category = $1 order by s.name`,
    [preciseTracking],
  );
  check(
    `${preciseTracking} in Voltaic S5 Intermediate is PGT and Snake Track`,
    precise.rows.map((r) => r.name).join(", ") ===
      "VT PGT Intermediate S5, VT Snake Track Intermediate S5",
    precise.rows.map((r) => r.name).join(", "),
  );

  // Verification data must reach the server, or the Edge Functions silently skip the
  // checks that depend on it and every run comes back Consistent.
  //
  // Coverage is deliberately reported rather than demanded. Models are LEARNED from
  // observed runs, and the seed corpus is one player's history, so only scenarios they
  // have played at least eight times can have one. Coverage grows on its own as
  // players upload; a scenario with no model skips the check rather than failing it.
  const models = await db.query<{ n: number }>(
    `select count(*)::int as n from scenarios where score_model_stat is not null`,
  );
  const totalScenarios = await db.query<{ n: number }>(
    `select count(*)::int as n from scenarios`,
  );
  const pct = ((models.rows[0].n / totalScenarios.rows[0].n) * 100).toFixed(0);
  check("score models were seeded", models.rows[0].n > 10,
    `${models.rows[0].n}/${totalScenarios.rows[0].n} scenarios (${pct}%), grows as players upload`);

  // The weapon-block rates verify runs that have no kill rows, which no seed file
  // carries: like the tail models they are learned locally and pushed by
  // `npm run sync:reference`. What has to be true here is that the migration made
  // somewhere for them to land, or the sync fails and the checks silently skip.
  const weaponColumns = await db.query<{ n: number }>(
    `select count(*)::int as n from information_schema.columns
     where table_name = 'scenarios'
       and column_name in ('weapon_score_per_damage', 'weapon_damage_per_shot',
                           'shots_per_second', 'duration_seconds')`,
  );
  check("weapon-block and firing-rate columns exist", weaponColumns.rows[0].n === 4,
    `${weaponColumns.rows[0].n} of 4`);

  const wr = await db.query<{ n: number }>(
    `select count(*)::int as n from scenarios where world_record is not null`,
  );
  check("world records were seeded", wr.rows[0].n > 40, `${wr.rows[0].n} scenarios`);

  const frog = await db.query<{ stat: string; k: number }>(
    `select score_model_stat as stat, score_model_k as k from scenarios
     where name = 'VT Frogtagon Intermediate S5'`,
  );
  check("Frogtagon's model is kills * 10",
    frog.rows[0]?.stat === "kills" && Number(frog.rows[0]?.k) === 10,
    `${frog.rows[0]?.stat} * ${frog.rows[0]?.k}`);

  const history = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_tables
     where schemaname = 'public' and tablename = 'rating_history'`,
  );
  check("rating history table exists", history.rows[0].n === 1);

  // ── rate limiting ──────────────────────────────────────────────────────────
  //
  // The limiter is the one piece of the schema whose whole job is to say no, so it is
  // worth proving it both counts and stops - and, more importantly, that it RESETS.
  // A window that never rolls over is not a rate limit, it is a lifetime quota that
  // locks a player out permanently, and it would look identical to a working one until
  // somebody hit it.
  console.log();
  console.log("── rate limiting ────────────────────────────────");

  const rlPlayer = await db.query<{ id: string }>(
    `insert into auth.users default values returning id`,
  );
  const rlId = rlPlayer.rows[0].id;
  await db.exec(
    `insert into players (id, steam_id, display_name)
     values ('${rlId}', '76561000000000009', 'rate limit probe')`,
  );

  const consume = async (limit: number, window = "60 seconds") => {
    const r = await db.query<{ ok: boolean }>(
      `select consume_rate_limit('${rlId}', 'probe', ${limit}, interval '${window}') as ok`,
    );
    return r.rows[0].ok;
  };

  const first = await consume(3);
  check("the first request is allowed", first === true);

  await consume(3);
  const third = await consume(3);
  check("requests up to the limit are allowed", third === true);

  const fourth = await consume(3);
  check("the request past the limit is refused", fourth === false);

  // Rolling the window back is what a real expiry does; this is the only way to test
  // it without sleeping for the window length.
  await db.exec(
    `update rate_limits set window_start = now() - interval '2 minutes'
     where player_id = '${rlId}' and action = 'probe'`,
  );
  const afterWindow = await consume(3);
  check("a new window lets the player back in", afterWindow === true);

  const counted = await db.query<{ count: number }>(
    `select count from rate_limits where player_id = '${rlId}' and action = 'probe'`,
  );
  check("the counter restarted rather than continuing",
    counted.rows[0].count === 1, `count is ${counted.rows[0].count}`);

  // Separate actions must not share a budget: a player who exhausts submit-run should
  // still be able to abandon the match they are stuck in.
  const otherAction = await db.query<{ ok: boolean }>(
    `select consume_rate_limit('${rlId}', 'different-action', 1, interval '60 seconds') as ok`,
  );
  check("a different action has its own budget", otherAction.rows[0].ok === true);

  const rlLocked = await db.query<{ n: number }>(
    `select count(*)::int as n from information_schema.role_table_grants
     where table_name = 'rate_limits' and grantee in ('anon', 'authenticated')`,
  );
  check("clients cannot read or write the limit counters",
    rlLocked.rows[0].n === 0, `${rlLocked.rows[0].n} grants`);

  // -------------------------------------------------------------------------------
  // Ghost cards (20260930000020). Minted by post-ghost from re-verified runs and read by
  // ghost-card, both under the service role; a client that could write here could mint a
  // card with nothing behind it. Each refusal below is asserted as a refusal that fired,
  // on a row that is otherwise valid, so a check cannot pass because the insert was
  // broken for some other reason.
  console.log("\n── ghost cards ──────────────────────────────────");

  const ghostTable = await db.query<{ rowsecurity: boolean }>(
    `select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'ghost_results'`,
  );
  check("the ghost_results table exists with row level security",
    ghostTable.rows.length === 1 && ghostTable.rows[0].rowsecurity === true);
  const ghostPolicies = policies.rows.filter((p) => p.tablename === "ghost_results");
  check("no client policy of any kind on it", ghostPolicies.length === 0,
    ghostPolicies.map((p) => p.cmd).join(", ") || "none");
  const ghostGrants = await db.query<{ n: number }>(
    `select count(*)::int as n from information_schema.role_table_grants
      where table_name = 'ghost_results' and grantee in ('anon', 'authenticated')`,
  );
  check("and no table grant to anon or authenticated", ghostGrants.rows[0].n === 0, `${ghostGrants.rows[0].n} grants`);

  const ghostUser = await db.query<{ id: string }>(`insert into auth.users (email) values ('ghost@arena.invalid') returning id`);
  const ghostPlayer = ghostUser.rows[0].id;
  await db.exec(`insert into players (id, steam_id, display_name) values ('${ghostPlayer}', '76561199000000077', 'ghost racer')`);
  const runIds = ["gen_random_uuid()", "gen_random_uuid()", "gen_random_uuid()"];
  const ghostRow = (over: Record<string, string> = {}) => {
    const cols: Record<string, string> = {
      player_id: `'${ghostPlayer}'`,
      code: `'ABCD2345'`,
      kind: `'last_week'`,
      scenario_names: `'{a,b,c}'`,
      live_run_ids: `array[${runIds.join(",")}]`,
      live_scores: `'{100,200,300}'`,
      ghost_scores: `'{98,205,290}'`,
      baselines: `'{99,201,295}'`,
      pbs: `'{120,230,330}'`,
      ghost_days: `'{2026-09-20,2026-09-22,2026-08-14}'`,
      tz_offset_minutes: `360`,
      margin: `0.012`,
      verdict: `'win'`,
      live_tier: `'consistent'`,
      ...over,
    };
    return db.query<{ live_run_ids: string[] }>(
      `insert into ghost_results (${Object.keys(cols).join(", ")}) values (${Object.values(cols).join(", ")}) returning live_run_ids`,
    );
  };
  const firstCard = await ghostRow();
  check("a card of three rounds is accepted", firstCard.rows.length === 1);
  const sameRuns = `'{${firstCard.rows[0].live_run_ids.join(",")}}'::uuid[]`;
  check("a void result has no card: the verdict enum refuses it",
    await refused(() => ghostRow({ code: `'ABCD2346'`, verdict: `'void'` })));
  check("a card of two rounds is refused",
    await refused(() => ghostRow({ code: `'ABCD2347'`, live_run_ids: `array[gen_random_uuid(), gen_random_uuid()]` })));
  check("a card whose arrays disagree in length is refused",
    await refused(() => ghostRow({ code: `'ABCD2348'`, ghost_scores: `'{98,205}'` })));
  check("the same three runs cannot mint a second card",
    await refused(() => ghostRow({ code: `'ABCD2349'`, live_run_ids: sameRuns })));
  check("a code post-ghost could not have minted is refused",
    await refused(() => ghostRow({ code: `'abcd0001'` })));
  check("an offset outside any real timezone is refused",
    await refused(() => ghostRow({ code: `'ABCD234A'`, tz_offset_minutes: `9999` })));
  check("and a different three are accepted, so the refusals above were about their one change",
    (await ghostRow({ code: `'ABCD234B'` })).rows.length === 1);
  await db.exec(`delete from players where id = '${ghostPlayer}'`);
  const ghostOrphans = await db.query<{ n: number }>(`select count(*)::int as n from ghost_results where player_id = '${ghostPlayer}'`);
  check("a deleted player leaves no card behind", ghostOrphans.rows[0].n === 0);

  // post-ghost's one UPDATE on runs, run for real: a file already counted by a ranked
  // match must come through a ghost post byte for byte, because settle-match reads its
  // played_at and tier. The statement is the one the function builds (player, sha,
  // match_id is null); validate:ghost holds the function's source to that filter and
  // runs planRunWrite, which decides it is never even attempted on a bound row.
  const racerUser = await db.query<{ id: string }>(`insert into auth.users (email) values ('ghost2@arena.invalid') returning id`);
  const racer = racerUser.rows[0].id;
  await db.exec(`insert into players (id, steam_id, display_name) values ('${racer}', '76561199000000078', 'ghost racer two')`);
  const ranked = await db.query<{ id: string }>(
    `insert into matches (mode, category, benchmark_name, difficulty, window_index, seed, scenario_ids, status)
     values ('async', 'Static Clicking', 'Season 1', 'Intermediate', 1, 'ghost-bound', '{1,2,3}', 'awaiting_runs')
     returning id`,
  );
  const rankedId = ranked.rows[0].id;
  await db.exec(
    `insert into runs (player_id, scenario_name, score, played_at, csv_sha256, match_id, verification_tier)
     values ('${racer}', 'bound scenario', 100, '2026-09-30T12:00:00Z', 'sha-bound', '${rankedId}', 'rejected'),
            ('${racer}', 'loose scenario', 100, '2026-09-30T12:00:00Z', 'sha-loose', null, 'suspect')`,
  );
  const ghostUpdate = (sha: string) =>
    db.query<{ id: string }>(
      `update runs set played_at = '2026-09-29T03:00:00Z', verification_tier = 'consistent', duration_seconds = 1
        where player_id = '${racer}' and csv_sha256 = '${sha}' and match_id is null returning id`,
    );
  const boundTouched = await ghostUpdate("sha-bound");
  const bound = await db.query<{ played_at: Date; verification_tier: string; match_id: string; duration_seconds: number | null }>(
    `select played_at, verification_tier, match_id, duration_seconds from runs where csv_sha256 = 'sha-bound'`,
  );
  check("a ghost post's update writes no row a ranked match has counted", boundTouched.rows.length === 0, `${boundTouched.rows.length} rows`);
  check("and that run's played_at, tier and match are exactly as the match left them",
    new Date(bound.rows[0].played_at).toISOString() === "2026-09-30T12:00:00.000Z" &&
      bound.rows[0].verification_tier === "rejected" && bound.rows[0].match_id === rankedId && bound.rows[0].duration_seconds === null,
    `${new Date(bound.rows[0].played_at).toISOString()} ${bound.rows[0].verification_tier}`);
  const looseTouched = await ghostUpdate("sha-loose");
  check("while a history row no match has claimed is rewritten, so the filter is not simply matching nothing",
    looseTouched.rows.length === 1);

  await db.close();

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK: schema and seed apply cleanly to a real Postgres");
}

main();
