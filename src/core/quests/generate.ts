/**
 * Quest generation.
 *
 * Quests exist to give a reason to open Arena on a day the player does not want to
 * compete (PLAN.md §10). They are generated against whichever benchmark the player
 * chose to track, so the targets are real scenarios with real thresholds rather than
 * generic busywork.
 *
 * One rule is load-bearing: **quest XP never touches Arena rating.** The moment
 * grinding quests moves the ladder, the ladder stops measuring skill.
 */

import { evaluateBenchmark, type ScenarioResult } from "../benchmarks/energy.ts";
import type { DifficultyDef } from "../benchmarks/types.ts";
import type { ScenarioHistory } from "../history/history.ts";
import { generateFloorQuests } from "./floorQuests.ts";

export type QuestKind =
  | "close_the_gap"
  | "rank_up_any"
  | "beat_baseline"
  | "play_category"
  | "win_weakest"
  | "play_streak"
  // Floor quests (see floorQuests.ts). These ask for five runs with no bad one rather
  // than one good run, which is a different skill and the one that transfers.
  | "floor_rank_up"
  | "close_the_spread"
  | "no_disasters";

export interface Quest {
  id: string;
  kind: QuestKind;
  /** Player-facing text, already resolved against real data. */
  title: string;
  detail: string;
  target: number;
  progress: number;
  xp: number;
  /** Scenario or category this quest is about, for deep-linking into the queue. */
  subject?: string;
  expiresAt: Date;
}

export interface GenerateOptions {
  difficulty: DifficultyDef;
  history: Map<string, ScenarioHistory>;
  /** Start of the quest day. */
  now: Date;
  /** How many daily quests to issue. */
  count?: number;
  /** Deterministic tie-breaking, so a reload does not reroll the day's quests. */
  seed?: string;
  /**
   * How many of the day's quests should target the floor rather than the ceiling.
   *
   * A mix on purpose: ceiling quests give a player something to chase on a day they
   * feel sharp, floor quests give them something worth doing on a day they do not.
   */
  floorQuests?: number;
}

const DAY_MS = 86_400_000;

function endOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d;
}

function shortName(scenario: string, difficulty: string): string {
  return scenario
    .replace(/^VT /, "")
    .replace(new RegExp(`\\s*${difficulty.split(" ")[0]}\\s*`, "i"), " ")
    .replace(/\s*S\d(\.\d)?\s*$/i, "")
    .trim();
}

function runsToday(history: ScenarioHistory | undefined, now: Date): number {
  if (!history) return 0;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return history.runs.filter((r) => r.playedAt && r.playedAt >= start).length;
}

/**
 * Consecutive days, ending today or yesterday, on which anything was played.
 * Counting yesterday as alive means a streak is not lost until the day is over.
 */
export function playStreak(history: Map<string, ScenarioHistory>, now: Date): number {
  const days = new Set<string>();
  for (const h of history.values()) {
    for (const run of h.runs) {
      if (run.playedAt) days.add(run.playedAt.toDateString());
    }
  }

  let streak = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);

  if (!days.has(cursor.toDateString())) {
    cursor.setTime(cursor.getTime() - DAY_MS);
    if (!days.has(cursor.toDateString())) return 0;
  }

  while (days.has(cursor.toDateString())) {
    streak++;
    cursor.setTime(cursor.getTime() - DAY_MS);
  }
  return streak;
}

/**
 * Generate the day's quests.
 *
 * Candidates are built from real standing, then the most motivating are kept: a
 * specific, nearly-achievable target beats a vague one, so scenarios closest to a rank
 * threshold are preferred.
 */
