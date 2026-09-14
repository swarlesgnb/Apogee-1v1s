/**
 * Validate quest completion, payment and levelling, on a board built by hand.
 *
 * The property that matters most is that **a quest, once earned, is paid exactly once**.
 * The first board failed the first half: completing a quest changed the standing it was
 * generated from, the quest was replaced before it could be paid, and nothing noticed
 * because this suite only ever fed the reconciler quests that sat still. So these checks
 * move the standing underneath a quest on purpose, and assert it stays put and stays paid.
 *
 * The other half is idempotence. Sync runs on every run that lands, so a quest paid twice
 * would inflate XP quietly and in proportion to playtime, which is the hardest kind of
 * bug to notice.
 *
 *   npx tsx src/core/quests/validateProgression.ts
 */

import type { DifficultyDef } from "../benchmarks/types.ts";
import type { ScenarioHistory } from "../history/history.ts";
import {
  bonusXp,
  emptyQuestState,
  recordMatch,
  rerollQuest,
  startOfDay,
  startOfWeek,
  syncBoard,
  type BoardContext,
  type IssuedQuest,
  type Quest,
  type QuestKind,
  type QuestSlot,
  type QuestState,
} from "./board.ts";
import { dayKey, levelFor, xpForLevel } from "./progression.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

// ---- a three-scenario season -------------------------------------------------------

const difficulty: DifficultyDef = {
  name: "Test",
  kovaaksBenchmarkId: 0,
  rankNames: ["Iron", "Bronze", "Silver", "Gold"],
  rankColors: {},
  categories: [
    {
      name: "Clicking",
      rankMaxes: [100, 200, 300, 400],
      scenarios: ["A", "B", "C"].map((name) => ({ name, leaderboardId: null, rankMaxes: [100, 200, 300, 400] })),
    },
  ],
};

const NOW = new Date("2026-08-19T15:00:00"); // a Wednesday
const TODAY = startOfDay(NOW);
const YESTERDAY = new Date(TODAY.getTime() - 86_400_000);
const TOMORROW = new Date(TODAY.getTime() + 86_400_000);
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

type Runs = Record<string, { score: number; playedAt: Date }[]>;

function historyOf(runs: Runs): Map<string, ScenarioHistory> {
  const out = new Map<string, ScenarioHistory>();
  for (const [scenario, list] of Object.entries(runs)) {
    const sorted = [...list].sort((a, b) => a.playedAt.getTime() - b.playedAt.getTime());
    out.set(scenario, {
      scenario,
      runs: sorted,
      best: Math.max(...sorted.map((r) => r.score)),
      lastPlayed: sorted[sorted.length - 1]?.playedAt ?? null,
    });
  }
  return out;
}

/** Ten runs a week ago on each scenario, so every standing exists before today. */
function baseRuns(): Runs {
  const weekAgo = new Date(TODAY.getTime() - 7 * 86_400_000);
  return Object.fromEntries(
    ["A", "B", "C"].map((s) => [s, Array.from({ length: 10 }, (_, i) => ({ score: 150 + i, playedAt: at(weekAgo, i) }))]),
  );
}

function withRuns(runs: Runs, scenario: string, scores: number[], base: Date, startMinute = 60): Runs {
  const added = scores.map((score, i) => ({ score, playedAt: at(base, startMinute + i) }));
  return { ...runs, [scenario]: [...(runs[scenario] ?? []), ...added] };
}

function ctx(runs: Runs, now = NOW, ranked = false): BoardContext {
  return { difficulty, history: historyOf(runs), now, labelFor: (s) => s, ranked };
}

function quest(
  kind: QuestKind,
  slot: QuestSlot,
  params: Quest["params"],
  target: number,
  xp: number,
  day = TODAY,
  unit: Quest["unit"] = "runs",
): IssuedQuest {
  const until = slot === "weekly" ? new Date(startOfWeek(day).getTime() + 7 * 86_400_000) : new Date(day.getTime() + 86_400_000);
  const since = slot === "weekly" ? startOfWeek(day) : day;
  return {
    id: `${kind}:${params.scenario ?? ""}`,
    slot,
    kind,
    title: kind,
    detail: "d",
    xp,
    target,
    unit,
    params,
    since: since.toISOString(),
    until: until.toISOString(),
    progress: 0,
    completedAt: null,
  };
}

