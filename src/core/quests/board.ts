/**
 * The quest board: issued once, then measured.
 *
 * Quests exist to give a reason to open Apogee on a day the player does not want to
 * compete (PLAN.md §10). One rule is load-bearing: **quest XP never touches Apogee
 * rating.** The moment grinding quests moves the ladder, the ladder stops measuring skill.
 *
 * The first version regenerated the day's quests from the whole history on every rebuild
 * and keyed completions on the quest's title. Completing a quest changes the standing it
 * was generated from, so the quest that had just been earned was replaced by a new one
 * with a new title before anything could pay it: "Reach Scalding on Sparky" became "Reach
 * Blistering on Sparky" in the same rebuild. Played against the real history on
 * 2026-09-13, all five quests on the board either vanished the moment they were done or
 * carried a progress hard-coded to zero. It also issued the same five quests every day,
 * because nothing in it varied except the history.
 *
 * So now a board is issued once and frozen:
 *
 *   - It is built from the history *before* the period began (local midnight for the
 *     dailies, Monday for the weekly), so the same day always yields the same board, and
 *     launching the app at noon cannot change what the morning's runs are measured against.
 *   - Progress counts only runs played *since* then. A quest measures what was done today,
 *     not what the standing happens to be, so reaching a rank cannot un-issue the quest
 *     that asked for it.
 *   - Completion is sticky. Once paid, a quest stays done.
 *   - Which quests are drawn is seeded by the day, and a subject on yesterday's board is
 *     steered around today, so the board varies even when the history barely has.
 */

import { evaluateBenchmark, rankIndex } from "../benchmarks/energy.ts";
import type { CategoryDef, DifficultyDef, ScenarioDef } from "../benchmarks/types.ts";
import { MIN_RUNS_FOR_BASELINE, recentMedian } from "../history/baseline.ts";
import type { ScenarioHistory } from "../history/history.ts";
import { dayKey } from "./progression.ts";

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

/** Where a quest sits on the board. One daily of each of the first three, plus the weekly. */
export type QuestSlot = "ceiling" | "floor" | "variety" | "weekly";

export const DAILY_SLOTS: QuestSlot[] = ["ceiling", "floor", "variety"];

export type QuestKind =
  // ceiling: one good run
  | "reach_rank"
  | "beat_median"
  // floor: no bad run
  | "clean_set"
  | "no_disasters"
  // variety: breadth, revisits, the ranked queue
  | "category_volume"
  | "variety"
  | "revisit"
  | "ranked_play"
  // weekly
  | "weekly_rank_ups"
  | "weekly_floors"
  | "weekly_wins"
  | "weekly_days";

export type QuestUnit = "score" | "runs" | "scenarios" | "matches" | "wins" | "days" | "sets" | "ranks";

/** What a quest measures, fixed when it is issued. */
export interface QuestParams {
  scenario?: string;
  category?: string;
  /** Score a run has to reach. */
  bar?: number;
  /** Where the player stood when it was issued, so a score bar starts from there. */
  from?: number;
  /** Per-scenario bars, for a quest that counts runs on anything in the pool. */
  bars?: Record<string, number>;
  /** Per-family ladder rank when issued, for a quest counting rank-ups. */
  ranks?: Record<string, number>;
}

export interface Quest {
  id: string;
  slot: QuestSlot;
  kind: QuestKind;
  title: string;
  detail: string;
  xp: number;
  target: number;
  unit: QuestUnit;
  params: QuestParams;
}

export interface IssuedQuest extends Quest {
  /** Runs and matches in [since, until) count toward it. */
  since: string;
  until: string;
  progress: number;
  completedAt: string | null;
}

/** A settled ranked match, remembered because the server does not re-send it. */
export interface MatchRecord {
  id: string;
  at: string;
  verdict: "win" | "loss" | "draw" | "void";
  /** A seeding match has nobody on the other side, so it can be played but not won. */
  seeding: boolean;
  category: string | null;
}

