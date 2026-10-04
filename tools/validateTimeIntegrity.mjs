/**
 * Time integrity: the UTC offset a client declares, held to the match it started, to the
 * player's own recent uploads, to the server's clock and to the first upload of each run.
 *
 *   npx tsx tools/validateTimeIntegrity.mjs
 *
 * Runs the shipped submit-run handler and the shared helpers in
 * supabase/functions/_shared/timeIntegrity.ts against every migration in PGlite. Players
 * are simulated as the desktop client is: their runs are written by the synthetic stats
 * generator in their own zone (process.env.TZ), history goes up through the client's own
 * payload builder as the `authenticated` role, and submissions carry the offset the client
 * computes. Only authentication, rate limiting and the network to KovaaK's are stubbed.
 *
 * Three groups, each of which must hold:
 *
 *   HONEST   players from UTC-10 to UTC+14, on half-hour and 45-minute offsets, across a
 *            daylight-saving change, on an older client, and backfilling week-old runs,
 *            all play and count exactly as before.
 *   ATTACKS  each path in the security audit (SEC-01, SEC-02) and the ones found while
 *            fixing it, refused or rejected.
 *   RESIDUAL what is still possible is shown passing, so the doc's claim about it is
 *            measured rather than asserted.
 */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { build } from "esbuild";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { migratedDatabase, restClient, toParam } from "./lib/postgrestOverPglite.mjs";
import { appendRun, catalog } from "./fixtures/syntheticStats.ts";
import { parseStatsFile } from "../src/core/stats/parseStatsFile.ts";
import { hashCsv, runClockOffset, toPayload } from "../src/core/sync/uploadRuns.ts";
import {
  clockContinuity,
  formatUtcOffset,
  isFutureDated,
  matchClockProblem,
  wallClock,
  zoneExplaining,
} from "../src/core/verify/timeIntegrity.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.now();
let cases = 0;
const pass = (label) => { cases++; console.log(`  ok   ${label}`); };

// ---- database ------------------------------------------------------------------------
const { db } = await migratedDatabase(PGlite, readFileSync, readdirSync);
const admin = restClient(db);

// ---- the shipped handler and helpers -------------------------------------------------
mkdirSync(".cache", { recursive: true });
const actualShared = resolve("supabase/functions/_shared/apogee.ts").replaceAll("\\", "/");
const stubs = {
  name: "isolated-boundaries",
  setup(b) {
    b.onResolve({ filter: /\/_shared\/apogee\.ts$/ }, (args) =>
      args.namespace === "test" ? { path: actualShared, namespace: "file" }
        : args.importer.replaceAll("\\", "/").endsWith("submit-run/index.ts") ? { path: "boundary", namespace: "test" }
        : undefined);
    b.onResolve({ filter: /\/_shared\/rateLimit\.ts$/ }, () => ({ path: "limits", namespace: "test" }));
    b.onResolve({ filter: /^jsr:/ }, () => ({ path: "client", namespace: "test" }));
    b.onLoad({ filter: /.*/, namespace: "test" }, (args) => ({
      contents: args.path === "boundary"
        ? `export * from ${JSON.stringify(actualShared)};
           export const handler = fn => req => fn(req, globalThis.ti.admin);
           export const requireCaller = async () => globalThis.ti.caller;
           export const json = (body, status = 200) => ({ body, status });`
        : args.path === "limits" ? "export const enforceRateLimit = async () => {};"
        : "export function createClient(){ throw new Error('no network in this test'); }",
      loader: "js",
    }));
  },
};
await build({ entryPoints: ["supabase/functions/submit-run/index.ts"], outfile: ".cache/time-submit-run.mjs", bundle: true, platform: "node", format: "esm", plugins: [stubs], logLevel: "error" });
await build({ entryPoints: ["supabase/functions/_shared/timeIntegrity.ts"], outfile: ".cache/time-shared.mjs", bundle: true, platform: "node", format: "esm", plugins: [stubs], logLevel: "error" });

let handler;
globalThis.Deno = { env: { get: () => "" }, serve: (fn) => { handler = fn; } };
globalThis.ti = { admin, caller: null, kovaaks: new Map() };
// KovaaK's last-scores, answered from a fixture: the network is not part of this test.
globalThis.fetch = async (url) => {
  const name = new URL(String(url)).searchParams.get("scenarioName");
  return new Response(JSON.stringify((globalThis.ti.kovaaks.get(name) ?? []).map((r) => ({
    score: r.score, attributes: { hash: r.hash, challengeStart: r.challengeStart, epoch: String(r.epoch) },
  }))), { status: 200 });
};
await import(pathToFileURL(resolve(".cache/time-submit-run.mjs")).href);
const shared = await import(pathToFileURL(resolve(".cache/time-shared.mjs")).href);
assert.equal(typeof handler, "function", "the real submit-run handler registered");

