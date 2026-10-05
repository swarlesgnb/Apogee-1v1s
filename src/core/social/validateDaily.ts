/**
 * Validate Apogee Daily: the draw, the day, the result, the streak and the share text.
 *
 *   npm run validate:daily
 *
 * Needs no stats folder and no network. It checks, through the code the app and the Edge
 * Functions run:
 *
 *   - the day: daily numbers change at 08:00 UTC and nowhere else, whatever the process
 *     time zone, and a filename's wall clock lands on the same daily on the client path
 *     (the parser, in the player's zone) and the server path (wallClockToInstant);
 *   - the seed: the same day and band draw the same three every time, in every time zone,
 *     from the pool as the app builds it out of the season file and as the server builds it
 *     out of season_scenarios rows in database order; a different season draws differently;
 *   - band separation: each band's three come from that band alone, one per skill in skill
 *     order, and runs on another band's draw do not count toward this one;
 *   - no preview: the app's entry point takes the clock, never a number, and yields the
 *     live day up to the last millisecond before the change and the next day only after it;
 *     dailyService.ts never draws by number; the server functions refuse a future day
 *     (validate:social-functions drives the refusal itself);
 *   - the result: first run inside the day counts, the baseline is runs before it, ±1% is
 *     "near", a scenario with no earlier run is "first" and stays out of the mean;
 *   - the streak: counted in daily numbers, so the same local evening can hold two dailies
 *     and a daylight-saving change cannot break one;
 *   - the share text: the format, and no scenario name, family, label or score from the
 *     whole pool in any of the texts built here;
 *   - the board: percentile, rank and quartiles, and no other player's id in what is sent.
 */

import { readFileSync } from "node:fs";

import { loadSeason } from "../season/season.ts";
import { parseFilename } from "../stats/parseStatsFile.ts";
import { wallClockToInstant } from "../ghost/zone.ts";
import {
  BAND_SLUGS,
  boardFromRows,
  dailyFor,
  dailyNumberAt,
  dailySeed,
  dailyStreak,
  dailyWindow,
  drawDaily,
  evaluateDaily,
  GLYPH_CHAR,
  glyphFor,
  glyphLetters,
  glyphsFromLetters,
  NEAR_BAND,
  playedDailies,
  shareText,
  skillOf,
  DAILY_EPOCH_MS,
  DAY_MS,
  SKILLS,
  type DailyHistory,
  type DailyPoolEntry,
  type DailyResult,
} from "./daily.ts";
import { landingUrl } from "./deepLinks.ts";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  } else if (process.env.VERBOSE) console.log(`  ok   ${name}${detail ? `: ${detail}` : ""}`);
}
function section(title: string): void {
  console.log(`\n${title}`);
}

const season = loadSeason();
// The pool as dailyService.ts builds it.
const clientPool: DailyPoolEntry[] = season.scenarios.map((s) => ({ name: s.scenario, category: s.category, window: s.window ?? 0 }));
const bands = season.windows ?? [];
const HORIZON = 400;

// ---------------------------------------------------------------------------
section("the day");
// ---------------------------------------------------------------------------
check("Daily #1 begins at 2026-10-01 08:00 UTC", new Date(DAILY_EPOCH_MS).toISOString() === "2026-10-01T08:00:00.000Z");
check("a millisecond before Daily #1 is no daily", dailyNumberAt(DAILY_EPOCH_MS - 1) === 0);
check("its first and last millisecond are Daily #1", dailyNumberAt(DAILY_EPOCH_MS) === 1 && dailyNumberAt(DAILY_EPOCH_MS + DAY_MS - 1) === 1);
check("the next millisecond is Daily #2", dailyNumberAt(DAILY_EPOCH_MS + DAY_MS) === 2);
for (let n = 1; n <= HORIZON; n++) {
  const { start, end } = dailyWindow(n);
  if (dailyNumberAt(start) !== n || dailyNumberAt(end - 1) !== n || dailyNumberAt(end) !== n + 1 || end - start !== DAY_MS) {
    check(`Daily #${n}'s window is its own`, false);
    break;
  }
}
check(`every window of ${HORIZON} dailies starts at 08:00 UTC`, Array.from({ length: HORIZON }, (_, i) => new Date(dailyWindow(i + 1).start).toISOString().slice(11)).every((t) => t === "08:00:00.000Z"));