/** Everything remembered between launches. */
export interface QuestState {
  version: 2;
  /** Local calendar day the dailies belong to; empty before the first issue. */
  day: string;
  /** Local date of the Monday the weekly belongs to. */
  week: string;
  daily: IssuedQuest[];
  /** One alternate per daily slot, drawn with the board, for the day's reroll. */
  reserve: Quest[];
  weekly: IssuedQuest | null;
  rerolled: boolean;
  /** The board-clear bonus, once paid for this day. */
  bonus: { xp: number; streak: number; paidAt: string } | null;
  /** Lifetime XP. */
  totalXp: number;
  /** Settled matches from the last eight days, newest last. */
  matches: MatchRecord[];
  /** Subjects on the previous board, so the next one steers around them. */
  recent: string[];
  lastWeeklyKind: QuestKind | null;
  /**
   * Whether this install has ever been signed in.
   *
   * The session is restored asynchronously, after the first scan has already issued the
   * day's board, so "signed in right now" would leave ranked quests off every morning's
   * board. Having ever been signed in is known synchronously and is the better question.
   */
  rankedSeen: boolean;
}

export interface CompletedQuest {
  id: string;
  slot: QuestSlot | "bonus";
  kind: QuestKind | "board_clear";
  title: string;
  detail: string;
  xp: number;
  completedAt: string;
}

export interface BoardContext {
  difficulty: DifficultyDef;
  history: Map<string, ScenarioHistory>;
  now: Date;
  /** How to name a scenario. It has to be the name KovaaK's shows, variant included. */
  labelFor: (scenario: string) => string;
  /** Signed in now. Folded into `rankedSeen`. */
  ranked: boolean;
}

export function emptyQuestState(totalXp = 0): QuestState {
  return {
    version: 2,
    day: "",
    week: "",
    daily: [],
    reserve: [],
    weekly: null,
    rerolled: false,
    bonus: null,
    totalXp,
    matches: [],
    recent: [],
    lastWeeklyKind: null,
    rankedSeen: false,
  };
}

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

const XP: Record<QuestKind, number> = {
  reach_rank: 300,
  beat_median: 200,
  clean_set: 350,
  no_disasters: 300,
  category_volume: 150,
  variety: 150,
  revisit: 250,
  ranked_play: 250,
  weekly_rank_ups: 1000,
  weekly_floors: 1000,
  weekly_wins: 1000,
  weekly_days: 800,
};

/** Runs in a row a floor quest asks for: the same five the floor itself is the worst of. */
const CLEAN_SET = 5;

/**
 * How far under a median still counts as "not a disaster".
 *
 * A tenth: loose enough that an ordinary off run passes, tight enough that a thrown run
 * does not. `validateQuests` replays the real history and prints how often a day's play
 * would have completed it.
 */
const DISASTER_FRACTION = 0.9;

/** A scenario untouched this long is worth a revisit quest. */
const NEGLECTED_DAYS = 21;

/** Settled matches are kept this long; nothing reads further back than a week. */
const MATCH_MEMORY_DAYS = 8;

/** Bonus for clearing the whole daily board, rising with the play streak. */
export function bonusXp(streak: number): number {
  return 100 + 50 * Math.min(Math.max(streak, 1) - 1, 6);
}

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local Monday 00:00. `setDate` rather than millisecond arithmetic, so DST cannot shift it. */
export function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function nextDay(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  return d;
}

function nextWeek(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + 7);
  return d;
}

/**
 * Consecutive days, ending today or yesterday, on which anything was played.
 * Counting yesterday as alive means a streak is not lost until the day is over.
 */
