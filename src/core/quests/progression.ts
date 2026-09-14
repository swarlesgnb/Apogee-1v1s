/**
 * Account level from quest XP.
 *
 * One rule governs all of this: **quest XP never touches Apogee rating** (PLAN.md §10).
 * The moment grinding quests moves the ladder, the ladder stops measuring skill and
 * starts measuring time spent. XP buys levels and titles; nothing else.
 *
 * Completion and payment live in `board.ts`, next to the quests they pay for.
 */

/** Local calendar day, which is when a player experiences "today" rolling over. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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
