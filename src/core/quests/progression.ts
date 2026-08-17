/**
 * Quest completion, XP and account level.
 *
 * One rule governs all of this: **quest XP never touches Arena rating** (PLAN.md §10).
 * The moment grinding quests moves the ladder, the ladder stops measuring skill and
 * starts measuring time spent. XP buys levels and titles; nothing else.
 *
 * Completion is detected by comparing freshly-computed progress against what was
 * already recorded, rather than by watching for an event. Progress is derived from run
 * history, so it is always recoverable: if the app was closed when the run landed, the
 * quest still completes the next time it opens, and a crash cannot lose an award.
 */

export interface QuestSnapshot {
  id: string;
  kind: string;
  title: string;
  detail: string;
  progress: number;
  target: number;
  xp: number;
  subject?: string;
}

export interface CompletedQuest {
  id: string;
  kind: string;
  title: string;
  detail: string;
  xp: number;
  subject?: string;
  completedAt: string;
}

/** What is remembered between launches. Keyed by quest id, scoped to a day. */
export interface QuestProgressState {
  /** Local calendar day these quests belong to, so they reset at midnight. */
  day: string;
  /** Quest ids already completed today, with the XP that was awarded. */
  completed: Record<string, { xp: number; completedAt: string }>;
  /** Lifetime XP. */
  totalXp: number;
}

export function emptyState(day: string): QuestProgressState {
  return { day, completed: {}, totalXp: 0 };
}

/** Local calendar day, which is when a player experiences "today" rolling over. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isComplete(quest: QuestSnapshot): boolean {
  return quest.target > 0 && quest.progress >= quest.target;
}

export interface ReconcileResult {
  state: QuestProgressState;
  /** Quests that completed on this pass, and have not been announced before. */
  newlyCompleted: CompletedQuest[];
  xpAwarded: number;
  /** True when the day rolled over and the board reset. */
  dayRolled: boolean;
}

/**
 * Fold freshly-computed quest progress into the stored state.
 *
 * Awards are idempotent: a quest already recorded as complete today is never awarded
 * twice, however many times this runs. That matters because it runs on every run that
 * lands, and a rebuild triggered twice must not double-pay.
 */
export function reconcile(
  quests: QuestSnapshot[],
  stored: QuestProgressState,
  now: Date,
): ReconcileResult {
  const today = dayKey(now);
  const dayRolled = stored.day !== today;

  // A new day clears the board but keeps lifetime XP.
  const state: QuestProgressState = dayRolled
    ? { day: today, completed: {}, totalXp: stored.totalXp }
    : { ...stored, completed: { ...stored.completed } };

  const newlyCompleted: CompletedQuest[] = [];
  let xpAwarded = 0;

  for (const quest of quests) {
    if (!isComplete(quest)) continue;
    if (state.completed[quest.id]) continue;

    const completedAt = now.toISOString();
    state.completed[quest.id] = { xp: quest.xp, completedAt };
    state.totalXp += quest.xp;
    xpAwarded += quest.xp;

    newlyCompleted.push({
      id: quest.id,
      kind: quest.kind,
      title: quest.title,
      detail: quest.detail,
      xp: quest.xp,
      subject: quest.subject,
      completedAt,
    });
  }

  return { state, newlyCompleted, xpAwarded, dayRolled };
}

// ---------------------------------------------------------------------------
// account level
// ---------------------------------------------------------------------------

/**
 * XP required to reach a level, cumulative.
 *
 * The gap widens with each level so early progress is quick and later levels stay
 * worth something. A player finishing a couple of quests a day reaches level 5 in
 * about a fortnight, which is roughly how long it takes for the habit to matter.
 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  // 1000, 2250, 3750, 5500, 7500 ... a quadratic that stays readable.
  let total = 0;
  for (let l = 2; l <= level; l++) total += 750 + 250 * (l - 1);
  return total;
}

export interface LevelStanding {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  progress: number;
}

export function levelFor(xp: number): LevelStanding {
  let level = 1;
  while (xpForLevel(level + 1) <= xp && level < 200) level++;

  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const span = next - base;

  return {
    level,
    xp,
    xpIntoLevel: xp - base,
    xpForNextLevel: span,
    progress: span > 0 ? (xp - base) / span : 1,
  };
}