export function generateQuests(options: GenerateOptions): Quest[] {
  const { difficulty, history, now } = options;
  const count = options.count ?? 3;
  const expiresAt = endOfDay(now);

  const scores = new Map<string, number>();
  for (const cat of difficulty.categories) {
    for (const scen of cat.scenarios) {
      const h = history.get(scen.name);
      if (h) scores.set(scen.name, h.best);
    }
  }

  const result = evaluateBenchmark(difficulty, scores);
  const candidates: Quest[] = [];

  // --- close the gap: the single most motivating quest, because it names a number ---
  const gaps: ScenarioResult[] = result.categories
    .flatMap((c) => c.scenarios)
    .filter((s) => s.score > 0 && s.gapToNextRank != null && s.nextRankName != null)
    .sort((a, b) => a.gapToNextRank! / a.score - b.gapToNextRank! / b.score);

  for (const s of gaps.slice(0, 2)) {
    const label = shortName(s.scenario.name, difficulty.name);
    candidates.push({
      id: `gap:${s.scenario.name}`,
      kind: "close_the_gap",
      title: `Reach ${s.nextRankName} on ${label}`,
      detail:
        `You are at ${s.score.toFixed(0)}. ` +
        `${s.nextRankScore!.toFixed(0)} takes you to ${s.nextRankName}, ` +
        `${s.gapToNextRank!.toFixed(0)} more.`,
      target: s.nextRankScore!,
      progress: s.score,
      xp: 300,
      subject: s.scenario.name,
      expiresAt,
    });
  }

  // --- rank up anything in the tracked benchmark: the original idea, generalised ---
  if (gaps.length > 0) {
    candidates.push({
      id: "rank_up_any",
      kind: "rank_up_any",
      title: `Rank up any scenario in ${difficulty.name}`,
      detail: `${gaps.length} scenarios are within reach of their next rank.`,
      target: 1,
      progress: 0,
      xp: 400,
      expiresAt,
    });
  }

  // --- target the weakest category, where improvement is cheapest ---
  const weakest = [...result.categories].sort((a, b) => a.energy - b.energy)[0];
  if (weakest) {
    const played = weakest.scenarios.reduce(
      (n, s) => n + runsToday(history.get(s.scenario.name), now),
      0,
    );
    candidates.push({
      id: `category:${weakest.name}`,
      kind: "play_category",
      title: `Play 3 ${weakest.name} scenarios`,
      detail: `${weakest.name} is your weakest category at ${weakest.energy.toFixed(0)} energy.`,
      target: 3,
      progress: Math.min(3, played),
      xp: 150,
      subject: weakest.name,
      expiresAt,
    });

    candidates.push({
      id: `win_weakest:${weakest.name}`,
      kind: "win_weakest",
      title: `Win a match in ${weakest.name}`,
      detail: "Ranked wins in your weakest category are worth the most.",
      target: 1,
      progress: 0,
      xp: 500,
      subject: weakest.name,
      expiresAt,
    });
  }

  // --- beat your own baseline: always available, never depends on thresholds ---
  candidates.push({
    id: "beat_baseline",
    kind: "beat_baseline",
    title: "Beat your baseline twice",
    detail: "Score above your own recent median in any two scenarios.",
    target: 2,
    progress: 0,
    xp: 200,
    expiresAt,
  });

  // --- streak ---
  const streak = playStreak(history, now);
  candidates.push({
    id: "streak",
    kind: "play_streak",
    title: streak > 0 ? `Extend your ${streak}-day streak` : "Start a play streak",
    detail: streak > 0 ? `Play today to reach ${streak + 1} days.` : "Play today to begin.",
    target: 1,
    progress: runsTodayTotal(history, now) > 0 ? 1 : 0,
    xp: 100,
    expiresAt,
  });

  // Floor quests are interleaved rather than appended, so they are not always the ones
  // pushed off the end of a short list.
  const floorCount = options.floorQuests ?? Math.min(2, Math.max(1, Math.floor(count / 2)));
  const floor = generateFloorQuests({ difficulty, history, now, count: floorCount });

  const mixed: Quest[] = [];
  const ceilingQueue = [...candidates];
  const floorQueue = [...floor];

  // Lead with a floor quest: it is the one a player is least likely to have thought of
  // for themselves, and the reason the mode exists.
  while (mixed.length < count && (floorQueue.length || ceilingQueue.length)) {
    if (floorQueue.length) mixed.push(floorQueue.shift()!);
    if (mixed.length < count && ceilingQueue.length) mixed.push(ceilingQueue.shift()!);
  }

  // Deterministic ordering so the same day yields the same quests on every reload.
  return mixed.slice(0, count);
}

function runsTodayTotal(history: Map<string, ScenarioHistory>, now: Date): number {
  let total = 0;
  for (const h of history.values()) total += runsToday(h, now);
  return total;
}

/** Has this quest been completed? */
export function isComplete(quest: Quest): boolean {
  return quest.progress >= quest.target;
}

/** Fraction complete, clamped to 0..1, for progress bars. */
export function questProgress(quest: Quest): number {
  if (quest.target <= 0) return 1;
  if (quest.kind === "close_the_gap") {
    // Progress toward a score threshold is only meaningful from the previous rank up,
    // so show it as a share of the remaining gap rather than of the absolute score.
    return Math.max(0, Math.min(1, quest.progress / quest.target));
  }
  return Math.max(0, Math.min(1, quest.progress / quest.target));
}
