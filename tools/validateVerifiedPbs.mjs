/**
 * The verified-PB baseline floor, populated and frozen (audit SEC-04).
 *
 *   node tools/validateVerifiedPbs.mjs
 *
 * PLAN.md section 3: baseline = max(median of the last 50 runs, 0.9 x verified PB).
 * verified_pbs was read and never written, so the floor was zero for everybody. This runs
 * the shipped `baselineFor` (supabase/functions/_shared/apogee.ts) with the real baseline
 * rule against every migration in PGlite and asserts:
 *
 *   - a run graded Verified records its score as the player's verified PB, and only a
 *     higher one replaces it;
 *   - migration 20261003000026 backfills the PB from runs already graded Verified;
 *   - baselineFor returns the floored value (it returned the raw median before);
 *   - a settlement's frozen baseline uses only verified runs from before the match, so a
 *     personal best set inside a match never raises that match's own baseline;
 *   - a client cannot reach any of it.
 */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { build } from "esbuild";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { migratedDatabase, restClient } from "./lib/postgrestOverPglite.mjs";

const MIGRATION = "20261003000026_time_integrity_and_hardening.sql";
let cases = 0;
const pass = (label) => { cases++; console.log(`  ok   ${label}`); };

mkdirSync(".cache", { recursive: true });
await build({
  entryPoints: ["supabase/functions/_shared/apogee.ts"], outfile: ".cache/verified-pbs-apogee.mjs",
  bundle: true, platform: "node", format: "esm", logLevel: "error",
  plugins: [{ name: "no-network", setup(b) {
    b.onResolve({ filter: /^jsr:/ }, () => ({ path: "client", namespace: "test" }));
    b.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export function createClient(){throw new Error('no network in this test')}", loader: "js" }));
  } }],
});
await build({
  entryPoints: ["src/core/history/baseline.ts"], outfile: ".cache/verified-pbs-baseline.mjs",
  bundle: true, platform: "node", format: "esm", logLevel: "error",
});
globalThis.Deno = { env: { get: () => "" } };
const { baselineFor } = await import(pathToFileURL(resolve(".cache/verified-pbs-apogee.mjs")).href);
const { baselineFromScores } = await import(pathToFileURL(resolve(".cache/verified-pbs-baseline.mjs")).href);