/** A board that will never pay by accident: a weekly nobody can finish. */
function board(daily: IssuedQuest[], day = TODAY, extra: Partial<QuestState> = {}): QuestState {
  return {
    ...emptyQuestState(),
    day: dayKey(day),
    week: dayKey(startOfWeek(day)),
    daily,
    weekly: quest("weekly_days", "weekly", {}, 99, 800, day, "days"),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
console.log("── a quest survives the run that completes it ───");

const reach = quest("reach_rank", "ceiling", { scenario: "A", bar: 200, from: 159 }, 200, 300, TODAY, "score");
let runs = baseRuns();

const idle = syncBoard(board([reach]), ctx(runs));
check("an unplayed quest pays nothing", idle.xpAwarded === 0 && idle.state.daily[0].progress === 0);

runs = withRuns(runs, "A", [210], TODAY);
const hit = syncBoard(idle.state, ctx(runs));
check("reaching the bar completes it", hit.newlyCompleted.length === 1 && hit.xpAwarded === 300, `${hit.xpAwarded} XP`);
check("it is still on the board afterwards", hit.state.daily[0].id === reach.id && hit.state.daily[0].completedAt !== null);

// The standing moves again - the next rank is now in reach - and the old board would have
// swapped the quest out for "Reach Gold". This one must not move.
runs = withRuns(runs, "A", [320], TODAY, 90);
const later = syncBoard(hit.state, ctx(runs));
check("a later rank-up does not replace it", later.state.daily[0].id === reach.id);
check("and does not pay it again", later.xpAwarded === 0 && later.state.totalXp === 300, `${later.state.totalXp}`);

let state = later.state;
for (let i = 0; i < 20; i++) state = syncBoard(state, ctx(runs)).state;
check("twenty more syncs pay nothing", state.totalXp === 300, `${state.totalXp} XP`);

// A run before the quest's window is the standing it was issued from, not progress.
const early = syncBoard(board([quest("reach_rank", "ceiling", { scenario: "B", bar: 200, from: 159 }, 200, 300, TODAY, "score")]),
  ctx(withRuns(baseRuns(), "B", [250], YESTERDAY)));
check("a run from before the board does not count", early.xpAwarded === 0, `progress ${early.state.daily[0].progress}`);

// ---------------------------------------------------------------------------
console.log("\n── floor quests count runs in a row ─────────────");

const set = quest("clean_set", "floor", { scenario: "A", bar: 200 }, 5, 350);
const broken = syncBoard(board([set]), ctx(withRuns(baseRuns(), "A", [210, 190, 210, 210, 210, 210], TODAY)));
check("a bad run resets the streak", broken.state.daily[0].progress === 4 && broken.xpAwarded === 0,
  `${broken.state.daily[0].progress}/5`);
const clean = syncBoard(board([set]), ctx(withRuns(baseRuns(), "A", [210, 190, 210, 210, 210, 210, 210], TODAY)));
check("five in a row completes it", clean.xpAwarded === 350, `${clean.state.daily[0].progress}/5`);

// Across scenarios, in the order played: a bad run on B breaks a streak built on A.
const nd = quest("no_disasters", "floor", { bars: { A: 100, B: 100 } }, 5, 300);
let ndRuns = withRuns(baseRuns(), "A", [150, 150, 150], TODAY, 60);
ndRuns = withRuns(ndRuns, "B", [50], TODAY, 63);
ndRuns = withRuns(ndRuns, "A", [150, 150, 150, 150], TODAY, 64);
ndRuns = withRuns(ndRuns, "C", [1], TODAY, 70); // no bar on C: skipped, not a disaster
const disaster = syncBoard(board([nd]), ctx(ndRuns));
check("a disaster on one scenario breaks the streak on another", disaster.state.daily[0].progress === 4,
  `${disaster.state.daily[0].progress}/5`);
ndRuns = withRuns(ndRuns, "B", [150], TODAY, 80);
check("runs on a scenario with no median are skipped, not counted against",
  syncBoard(board([nd]), ctx(ndRuns)).xpAwarded === 300);

// ---------------------------------------------------------------------------
console.log("\n── the day rolls over ───────────────────────────");

// Finished yesterday with the app closed: the run is in the folder, nothing saw it land.
const yq = quest("beat_median", "ceiling", { scenario: "C", bar: 150 }, 3, 200, YESTERDAY);
const yRuns = withRuns(baseRuns(), "C", [200, 200, 200], YESTERDAY);
const rolled = syncBoard(board([yq], YESTERDAY, { totalXp: 1000 }), ctx(yRuns));
check("yesterday's finished quest is paid on today's first sync",
  rolled.newlyCompleted.some((q) => q.id === yq.id), rolled.newlyCompleted.map((q) => q.id).join(","));
check("stamped inside its own day", rolled.newlyCompleted.find((q) => q.id === yq.id)?.completedAt.startsWith(dayKey(YESTERDAY).slice(0, 7)) === true
  && new Date(rolled.newlyCompleted.find((q) => q.id === yq.id)!.completedAt) < TODAY);
check("a new board is issued", rolled.state.day === dayKey(NOW) && rolled.state.daily.length === 3,
  `${rolled.state.daily.length} quests`);
check("one of each daily slot", new Set(rolled.state.daily.map((q) => q.slot)).size === 3,
  rolled.state.daily.map((q) => q.slot).join(","));
check("lifetime XP survives the reset", rolled.state.totalXp >= 1200, `${rolled.state.totalXp}`);
check("the reroll is restored", rolled.state.rerolled === false);

const again = syncBoard(null, ctx(yRuns));
check("the same day issues the same board",
  JSON.stringify(again.state.daily.map((q) => q.id)) === JSON.stringify(syncBoard(null, ctx(yRuns)).state.daily.map((q) => q.id)));
const launchedLater = syncBoard(null, ctx(yRuns, at(TODAY, 23 * 60)));
check("launching later in the day does not change it",
  JSON.stringify(again.state.daily.map((q) => q.id)) === JSON.stringify(launchedLater.state.daily.map((q) => q.id)));

// ---------------------------------------------------------------------------
console.log("\n── reroll ───────────────────────────────────────");

const fresh = syncBoard(null, ctx(baseRuns())).state;
const open = fresh.daily.find((q) => fresh.reserve.some((r) => r.slot === q.slot));
if (!open) {
  check("the board carries a spare to reroll into", false);
} else {
  const first = rerollQuest(fresh, open.id);
  check("a reroll swaps the quest", "state" in first && first.state.daily.every((q) => q.id !== open.id));
  if ("state" in first) {
    const second = rerollQuest(first.state, first.state.daily[0].id);
    check("a second reroll the same day is refused", "error" in second);
  }
}
const finished = board([{ ...reach, completedAt: NOW.toISOString(), progress: 210 }], TODAY, {
  reserve: [{ ...reach, id: "spare", params: { scenario: "B", bar: 200 } }],
});
check("a finished quest cannot be rerolled", "error" in rerollQuest(finished, reach.id));

// ---------------------------------------------------------------------------
console.log("\n── clearing the board ───────────────────────────");

const three = [
  quest("reach_rank", "ceiling", { scenario: "A", bar: 200, from: 159 }, 200, 300, TODAY, "score"),
  quest("category_volume", "variety", { category: "Clicking" }, 2, 150),
  quest("variety", "floor", {}, 2, 150, TODAY, "scenarios"),
];
let bRuns = withRuns(baseRuns(), "A", [250], TODAY);
const partial = syncBoard(board(three), ctx(bRuns));
check("no bonus until all three are done", partial.state.bonus === null);
bRuns = withRuns(bRuns, "B", [150], TODAY, 70);
const cleared = syncBoard(partial.state, ctx(bRuns));
const bonus = cleared.newlyCompleted.find((q) => q.kind === "board_clear");
check("clearing the board pays the bonus", bonus !== undefined && cleared.state.bonus !== null, bonus ? `+${bonus.xp}` : "none");
check("the bonus follows the streak", bonus?.xp === bonusXp(cleared.state.bonus?.streak ?? 0));
check("and is paid once", syncBoard(cleared.state, ctx(bRuns)).xpAwarded === 0);
check("the bonus grows and then stops", bonusXp(1) < bonusXp(4) && bonusXp(7) === bonusXp(30), `${bonusXp(1)}..${bonusXp(7)}`);

// ---------------------------------------------------------------------------
console.log("\n── ranked quests ────────────────────────────────");

const rp = quest("ranked_play", "variety", {}, 1, 250, TODAY, "matches");
const ww = quest("weekly_wins", "weekly", {}, 2, 1000, TODAY, "wins");
let rs: QuestState = { ...board([rp]), weekly: ww };
const match = (id: string, verdict: "win" | "loss" | "void", seeding = false) =>
  ({ id, at: at(TODAY, 120).toISOString(), verdict, seeding, category: "Clicking" });
rs = recordMatch(rs, match("m1", "void"));
check("a void match is not a match played", syncBoard(rs, ctx(baseRuns())).xpAwarded === 0);
rs = recordMatch(rs, match("m2", "win", true));
rs = recordMatch(rs, match("m2", "win", true));
check("a match recorded twice is kept once", rs.matches.length === 2);
const played = syncBoard(rs, ctx(baseRuns()));
check("a seeding match counts as played", played.state.daily[0].completedAt !== null);
check("but not as a win", played.state.weekly?.progress === 0, `${played.state.weekly?.progress}`);
rs = recordMatch(recordMatch(played.state, match("m3", "win")), match("m4", "win"));
check("two real wins finish the weekly", syncBoard(rs, ctx(baseRuns())).newlyCompleted.some((q) => q.kind === "weekly_wins"));

const signedOut = syncBoard(null, ctx(baseRuns(), NOW, false)).state;
check("a never-signed-in install is offered no ranked quest",
  ![...signedOut.daily, ...signedOut.reserve].some((q) => q.kind === "ranked_play"));
const seen = syncBoard({ ...emptyQuestState(), rankedSeen: true }, ctx(baseRuns(), NOW, false)).state;
check("having signed in once is enough, before the session restores", seen.rankedSeen);

// ---------------------------------------------------------------------------
console.log("\n── levelling ────────────────────────────────────");

check("level 1 starts at zero XP", xpForLevel(1) === 0);
check("levels cost progressively more", xpForLevel(3) - xpForLevel(2) > xpForLevel(2) - xpForLevel(1));

const start = levelFor(0);
check("no XP is level 1", start.level === 1, `${start.level}`);
check("and zero progress into it", start.progress === 0);

const mid = levelFor(xpForLevel(4) + 1);
check("XP just past a threshold is the new level", mid.level === 4, `${mid.level}`);
check("progress into a level starts near zero", mid.progress < 0.05, mid.progress.toFixed(3));

let previous = 0;
let monotonic = true;
for (let xp = 0; xp < 200_000; xp += 137) {
  const l = levelFor(xp).level;
  if (l < previous) { monotonic = false; break; }
  previous = l;
}
check("more XP never lowers your level", monotonic);
check("levelling stays bounded on absurd XP", levelFor(1e12).level <= 200);

// Two dailies a day is roughly 550 XP; the whole board with its bonus is roughly 1,200.
const fortnight = 14 * 550;
console.log(`       two quests a day for a fortnight (~${fortnight} XP) -> level ${levelFor(fortnight).level}`);
check("a fortnight of two quests a day reaches a mid level",
  levelFor(fortnight).level >= 3 && levelFor(fortnight).level <= 8, `level ${levelFor(fortnight).level}`);

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: quest progression validated");
void TOMORROW;
