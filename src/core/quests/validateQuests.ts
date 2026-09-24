/**
 * Validate evxl link resolution and the quest board, against real history.
 *
 * Link parsing is tested against the shapes players actually paste, including the ones
 * that must FAIL: an ambiguous name silently resolving to the wrong benchmark would
 * have someone grinding quests for a season they are not playing.
 *
 * The board is tested three ways, each answering a failure the first version had:
 *
 *   - doing exactly what each quest asks completes it. The first board lost every quest
 *     that could complete, because completing it changed the standing it was built from;
 *   - past days are replayed through the issuer and the boards compared, because the
 *     first board issued the same five quests seven days running;
 *   - past days are replayed through the *measure* with the runs actually played that
 *     day, and the completion rate printed per kind. A quest that always completes is
 *     busywork and one that never does is a lie, and this is where either shows.
 *
 *   npx tsx src/core/quests/validateQuests.ts [statsFolder]
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { scanStatsFolder, type ScenarioHistory } from "../history/history.ts";
import { loadSeason, seasonAsDifficulty, seasonLabels } from "../season/season.ts";
import {
  parseEvxlLink,
  resolveBenchmark,
  toTrackRequest,
  type BenchmarkRegistryEntry,
} from "./evxlLink.ts";
import {
  issueDaily,
  issueWeekly,
  measure,
  playStreak,
  recordMatch,
  startOfDay,
  startOfWeek,
  syncBoard,
  type BoardContext,
  type IssuedQuest,
  type Quest,
} from "./board.ts";
import { dayKey } from "./progression.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const registry = (
  JSON.parse(
    readFileSync(new URL("../../../data/evxl_registry.json", import.meta.url), "utf8"),
  ) as { benchmarks: BenchmarkRegistryEntry[] }
).benchmarks;

console.log(`registry: ${registry.length} benchmarks\n`);

console.log("── link parsing ─────────────────────────────────");

const canonical = parseEvxlLink("https://evxl.app/benchmarks/Voltaic%20S5");
check("a canonical benchmark URL parses", canonical?.benchmarkName === "Voltaic S5",
  JSON.stringify(canonical));

check("a URL with a difficulty keeps it",
  parseEvxlLink("https://evxl.app/benchmarks/Voltaic%20S5/Intermediate")?.difficulty ===
    "Intermediate");

check("a bare name is accepted",
  parseEvxlLink("Voltaic S5")?.benchmarkName === "Voltaic S5");

check("a scheme-less URL is accepted",
  parseEvxlLink("evxl.app/benchmarks/Revosect%20S5")?.benchmarkName === "Revosect S5");

check("whitespace is tolerated",
  parseEvxlLink("  https://evxl.app/benchmarks/Voltaic%20S5  ")?.benchmarkName === "Voltaic S5");

check("a leaderboard URL parses",
  parseEvxlLink("https://evxl.app/leaderboards/460")?.source === "leaderboards");

check("a non-evxl host is rejected",
  parseEvxlLink("https://example.com/benchmarks/Voltaic%20S5") === null);
check("an empty string is rejected", parseEvxlLink("") === null);
check("nonsense is rejected", parseEvxlLink("https://evxl.app/") === null);

console.log("\n── benchmark resolution ─────────────────────────");

const s5 = resolveBenchmark(parseEvxlLink("https://evxl.app/benchmarks/Voltaic%20S5")!, registry);
check("Voltaic S5 resolves exactly",
  s5?.entry.benchmarkName === "Voltaic S5" && s5.exact === true);

const s55 = resolveBenchmark(parseEvxlLink("https://evxl.app/benchmarks/Voltaic%20S5.5")!, registry);
check("Voltaic S5.5 resolves to itself, not S5",
  s55?.entry.benchmarkName === "Voltaic S5.5", s55?.entry.benchmarkName);

const cased = resolveBenchmark(parseEvxlLink("voltaic s5")!, registry);
check("casing and punctuation are tolerated",
  cased?.entry.benchmarkName === "Voltaic S5");

// The important negative: a name matching several benchmarks must NOT pick one.
const ambiguous = resolveBenchmark(parseEvxlLink("Voltaic")!, registry);
check("an ambiguous name resolves to nothing", ambiguous === null,
  ambiguous?.entry.benchmarkName);

const unknown = resolveBenchmark(parseEvxlLink("Definitely Not A Benchmark")!, registry);
check("an unknown name resolves to nothing", unknown === null,
  unknown ? `resolved to ${unknown.entry.benchmarkName}` : "");

check("a short nonsense string resolves to nothing",
  resolveBenchmark(parseEvxlLink("zzzzz")!, registry) === null);

// The registry contains non-Latin names; they must still be reachable, and must not
// act as a catch-all for everything else.
const cjk = registry.find((e) => /[一-鿿]/.test(e.benchmarkName));
if (cjk) {
  const byCjk = resolveBenchmark(parseEvxlLink(cjk.benchmarkName)!, registry);
  check("a non-Latin benchmark name still resolves to itself",
    byCjk?.entry.benchmarkName === cjk.benchmarkName, byCjk?.entry.benchmarkName);
} else {
  check("registry contains a non-Latin name to test", false);
}

// A numeric leaderboard id should find the right benchmark AND difficulty.
const byId = resolveBenchmark(parseEvxlLink("https://evxl.app/leaderboards/460")!, registry);
check("a leaderboard id resolves to a benchmark",
  byId?.entry.benchmarkName === "Voltaic S5", byId?.entry.benchmarkName);
check("a leaderboard id resolves to a difficulty",
  byId?.difficulty === "Advanced", byId?.difficulty ?? "none");

console.log("\n── track request ────────────────────────────────");

const track = toTrackRequest(s5!);
check("a track request is produced", track !== null);
check("it carries a KovaaK's benchmark id",
  typeof track?.kovaaksBenchmarkId === "number" && track.kovaaksBenchmarkId > 0,
  String(track?.kovaaksBenchmarkId));
check("it defaults to an official difficulty",
  !/unofficial/i.test(track?.difficulty ?? ""), track?.difficulty);

const preferred = toTrackRequest(s5!, "Advanced");
check("a preferred difficulty is honoured", preferred?.difficulty === "Advanced",
  preferred?.difficulty);

const explicit = toTrackRequest(
  resolveBenchmark(parseEvxlLink("https://evxl.app/benchmarks/Voltaic%20S5/Novice")!, registry)!,
);
check("a difficulty in the URL wins", explicit?.difficulty === "Novice", explicit?.difficulty);

// Every registry entry with a usable difficulty should produce a track request, so a
// player can track any benchmark evxl knows about.
let trackable = 0;
const untrackable: string[] = [];
for (const entry of registry) {
  const request = toTrackRequest({ entry, difficulty: null, exact: true });
  if (request) trackable++;
  else untrackable.push(entry.benchmarkName);
}
console.log(`       ${trackable} of ${registry.length} benchmarks are trackable`);
check("most of the registry is trackable", trackable > registry.length * 0.8,
  `${trackable}/${registry.length}`);

// The only honest reason to refuse is a benchmark hosted somewhere other than KovaaK's,
// which carries no id to track by. Counting refusals instead used to assert there was at
// least one, and that broke the day evxl dropped its last Aimbeast entry: the data
// changed, the code was fine, and the suite failed. Assert the rule, not the census.
const linked = registry.filter((entry) =>
  (entry.difficulties ?? []).some(
    (d) => typeof d.kovaaksBenchmarkId === "number" && d.kovaaksBenchmarkId > 0,
  ),
);
check("every benchmark with a KovaaK's id is trackable", trackable === linked.length,
  `${trackable}/${linked.length}, refused: ${untrackable.join(", ") || "none"}`);

// ---------------------------------------------------------------------------
// the board, against the real history
// ---------------------------------------------------------------------------

const season = loadSeason();
const difficulty = seasonAsDifficulty(season);
const labels = seasonLabels(season);
const poolNames = new Set(season.scenarios.map((s) => s.scenario));
const history = scanStatsFolder(process.argv[2] ?? DEFAULT_STATS_DIR);
const now = new Date();
const DAY_MS = 86_400_000;

const ctxAt = (h: Map<string, ScenarioHistory>, when: Date, ranked = true): BoardContext => ({
  difficulty,
  history: h,
  now: when,
  labelFor: (s) => labels.get(s) ?? s,
  ranked,
});

// The simulations below replay weeks of real history, and that history was played on the
// first draft's pool of borrowed scenarios, not on Apogee's own that replaced it: against
// the new pool it reads as a player who has barely started, so the scenario-specific kinds
// are never issued and one floor quest fills the board - a fact about the data, not the
// issuer. So the weeks are replayed against the pool the history actually played, read
// from the last commit that had it; today's board above stays on the season as it is.
const FIRST_DRAFT = "7b212c0";
const played = JSON.parse(
  execFileSync("git", ["show", `${FIRST_DRAFT}:data/seasons/season-1.json`], { encoding: "utf8", maxBuffer: 64 << 20 }),
) as ReturnType<typeof loadSeason>;
const playedDifficulty = seasonAsDifficulty(played);
const playedLabels = seasonLabels(played);
const simAt = (h: Map<string, ScenarioHistory>, when: Date, ranked = true): BoardContext => ({
  difficulty: playedDifficulty,
  history: h,
  now: when,
  labelFor: (s) => playedLabels.get(s) ?? s,
  ranked,
});

console.log("\n── today's board from real history ──────────────");

if (history.size === 0) {
  check("real history was readable", false);
} else {
  const sync = syncBoard(null, ctxAt(history, now));
  const board = sync.state;
  const all = [...board.daily, ...(board.weekly ? [board.weekly] : [])];

  console.log();
  for (const q of all) {
    console.log(`  [${q.slot.padEnd(7)} ${String(q.xp).padStart(4)} xp] ${q.title}`);
    console.log(`                      ${q.detail}`);
    console.log(`                      ${q.progress} / ${q.target} ${q.unit}${q.completedAt ? "  COMPLETE" : ""}`);
  }
  console.log();

  check("three dailies are issued", board.daily.length === 3, `${board.daily.length}`);
  check("one per daily slot", new Set(board.daily.map((q) => q.slot)).size === 3,
    board.daily.map((q) => q.slot).join(","));
  check("a weekly is issued", board.weekly !== null);
  check("every quest has player-facing text", all.every((q) => q.title.length > 0 && q.detail.length > 0));
  check("every quest has a positive target and XP", all.every((q) => q.target > 0 && q.xp > 0));
  check("quest ids are unique", new Set(all.map((q) => q.id)).size === all.length);
  check("every named scenario is in the season pool",
    all.every((q) => !q.params.scenario || poolNames.has(q.params.scenario)),
    all.map((q) => q.params.scenario).filter(Boolean).join(", "));
  check("no text prints a raw fraction",
    all.every((q) => !/\d\.\d{3,}/.test(q.title + q.detail)),
    all.map((q) => q.detail).find((d) => /\d\.\d{3,}/.test(d)) ?? "");
  check("the dailies run from local midnight",
    board.daily.every((q) => new Date(q.since).getTime() === startOfDay(now).getTime()));
  check("the weekly runs from Monday",
    board.weekly !== null && new Date(board.weekly.since).getTime() === startOfWeek(now).getTime());

  const again = syncBoard(null, ctxAt(history, now)).state;
  check("issuing twice yields the same board",
    JSON.stringify(board.daily.map((q) => q.id)) === JSON.stringify(again.daily.map((q) => q.id)));

  console.log(`       current play streak: ${playStreak(history, now)} days`);

  // -------------------------------------------------------------------------
  console.log("\n── doing what a quest asks completes it ─────────");

  // Runs that satisfy exactly what the quest names, played inside its window. Returned
  // as a new history plus any matches, so the real one is never touched.
  function satisfy(q: IssuedQuest, base = history): { h: Map<string, ScenarioHistory>; matches: typeof board.matches } | null {
    const h = new Map(base);
    const start = new Date(q.since).getTime() + 60_000;
    let minute = 0;
    const play = (scenario: string, score: number) => {
      const prior = h.get(scenario) ?? { scenario, runs: [], best: 0, lastPlayed: null };
      const run = { score, playedAt: new Date(start + minute++ * 60_000) };
      h.set(scenario, { ...prior, runs: [...prior.runs, run], best: Math.max(prior.best, score), lastPlayed: run.playedAt });
    };
    const firstIn = (category: string) => difficulty.categories.find((c) => c.name === category)?.scenarios[0]?.name;
    const pool = [...poolNames];
    let matches = [] as typeof board.matches;

    switch (q.kind) {
      case "reach_rank":
      case "revisit":
        play(q.params.scenario!, Math.ceil(q.params.bar!));
        break;
      case "beat_median":
        for (let i = 0; i < 3; i++) play(q.params.scenario!, q.params.bar! + 1);
        break;
      case "clean_set":
        for (let i = 0; i < 5; i++) play(q.params.scenario!, q.params.bar!);
        break;
      case "no_disasters": {
        const [scenario, bar] = Object.entries(q.params.bars!)[0];
        for (let i = 0; i < 5; i++) play(scenario, bar);
        break;
      }
      case "category_volume":
        for (let i = 0; i < 8; i++) play(firstIn(q.params.category!)!, 1);
        break;
      case "variety":
        for (const s of pool.slice(0, 4)) play(s, 1);
        break;
      case "weekly_days":
        for (let d = 0; d < 5; d++) { minute = d * 24 * 60; play(pool[0], 1); }
        break;
      case "weekly_floors":
        for (const [scenario, bar] of Object.entries(q.params.bars!).slice(0, 3)) {
          for (let i = 0; i < 5; i++) play(scenario, bar);
        }
        break;
      case "weekly_rank_ups":
        // A score past every threshold on three families' top variants.
        for (const cat of difficulty.categories.slice(0, 3)) {
          const top = [...cat.scenarios].sort((a, b) => (b.window ?? 0) - (a.window ?? 0))[0];
          play(top.name, top.rankMaxes[top.rankMaxes.length - 1] * 10);
        }
        break;
      case "ranked_play":
      case "weekly_wins": {
        let s = { ...board, matches: [] as typeof board.matches };
        for (let i = 0; i < 3; i++) {
          s = recordMatch(s, { id: `m${i}`, at: new Date(start + i * 60_000).toISOString(), verdict: "win", seeding: false, category: null });
        }
        matches = s.matches;
        break;
      }
      default:
        return null;
    }
    return { h, matches };
  }

  // Every kind on today's board and the reserve, plus the boards of the last four weeks,
  // so every kind the issuer can produce is exercised against a real standing.
  // Each quest is measured against the pool it was issued from.
  const seen = new Map<string, { q: IssuedQuest; at: typeof ctxAt }>();
  const consider = (at: typeof ctxAt) => (q: IssuedQuest) => { if (!seen.has(q.kind)) seen.set(q.kind, { q, at }); };
  all.forEach(consider(ctxAt));
  for (let d = 0; d < 28; d++) {
    const day = new Date(startOfDay(now).getTime() - d * DAY_MS);
    const { daily, reserve } = issueDaily(simAt(history, day), day, []);
    daily.forEach(consider(simAt));
    const since = startOfDay(day);
    reserve.forEach((q: Quest) => consider(simAt)({ ...q, since: since.toISOString(), until: new Date(since.getTime() + DAY_MS).toISOString(), progress: 0, completedAt: null }));
    const weekly = issueWeekly(simAt(history, day), day, null);
    if (weekly) consider(simAt)(weekly);
  }

  for (const { q, at } of seen.values()) {
    const done = satisfy(q);
    if (!done) { check(`${q.kind} has a way to be satisfied`, false); continue; }
    const progress = measure(q, at(done.h, now), done.matches);
    check(`${q.kind.padEnd(16)} completes when done`, progress >= q.target, `${progress}/${q.target}  ${q.title}`);
  }
  console.log(`       ${seen.size} of 12 kinds exercised`);
  check("most kinds were issued at least once", seen.size >= 9, [...seen.keys()].join(", "));

  // The whole loop, on today's board: finish one quest, and the board keeps it and pays it.
  const priorDay = new Map([...history].map(([name,h]) => {
    const runs = h.runs.filter(r=>!r.playedAt || r.playedAt < startOfDay(now));
    return [name,{...h,runs,best:Math.max(0,...runs.map(r=>r.score)),lastPlayed:runs.at(-1)?.playedAt??null}];
  }));
  const unpaid = syncBoard(null,ctxAt(priorDay,now)).state;
  const target = unpaid.daily.find((q) => q.kind !== "ranked_play") ?? unpaid.daily[0];
  const played = satisfy(target,priorDay)!;
  const paid = syncBoard(unpaid, ctxAt(played.h, now));
  const kept = paid.state.daily.find((q) => q.id === target.id);
  check("the finished quest is still on the board", kept !== undefined, target.title);
  check("and was paid", kept?.completedAt !== null && paid.xpAwarded >= target.xp, `+${paid.xpAwarded} XP`);
  check("and is not paid twice", syncBoard(paid.state, ctxAt(played.h, now)).xpAwarded === 0);

  // -------------------------------------------------------------------------
  console.log("\n── the board varies from day to day ─────────────");

  const DAYS = 28;
  let recent: string[] = [];
  const appearances = new Map<string, number>();
  const kinds = new Set<string>();
  let repeats = 0;
  for (let d = DAYS - 1; d >= 0; d--) {
    const day = new Date(startOfDay(now).getTime() - d * DAY_MS);
    const { daily } = issueDaily(simAt(history, day), day, recent);
    const subjects = daily.map((q) => q.params.scenario ?? q.params.category ?? q.kind);
    repeats += subjects.filter((s) => recent.includes(s)).length;
    recent = subjects;
    for (const q of daily) {
      kinds.add(q.kind);
      appearances.set(q.title, (appearances.get(q.title) ?? 0) + 1);
    }
  }
  const mostSeen = Math.max(...appearances.values());
  console.log(`       ${appearances.size} distinct quests and ${kinds.size} kinds over ${DAYS} days;` +
    ` the most frequent appeared on ${mostSeen}`);
  check("the same subject is never on two boards in a row", repeats === 0, `${repeats} repeats`);
  check("no single quest dominates", mostSeen <= DAYS / 3, `${mostSeen} of ${DAYS} days: ${[...appearances].filter(([,n])=>n===mostSeen).map(([title])=>title).join(", ")}`);
  check("every daily kind that needs no server shows up", kinds.size >= 6, [...kinds].join(", "));

  // -------------------------------------------------------------------------
  console.log("\n── replaying real days: how often each kind completes ──");

  // Days with enough play to judge a board by: the board is what would have been issued
  // that morning, measured against what was actually played. Ranked kinds are left out;
  // the stats folder does not know about matches.
  //
  // Nobody saw these boards, so "completed out of issued" mostly measures whether the
  // player happened to launch the scenario a quest names. The number that says how hard
  // a quest is counts only the days its subject was actually played - enough runs of it
  // that finishing was possible - and that is the one held to a range.
  const runsOnDay = new Map<string, number>();
  for (const h of history.values()) {
    for (const r of h.runs) if (r.playedAt) runsOnDay.set(dayKey(r.playedAt), (runsOnDay.get(dayKey(r.playedAt)) ?? 0) + 1);
  }
  const tally = new Map<string, { issued: number; attempted: number; done: number }>();
  const note = (kind: string, attempted: boolean, done: boolean) => {
    const t = tally.get(kind) ?? { issued: 0, attempted: 0, done: 0 };
    t.issued++;
    if (attempted) t.attempted++;
    if (done) t.done++;
    tally.set(kind, t);
  };

  /** Played the quest's subject enough that day for finishing to have been possible. */
  const attempted = (q: IssuedQuest): boolean => {
    const since = new Date(q.since);
    const until = new Date(q.until);
    const count = (scenario: string) =>
      (history.get(scenario)?.runs ?? []).filter((r) => r.playedAt && r.playedAt >= since && r.playedAt < until).length;
    if (q.params.scenario) {
      const needed = q.kind === "clean_set" || q.kind === "beat_median" ? q.target : 1;
      return count(q.params.scenario) >= needed;
    }
    if (q.params.category) {
      const cat = difficulty.categories.find((c) => c.name === q.params.category);
      return (cat?.scenarios ?? []).some((s) => count(s.name) > 0);
    }
    return true;
  };

  let judged = 0;
  for (let d = 1; d <= 120; d++) {
    const day = new Date(startOfDay(now).getTime() - d * DAY_MS);
    if ((runsOnDay.get(dayKey(day)) ?? 0) < 10) continue;
    judged++;
    const ctx = simAt(history, day, false);
    const { daily, reserve } = issueDaily(ctx, day, []);
    const since = startOfDay(day);
    const asIssued = (q: Quest): IssuedQuest =>
      ({ ...q, since: since.toISOString(), until: new Date(since.getTime() + DAY_MS).toISOString(), progress: 0, completedAt: null });
    for (const q of [...daily, ...reserve.map(asIssued)]) note(q.kind, attempted(q), measure(q, ctx, []) >= q.target);
  }
  for (let w = 1; w <= 12; w++) {
    const day = new Date(startOfWeek(now).getTime() - w * 7 * DAY_MS + DAY_MS);
    const weekly = issueWeekly(simAt(history, day, false), day, null);
    if (weekly) note(weekly.kind, true, measure(weekly, simAt(history, day, false), []) >= weekly.target);
  }

  console.log(`       ${judged} days with 10+ runs in the last 120\n`);
  console.log(`       ${"kind".padEnd(16)} issued  played  done  done when played`);
  const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(0)}%` : "-");
  for (const [kind, t] of [...tally].sort()) {
    console.log(`       ${kind.padEnd(16)} ${String(t.issued).padStart(6)}  ${String(t.attempted).padStart(6)}  ${String(t.done).padStart(4)}  ${pct(t.done, t.attempted).padStart(6)}`);
  }

  if (judged === 0) {
    check("there were days to replay", false);
  } else {
    // Only kinds with enough played days to say anything; a rate over three days is noise.
    const judgedKinds = [...tally].filter(([, t]) => t.attempted >= 5);
    const trivial = judgedKinds.filter(([, t]) => t.done / t.attempted > 0.95).map(([k]) => k);
    const impossible = judgedKinds.filter(([, t]) => t.done === 0).map(([k]) => k);
    check("no kind completes on nearly every day it is played", trivial.length === 0, trivial.join(", "));
    check("no kind never completes on days it is played", impossible.length === 0, impossible.join(", "));
  }
}

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: quests and evxl link resolution validated");