// ---- the player, as the desktop client ------------------------------------------------
const STATS = ".cache/time-integrity/stats";
rmSync(".cache/time-integrity", { recursive: true, force: true });

// Library scenarios carry learned score and weapon models, so the real checks run.
const inSeed = new Set((await db.query("select name from scenarios")).rows.map((r) => r.name));
const library = catalog().library.map((s) => s.name).filter((n) => inSeed.has(n)).slice(0, 4);
assert.equal(library.length, 4, "four library scenarios exist in the seed");
const scenarioIds = (await db.query("select id, name from scenarios where name = any($1)", [library])).rows;
const idOf = (name) => Number(scenarioIds.find((s) => s.name === name).id);
const MATCH = library.slice(0, 3);
const ELSE = library[3];

let serial = 0;
async function mkPlayer(label) {
  const id = (await db.query("insert into auth.users default values returning id")).rows[0].id;
  serial++;
  await db.query("insert into players (id, steam_id, display_name) values ($1, $2, $3)",
    [id, `7656110${String(serial).padStart(10, "0")}`, label]);
  return id;
}

/** KovaaK's writes the file when a run ends, in the PC's local time. */
function play(zone, scenario, endedAt) {
  process.env.TZ = zone;
  return appendRun(STATS, { scenario, seed: ++serial * 7919, at: new Date(endedAt) });
}

/** History, exactly as uploadRecentRuns sends it: the client's payload, under RLS. */
async function uploadHistory(player, zone, runs, { oldClient = false } = {}) {
  process.env.TZ = zone;
  await db.exec("set role authenticated");
  await db.query("select set_config('test.player_id', $1, false)", [player]);
  let stored = 0;
  try {
    for (const run of runs) {
      const parsed = parseStatsFile(run.file, run.content);
      assert.ok(parsed.ok, `generator run parses: ${run.file}`);
      const payload = { ...toPayload(parsed.run, hashCsv(run.content)), player_id: player };
      if (oldClient) delete payload.tz_offset_minutes;
      const keys = Object.keys(payload);
      const r = await db.query(
        `insert into runs (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})
         on conflict (player_id, csv_sha256) do nothing`,
        keys.map((k) => toParam(payload[k])),
      );
      stored += r.affectedRows ?? 0;
    }
  } finally {
    await db.exec("reset role");
  }
  return stored;
}

/** find-match / send-duel / answer-duel: the shared clock check, then the match and side. */
async function queue(player, zone, { createdAt = NOW - 4 * MIN, ttl = 8 * MIN, offset, oldClient = false } = {}) {
  process.env.TZ = zone;
  const body = oldClient ? {} : { tzOffsetMinutes: offset ?? new Date(createdAt).getTimezoneOffset() };
  const clock = await shared.matchClock(admin, player, body, createdAt);
  const match = (await db.query(
    `insert into matches (category, status, benchmark_name, difficulty, window_index, seed, scenario_ids, created_at, expires_at)
     values ('Clicking', 'awaiting_runs', 'Season 1', 'Intermediate', 1, $1, $2::bigint[], $3, $4) returning id`,
    [`seed-${++serial}`, MATCH.map(idOf), new Date(createdAt), new Date(createdAt + ttl)],
  )).rows[0].id;
  await db.query(
    "insert into match_sides (match_id, player_id, rating_before, rd_before, tz_offset_minutes, tz_declared_at) values ($1, $2, 1500, 350, $3, $4)",
    [match, player, clock.tz_offset_minutes ?? null, clock.tz_declared_at ?? null],
  );
  return match;
}

/** submit-run, with the body the client builds. `overrides` is what a modified client changes. */
async function submit(player, zone, run, matchId, overrides = {}, kovaaksUsername = null) {
  process.env.TZ = zone;
  const body = { filename: run.file, csv: run.content, csvSha256: hashCsv(run.content), matchId, tzOffsetMinutes: runClockOffset(run.file), ...overrides };
  globalThis.ti.caller = { playerId: player, kovaaksUsername };
  return handler(new Request("https://local.invalid/submit-run", { method: "POST", body: JSON.stringify(body) }));
}