export function playStreak(history: Map<string, ScenarioHistory>, now: Date): number {
  const days = new Set<string>();
  for (const h of history.values()) {
    for (const run of h.runs) if (run.playedAt) days.add(run.playedAt.toDateString());
  }

  let streak = 0;
  const cursor = startOfDay(now);
  if (!days.has(cursor.toDateString())) {
    cursor.setTime(cursor.getTime() - DAY_MS);
    if (!days.has(cursor.toDateString())) return 0;
  }
  while (days.has(cursor.toDateString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// ---------------------------------------------------------------------------
// seeded choice
// ---------------------------------------------------------------------------

/** Small seeded generator (mulberry32 over a string hash). Same day, same board. */
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** What a quest is about, for steering the next board away from it. */
function subjectOf(q: Quest): string {
  return q.params.scenario ?? q.params.category ?? q.kind;
}

/**
 * Pick one quest for a slot, and a spare for the reroll.
 *
 * A kind is drawn first and a candidate within it second, so a slot with eight
 * reach-rank candidates and one of anything else does not come up reach-rank eight days
 * in nine. Within a kind the candidates arrive best-first, and the pick is among the top
 * three: near enough to the best to be worth doing, loose enough to vary.
 */
function choose(
  candidates: Quest[],
  rng: () => number,
  avoid: Set<string>,
): { pick: Quest | null; spare: Quest | null } {
  const fresh = candidates.filter((q) => !avoid.has(subjectOf(q)));
  const usable = fresh.length > 0 ? fresh : candidates;
  if (usable.length === 0) return { pick: null, spare: null };

  const byKind = new Map<QuestKind, Quest[]>();
  for (const q of usable) byKind.set(q.kind, [...(byKind.get(q.kind) ?? []), q]);
  const kinds = shuffle([...byKind.keys()], rng);

  const from = (list: Quest[]) => list[Math.floor(rng() * Math.min(3, list.length))];
  const pick = from(byKind.get(kinds[0])!);

  const otherKind = kinds.slice(1).map((k) => byKind.get(k)!);
  const sameKind = byKind.get(kinds[0])!.filter((q) => q.id !== pick.id);
  const spare = otherKind.length > 0 ? from(otherKind[0]) : sameKind.length > 0 ? from(sameKind) : null;

  return { pick, spare };
}

// ---------------------------------------------------------------------------
// reading the history
// ---------------------------------------------------------------------------

type Run = { score: number; playedAt: Date | null };

interface PoolScenario {
  def: ScenarioDef;
  category: CategoryDef;
}

function poolOf(difficulty: DifficultyDef): PoolScenario[] {
  return difficulty.categories.flatMap((category) =>
    category.scenarios.map((def) => ({ def, category })),
  );
}

/** Runs before an instant. A run with no timestamp is old by definition. */
function before(h: ScenarioHistory | undefined, t: Date): Run[] {
  return h ? h.runs.filter((r) => !r.playedAt || r.playedAt < t) : [];
}

/** Runs in [since, until), oldest first. */
function within(h: ScenarioHistory | undefined, since: Date, until: Date): Run[] {
  return h ? h.runs.filter((r) => r.playedAt && r.playedAt >= since && r.playedAt < until) : [];
}

function longestStreak(flags: boolean[]): number {
  let best = 0;
  let run = 0;
  for (const ok of flags) {
    run = ok ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Name of the ladder rank a threshold on this variant awards. */
function ladderName(p: PoolScenario, index: number, difficulty: DifficultyDef): string {
  const ladder = p.category.rankNames ?? difficulty.rankNames;
  const offset = (p.def.window ?? 0) * (p.category.windowSize ?? 0);
  return ladder[offset + index] ?? "the next rank";
}

function familyKey(p: { category: string; family?: string; name: string }): string {
  return `${p.category}/${p.family ?? p.name}`;
}

/** Each family's ladder rank from the given best scores. */
function familyRanks(difficulty: DifficultyDef, bests: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const result = evaluateBenchmark(difficulty, bests);
  for (const cat of result.categories) {
    for (const s of cat.scenarios) {
      out.set(familyKey({ category: cat.name, family: s.scenario.family, name: s.scenario.name }), s.rankIndex);
    }
  }
  return out;
}

function bestsBefore(pool: PoolScenario[], history: Map<string, ScenarioHistory>, t: Date): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pool) {
    const runs = before(history.get(p.def.name), t);
    if (runs.length > 0) out.set(p.def.name, Math.max(...runs.map((r) => r.score)));
  }
  return out;
}

const round = (n: number) => Math.round(n);
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

// ---------------------------------------------------------------------------
// candidates
// ---------------------------------------------------------------------------

interface IssueContext extends BoardContext {
  /** The period's boundary: history before it is the standing, runs after it are progress. */
  since: Date;
  pool: PoolScenario[];
  bests: Map<string, number>;
}

function dailyCandidates(ctx: IssueContext): Record<"ceiling" | "floor" | "variety", Quest[]> {
  const { difficulty, history, since, pool, labelFor } = ctx;
  const ceiling: Quest[] = [];
  const floor: Quest[] = [];
  const variety: Quest[] = [];

  const result = evaluateBenchmark(difficulty, ctx.bests);

  // ---- reach a rank: a specific number on a specific scenario --------------------
  //
  // The target is on the scenario the threshold lives on, which is not always the one
  // currently ranked by: the next rank can sit in a harder window, and then the score,
  // the target and the scenario to launch all belong to that variant.
  const gaps = result.categories
    .flatMap((c) => c.scenarios)
    .filter((s) => s.nextRankScore != null && s.nextRankName != null && (s.nextRankFromScore ?? s.score) > 0)
    .map((s) => {
      const scenario = s.nextRankScenario ?? s.scenario.name;
      const at = s.nextRankFromScore ?? s.score;
      return { s, scenario, at, share: (s.nextRankScore! - at) / s.nextRankScore! };
    })
    .filter((g) => g.share > 0)
    .sort((a, b) => a.share - b.share)
    .slice(0, 8);

  for (const g of gaps) {
    const label = labelFor(g.scenario);
    ceiling.push({
      id: `reach_rank:${g.scenario}`,
      slot: "ceiling",
      kind: "reach_rank",
      title: `Reach ${g.s.nextRankName} on ${label}`,
      detail: `Your best is ${fmt(g.at)}. ${fmt(g.s.nextRankScore!)} takes you to ${g.s.nextRankName}, ${fmt(g.s.nextRankScore! - g.at)} more.`,
      xp: XP.reach_rank,
      target: round(g.s.nextRankScore!),
      unit: "score",
      params: { scenario: g.scenario, bar: g.s.nextRankScore!, from: g.at },
    });
  }

  // ---- beat your own median: the ceiling quest that never depends on thresholds ----
  const recent = pool
    .map((p) => ({ p, runs: before(history.get(p.def.name), since) }))
    .filter(({ runs }) => runs.length >= MIN_RUNS_FOR_BASELINE)
    .map(({ p, runs }) => ({ p, runs, last: runs[runs.length - 1].playedAt?.getTime() ?? 0 }))
    .filter(({ last }) => since.getTime() - last <= 30 * DAY_MS)
    .sort((a, b) => b.last - a.last)
    .slice(0, 8);

  for (const { p, runs } of recent) {
    const median = recentMedian(runs.map((r) => r.score));
    if (median <= 0) continue;
    const label = labelFor(p.def.name);
    ceiling.push({
      id: `beat_median:${p.def.name}`,
      slot: "ceiling",
      kind: "beat_median",
      title: `Beat your ${label} median three times`,
      detail: `Your median over your last ${Math.min(runs.length, 50)} runs is ${fmt(median)}. Three runs above it today.`,
      xp: XP.beat_median,
      target: 3,
      unit: "runs",
      params: { scenario: p.def.name, bar: median },
    });
  }

  // ---- a clean set: five in a row that lift the floor a rank -----------------------
  //
  // Five in a row at the bar means the worst of the last five clears it, which is the
  // floor rank by definition. Offered only where the bar is already being hit some of
  // the time, because five in a row at a score never yet reached is not a quest.
  const sets = pool
    .map((p) => ({ p, runs: before(history.get(p.def.name), since) }))
    .filter(({ p, runs }) => runs.length >= CLEAN_SET && p.def.rankMaxes.length > 0)
    .map(({ p, runs }) => {
      const scores = runs.map((r) => r.score);
      const worst = Math.min(...scores.slice(-CLEAN_SET));
      const next = rankIndex(worst, p.def.rankMaxes) + 1;
      if (next >= p.def.rankMaxes.length) return null;
      const bar = p.def.rankMaxes[next];
      const clearing = scores.slice(-10).filter((s) => s >= bar).length;
      return { p, worst, bar, next, clearing };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null && c.clearing >= 3)
    .sort((a, b) => b.clearing - a.clearing)
    .slice(0, 8);

  for (const c of sets) {
    const label = labelFor(c.p.def.name);
    const rank = ladderName(c.p, c.next, difficulty);
    floor.push({
      id: `clean_set:${c.p.def.name}`,
      slot: "floor",
      kind: "clean_set",
      title: `Five clean runs on ${label}`,
      detail: `Five in a row at ${fmt(c.bar)} or better lifts your floor to ${rank}. Your worst of the last five is ${fmt(c.worst)}; ${c.clearing} of your last ten cleared it.`,
      xp: XP.clean_set,
      target: CLEAN_SET,
      unit: "runs",
      params: { scenario: c.p.def.name, bar: c.bar },
    });
  }

  // ---- no disasters: the habit, not the map ---------------------------------------
  const bars: Record<string, number> = {};
  for (const p of pool) {
    const runs = before(history.get(p.def.name), since);
    if (runs.length < MIN_RUNS_FOR_BASELINE) continue;
    const median = recentMedian(runs.map((r) => r.score));
    if (median > 0) bars[p.def.name] = median * DISASTER_FRACTION;
  }
  if (Object.keys(bars).length >= 3) {
    floor.push({
      id: "no_disasters",
      slot: "floor",
      kind: "no_disasters",
      title: "No disasters",
      detail: `Five runs in a row on anything in the pool you have a median on, without one landing under ${Math.round(DISASTER_FRACTION * 100)}% of it.`,
      xp: XP.no_disasters,
      target: CLEAN_SET,
      unit: "runs",
      params: { bars },
    });
  }

  // ---- volume in a category, weighted toward the weak ones -------------------------
  const weakFirst = [...result.categories].sort((a, b) => a.energy - b.energy).slice(0, 3);
  for (const cat of weakFirst) {
    variety.push({
      id: `category_volume:${cat.name}`,
      slot: "variety",
      kind: "category_volume",
      title: `Put eight runs into ${cat.name}`,
      detail: `${cat.name} sits at ${cat.rankName ?? "unranked"}. Any of its ${cat.scenarios.length} families count, at any difficulty.`,
      xp: XP.category_volume,
      target: 8,
      unit: "runs",
      params: { category: cat.name },
    });
  }

  variety.push({
    id: "variety",
    slot: "variety",
    kind: "variety",
    title: "Play four different scenarios",
    detail: "Anything in the season pool. A match draws three from it, so breadth is what gets tested.",
    xp: XP.variety,
    target: 4,
    unit: "scenarios",
    params: {},
  });

  // ---- revisit something let go -----------------------------------------------------
  const neglected = pool
    .map((p) => ({ p, runs: before(history.get(p.def.name), since) }))
    .filter(({ runs }) => runs.length >= 3)
    .map(({ p, runs }) => ({
      p,
      runs: runs.length,
      best: Math.max(...runs.map((r) => r.score)),
      days: Math.floor((since.getTime() - (runs[runs.length - 1].playedAt?.getTime() ?? 0)) / DAY_MS),
    }))
    .filter((n) => n.days >= NEGLECTED_DAYS && n.best > 0)
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 8);

  for (const n of neglected) {
    const label = labelFor(n.p.def.name);
    const bar = n.best * 0.9;
    variety.push({
      id: `revisit:${n.p.def.name}`,
      slot: "variety",
      kind: "revisit",
      title: `Revisit ${label}`,
      detail: `Untouched for ${n.days} days. Get within a tenth of your best of ${fmt(n.best)}: ${fmt(bar)}.`,
      xp: XP.revisit,
      target: round(bar),
      unit: "score",
      params: { scenario: n.p.def.name, bar, from: 0 },
    });
  }

  if (ctx.ranked) {
    variety.push({
      id: "ranked_play",
      slot: "variety",
      kind: "ranked_play",
      title: "Play a ranked match",
      detail: "Any category. A seeding match counts; a void one does not.",
      xp: XP.ranked_play,
      target: 1,
      unit: "matches",
      params: {},
    });
  }

  return { ceiling, floor, variety };
}

function weeklyCandidates(ctx: IssueContext): Quest[] {
  const { difficulty, history, since, pool } = ctx;
  const out: Quest[] = [];

  const ranks = Object.fromEntries(familyRanks(difficulty, ctx.bests));
  out.push({
    id: "weekly_rank_ups",
    slot: "weekly",
    kind: "weekly_rank_ups",
    title: "Rank up three scenarios this week",
    detail: "Any three families in the season, each by at least one rank.",
    xp: XP.weekly_rank_ups,
    target: 3,
    unit: "ranks",
    params: { ranks },
  });

  const medians: Record<string, number> = {};
  for (const p of pool) {
    const runs = before(history.get(p.def.name), since);
    if (runs.length < MIN_RUNS_FOR_BASELINE) continue;
    const median = recentMedian(runs.map((r) => r.score));
    if (median > 0) medians[p.def.name] = median;
  }
  if (Object.keys(medians).length >= 3) {
    out.push({
      id: "weekly_floors",
      slot: "weekly",
      kind: "weekly_floors",
      title: "Three clean sets this week",
      detail: "Five runs in a row at or above your median, on three different scenarios.",
      xp: XP.weekly_floors,
      target: 3,
      unit: "sets",
      params: { bars: medians },
    });
  }

  if (ctx.ranked) {
    out.push({
      id: "weekly_wins",
      slot: "weekly",
      kind: "weekly_wins",
      title: "Win three ranked matches this week",
      detail: "Rated or tournament, any category. Seeding matches have nobody to beat.",
      xp: XP.weekly_wins,
      target: 3,
      unit: "wins",
      params: {},
    });
  }

  out.push({
    id: "weekly_days",
    slot: "weekly",
    kind: "weekly_days",
    title: "Play on five days this week",
    detail: "Any scenario, any length of session. Most of what practice does, it does by being regular.",
    xp: XP.weekly_days,
    target: 5,
    unit: "days",
    params: {},
  });

  return out;
}

function issueContext(ctx: BoardContext, since: Date): IssueContext {
  const pool = poolOf(ctx.difficulty);
  return { ...ctx, since, pool, bests: bestsBefore(pool, ctx.history, since) };
}

function issued(q: Quest, since: Date, until: Date): IssuedQuest {
  return { ...q, since: since.toISOString(), until: until.toISOString(), progress: 0, completedAt: null };
}

/**
 * The day's board: one quest per daily slot, and a spare per slot for the reroll.
 *
 * Exported for the validator, which replays past days through it.
 */
export function issueDaily(
  ctx: BoardContext,
  day: Date,
  recent: string[],
): { daily: IssuedQuest[]; reserve: Quest[] } {
  const since = startOfDay(day);
  const until = nextDay(since);
  const rng = seeded(`apogee-daily:${dayKey(since)}`);
  const candidates = dailyCandidates(issueContext(ctx, since));

  const avoid = new Set(recent);
  const daily: IssuedQuest[] = [];
  const reserve: Quest[] = [];

  for (const slot of DAILY_SLOTS as ("ceiling" | "floor" | "variety")[]) {
    // A player too new for a slot's own kinds still gets three quests: the variety pool
    // always has something, and a slot left empty would read as the board being broken.
    let pool = candidates[slot];
    if (pool.length === 0) pool = candidates.variety.map((q) => ({ ...q, id: `${q.id}#${slot}`, slot }));

    const { pick, spare } = choose(pool, rng, avoid);
    if (!pick) continue;
    daily.push(issued(pick, since, until));
    avoid.add(subjectOf(pick));
    if (spare) reserve.push(spare);
  }

  return { daily, reserve };
}

export function issueWeekly(ctx: BoardContext, day: Date, lastKind: QuestKind | null): IssuedQuest | null {
  const since = startOfWeek(day);
  const rng = seeded(`apogee-weekly:${dayKey(since)}`);
  const candidates = weeklyCandidates(issueContext(ctx, since));
  const { pick } = choose(candidates, rng, new Set(lastKind ? [lastKind] : []));
  return pick ? issued(pick, since, nextWeek(since)) : null;
}

// ---------------------------------------------------------------------------
// measuring
// ---------------------------------------------------------------------------

/** How far along a quest is, from runs and matches in its window only. */
export function measure(q: IssuedQuest, ctx: BoardContext, matches: MatchRecord[]): number {
  const since = new Date(q.since);
  const until = new Date(q.until);
  const { history } = ctx;
  const runsOn = (scenario: string) => within(history.get(scenario), since, until);
  const inWindow = (m: MatchRecord) => {
    const at = new Date(m.at);
    return at >= since && at < until;
  };

  switch (q.kind) {
    case "reach_rank":
    case "revisit": {
      const runs = runsOn(q.params.scenario!);
      return runs.length > 0 ? Math.max(...runs.map((r) => r.score)) : 0;
    }

    case "beat_median":
      return runsOn(q.params.scenario!).filter((r) => r.score > q.params.bar!).length;

    case "clean_set":
      return longestStreak(runsOn(q.params.scenario!).map((r) => r.score >= q.params.bar!));

    case "no_disasters": {
      // In the order they were played, across scenarios: a bad run on one breaks the
      // streak on all of them, which is the habit being asked for. Runs on anything
      // without a median are skipped rather than counted either way.
      const bars = q.params.bars ?? {};
      const runs = Object.keys(bars)
        .flatMap((scenario) => runsOn(scenario).map((r) => ({ ...r, ok: r.score >= bars[scenario] })))
        .sort((a, b) => a.playedAt!.getTime() - b.playedAt!.getTime());
      return longestStreak(runs.map((r) => r.ok));
    }

    case "category_volume": {
      const cat = ctx.difficulty.categories.find((c) => c.name === q.params.category);
      return (cat?.scenarios ?? []).reduce((n, s) => n + runsOn(s.name).length, 0);
    }

    case "variety":
      return poolOf(ctx.difficulty).filter((p) => runsOn(p.def.name).length > 0).length;

    case "ranked_play":
      return matches.filter((m) => inWindow(m) && m.verdict !== "void").length;

    case "weekly_rank_ups": {
      const was = q.params.ranks ?? {};
      const now = familyRanks(ctx.difficulty, bestsBefore(poolOf(ctx.difficulty), history, until));
      let ups = 0;
      for (const [family, rank] of now) if (rank > (was[family] ?? -1)) ups++;
      return ups;
    }

    case "weekly_floors": {
      const bars = q.params.bars ?? {};
      return Object.keys(bars).filter(
        (scenario) => longestStreak(runsOn(scenario).map((r) => r.score >= bars[scenario])) >= CLEAN_SET,
      ).length;
    }

    case "weekly_wins":
      return matches.filter((m) => inWindow(m) && m.verdict === "win" && !m.seeding).length;

    case "weekly_days": {
      const days = new Set<string>();
      for (const h of history.values()) {
        for (const r of within(h, since, until)) days.add(dayKey(r.playedAt!));
      }
      return days.size;
    }
  }
}

function done(q: Quest, progress: number): boolean {
  return q.target > 0 && progress >= q.target;
}

// ---------------------------------------------------------------------------
// the state machine
// ---------------------------------------------------------------------------

export interface QuestSync {
  state: QuestState;
  /** Quests that completed on this pass and have not been announced before. */
  newlyCompleted: CompletedQuest[];
  xpAwarded: number;
  /** Whether anything worth writing to disk changed. */
  changed: boolean;
}

/**
 * Measure every open quest and pay whatever has completed. Idempotent: a paid quest has a
 * `completedAt`, and nothing with one is paid again however many times this runs.
 */
function settle(state: QuestState, ctx: BoardContext, paid: CompletedQuest[]): void {
  const quests = [...state.daily, ...(state.weekly ? [state.weekly] : [])];
  for (const q of quests) {
    if (q.completedAt) continue;
    q.progress = measure(q, ctx, state.matches);
    if (!done(q, q.progress)) continue;

    // Stamped with the end of its own window when settled late, so a quest finished
    // yesterday with the app closed does not claim to have been finished this morning.
    const until = new Date(q.until);
    q.completedAt = (ctx.now < until ? ctx.now : new Date(until.getTime() - 1)).toISOString();
    state.totalXp += q.xp;
    paid.push({ id: q.id, slot: q.slot, kind: q.kind, title: q.title, detail: q.detail, xp: q.xp, completedAt: q.completedAt });
  }

  // A full board only. The issuer always fills all three slots, so a shorter one is a
  // board that was built some other way and has not earned a bonus for being short.
  if (!state.bonus && state.daily.length === DAILY_SLOTS.length && state.daily.every((q) => q.completedAt)) {
    const at = new Date(Math.max(...state.daily.map((q) => new Date(q.completedAt!).getTime())));
    const streak = playStreak(ctx.history, at);
    const xp = bonusXp(streak);
    state.bonus = { xp, streak, paidAt: at.toISOString() };
    state.totalXp += xp;
    paid.push({
      id: `board_clear:${state.day}`,
      slot: "bonus",
      kind: "board_clear",
      title: "Board cleared",
      detail: `All three of today's quests, on a ${streak}-day streak.`,
      xp,
      completedAt: at.toISOString(),
    });
  }
}

/**
 * Fold the latest history into the stored board.
 *
 * Runs on every rebuild, which means on every run that lands. A board left over from an
 * earlier day is settled against its own day's runs before it is replaced, so a quest
 * finished with the app closed is still paid the next time it opens.
 */
export function syncBoard(stored: QuestState | null, ctx: BoardContext): QuestSync {
  const before = stored ? JSON.stringify(stored) : "";
  const state: QuestState = stored ? structuredClone(stored) : emptyQuestState();
  const paid: CompletedQuest[] = [];
  const xpBefore = state.totalXp;

  if (ctx.ranked) state.rankedSeen = true;
  const issuing: BoardContext = { ...ctx, ranked: ctx.ranked || state.rankedSeen };

  const cutoff = ctx.now.getTime() - MATCH_MEMORY_DAYS * DAY_MS;
  state.matches = state.matches.filter((m) => new Date(m.at).getTime() >= cutoff);

  // Whatever is on the board is settled first, against its own window.
  settle(state, ctx, paid);

  const today = dayKey(ctx.now);
  if (state.day !== today) {
    const { daily, reserve } = issueDaily(issuing, ctx.now, state.daily.map(subjectOf));
    state.day = today;
    state.daily = daily;
    state.reserve = reserve;
    state.rerolled = false;
    state.bonus = null;
    state.recent = daily.map(subjectOf);
  }

  const week = dayKey(startOfWeek(ctx.now));
  if (state.week !== week || !state.weekly) {
    const last = state.weekly?.kind ?? state.lastWeeklyKind;
    state.weekly = issueWeekly(issuing, ctx.now, last);
    state.week = week;
    state.lastWeeklyKind = state.weekly?.kind ?? last;
  }

  // And the fresh board measured, since today's runs may already have finished it.
  settle(state, ctx, paid);

  return {
    state,
    newlyCompleted: paid,
    xpAwarded: state.totalXp - xpBefore,
    changed: JSON.stringify(state) !== before,
  };
}

/**
 * Swap one daily quest for its slot's spare. Once a day, and never a finished quest:
 * rerolling a done quest would be a second payout with extra steps.
 */
export function rerollQuest(state: QuestState, id: string): { state: QuestState } | { error: string } {
  if (state.rerolled) return { error: "Today's reroll is already used." };
  const index = state.daily.findIndex((q) => q.id === id);
  if (index < 0) return { error: "That quest is not on today's board." };
  const current = state.daily[index];
  if (current.completedAt) return { error: "A finished quest cannot be rerolled." };
  const spare = state.reserve.find((q) => q.slot === current.slot);
  if (!spare) return { error: "There is nothing to swap it for today." };

  const next = structuredClone(state);
  next.daily[index] = { ...spare, since: current.since, until: current.until, progress: 0, completedAt: null };
  next.reserve = next.reserve.filter((q) => q.id !== spare.id);
  next.rerolled = true;
  next.recent = next.daily.map(subjectOf);
  return { state: next };
}

/** Remember a settled match, once. */
export function recordMatch(state: QuestState, match: MatchRecord): QuestState {
  if (state.matches.some((m) => m.id === match.id)) return state;
  return { ...state, matches: [...state.matches, match] };
}

// ---------------------------------------------------------------------------
// what the renderer sees
// ---------------------------------------------------------------------------

export interface QuestView {
  id: string;
  slot: QuestSlot;
  kind: QuestKind;
  title: string;
  detail: string;
  xp: number;
  target: number;
  unit: QuestUnit;
  /** Raw progress: a score for a score quest, a count for everything else. */
  progress: number;
  /** 0..1, for the bar. A score quest's bar starts where the player stood. */
  fraction: number;
  complete: boolean;
  /** The scenario to launch, when the quest names one. */
  scenario: string | null;
}

export interface BoardView {
  day: string;
  daily: QuestView[];
  weekly: QuestView | null;
  /** Local date the weekly closes on, inclusive. */
  weekEnds: string | null;
  canReroll: boolean;
  bonus: { xp: number; streak: number; earned: boolean };
}

function viewOf(q: IssuedQuest): QuestView {
  const complete = q.completedAt !== null;
  let fraction: number;
  if (complete) fraction = 1;
  else if (q.unit === "score") {
    const from = q.params.from ?? 0;
    fraction = q.progress <= 0 ? 0 : q.target > from ? (q.progress - from) / (q.target - from) : 0;
  } else fraction = q.progress / q.target;

  return {
    id: q.id,
    slot: q.slot,
    kind: q.kind,
    title: q.title,
    detail: q.detail,
    xp: q.xp,
    target: q.target,
    unit: q.unit,
    progress: q.unit === "score" ? round(q.progress) : Math.min(q.progress, q.target),
    fraction: Math.max(0, Math.min(1, fraction)),
    complete,
    scenario: q.params.scenario ?? null,
  };
}

export function boardView(state: QuestState, history: Map<string, ScenarioHistory>, now: Date): BoardView {
  const canReroll = !state.rerolled && state.daily.some(
    (q) => !q.completedAt && state.reserve.some((r) => r.slot === q.slot),
  );

  // What clearing the board would pay: today counts toward the streak once played, and
  // clearing it means playing.
  const streak = playStreak(history, now);
  const playedToday = [...history.values()].some((h) =>
    h.runs.some((r) => r.playedAt && dayKey(r.playedAt) === dayKey(now)),
  );
  const preview = playedToday ? streak : streak + 1;

  const weekEnds = state.weekly ? new Date(new Date(state.weekly.until).getTime() - 1) : null;

  return {
    day: state.day,
    daily: state.daily.map(viewOf),
    weekly: state.weekly ? viewOf(state.weekly) : null,
    weekEnds: weekEnds ? dayKey(weekEnds) : null,
    canReroll,
    bonus: state.bonus
      ? { xp: state.bonus.xp, streak: state.bonus.streak, earned: true }
      : { xp: bonusXp(preview), streak: preview, earned: false },
  };
}
