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

  const policies = await db.query<{ tablename: string; policyname: string; cmd: string }>(
    `select tablename, policyname, cmd from pg_policies
     where schemaname = 'public' order by tablename, policyname`,
  );
  check("policies were created", policies.rows.length > 0, `${policies.rows.length} policies`);

  // The rule the whole security model rests on: clients may read these, never write.
  const protectedTables = ["ratings", "matches", "match_sides", "baselines", "verified_pbs"];
  const writable = policies.rows.filter(
    (p) => protectedTables.includes(p.tablename) && p.cmd.toUpperCase() !== "SELECT",
  );
  check("no client write policy on rating or match tables", writable.length === 0,
    writable.length ? writable.map((p) => `${p.tablename}:${p.cmd}`).join(", ") : "read-only");

  // Runs must be append-only.
  const runPolicies = policies.rows.filter((p) => p.tablename === "runs");
  const runCmds = new Set(runPolicies.map((p) => p.cmd.toUpperCase()));
  check("runs are append-only", !runCmds.has("UPDATE") && !runCmds.has("DELETE"),
    [...runCmds].join(", "));

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
  check("all nine sub-categories are present", subcats.rows.length === 9,
    subcats.rows.map((r) => r.sub_category).join(", "));

  const precise = await db.query<{ name: string }>(
    `select s.name from scenarios s
     join benchmark_scenarios bs on bs.scenario_id = s.id
     where bs.benchmark_name = 'Voltaic S5' and bs.difficulty = 'Intermediate'
       and s.sub_category = 'Precise' order by s.name`,
  );
  check("Precise tracking is PGT and Snake Track",
    precise.rows.map((r) => r.name).join(", ") ===
      "VT PGT Intermediate S5, VT Snake Track Intermediate S5",
    precise.rows.map((r) => r.name).join(", "));

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

  await db.close();

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK: schema and seed apply cleanly to a real Postgres");
}

main();