const refused = async (promise, status, pattern, label) => {
  await assert.rejects(promise, (e) => e.status === status && (!pattern || pattern.test(e.message)), label);
};
const stored = async (player, run) => (await db.query(
  "select played_at, tz_offset_minutes, ended_local, match_id, verification_tier from runs where player_id = $1 and csv_sha256 = $2",
  [player, hashCsv(run.content)],
)).rows[0];
const sideClock = async (match, player) => (await db.query(
  "select tz_offset_minutes from match_sides where match_id = $1 and player_id = $2", [match, player],
)).rows[0].tz_offset_minutes;

// =====================================================================================
console.log("\n-- pure rules --");
assert.equal(formatUtcOffset(300), "UTC-5");
assert.equal(formatUtcOffset(-345), "UTC+5:45");
assert.equal(formatUtcOffset(0), "UTC");
assert.equal(wallClock("X - Challenge - 2026.10.03-16.01.02 Stats.csv").local, "2026-10-03 16:01:02");
pass("offsets format as players read them, and the filename wall clock reads without a zone");
// Sydney left standard time at 2026-10-03T16:00Z; Lord Howe moves half an hour; Troll two.
assert.notEqual(zoneExplaining({ offset: -600, at: Date.parse("2026-10-03T15:30Z") }, { offset: -660, at: Date.parse("2026-10-03T16:30Z") }), null);
assert.notEqual(zoneExplaining({ offset: -630, at: Date.parse("2026-10-03T15:00Z") }, { offset: -660, at: Date.parse("2026-10-03T16:00Z") }), null);
assert.notEqual(zoneExplaining({ offset: 0, at: Date.parse("2026-03-29T00:30Z") }, { offset: -120, at: Date.parse("2026-03-29T01:30Z") }), null);
assert.equal(zoneExplaining({ offset: 0, at: Date.parse("2026-10-03T10:00Z") }, { offset: 300, at: Date.parse("2026-10-03T15:00Z") }), null);
assert.equal(zoneExplaining({ offset: -600, at: Date.parse("2026-10-01T10:00Z") }, { offset: -660, at: Date.parse("2026-10-01T12:00Z") }), null,
  "a one-hour step with no transition between the two instants is not daylight saving");
