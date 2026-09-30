/**
 * Validate Ghost Mode against the real stats folder.
 *
 * Every number docs/overnight/mechanics.md quotes is re-derived here, through the code the
 * app runs, rather than carried over from the one-off script that first produced them:
 *
 *   - the corpus is really there, and is counted rather than assumed;
 *   - every play day is replayed as a ghost match, per definition of "past self", and the
 *     live side's win rate and margin percentiles printed. The shipped kinds must land in
 *     35%..80%, the band validateQuests holds quest completion to: a ghost that always
 *     loses is busywork and one that always wins is a lie. Best-ever must land *outside*
 *     it, or the reason it is not shipped has gone;
 *   - the pool fact: how many days a ghost could be drawn from Season 1's scenarios only;
 *   - a draw is reproducible;
 *   - each rule that must refuse a run does, built on a real draw. Every check asserts
 *     the refusal happened, with the reason named, not that nothing went wrong.
 *
 * A replay is: for each local day with play, the scenarios touched that day that were
 * eligible at its midnight (five runs before it, a ghost session for the definition),
 * three of them drawn by the app's own `pickRounds` with the app's seed, the day's first
 * run on each as the live side, and `judge` for the verdict.
 *
 *   npx tsx src/core/ghost/validateGhost.ts [statsFolder]
 */

import { readFileSync } from "node:fs";

import { scanStatsFolder, type ScenarioHistory } from "../history/history.ts";
import { dayKey } from "../quests/progression.ts";
import {
  abandonMatch,
  applyRun,
  availableKinds,
  definitionOf,
  drawGhostMatch,
  drawSeed,
  expireIfLate,
  GHOST_END_GRACE_MS,
  GHOST_IDLE_ALLOWANCE_MS,
  GHOST_KINDS,
  GHOST_START_ALLOWANCE_MS,
  ghostCandidatesBy,
  ghostStreak,
  inTen,
  judge,
  MEASURED_WIN_RATE,
  pickRounds,
  rematchOf,
  startMatch,
  startOfLocalDay,
  type GhostDefinition,
  type GhostKind,
  type GhostMatch,
  type IncomingRun,
} from "./ghost.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

/** Fewer drawable days than this and the folder is empty, moved or not the corpus. */
const MIN_DRAWABLE_DAYS = 100;
/** The band a shipped kind's win rate must sit in. */
const BAND = { low: 0.35, high: 0.8 };
/** How far a replay may drift from MEASURED_WIN_RATE before the constants are stale. */
const DRIFT = 0.05;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const dir = process.argv[2] ?? DEFAULT_STATS_DIR;
const history = scanStatsFolder(dir);

// ---------------------------------------------------------------------------
console.log("── the corpus ───────────────────────────────────");