const ZONES = ["UTC", "Pacific/Honolulu", "America/Los_Angeles", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney", "Pacific/Kiritimati"];
const zoneBefore = process.env.TZ;
let agreed = 0;
let zoneChecks = 0;
for (const zone of ZONES) {
  process.env.TZ = zone;
  // Filenames across both 2026 daylight-saving changes and either side of 08:00 UTC.
  for (const stamp of ["2026.10.03-00.30.00", "2026.10.03-07.59.30", "2026.10.03-08.00.30", "2026.10.25-01.30.00", "2026.11.01-01.30.00", "2026.11.01-23.59.59", "2027.03.28-02.30.00"]) {
    const name = `Apogee Galaga Novice - Challenge - ${stamp} Stats.csv`;
    const client = parseFilename(name)?.playedAt;
    const server = wallClockToInstant(name, zone);
    zoneChecks++;
    if (!client || !server) continue;
    // In the hour that repeats when clocks go back, a wall clock names two instants; the
    // server takes the first (zone.ts) and the client's Date may take either. Both are on
    // the same local day; the daily can differ only if 08:00 UTC falls inside that hour,
    // which in these zones it never does.
    if (dailyNumberAt(client.getTime()) === dailyNumberAt(server.getTime())) agreed++;
    else check(`${zone} ${stamp}: client and server read the same daily`, false, `${client.toISOString()} vs ${server.toISOString()}`);
  }
}
process.env.TZ = zoneBefore;
check(`a filename lands on one daily on the client and the server path (${agreed} of ${zoneChecks}, ${ZONES.length} zones)`, agreed === zoneChecks && agreed > 50);

// ---------------------------------------------------------------------------
section("the seed and the draw");
// ---------------------------------------------------------------------------
const drawKey = (pool: DailyPoolEntry[], name: string, n: number, w: number) => drawDaily(pool, name, n, w)?.scenarios.join(" | ") ?? "none";
const baseline = new Map<string, string>();
for (let n = 1; n <= HORIZON; n++) for (let w = 0; w < bands.length; w++) baseline.set(`${n}:${w}`, drawKey(clientPool, season.name, n, w));
check(`${baseline.size} draws, none empty`, baseline.size === HORIZON * bands.length && ![...baseline.values()].includes("none"));

let sameAcrossZones = true;
for (const zone of ZONES) {
  process.env.TZ = zone;
  for (let n = 1; n <= HORIZON && sameAcrossZones; n += 7) {
    for (let w = 0; w < bands.length; w++) if (drawKey(clientPool, season.name, n, w) !== baseline.get(`${n}:${w}`)) sameAcrossZones = false;
  }
}
process.env.TZ = zoneBefore;
check("the draw is the same in every process time zone", sameAcrossZones);

// The server path: season_scenarios rows as pushSeason writes them, joined to scenarios
// and mapped the way loadSeasonPool and _shared/social.ts dailyPool map them, in an order
// the database is free to return.
const rows = season.scenarios.map((s, i) => ({
  scenario_id: 9000 + i,
  window_index: s.window ?? 0,
  category: s.category,
  scenarios: { id: 9000 + i, name: s.scenario, aim_type: null, sub_category: "catalogue value, ignored when the season has one" },
}));
const shuffled = (seed: number) => {
  const out = [...rows];
  let h = seed;
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) % 2 ** 31;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
let serverAgrees = true;
for (const seed of [1, 7, 99]) {
  const order = shuffled(seed);
  for (let w = 0; w < bands.length; w++) {
    const selectable = order.filter((r) => r.window_index === w).map((r) => ({ id: r.scenarios.id, name: r.scenarios.name, aimType: r.scenarios.aim_type, subCategory: r.category ?? r.scenarios.sub_category }));
    const serverPool: DailyPoolEntry[] = selectable.map((s) => ({ name: s.name, category: s.subCategory ?? "", window: w }));
    for (let n = 1; n <= HORIZON; n++) if (drawKey(serverPool, season.name, n, w) !== baseline.get(`${n}:${w}`)) serverAgrees = false;
  }
}
check("the server's pool, in three database orders, draws what the client draws", serverAgrees);
check("the pool reversed draws the same", (() => {
  const rev = [...clientPool].reverse();
  for (let n = 1; n <= 50; n++) for (let w = 0; w < bands.length; w++) if (drawKey(rev, season.name, n, w) !== baseline.get(`${n}:${w}`)) return false;
  return true;
})());
check("the seed names the season, the day and the band", dailySeed("Season 1", 14, 2) === "apogee-daily:v1:Season 1:14:2");
let differ = 0;
for (let n = 1; n <= 100; n++) if (drawKey(clientPool, "Season 2", n, 1) !== baseline.get(`${n}:1`)) differ++;
check(`another season's name draws differently (${differ} of 100 days)`, differ >= 90);

let shapeOk = true;
const counts = new Map<string, number>();
for (let n = 1; n <= HORIZON; n++) {
  for (let w = 0; w < bands.length; w++) {
    const d = drawDaily(clientPool, season.name, n, w)!;
    const inBand = new Map(clientPool.filter((p) => p.window === w).map((p) => [p.name, p]));
    const skills = d.scenarios.map((s) => skillOf(inBand.get(s)?.category));
    if (new Set(d.scenarios).size !== 3 || !d.scenarios.every((s) => inBand.has(s)) || skills.join() !== SKILLS.join() || d.skills.join() !== SKILLS.join()) shapeOk = false;
    if (w === 1) for (const s of d.scenarios) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
}
check("every draw is three different scenarios of its own band, Clicking then Tracking then Switching", shapeOk);
const band1 = clientPool.filter((p) => p.window === 1).length;
check(`over ${HORIZON} days every ${bands[1]} scenario is drawn (${counts.size} of ${band1})`, counts.size === band1);
check("no scenario is drawn on more than a fifth of days", Math.max(...counts.values()) <= HORIZON / 5, `most ${Math.max(...counts.values())}`);
check("a pool too small for three draws nothing", drawDaily(clientPool.slice(0, 2).map((p) => ({ ...p, window: 0 })), season.name, 1, 0) === null);
check("a number that is not a daily draws nothing", drawDaily(clientPool, season.name, 0, 1) === null && drawDaily(clientPool, season.name, 1.5, 1) === null);

// ---------------------------------------------------------------------------
section("band separation");
// ---------------------------------------------------------------------------
let disjoint = true;
for (let n = 1; n <= HORIZON; n++) {
  const all = Array.from({ length: bands.length }, (_, w) => drawDaily(clientPool, season.name, n, w)!.scenarios).flat();
  if (new Set(all).size !== all.length) disjoint = false;
}
check("on every day the four bands' draws share no scenario", disjoint);
const today = 3;
const t0 = dailyWindow(today).start;
const histOf = (runs: [string, number, number][]): Map<string, DailyHistory> => {
  const m = new Map<string, DailyHistory>();
  for (const [name, score, at] of runs) {
    if (!m.has(name)) m.set(name, { runs: [] });
    m.get(name)!.runs.push({ score, playedAt: new Date(at) });
  }
  for (const h of m.values()) h.runs.sort((a, b) => a.playedAt!.getTime() - b.playedAt!.getTime());
  return m;
};
const otherBand = drawDaily(clientPool, season.name, today, 2)!;
const thisBand = drawDaily(clientPool, season.name, today, 1)!;
const crossHistory = histOf(otherBand.scenarios.map((s, i) => [s, 100, t0 + 60_000 * (i + 1)]));
check("runs on another band's draw leave this band's day unplayed", evaluateDaily(crossHistory, thisBand).rounds.every((r) => r.score === null));
check("and complete that band's day", evaluateDaily(crossHistory, otherBand).complete);

// ---------------------------------------------------------------------------
section("no preview of tomorrow");
// ---------------------------------------------------------------------------
let livePreview = true;
for (let n = 1; n <= 60; n++) {
  const { start, end } = dailyWindow(n);
  for (const t of [start, start + 1, end - 1]) if (dailyFor(clientPool, season.name, t, 1)?.number !== n) livePreview = false;
  if (dailyFor(clientPool, season.name, end, 1)?.number !== n + 1) livePreview = false;
}
check("the clock-driven draw is the live day until its last millisecond, and the next only after", livePreview);
check("before Daily #1 there is no draw at all", dailyFor(clientPool, season.name, DAILY_EPOCH_MS - 1, 1) === null);
const serviceSource = readFileSync(new URL("../../app/dailyService.ts", import.meta.url), "utf8");
check("dailyService.ts draws only through the clock (dailyFor), never by number", /dailyFor\(/.test(serviceSource) && !/drawDaily\(/.test(serviceSource));
const preload = readFileSync(new URL("../../app/preload.cjs", import.meta.url), "utf8");
check("the renderer's daily() takes no argument", /daily: \(\) => ipcRenderer\.invoke\("apogee:daily"\)/.test(preload));
for (const fn of ["daily-submit", "daily-board"]) {
  const src = readFileSync(new URL(`../../../supabase/functions/${fn}/index.ts`, import.meta.url), "utf8");
  check(`${fn} refuses a daily after today's`, /if \((?:n|body\.dailyNumber) > today\) throw new HttpError\(422/.test(src));
}
const played = playedDailies(histOf(drawDaily(clientPool, season.name, today + 1, 1)!.scenarios.map((s, i) => [s, 100, dailyWindow(today + 1).start + i])), clientPool, season.name, today, bands.length);
check("a played day after today is never counted (clock skew cannot pad a streak)", !played(today + 1));

// ---------------------------------------------------------------------------
section("the result");
// ---------------------------------------------------------------------------
const [A, B, C] = thisBand.scenarios;
const before = (name: string, scores: number[]) => scores.map((s, i) => [name, s, t0 - DAY_MS + i * 60_000] as [string, number, number]);
const resultHistory = histOf([
  ...before(A, [100, 100, 100, 100, 100, 100]),
  ...before(B, [200, 200]),
  [A, 103, t0 + 10 * 60_000], // first in the day: counts, +3%
  [A, 50, t0 + 20 * 60_000], // practice
  [B, 200, t0 + 5 * 60_000], // exactly the baseline: near
  [C, 900, t0], // no history; the first millisecond of the day counts
  [C, 1, dailyWindow(today).end], // tomorrow
]);
const res = evaluateDaily(resultHistory, thisBand);
check("a day with a run on each of the three is complete", res.complete);
check("the first run inside the day counts, not a later one", res.rounds[0].score === 103);
check("a run at the day's first millisecond counts", res.rounds[2].score === 900);
check("the baseline is built from runs before the day", res.rounds[0].baseline === 100 && res.rounds[1].baseline === 200);
check("+3% is above", res.rounds[0].glyph === "above" && Math.abs((res.rounds[0].delta ?? 0) - 0.03) < 1e-12);
check("exactly the baseline is near", res.rounds[1].glyph === "near" && res.rounds[1].delta === 0);
check("a scenario never played before is a first run, with no delta", res.rounds[2].glyph === "first" && res.rounds[2].delta === null && res.rounds[2].baseline === null);
check("the mean leaves first runs out", Math.abs((res.meanDelta ?? 0) - 0.015) < 1e-12, String(res.meanDelta));
check("provisional when a measured round had fewer than five earlier runs", res.provisional === true && res.rounds[1].provisional && !res.rounds[0].provisional);
check("near is ±1%", NEAR_BAND === 0.01 && glyphFor(0.01, 9, true) === "near" && glyphFor(0.0101, 9, true) === "above" && glyphFor(-0.01, 9, true) === "near" && glyphFor(-0.0101, 9, true) === "below");
check("an unplayed round is pending", glyphFor(null, 9, false) === "pending");
const firstsOnly = evaluateDaily(histOf(thisBand.scenarios.map((s, i) => [s, 10 + i, t0 + i])), thisBand);
check("a day of first runs is complete, with no mean and not 'provisional'", firstsOnly.complete && firstsOnly.meanDelta === null && !firstsOnly.provisional);
const partial = evaluateDaily(histOf([[A, 1, t0 + 1]]), thisBand);
check("a day with one of three is not complete and has no mean", !partial.complete && partial.meanDelta === null);
check("glyph letters round-trip", glyphLetters(res.rounds) === "ANF" && glyphsFromLetters("ANF").join() === "above,near,first" && glyphLetters(partial.rounds) === null);

// ---------------------------------------------------------------------------
section("the streak");
// ---------------------------------------------------------------------------
const set = (ns: number[]) => (n: number) => ns.includes(n);
check("five days ending today is 5", dailyStreak(set([6, 7, 8, 9, 10]), 10) === 5);
check("five days ending yesterday is still 5: today is not over", dailyStreak(set([5, 6, 7, 8, 9]), 10) === 5);
check("ending two days ago it is 0", dailyStreak(set([4, 5, 6, 7, 8]), 10) === 0);
check("a gap ends it", dailyStreak(set([3, 4, 6, 7, 8, 9, 10]), 10) === 5);
check("nothing before Daily #1", dailyStreak(set([1, 2]), 2) === 2 && dailyStreak(() => true, 0) === 0);
check("a streak longer than the horizon stops at it", dailyStreak(() => true, 1000) === 400);

/** All three of band 1's draw for daily n, played at the given instants (client parse of a wall clock in `zone`). */
function streakFromWallClocks(zone: string, stamps: string[], todayNumber: number): number {
  process.env.TZ = zone;
  const runs: [string, number, number][] = [];
  for (const stamp of stamps) {
    // Which daily the player's evening lands on is decided by the instant, which is what
    // the client parse of their filename gives.
    const probe = parseFilename(`x - Challenge - ${stamp} Stats.csv`)!.playedAt!.getTime();
    const draw = drawDaily(clientPool, season.name, dailyNumberAt(probe), 1)!;
    draw.scenarios.forEach((s, i) => runs.push([s, 100, probe + i * 60_000]));
  }
  const streak = dailyStreak(playedDailies(histOf(runs), clientPool, season.name, todayNumber, bands.length), todayNumber);
  process.env.TZ = zoneBefore;
  return streak;
}
const d = (iso: string) => dailyNumberAt(Date.parse(iso));
// Honolulu (UTC-10): 9:30pm and 10:30pm on the same local evening straddle 08:00 UTC, so
// they are two dailies, and the second extends the first.
check("Honolulu: one local evening can hold two consecutive dailies", streakFromWallClocks("Pacific/Honolulu", ["2026.10.04-21.30.00", "2026.10.04-22.30.00"], d("2026-10-05T09:00:00Z")) === 2);
// Tokyo (UTC+9): 4:50pm and 5:10pm, either side of the change.
check("Tokyo: twenty minutes apart across 5pm local are two dailies", streakFromWallClocks("Asia/Tokyo", ["2026.10.06-16.50.00", "2026.10.06-17.10.00"], d("2026-10-06T09:00:00Z")) === 2);
// London across the end of British Summer Time on 25 October: the same 9:30am local is
// 08:30Z one day and 09:30Z the next, and the streak holds.
check("London: a daylight-saving change between two mornings keeps the streak", streakFromWallClocks("Europe/London", ["2026.10.24-09.30.00", "2026.10.25-09.30.00"], d("2026-10-25T12:00:00Z")) === 2);
// New York: 11pm on consecutive evenings is 03:00Z, inside the previous UTC day's daily.
check("New York: late evenings on consecutive days are consecutive dailies", streakFromWallClocks("America/New_York", ["2026.10.03-23.00.00", "2026.10.04-23.00.00"], d("2026-10-05T03:30:00Z")) === 2);
// Two dailies apart in Sydney is no streak.
check("Sydney: a day skipped ends it", streakFromWallClocks("Australia/Sydney", ["2026.10.03-20.00.00", "2026.10.05-20.00.00"], d("2026-10-05T12:00:00Z")) === 1);
const twoBands = histOf([
  ...drawDaily(clientPool, season.name, 5, 0)!.scenarios.map((s, i) => [s, 1, dailyWindow(5).start + i] as [string, number, number]),
  ...drawDaily(clientPool, season.name, 6, 3)!.scenarios.map((s, i) => [s, 1, dailyWindow(6).start + i] as [string, number, number]),
]);
check("a streak counts any band, day by day", dailyStreak(playedDailies(twoBands, clientPool, season.name, 6, bands.length), 6) === 2);
const twoOfThree = histOf(drawDaily(clientPool, season.name, 6, 1)!.scenarios.slice(0, 2).map((s, i) => [s, 1, dailyWindow(6).start + i]));
check("two of three is not a day played", !playedDailies(twoOfThree, clientPool, season.name, 6, bands.length)(6));

// ---------------------------------------------------------------------------
section("the share text");
// ---------------------------------------------------------------------------
const forbidden = new Set<string>();
for (const s of season.scenarios) {
  forbidden.add(s.scenario.toLowerCase());
  if (s.family) forbidden.add(s.family.toLowerCase());
  const label = (s as { label?: string }).label;
  if (label) forbidden.add(label.toLowerCase());
}
const texts: string[] = [];
const glyphs = ["above", "near", "below", "first"] as const;
for (const a of glyphs) for (const b of glyphs) for (const c of glyphs) {
  for (const [w, streak] of [[0, 0], [1, 1], [2, 14], [3, 365]] as const) {
    const draw = drawDaily(clientPool, season.name, 14, w)!;
    const rounds = [a, b, c].map((g, i) => ({
      scenario: draw.scenarios[i], skill: draw.skills[i], score: 1234.5 + i, playedAt: 0, priorRuns: g === "first" ? 0 : 3 + i,
      baseline: g === "first" ? null : 1000, delta: g === "first" ? null : g === "above" ? 0.042 : g === "below" ? -0.031 : 0.004,
      provisional: true, glyph: g,
    }));
    const measured = rounds.filter((r) => r.delta !== null);
    const result: DailyResult = {
      number: 14, window: w, scenarios: draw.scenarios, rounds, complete: true,
      meanDelta: measured.length ? measured.reduce((s, r) => s + (r.delta as number), 0) / measured.length : null,
      provisional: measured.length > 0,
    };
    const link = landingUrl({ kind: "daily", number: 14, band: BAND_SLUGS[w] });
    texts.push(shareText({ result, bandName: bands[w], streak, link }) as string);
  }
}
check(`${texts.length} share texts built`, texts.length === 4 * 4 * 4 * 4 && texts.every(Boolean));
const leaks = texts.filter((t) => [...forbidden].some((f) => t.toLowerCase().includes(f)));
check(`no text names a scenario, family or label (${forbidden.size} names checked)`, leaks.length === 0, leaks[0]);
check("no text carries a raw score", texts.every((t) => !/1,?23[45]/.test(t)));
const FIRST = /^Apogee Daily #14 · (Novice|Intermediate|Advanced|Expert)$/;
const chars = Object.values(GLYPH_CHAR).filter((c) => c !== GLYPH_CHAR.pending).join("");
const SECOND = new RegExp(`^[${chars}] [${chars}] [${chars}]  ([+−]\\d+\\.\\d%|0\\.0%|baselines set)$`);
check("line one is the number and the band", texts.every((t) => FIRST.test(t.split("\n")[0])));
check("line two is one glyph per scenario and the mean delta", texts.every((t) => SECOND.test(t.split("\n")[1])));
check("the last line is the https link to the same daily", texts.every((t) => /^https:\/\/\S+\/c\/\?daily=14&band=(novice|intermediate|advanced|expert)$/.test(t.split("\n").at(-1)!)));
check("a streak is shown from 2, provisional baselines are said", texts.some((t) => t.includes("Streak 14 · provisional baselines")) && !texts.some((t) => t.includes("Streak 1 ")) && !texts.some((t) => t.includes("Streak 0")));
check("every text fits a post (280 characters)", texts.every((t) => t.length <= 280), String(Math.max(...texts.map((t) => t.length))));
check("an unfinished day has no share text", shareText({ result: partial, bandName: bands[1], streak: 3, link: "x" }) === null);
console.log(`  e.g.\n${texts[5].split("\n").map((l) => `    ${l}`).join("\n")}`);

// ---------------------------------------------------------------------------
section("the board");
// ---------------------------------------------------------------------------
const ids = Array.from({ length: 9 }, (_, i) => `00000000-0000-0000-0000-00000000000${i}`);
const rowsFor = (means: (number | null)[]) => means.map((m, i) => ({ player_id: ids[i], mean_delta: m === null ? null : String(m), glyphs: "ANB", provisional: false }));
const meta = { dailyNumber: 14, window: 1, band: "Intermediate", streak: 3 };
const alone = boardFromRows(rowsFor([0.02]), ids[0], meta);
check("alone on the board: counted, ranked first, no percentile", alone.players === 1 && alone.you?.rank === 1 && alone.you.percentile === null);
const five = boardFromRows(rowsFor([0.05, -0.01, 0.02, 0.0, null]), ids[2], meta);
check("five entries, one with no mean: four ranked", five.players === 5 && five.ranked === 4);
check("+2% of (−1%, 0%, +2%, +5%) is second, ahead of 66.7% of the others", five.you?.rank === 2 && five.you.percentile === 66.7, JSON.stringify(five.you));
check("quartiles appear at four ranked entries", JSON.stringify(five.quartiles) === JSON.stringify([0, 0.02, 0.05]));
const unranked = boardFromRows(rowsFor([0.05, null]), ids[1], meta);
check("an entry of first runs is counted and not placed", unranked.you?.rank === null && unranked.you.percentile === null && unranked.you.meanDelta === null);
const ties = boardFromRows(rowsFor([0.01, 0.01, 0.01]), ids[0], meta);
check("ties count half", ties.you?.percentile === 50 && ties.you.rank === 1);
const nobody = boardFromRows(rowsFor([0.01, 0.02]), ids[8], meta);
check("a caller with no entry gets the distribution and no place", nobody.you === null && nobody.players === 2);
check("no board carries another player's id", [alone, five, unranked, ties, nobody].every((b) => !ids.some((id) => JSON.stringify(b).includes(id))));

console.log(`\n${failures === 0 ? "OK" : "FAILED"}: ${checks - failures} of ${checks} daily checks passed`);
if (failures > 0) process.exit(1);