pass("a real zone explains a 60-, 30- or 120-minute daylight-saving step only across its own transition");
assert.equal(clockContinuity({ offset: 300, at: NOW }, [{ offset: 0, at: NOW - 5 * HOUR }]).ok, false);
assert.equal(clockContinuity({ offset: 300, at: NOW }, [{ offset: 0, at: NOW - 7 * HOUR }]).ok, true);
assert.match(clockContinuity({ offset: 300, at: NOW }, [{ offset: 0, at: NOW - 5 * HOUR }]).message, /UTC-5.*UTC.*6 hours/);
assert.equal(matchClockProblem({ offset: 0, at: NOW }, { offset: 0, at: NOW }), null);
assert.match(matchClockProblem({ offset: 0, at: NOW }, { offset: 299, at: NOW }), /started with your PC's clock on UTC/);
assert.equal(isFutureDated(NOW + 14 * MIN, NOW), false);
assert.equal(isFutureDated(NOW + 16 * MIN, NOW), true);
pass("continuity, one clock per match and the future bound decide as documented");

// =====================================================================================
console.log("\n-- honest players, UTC-10 to UTC+14 --");
const ZONES = [
  "Pacific/Honolulu", "Pacific/Marquesas", "America/Anchorage", "America/Los_Angeles", "America/Chicago",
  "America/New_York", "America/St_Johns", "America/Sao_Paulo", "Atlantic/Azores", "UTC", "Europe/London",
  "Europe/Berlin", "Africa/Lagos", "Europe/Moscow", "Asia/Tehran", "Asia/Dubai", "Asia/Kabul", "Asia/Kolkata",
  "Asia/Kathmandu", "Asia/Yangon", "Asia/Shanghai", "Australia/Eucla", "Asia/Tokyo", "Australia/Adelaide",
  "Australia/Sydney", "Australia/Lord_Howe", "Pacific/Auckland", "Pacific/Chatham", "Pacific/Tongatapu", "Pacific/Kiritimati",
];
const seenOffsets = new Set();
for (const [i, zone] of ZONES.entries()) {
  const p = await mkPlayer(`honest ${zone}`);
  // Earlier this evening, uploaded as each run landed.
  const evening = [play(zone, ELSE, NOW - 3 * HOUR), play(zone, MATCH[0], NOW - 2 * HOUR), play(zone, ELSE, NOW - HOUR)];
  assert.equal(await uploadHistory(p, zone, evening), 3, `${zone}: history uploads`);
  const match = await queue(p, zone);
  process.env.TZ = zone;
  const offset = new Date(NOW).getTimezoneOffset();
  seenOffsets.add(offset);
  assert.equal(await sideClock(match, p), offset, `${zone}: match clock recorded`);
  for (const [k, name] of MATCH.entries()) {
    const run = play(zone, name, NOW - (3 - k) * MIN);
    // Every other player has the first match run reach history first, as with the app
    // closed: submit-run then claims the stored row.
    if (k === 0 && i % 2 === 1) assert.equal(await uploadHistory(p, zone, [run]), 1);
    const res = await submit(p, zone, run, match);
    assert.equal(res.body.counted, true, `${zone} ${name}: counted (${res.body.reasons})`);
    assert.ok(["consistent", "verified"].includes(res.body.verificationTier), `${zone}: tier ${res.body.verificationTier}`);
    const row = await stored(p, run);
    assert.equal(new Date(row.played_at).getTime(), run.endedAt.getTime(), `${zone}: stored at the instant it was played`);
    assert.equal(row.tz_offset_minutes, offset);
    assert.equal(row.match_id, match);
  }
}
assert.ok(seenOffsets.has(600) && seenOffsets.has(-840) && seenOffsets.has(-345) && seenOffsets.has(-525) && seenOffsets.has(-825) && seenOffsets.has(570),
  "the matrix covers UTC-10, UTC+14 and the 30- and 45-minute offsets");
pass(`${ZONES.length} zones (${seenOffsets.size} distinct offsets): history, queue and three ranked runs each, all counted at the true instant`);

// =====================================================================================
console.log("\n-- honest players across a daylight-saving change --");
// Sydney: AEST (UTC+10) until 2026-10-03T16:00Z, AEDT (UTC+11) after.
{
  const zone = "Australia/Sydney";
  const p = await mkPlayer("Sydney across the change");
  const before = [play(zone, ELSE, Date.parse("2026-10-03T15:20Z")), play(zone, MATCH[1], Date.parse("2026-10-03T15:50Z"))];
  process.env.TZ = zone;
  assert.deepEqual(before.map((r) => toPayload(parseStatsFile(r.file, r.content).run, "x").tz_offset_minutes), [-600, -600],
    "a run from before the change carries the offset it was played under, not today's");
  assert.equal(await uploadHistory(p, zone, before), 2);
  // Upload history pressed again after the change: the same files, ignored.
  assert.equal(await uploadHistory(p, zone, before), 0);
  // A match at 17:00Z, on daylight time, with the standard-time uploads 70 minutes old.
  const clock = await shared.matchClock(admin, p, { tzOffsetMinutes: -660 }, Date.parse("2026-10-03T17:00Z"));
  assert.equal(clock.tz_offset_minutes, -660);
  // A clock no zone explains is still refused.
  await refused(shared.matchClock(admin, p, { tzOffsetMinutes: -540 }, Date.parse("2026-10-03T17:00Z")), 409, /6 hours/);
  pass("Sydney: uploads on UTC+10, a match on UTC+11 an hour after the change, accepted; UTC+9 refused");
}
{
  // Lord Howe moves by thirty minutes, at 2026-10-03T15:30Z.
  const zone = "Australia/Lord_Howe";
  const p = await mkPlayer("Lord Howe across the change");
  assert.equal(await uploadHistory(p, zone, [play(zone, ELSE, Date.parse("2026-10-03T15:10Z"))]), 1);
  assert.equal((await shared.matchClock(admin, p, { tzOffsetMinutes: -660 }, Date.parse("2026-10-03T16:10Z"))).tz_offset_minutes, -660);
  pass("Lord Howe: a 30-minute daylight-saving step between uploads, accepted");
}
{
  // Chicago sprang forward at 2026-03-08T08:00Z (UTC-6 to UTC-5).
  const zone = "America/Chicago";
  const p = await mkPlayer("Chicago in March");
  assert.equal(await uploadHistory(p, zone, [play(zone, ELSE, Date.parse("2026-03-08T07:30Z"))]), 1);
  assert.equal((await shared.matchClock(admin, p, { tzOffsetMinutes: 300 }, Date.parse("2026-03-08T09:00Z"))).tz_offset_minutes, 300);
  pass("Chicago: spring forward between an upload and a match, accepted");
}
{
  // A match that starts before Sydney's change and has a run land after it.
  const p = await mkPlayer("Sydney match across the change");
  const match = (await db.query(
    `insert into matches (category, status, benchmark_name, difficulty, seed, scenario_ids, created_at, expires_at)
     values ('Clicking', 'awaiting_runs', 'Season 1', 'Intermediate', 'dst', $1::bigint[], '2026-10-03T15:58Z', '2026-10-03T16:10Z') returning id`,
    [MATCH.map(idOf)])).rows[0].id;
  await db.query("insert into match_sides (match_id, player_id, tz_offset_minutes, tz_declared_at) values ($1, $2, -600, '2026-10-03T15:58Z')", [match, p]);
  const hold = (offset, at) => shared.holdToMatchClock(admin, {
    matchId: match, playerId: p, side: { tz_offset_minutes: -600, tz_declared_at: "2026-10-03T15:58Z" },
    matchCreatedAt: "2026-10-03T15:58Z", offset, runEndedAt: Date.parse(at), now: Date.parse(at) + 5000,
  });
  await hold(-600, "2026-10-03T15:59:30Z");
  await hold(-660, "2026-10-03T16:03Z");
  await refused(hold(-720, "2026-10-03T16:03Z"), 409, /started with your PC's clock on UTC\+10/);
  pass("a match that straddles the change takes the new offset for runs after it, and nothing else");
}

// =====================================================================================
console.log("\n-- an older client --");
{
  const zone = "America/Denver";
  const p = await mkPlayer("old client");
  assert.equal(await uploadHistory(p, zone, [play(zone, ELSE, NOW - HOUR)], { oldClient: true }), 1);
  const old = (await db.query("select tz_offset_minutes, ended_local from runs where player_id = $1", [p])).rows[0];
  assert.deepEqual([old.tz_offset_minutes, old.ended_local], [null, null]);
  pass("history from a client that sends no offset is stored as before, with no wall clock");
  const match = await queue(p, zone, { oldClient: true });
  assert.equal(await sideClock(match, p), null, "a match from an older client starts unpinned");
  const first = play(zone, MATCH[0], NOW - 3 * MIN);
  process.env.TZ = zone;
  // The old client sends today's offset with each ranked run; that pins the match clock.
  const res = await submit(p, zone, first, match, { tzOffsetMinutes: new Date().getTimezoneOffset() });
  assert.equal(res.body.counted, true);
  assert.equal(await sideClock(match, p), new Date().getTimezoneOffset(), "pinned by its first ranked run");
  const second = play(zone, MATCH[1], NOW - 2 * MIN);
  await refused(submit(p, zone, second, match, { tzOffsetMinutes: new Date().getTimezoneOffset() - 60 }), 409, /started with/);
  assert.equal((await submit(p, zone, second, match)).body.counted, true);
  await refused(submit(p, zone, play(zone, MATCH[2], NOW - MIN), match, { tzOffsetMinutes: undefined }), 400, /UTC offset/);
  pass("an older client's match is pinned by its first ranked run and held to it; a ranked run with no offset is refused");
}

// =====================================================================================
console.log("\n-- a late backfill of week-old runs --");
{
  const zone = "Europe/Paris";
  const p = await mkPlayer("backfill");
  const old = [play(zone, MATCH[0], NOW - 7 * 24 * HOUR), play(zone, MATCH[1], NOW - 7 * 24 * HOUR + 2 * MIN)];
  assert.equal(await uploadHistory(p, zone, old), 2);
  const rows = (await db.query("select played_at from runs where player_id = $1 order by played_at", [p])).rows;
  assert.deepEqual(rows.map((r) => new Date(r.played_at).getTime()), old.map((r) => r.endedAt.getTime()));
  pass("week-old runs upload as history at the instants they were played");
  // Travelled since: a week-old offset says nothing about the clock today.
  const match = await queue(p, "America/New_York");
  process.env.TZ = "America/New_York";
  const declared = new Date(NOW).getTimezoneOffset();
  const honest = await submit(p, zone, old[0], match, { tzOffsetMinutes: declared });
  assert.equal(honest.body.counted, false, "a week-old run is outside this match's window");
  // A week is beyond any offset (they stop at 14 hours), so the way to move it is to
  // rename the file: today's date and time in the filename, the honest offset. The server
  // has stored this performance before, and it keeps that time.
  const ny = "America/New_York";
  const match2 = await queue(p, ny, { createdAt: NOW - MIN });
  process.env.TZ = ny;
  const t = new Date(NOW - 30_000);
  const pad = (n) => String(n).padStart(2, "0");
  const renamed = {
    ...old[1],
    file: old[1].file.replace(/\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2} Stats\.csv$/,
      `${t.getFullYear()}.${pad(t.getMonth() + 1)}.${pad(t.getDate())}-${pad(t.getHours())}.${pad(t.getMinutes())}.${pad(t.getSeconds())} Stats.csv`),
  };
  const shifted = await submit(p, ny, renamed, match2);
  assert.equal(shifted.body.counted, false);
  assert.ok(shifted.body.advisories.some((a) => /first uploaded ending at/.test(a)));
  pass("a backfilled run cannot be counted in a match it was not played in, honestly or renamed to today");
}

// =====================================================================================
console.log("\n-- SEC-01: the offset as a time machine --");
{
  // The audit's PoC (poc/tzWindowBypass*.mjs) on a generator run: a player in UTC
  // pre-plays a run five hours before the match and stamps it inside with +300.
  const zone = "UTC";
  const p = await mkPlayer("sec-01 attacker");
  const preplayed = play(zone, MATCH[0], NOW - 5 * HOUR - 2 * MIN);
  // Their ordinary evening, uploaded as it landed.
  await uploadHistory(p, zone, [play(zone, ELSE, NOW - 2 * HOUR)]);
  // (a) Declare the shifted clock for the match: the evening's uploads contradict it.
  await refused(queue(p, zone, { offset: 300 }), 409, /UTC-5.*uploaded on UTC/);
  // (b) Honest match clock, shifted run: refused.
  const match = await queue(p, zone);
  await refused(submit(p, zone, preplayed, match, { tzOffsetMinutes: 300 }), 409, /started with your PC's clock on UTC/);
  // (c) Honest clock and honest offset: the run is where it always was, outside the window.
  assert.equal((await submit(p, zone, preplayed, match)).body.counted, false);
  pass("a pre-played run cannot be stamped into a match: the shifted clock is refused at queue and at submission");

  // Run-shopping: two pre-played runs from different hours into one match.
  const q = await mkPlayer("sec-01 shopper");
  const m = await queue(q, zone, { offset: 120 });
  const a = play(zone, MATCH[0], NOW - 2 * HOUR - 3 * MIN);
  const b = play(zone, MATCH[1], NOW - 4 * HOUR - 2 * MIN);
  assert.equal((await submit(q, zone, a, m, { tzOffsetMinutes: 120 })).body.counted, true, "(the residual, see below)");
  await refused(submit(q, zone, b, m, { tzOffsetMinutes: 240 }), 409, /started with/);
  pass("best runs from different times of day cannot share one match");

  // Uploaded live, restamped later. The run was uploaded as it landed; seven hours on,
  // past the continuity window, a shifted clock is accepted for a new match.
  const r = await mkPlayer("sec-01 restamp");
  const live = play(zone, MATCH[0], NOW - 7 * HOUR);
  await uploadHistory(r, zone, [live]);
  const late = await queue(r, zone, { offset: 420 });
  const res = await submit(r, zone, live, late, { tzOffsetMinutes: 420 });
  assert.equal(res.body.counted, false, "graded at its first-seen time, outside the window");
  assert.ok(res.body.reasons.some((x) => /in_match_window/.test(x)));
  assert.equal(new Date((await stored(r, live)).played_at).getTime(), live.endedAt.getTime(), "the stored time never moved");
  pass("a run uploaded live keeps its first-seen time and fails the window of a later match");

  // Nothing from the future.
  const f = await mkPlayer("sec-01 future");
  await refused(submit(f, zone, play(zone, ELSE, NOW - MIN), undefined, { tzOffsetMinutes: 90 }), 422, /ahead of the server's clock/);
  await db.exec("set role authenticated");
  await db.query("select set_config('test.player_id', $1, false)", [f]);
  const ahead = await db.query(
    `insert into runs (player_id, scenario_name, score, played_at, challenge_start, csv_sha256, tz_offset_minutes)
     values ($1, $2, 100, now() + interval '1 hour', '10:00:00.000', 'future-history', 0) on conflict (player_id, csv_sha256) do nothing`, [f, ELSE]);
  const skewed = await db.query(
    `insert into runs (player_id, scenario_name, score, played_at, challenge_start, csv_sha256, tz_offset_minutes)
     values ($1, $2, 100, now() + interval '10 minutes', '10:00:01.000', 'fast-clock-history', 0) on conflict (player_id, csv_sha256) do nothing`, [f, ELSE]);
  await db.exec("reset role");
  assert.equal(ahead.affectedRows, 0, "an hour-ahead history row is skipped, not stored");
  assert.equal(skewed.affectedRows, 1, "a PC clock ten minutes fast still uploads");
  assert.equal((await submit(f, zone, play(zone, ELSE, NOW + 10 * MIN), undefined, {})).body.counted, true, "and submits");
  pass("a corrected end later than the server's clock plus 15 minutes is refused; a ten-minute-fast PC is not");

  // Played after the deadline of a match nobody swept, then stamped back into it.
  // One fake offset held for both, 43 minutes behind, so the run played now is stamped
  // inside a window that closed half an hour ago - in-window by every other rule.
  const l = await mkPlayer("sec-01 post-play");
  const stale = await queue(l, zone, { offset: -43, createdAt: NOW - 45 * MIN });
  const postPlayed = play(zone, MATCH[0], NOW - MIN);
  assert.ok(wallClock(postPlayed.file).ms - 43 * MIN >= NOW - 48 * MIN, "the stamped time is inside the window");
  await refused(submit(l, zone, postPlayed, stale, { tzOffsetMinutes: -43 }), 409, /ran out of time/);
  pass("a ranked run reaching the server long after its match's deadline is refused");
}

// =====================================================================================
console.log("\n-- SEC-02: one performance, one match --");
{
  const zone = "Europe/Berlin";
  const p = await mkPlayer("sec-02 replay");
  const first = await queue(p, zone);
  const run = play(zone, MATCH[0], NOW - 2 * MIN);
  assert.equal((await submit(p, zone, run, first)).body.counted, true);
  const second = await queue(p, zone, { createdAt: NOW - MIN });
  // Re-exported: one whitespace byte, so a new csv_sha256.
  const reexported = { ...run, content: run.content + "\n" };
  const dup = await submit(p, zone, reexported, second);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.duplicate, true);
  // Renamed: the filename's clock moved thirty seconds, so a new wall clock as well.
  const renamed = { ...reexported, file: run.file.replace(/(\d{2}) Stats\.csv$/, (_, s) => `${String((+s + 30) % 60).padStart(2, "0")} Stats.csv`) };
  const dup2 = await submit(p, zone, renamed, second);
  assert.equal(dup2.status, 409);
  const claims = (await db.query("select count(*)::int as n from ranked_run_fingerprints where player_id = $1", [p])).rows[0].n;
  assert.equal(claims, 1);
  pass("a re-exported or renamed copy of a counted run is refused in another match");

  // The audit's PoC (poc/replayAcrossMatches.mjs) at the database: two digests, two
  // client-chosen instants an hour apart, two matches.
  const q = await mkPlayer("sec-02 direct");
  const mk = async (s) => (await db.query(
    `insert into matches (category, status, benchmark_name, difficulty, seed, scenario_ids) values ('Clicking','awaiting_runs','Voltaic S5','Intermediate',$1,$2::bigint[]) returning id`,
    [s, MATCH.map(idOf)])).rows[0].id;
  const [ma, mb] = [await mk("poc-a"), await mk("poc-b")];
  const ins = (sha, at, m) => db.query(
    `insert into runs (player_id, scenario_name, score, played_at, challenge_start, csv_sha256, match_id, verification_tier)
     values ($1, $2, 1234, $3, '09:00:00.000', $4, $5, 'consistent')`, [q, MATCH[0], at, sha, m]);
  await ins("file-as-exported", new Date(NOW - 10 * MIN), ma);
  await assert.rejects(ins("file-plus-one-space", new Date(NOW - 10 * MIN + HOUR), mb), (e) => e.code === "TI409" || e.code === "23505");
  assert.equal((await db.query("select count(*)::int as n from runs where player_id = $1", [q])).rows[0].n, 1);
  pass("the PoC's second insert is refused: one row stored, one claim");
}

// =====================================================================================
console.log("\n-- positive contradiction from KovaaK's --");
{
  const zone = "America/Los_Angeles";
  const linked = "linked_player";
  const record = (run, epoch) => {
    const parsed = parseStatsFile(run.file, run.content).run;
    globalThis.ti.kovaaks.set(run.scenario, [{ score: parsed.score, hash: parsed.hash, challengeStart: parsed.challengeStart, epoch }]);
  };
  // The residual attacker, linked: no live uploads, one fake zone, runs pre-played five
  // hours ahead. KovaaK's has the run, five hours before the window.
  const a = await mkPlayer("contradicted");
  process.env.TZ = zone;
  const fake = new Date(NOW).getTimezoneOffset() + 300;
  const m = await queue(a, zone, { offset: fake });
  const pre = play(zone, MATCH[0], NOW - 5 * HOUR - 2 * MIN);
  record(pre, pre.endedAt.getTime() + 2000);
  const res = await submit(a, zone, pre, m, { tzOffsetMinutes: fake }, linked);
  assert.equal(res.body.verificationTier, "rejected");
  assert.equal(res.body.counted, false);
  assert.ok(res.body.reasons.some((x) => /server_time_in_window/.test(x)));
  assert.equal(res.body.expiresAt, null, "a contradicted time cannot extend the deadline");
  pass("a KovaaK's record of the same run outside the match window rejects it");

  // Honest and linked: KovaaK's has it inside the window. Verified.
  const h = await mkPlayer("linked honest");
  const hm = await queue(h, zone);
  const run = play(zone, MATCH[0], NOW - 2 * MIN);
  record(run, run.endedAt.getTime() + 3000);
  assert.equal((await submit(h, zone, run, hm, {}, linked)).body.verificationTier, "verified");
  // Honest, linked, PC clock five minutes fast: KovaaK's time is in the window, the
  // corrected time is not within three minutes of it. Consistent, not rejected.
  const fast = play(zone, MATCH[1], NOW - MIN);
  record(fast, fast.endedAt.getTime() - 5 * MIN);
  const fastRes = await submit(h, zone, fast, hm, {}, linked);
  assert.equal(fastRes.body.verificationTier, "consistent");
  assert.equal(fastRes.body.counted, true);
  // No record at all: missing evidence degrades exactly as before.
  globalThis.ti.kovaaks.clear();
  assert.equal((await submit(h, zone, play(zone, MATCH[2], NOW - 30_000), hm, {}, linked)).body.counted, true);
  pass("honest linked runs: verified in the window, consistent with a fast PC clock or no record");
}

// =====================================================================================
console.log("\n-- what is still possible (documented residual) --");
{
  // Not linked, never uploads live, one fake zone held throughout: a run pre-played two
  // hours before queueing still counts. Only KovaaK's evidence authenticates time.
  const zone = "UTC";
  const p = await mkPlayer("residual");
  const m = await queue(p, zone, { offset: 120 });
  const pre = play(zone, MATCH[0], NOW - 2 * HOUR - 2 * MIN);
  const res = await submit(p, zone, pre, m, { tzOffsetMinutes: 120 });
  assert.equal(res.body.counted, true);
  pass("RESIDUAL: unlinked, no live uploads, a consistent fake zone: counts (Consistent), as docs/fleet/security.md states");
}

// =====================================================================================
console.log("\n-- every match creator records the clock --");
for (const fn of ["find-match", "send-duel", "answer-duel", "play-fixture"]) {
  const src = readFileSync(`supabase/functions/${fn}/index.ts`, "utf8");
  assert.match(src, /import \{[^}]*matchClock[^}]*\} from "\.\.\/_shared\/timeIntegrity\.ts"/, `${fn} imports matchClock`);
  assert.match(src, /await matchClock\(admin, caller\.playerId, body\)/, `${fn} checks the declared clock`);
  assert.ok(/\.\.\.clock/.test(src) || /recordMatchClock\(/.test(src), `${fn} writes it onto the side`);
}
const submitSrc = readFileSync("supabase/functions/submit-run/index.ts", "utf8");
assert.match(submitSrc, /holdToMatchClock\(/);
assert.match(submitSrc, /firstSeenPlayTime\(/);
pass("find-match, send-duel, answer-duel and play-fixture call matchClock; submit-run holds runs to it");

await db.close();
console.log(`\nOK: ${cases} time-integrity cases against the shipped handler, helpers and migrations`);