// The schema as it stood before this change, holding runs KovaaK's already verified.
const { db, finish } = await migratedDatabase(PGlite, readFileSync, readdirSync, { before: MIGRATION });
const admin = restClient(db);
const player = (await db.query("insert into auth.users default values returning id")).rows[0].id;
await db.query("insert into players (id, steam_id, display_name) values ($1, '76561100000000077', 'floored')", [player]);
const scenario = (await db.query("select id, name from scenarios where world_record > 2000 order by id limit 1")).rows[0];
let serial = 0;
const run = (score, tier, playedAt, extra = {}) => db.query(
  `insert into runs (player_id, scenario_name, score, played_at, created_at, challenge_start, csv_sha256, verification_tier, match_id)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [player, scenario.name, score, playedAt, extra.createdAt ?? playedAt, `10:00:${String(++serial).padStart(2, "0")}.000`,
   `pb-${serial}`, tier, extra.matchId ?? null],
);

// Thirty ordinary runs around 800, and one KovaaK's verified at 1000, last week.
for (let i = 0; i < 30; i++) await run(790 + (i % 3) * 10, "consistent", new Date(Date.parse("2026-09-20T12:00Z") + i * 60_000));
await run(1000, "verified", new Date("2026-09-25T12:00Z"));

const before = await baselineFor(admin, player, scenario.id, scenario.name, baselineFromScores);
assert.equal(before.value, 800, "before the change: the median alone, the floor never engaged");
assert.equal(before.flooredByPb, false);
pass("before 20261003000026 the baseline is the raw median (800); the verified 1000 is ignored");

await finish();
const backfilled = (await db.query("select score from verified_pbs where player_id = $1 and scenario_id = $2", [player, scenario.id])).rows[0];
assert.equal(Number(backfilled?.score), 1000);
pass("the migration backfills verified_pbs from runs already graded Verified");

const floored = await baselineFor(admin, player, scenario.id, scenario.name, baselineFromScores);
assert.equal(floored.value, 900, "max(median 800, 0.9 x 1000)");
assert.equal(floored.flooredByPb, true);
pass("baselineFor returns the floored value, max(800, 0.9 x 1000) = 900, as PLAN.md section 3 states");

await run(950, "verified", new Date("2026-09-26T12:00Z"));
assert.equal(Number((await db.query("select score from verified_pbs where player_id = $1", [player])).rows[0].score), 1000);
await run(1100, "consistent", new Date("2026-09-27T12:00Z"));
assert.equal(Number((await db.query("select score from verified_pbs where player_id = $1", [player])).rows[0].score), 1000,
  "an unverified score, however high, is not a verified PB");
pass("a lower verified run leaves the PB alone, and an unverified one never sets it");

// A match that began on 2026-10-01; inside it the player sets a verified 1200.
const match = (await db.query(
  `insert into matches (category, status, benchmark_name, difficulty, seed, scenario_ids, created_at)
   values ('Clicking', 'awaiting_runs', 'Season 1', 'Intermediate', 'pb', $1::bigint[], '2026-10-01T12:00Z') returning id`,
  [[scenario.id, scenario.id, scenario.id]])).rows[0].id;
await run(1200, "verified", new Date("2026-10-01T12:03Z"), { matchId: match, createdAt: new Date("2026-10-01T12:03:02Z") });
assert.equal(Number((await db.query("select score from verified_pbs where player_id = $1", [player])).rows[0].score), 1200,
  "the stored PB moves to 1200 at once");
const frozen = await baselineFor(admin, player, scenario.id, scenario.name, baselineFromScores,
  { at: "2026-10-01T12:00:00Z", matchId: match });
assert.equal(frozen.value, 900, "the match's own PB does not raise its baseline to 0.9 x 1200");
const later = await baselineFor(admin, player, scenario.id, scenario.name, baselineFromScores,
  { at: "2026-10-02T12:00:00Z", matchId: "00000000-0000-0000-0000-000000000000" });
assert.equal(later.value, 1080, "the next match does use it");
pass("a settlement freezes the floor at match start: 900 for the match the 1200 was set in, 1080 after");

// A player with no verified runs keeps exactly the baseline they had.
const other = (await db.query("insert into auth.users default values returning id")).rows[0].id;
await db.query("insert into players (id, steam_id, display_name) values ($1, '76561100000000078', 'unlinked')", [other]);
for (let i = 0; i < 10; i++) {
  await db.query(`insert into runs (player_id, scenario_name, score, played_at, csv_sha256, verification_tier)
    values ($1, $2, $3, $4, $5, 'consistent')`, [other, scenario.name, 700 + i, new Date(Date.parse("2026-09-20T12:00Z") + i * 60_000), `u-${i}`]);
}
const unlinked = await baselineFor(admin, other, scenario.id, scenario.name, baselineFromScores);
assert.equal(unlinked.value, 704.5);
assert.equal(unlinked.flooredByPb, false);
pass("a player with no Verified runs (no linked account) keeps the plain median");

await db.exec("set role authenticated");
await db.query("select set_config('test.player_id', $1, false)", [player]);
for (const sql of [
  `insert into verified_pbs (player_id, scenario_id, score) values ('${player}', ${scenario.id}, 999999)`,
  `update verified_pbs set score = 1 where player_id = '${player}'`,
  `insert into runs (player_id, scenario_name, score, played_at, csv_sha256, verification_tier) values ('${player}', '${scenario.name}', 99999, now(), 'forged', 'verified')`,
]) {
  let changed = 0;
  try { changed = (await db.query(sql)).affectedRows ?? 0; } catch { changed = 0; }
  assert.equal(changed, 0, `refused: ${sql.slice(0, 50)}`);
}
await db.exec("reset role");
assert.equal(Number((await db.query("select score from verified_pbs where player_id = $1", [player])).rows[0].score), 1200);
pass("a client can neither write verified_pbs nor file a run graded verified");

await db.close();
console.log(`\nOK: ${cases} verified-PB floor cases against the shipped baselineFor and migrations`);