let runs = 0;
let dated = 0;
const dayFirst = new Map<string, { start: Date; first: Map<string, number> }>();
for (const [name, h] of history) {
  runs += h.runs.length;
  for (const r of h.runs) {
    if (!r.playedAt) continue;
    dated++;
    const k = dayKey(r.playedAt);
    let e = dayFirst.get(k);
    if (!e) dayFirst.set(k, (e = { start: startOfLocalDay(r.playedAt), first: new Map() }));
    // Runs are oldest first, so the first one seen on a day is the day's first.
    if (!e.first.has(name)) e.first.set(name, r.score);
  }
}
const days = [...dayFirst.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
console.log(`       read ${dir}`);
console.log(`       ${runs} runs (${dated} dated) on ${history.size} scenarios over ${days.length} play days`);
check("the stats folder has runs in it", runs > 0, `${runs}`);
check("and play days to replay", days.length > 0, `${days.length}`);

// ---------------------------------------------------------------------------
console.log("\n── replaying every play day ─────────────────────");

interface Replay {
  matches: number;
  wins: number;
  margins: number[];
}

function replay(define: GhostDefinition, label: string, only?: Set<string>): Replay {
  let matches = 0;
  let wins = 0;
  const margins: number[] = [];
  for (const d of days) {
    const touched = new Map<string, ScenarioHistory>();
    for (const name of d.first.keys()) {
      if (only && !only.has(name)) continue;
      touched.set(name, history.get(name)!);
    }
    const candidates = ghostCandidatesBy(touched, d.start, define);
    const picked = pickRounds(candidates, d.start, drawSeed(dayKey(d.start), label, 0));
    if (picked.length < 3) continue;

    const match: GhostMatch = {
      id: label,
      kind: "last_week",
      day: dayKey(d.start),
      ordinal: 0,
      drawnAt: d.start.getTime(),
      startedAt: d.start.getTime(),
      deadline: null,
      rounds: picked.map(({ lastPlayed: _l, ...r }) => ({ ...r, live: { score: d.first.get(r.scenario)!, at: 0, abandoned: false } })),
      result: null,
    };
    const result = judge(match, "complete", d.start.getTime());
    matches++;
    if (result.verdict === "win") wins++;
    if (result.margin !== null) margins.push(result.margin);
  }
  margins.sort((a, b) => a - b);
  return { matches, wins, margins };
}

const q = (m: number[], x: number) => (m.length ? `${m[Math.min(m.length - 1, Math.floor(m.length * x))] >= 0 ? "+" : ""}${(100 * m[Math.min(m.length - 1, Math.floor(m.length * x))]).toFixed(1)}%` : "-");
const rate = (r: Replay) => (r.matches ? r.wins / r.matches : 0);

// The rejected definitions, replayed through the same path as the shipped ones.
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const trailingWeek: GhostDefinition = (rs, start) => {
  const from = new Date(start);
  from.setDate(from.getDate() - 7);
  const w = rs.filter((r) => r.playedAt && r.playedAt >= from && r.playedAt < start);
  return w.length >= 3 ? { score: median(w.map((r) => r.score)), sessionDay: dayKey(from), sessionRuns: w.length } : null;
};
const lastSessionBest: GhostDefinition = (rs, start) => {
  const before = rs.filter((r) => r.playedAt && r.playedAt < start);
  if (!before.length) return null;
  const last = before.reduce((a, r) => (r.playedAt! > a.playedAt! ? r : a));
  const day = dayKey(last.playedAt!);
  const session = before.filter((r) => dayKey(r.playedAt!) === day).map((r) => r.score);
  return { score: Math.max(...session), sessionDay: day, sessionRuns: session.length };
};
const bestEver: GhostDefinition = (rs, start) => {
  const before = rs.filter((r) => r.playedAt && r.playedAt < start);
  return before.length ? { score: Math.max(...before.map((r) => r.score)), sessionDay: "", sessionRuns: before.length } : null;
};

const rows: [string, GhostDefinition, GhostKind | null][] = [
  ["month_ago      median, session 30+ days back", definitionOf("month_ago"), "month_ago"],
  ["last_week      median, session 7+ days back", definitionOf("last_week"), "last_week"],
  ["last_week_best best, session 7+ days back", definitionOf("last_week_best"), "last_week_best"],
  ["(rejected)     trailing 7-day median", trailingWeek, null],
  ["(rejected)     best of the last session", lastSessionBest, null],
  ["(rejected)     best ever (PB)", bestEver, null],
];

console.log(`       ${"ghost".padEnd(46)} matches   won    margin p10 / p50 / p90`);
const results = new Map<string, Replay>();
for (const [label, define] of rows) {
  const r = replay(define, label);
  results.set(label, r);
  console.log(`       ${label.padEnd(46)} ${String(r.matches).padStart(7)}  ${(100 * rate(r)).toFixed(1).padStart(5)}%   ${q(r.margins, 0.1)} / ${q(r.margins, 0.5)} / ${q(r.margins, 0.9)}`);
}
console.log();

for (const [label, , kind] of rows) {
  const r = results.get(label)!;
  if (kind) {
    const measured = rate(r);
    check(`${kind} is drawable on ${MIN_DRAWABLE_DAYS}+ days`, r.matches >= MIN_DRAWABLE_DAYS, `${r.matches} days`);
    check(`${kind} is won ${BAND.low * 100}%..${BAND.high * 100}% of the time`, measured >= BAND.low && measured <= BAND.high,
      `${(100 * measured).toFixed(1)}%`);
    check(`${kind} still matches the rate the chooser quotes`,
      Math.abs(measured - MEASURED_WIN_RATE[kind]) <= DRIFT && inTen(measured) === inTen(MEASURED_WIN_RATE[kind]),
      `replayed ${(100 * measured).toFixed(1)}%, quoted ${(100 * MEASURED_WIN_RATE[kind]).toFixed(1)}% ("about ${inTen(MEASURED_WIN_RATE[kind])} in 10")`);
  }
}
const pb = results.get(rows[5][0])!;
check("best-ever lands outside the band, so leaving it out still holds",
  pb.matches > 0 && (rate(pb) < BAND.low || rate(pb) > BAND.high), `${(100 * rate(pb)).toFixed(1)}% over ${pb.matches}`);
const monthRate = rate(results.get(rows[0][0])!);
const weekRate = rate(results.get(rows[1][0])!);
const bestRate = rate(results.get(rows[2][0])!);
check("the three ghosts are ordered easiest to hardest", monthRate > weekRate && weekRate > bestRate,
  `${(100 * monthRate).toFixed(1)}% > ${(100 * weekRate).toFixed(1)}% > ${(100 * bestRate).toFixed(1)}%`);

// ---------------------------------------------------------------------------
console.log("\n── the season pool cannot host it ───────────────");

const season = JSON.parse(readFileSync(new URL("../../../data/seasons/season-1.json", import.meta.url), "utf8")) as { scenarios: { scenario: string }[] };
const pool = new Set(season.scenarios.map((s) => s.scenario));
const onPool = [...pool].map((n) => history.get(n)?.runs.length ?? 0);
console.log(`       season pool: ${pool.size} scenarios, ${onPool.filter((c) => c > 0).length} played, ` +
  `${onPool.filter((c) => c >= 5).length} with 5+ runs, ${onPool.reduce((a, c) => a + c, 0)} runs`);
let anyPool = 0;
for (const [label, define] of rows) {
  const r = replay(define, label, pool);
  anyPool = Math.max(anyPool, r.matches);
  if (label === rows[1][0]) console.log(`       days a last_week ghost could be drawn from the pool alone: ${r.matches} of ${days.length}`);
}
console.log(`       ... and for any definition above: ${anyPool}`);
const libraryWeek = results.get(rows[1][0])!.matches;
check("the library hosts many times what the pool does", libraryWeek > 0 && anyPool * 10 < libraryWeek,
  `library ${libraryWeek}, pool ${anyPool}`);

// ---------------------------------------------------------------------------
console.log("\n── today, and a real draw ───────────────────────");

// Today on this folder, or the last day it was played if it has gone quiet, so the rules
// below always run on a real draw rather than skipping when the author takes a week off.
let now = new Date();
let avail = availableKinds(history, now);
if (!avail.last_week.available && days.length) {
  now = new Date(days[days.length - 1].start.getTime() + 12 * 3_600_000);
  avail = availableKinds(history, now);
}
console.log(`       as of ${now.toString().slice(0, 24)}`);
for (const k of GHOST_KINDS) {
  const a = avail[k];
  console.log(`       ${k.padEnd(15)} ${a.available ? "available" : "not available"}  ${a.scenarios} scenarios, latest session ${a.sessionDay ?? "-"}${a.reason ? `  (${a.reason})` : ""}`);
}
check("a last_week ghost is available on this folder", avail.last_week.available);

const drawn = drawGhostMatch(history, now, "last_week", 0);
const again = drawGhostMatch(history, new Date(now.getTime() + 3_600_000), "last_week", 0);
check("a match can be drawn", drawn !== null && drawn.rounds.length === 3,
  drawn ? drawn.rounds.map((r) => r.scenario).join(" / ") : "none");
if (!drawn) {
  console.error("\nFAIL: no real draw to test the rules on");
  process.exit(1);
}
check("the same day, kind and ordinal draw the same three, later in the day too",
  JSON.stringify(again?.rounds) === JSON.stringify(drawn.rounds));
const other = drawGhostMatch(history, now, "last_week", 1);
check("a different ordinal is a different draw", other !== null && other.id !== drawn.id,
  other ? other.rounds.map((r) => r.scenario).join(" / ") : "none");
check("three different scenarios", new Set(drawn.rounds.map((r) => r.scenario)).size === 3);
check("every round has a positive ghost and baseline, and a session a week or more back",
  drawn.rounds.every((r) => r.ghost > 0 && r.baseline > 0 && r.sessionDay < dayKey(new Date(now.getTime() - 6 * 86_400_000))),
  drawn.rounds.map((r) => `${r.sessionDay} ghost ${r.ghost.toFixed(0)} base ${r.baseline.toFixed(0)}`).join("; "));

// ---------------------------------------------------------------------------
console.log("\n── rules that must refuse ───────────────────────");

const [a, b, c] = drawn.rounds;
const t0 = now.getTime() + 60_000;
const run = (scenario: string, score: number, endOffset: number, durationSeconds: number | null = 60, abandoned = false): IncomingRun =>
  ({ scenario, score, at: t0 + endOffset, durationSeconds, abandoned });

const unstarted = applyRun(drawn, run(a.scenario, a.ghost * 2, 90_000));
check("a run before Start is pressed is refused", !unstarted.accepted && unstarted.reason === "not-started",
  unstarted.accepted ? "accepted" : unstarted.reason);

let m = startMatch(drawn, t0);
check("Start sets the ranked clock", m.deadline === t0 + GHOST_START_ALLOWANCE_MS);

const early = applyRun(m, run(a.scenario, a.ghost * 2, -5_000));
check("a run that ended before Start is refused", !early.accepted && early.reason === "before-start",
  early.accepted ? "accepted" : early.reason);
const straddle = applyRun(m, run(a.scenario, a.ghost * 2, 30_000, 60));
check("a run begun before Start is refused, even though it ended after", !straddle.accepted && straddle.reason === "before-start",
  straddle.accepted ? "accepted" : straddle.reason);

const outsider = [...history.keys()].find((n) => !drawn.rounds.some((r) => r.scenario === n))!;
const unrelated = applyRun(m, run(outsider, 1e9, 90_000));
check("a run on an unrelated scenario is refused", !unrelated.accepted && unrelated.reason === "unrelated",
  unrelated.accepted ? "accepted" : `${unrelated.reason} (${outsider})`);

const first = applyRun(m, run(a.scenario, a.ghost * 1.1, 70_000));
check("the first run on a round counts", first.accepted && first.round === 0);
m = first.match;
check("and buys the idle allowance from when it ended", m.deadline === t0 + 70_000 + GHOST_IDLE_ALLOWANCE_MS);
const second = applyRun(m, run(a.scenario, a.ghost * 3, 140_000));
check("a second run on a counted round is refused", !second.accepted && second.reason === "already-counted",
  second.accepted ? "accepted" : second.reason);
check("and the counted score is still the first", m.rounds[0].live?.score === a.ghost * 1.1);

const lateAt = m.deadline! + GHOST_END_GRACE_MS + 1_000 - t0;
const late = applyRun(m, run(b.scenario, b.ghost * 2, lateAt));
check("a run landing after the idle deadline is refused", !late.accepted && late.reason === "late",
  late.accepted ? "accepted" : late.reason);
const graced = applyRun(m, run(b.scenario, b.ghost * 2, m.deadline! + GHOST_END_GRACE_MS - 1_000 - t0));
check("but one begun in time and landing inside the grace counts", graced.accepted);
const expired = expireIfLate(m, m.deadline! + GHOST_END_GRACE_MS + 1);
check("the clock ends a stalled match as a loss", expired.result?.verdict === "loss" && expired.result.end === "expired",
  `${expired.result?.verdict}/${expired.result?.end}`);
check("and not a moment before the grace runs out", expireIfLate(m, m.deadline! + GHOST_END_GRACE_MS).result === null);
const afterEnd = applyRun(expired, run(b.scenario, b.ghost * 2, 200_000));
check("a finished match takes nothing more", !afterEnd.accepted && afterEnd.reason === "finished");

// An abandoned run: the attempt of record, so the round is used up, and the match voids.
let v = startMatch(drawn, t0);
v = applyRun(v, run(a.scenario, a.ghost * 1.2, 70_000)).match;
v = applyRun(v, run(b.scenario, b.ghost * 1.2, 140_000)).match;
const quit = applyRun(v, run(c.scenario, c.ghost * 0.2, 160_000, 8, true));
check("an abandoned run is the attempt of record", quit.accepted);
check("and voids the match rather than scoring it", quit.match.result?.verdict === "void" && quit.match.result.end === "complete",
  `${quit.match.result?.verdict}: ${quit.match.result?.explanation}`);

// Whole matches, each verdict, through settleMatch.
const playAll = (f: number) => {
  let x = startMatch(drawn, t0);
  drawn.rounds.forEach((r, i) => { x = applyRun(x, run(r.scenario, r.ghost + f * r.baseline, 70_000 * (i + 1))).match; });
  return x.result!;
};
const win = playAll(0.03);
const loss = playAll(-0.03);
const level = playAll(0);
check("three rounds 3% of baseline over the ghost win by +3.0%", win.verdict === "win" && Math.abs(win.margin! - 0.03) < 1e-9,
  `${win.verdict} ${win.margin}`);
check("three under lose", loss.verdict === "loss");
check("three level draw", level.verdict === "draw");
check("the margin is the mean of (live - ghost) / baseline", win.rounds.every((r) => Math.abs(r.gap! - 0.03) < 1e-9));

// Abandon: a discard before Start, a loss after it, whatever the score.
check("abandoning before Start discards the draw and records nothing", abandonMatch(drawn, t0) === null);
let ahead = startMatch(drawn, t0);
ahead = applyRun(ahead, run(a.scenario, a.ghost * 1.5, 70_000)).match;
ahead = applyRun(ahead, run(b.scenario, b.ghost * 1.5, 140_000)).match;
const walked = abandonMatch(ahead, t0 + 150_000)!;
check("abandoning two rounds ahead is a loss, not a void", walked.result?.verdict === "loss" && walked.result.end === "abandoned",
  `${walked.result?.verdict}/${walked.result?.end}`);

// The streak, with that loss on the record.
const day = (n: number, hour = 20) => {
  const d = startOfLocalDay(now);
  d.setDate(d.getDate() - n);
  d.setHours(hour);
  return d.toISOString();
};
const records = [
  { at: day(3), verdict: "win" as const },
  { at: day(2), verdict: "win" as const },
  { at: day(1), verdict: "win" as const },
];
check("three days of wins is a streak of three", ghostStreak(records, now) === 3, `${ghostStreak(records, now)}`);
check("which today's abandoned match does not extend",
  ghostStreak([...records, { at: new Date(now).toISOString(), verdict: walked.result!.verdict }], now) === 3);
check("and a win today does", ghostStreak([...records, { at: new Date(now).toISOString(), verdict: "win" }], now) === 4);
check("a day with no win breaks it", ghostStreak([records[0], records[2]], now) === 1);

const rematch = rematchOf(walked, now, 1);
check("a rematch is the same three and the same ghosts on a fresh clock",
  JSON.stringify(rematch.rounds.map((r) => [r.scenario, r.ghost, r.baseline])) ===
    JSON.stringify(drawn.rounds.map((r) => [r.scenario, r.ghost, r.baseline])) &&
    rematch.startedAt === null && rematch.result === null && rematch.rounds.every((r) => r.live === null));

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: ghost mode validated against the real stats folder");
