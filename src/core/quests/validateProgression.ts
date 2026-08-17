/**
 * Validate quest completion, XP and levelling.
 *
 * The property that matters most is **idempotence**. Reconciliation runs on every run
 * that lands, so a quest already completed must never be paid again however many times
 * it is seen. Getting that wrong would inflate every player's XP quietly and in
 * proportion to how much they played, which is the hardest kind of bug to notice.
 *
 *   npx tsx src/core/quests/validateProgression.ts
 */

import {
  dayKey,
  emptyState,
  levelFor,
  reconcile,
  xpForLevel,
  type QuestSnapshot,
} from "./progression.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-08-17T12:00:00");
const TOMORROW = new Date("2026-08-18T09:00:00");

function quest(id: string, progress: number, target: number, xp = 100): QuestSnapshot {
  return { id, kind: "floor_rank_up", title: id, detail: "d", progress, target, xp };
}

console.log("── completion ───────────────────────────────────");

const fresh = emptyState(dayKey(NOW));

const none = reconcile([quest("a", 3, 5)], fresh, NOW);
check("an unfinished quest awards nothing", none.newlyCompleted.length === 0);
check("and no XP", none.xpAwarded === 0);

const one = reconcile([quest("a", 5, 5, 500)], fresh, NOW);
check("a finished quest completes", one.newlyCompleted.length === 1);
check("XP is awarded", one.xpAwarded === 500, `${one.xpAwarded}`);
check("XP lands in the total", one.state.totalXp === 500);

const over = reconcile([quest("b", 9, 5, 100)], fresh, NOW);
check("overshooting the target still completes", over.newlyCompleted.length === 1);

console.log("\n── idempotence ──────────────────────────────────");

// The reconciler runs on every landed run, so this is the case that decides whether
// XP inflates silently with playtime.
let state = one.state;
for (let i = 0; i < 20; i++) {
  const again = reconcile([quest("a", 5, 5, 500)], state, NOW);
  state = again.state;
  if (again.newlyCompleted.length > 0) {
    check("a completed quest is never re-awarded", false, `re-fired on pass ${i + 1}`);
    break;
  }
}
check("a completed quest is never re-awarded", state.totalXp === 500, `${state.totalXp} XP`);

const mixed = reconcile(
  [quest("a", 5, 5, 500), quest("c", 5, 5, 300)],
  state,
  NOW,
);
check("a new completion alongside an old one pays only the new one",
  mixed.xpAwarded === 300 && mixed.state.totalXp === 800, `${mixed.state.totalXp}`);

console.log("\n── the day rolls over ───────────────────────────");

const rolled = reconcile([quest("a", 5, 5, 500)], mixed.state, TOMORROW);
check("the board resets on a new day", rolled.dayRolled);
check("yesterday's completions clear", Object.keys(rolled.state.completed).length === 1);
check("lifetime XP survives the reset", rolled.state.totalXp === 1300, `${rolled.state.totalXp}`);
check("the same quest can be earned again tomorrow", rolled.newlyCompleted.length === 1);

console.log("\n── levelling ────────────────────────────────────");

check("level 1 starts at zero XP", xpForLevel(1) === 0);
check("levels cost progressively more",
  xpForLevel(3) - xpForLevel(2) > xpForLevel(2) - xpForLevel(1));

const start = levelFor(0);
check("no XP is level 1", start.level === 1, `${start.level}`);
check("and zero progress into it", start.progress === 0);

const mid = levelFor(xpForLevel(4) + 1);
check("XP just past a threshold is the new level", mid.level === 4, `${mid.level}`);
check("progress into a level starts near zero", mid.progress < 0.05, mid.progress.toFixed(3));

// Levels must be monotonic: more XP can never mean a lower level.
let previous = 0;
let monotonic = true;
for (let xp = 0; xp < 200_000; xp += 137) {
  const l = levelFor(xp).level;
  if (l < previous) { monotonic = false; break; }
  previous = l;
}
check("more XP never lowers your level", monotonic);
check("levelling stays bounded on absurd XP", levelFor(1e12).level <= 200);

// A player finishing a couple of quests a day should feel movement early.
const fortnight = 14 * 900;
console.log(`       two quests a day for a fortnight (~${fortnight} XP) -> level ${levelFor(fortnight).level}`);
check("a fortnight of play reaches a mid level",
  levelFor(fortnight).level >= 4 && levelFor(fortnight).level <= 8,
  `level ${levelFor(fortnight).level}`);

console.log("\n── malformed input ──────────────────────────────");

const zeroTarget = reconcile([quest("z", 0, 0, 100)], emptyState(dayKey(NOW)), NOW);
check("a zero-target quest cannot complete", zeroTarget.newlyCompleted.length === 0);

const negative = reconcile([quest("n", -1, 5, 100)], emptyState(dayKey(NOW)), NOW);
check("negative progress cannot complete", negative.newlyCompleted.length === 0);

check("an empty quest list is handled",
  reconcile([], emptyState(dayKey(NOW)), NOW).newlyCompleted.length === 0);

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: quest progression validated");
