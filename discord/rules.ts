/**
 * Every number the community layer runs on, as pure functions.
 *
 * Nothing here touches Discord, the store or the network, so validateDiscord.ts can hold
 * each rule to its claim directly. None of it feeds back into Apogee: stardust and levels
 * are Discord-only and decide nothing about a rating.
 */

// ---------------------------------------------------------------------------
// XP and levels
// ---------------------------------------------------------------------------

/**
 * XP to go from `level` to `level + 1`.
 *
 * Quadratic so early levels arrive inside a first evening of chatting (level 5 is about
 * 60 messages at the chat cooldown) while level 50 is months of being around. 5n² + 50n + 100 is the curve
 * most Discord level bots settled on, so regulars already have a feel for its pace.
 */
export function xpToNext(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/** Total XP needed to reach `level` from zero. */
export function xpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpToNext(l);
  return total;
}

export function levelForXp(xp: number): number {
  let level = 0;
  let remaining = xp;
  while (remaining >= xpToNext(level)) {
    remaining -= xpToNext(level);
    level++;
  }
  return level;
}

/** Progress inside the current level, for a bar: [into, needed]. */
export function levelProgress(xp: number): [number, number] {
  const level = levelForXp(xp);
  return [xp - xpForLevel(level), xpToNext(level)];
}

/**
 * Level roles. Named for a launch rather than a ladder, so they can never be mistaken for
 * an Apogee rank: those names (Stargazer ... Supernova) belong to the season and mean a
 * standing earned in matches, which chatting must not imitate.
 */
export const LEVEL_ROLES: { level: number; name: string; color: string }[] = [
  { level: 1, name: "Launchpad", color: "#8a93a6" },
  { level: 5, name: "Liftoff", color: "#9fb3c8" },
  { level: 10, name: "Low Orbit", color: "#7fc8f8" },
  { level: 20, name: "Escape Velocity", color: "#b8a5ff" },
  { level: 35, name: "Deep Space", color: "#6f5bd6" },
  { level: 50, name: "Event Horizon", color: "#f2f2f2" },
];

export function levelRoleFor(level: number): string | null {
  let best: string | null = null;
  for (const r of LEVEL_ROLES) if (level >= r.level) best = r.name;
  return best;
}

/** Seconds between messages that earn anything. Stops spam from being a strategy. */
export const CHAT_COOLDOWN_S = 60;

export function chatXp(rand: () => number): number {
  return 15 + Math.floor(rand() * 11);
}

export function chatStardust(rand: () => number): number {
  return 2 + Math.floor(rand() * 4);
}

// ---------------------------------------------------------------------------
// Daily
// ---------------------------------------------------------------------------

/** UTC calendar day as an integer, so streak arithmetic is subtraction. */
export function dayNumber(at: Date): number {
  return Math.floor(at.getTime() / 86_400_000);
}

export interface DailyState {
  lastDay: number | null;
  streak: number;
  shields: number;
}

export interface DailyOutcome {
  ok: boolean;
  reward: number;
  streak: number;
  shields: number;
  /** A shield was spent to bridge a missed day. */
  shieldUsed: boolean;
  /** The streak was lost (missed day, no shield). */
  broke: boolean;
}

/**
 * Claim a daily. One per UTC day; consecutive days build a streak worth +15 each up to a
 * week, then it holds. A single missed day is forgiven by a Streak Shield from the shop;
 * two missed days break it regardless, so a shield is insurance, not immortality.
 */
export function claimDaily(state: DailyState, today: number): DailyOutcome {
  if (state.lastDay === today) {
    return { ok: false, reward: 0, streak: state.streak, shields: state.shields, shieldUsed: false, broke: false };
  }
  let streak = 1;
  let shields = state.shields;
  let shieldUsed = false;
  let broke = false;
  if (state.lastDay !== null) {
    const gap = today - state.lastDay;
    if (gap === 1) streak = state.streak + 1;
    else if (gap === 2 && shields > 0) {
      streak = state.streak + 1;
      shields--;
      shieldUsed = true;
    } else broke = state.streak > 1;
  }
  return { ok: true, reward: dailyReward(streak), streak, shields, shieldUsed, broke };
}

export function dailyReward(streak: number): number {
  return 100 + 15 * (Math.min(streak, 7) - 1);
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

/** Stardust for a settled Apogee match. Losing still pays: showing up is the habit. */
export const MATCH_STARDUST = { win: 40, draw: 15, loss: 5 } as const;

/** Win streaks that get their own shout in #match-feed. */
export const STREAK_CALLOUTS: Record<number, string> = {
  3: "is heating up",
  5: "is on fire",
  10: "is unstoppable",
};

export function nextWinStreak(current: number, result: "win" | "loss" | "draw"): number {
  if (result === "win") return current + 1;
  // A draw doesn't extend a streak but doesn't end one either.
  if (result === "draw") return current;
  return 0;
}

// ---------------------------------------------------------------------------
// Predictions
// ---------------------------------------------------------------------------

export const PREDICTION_STAKE = 50;
/** Betting closes this long after the card posts, before most matches can be decided. */
export const PREDICTION_WINDOW_MS = 15 * 60_000;

export interface Bet {
  user: string;
  side: "back" | "fade";
  stake: number;
}

/**
 * Parimutuel payout: the whole pot goes to the winning side, split by stake.
 *
 * Returns the amount credited to each user (stake included). A draw, or a pot with nobody
 * on the winning side, refunds every stake, so no stardust is ever created or destroyed
 * by a prediction: the sum of payouts always equals the pot.
 */
export function settlePot(bets: Bet[], winner: "back" | "fade" | "draw"): Map<string, number> {
  const out = new Map<string, number>();
  const pot = bets.reduce((s, b) => s + b.stake, 0);
  const winners = winner === "draw" ? [] : bets.filter((b) => b.side === winner);
  const winStake = winners.reduce((s, b) => s + b.stake, 0);
  if (winStake === 0) {
    for (const b of bets) out.set(b.user, (out.get(b.user) ?? 0) + b.stake);
    return out;
  }
  // Floor every share, then hand the remainder out one at a time from the largest stake,
  // so rounding never leaks a stardust.
  let paid = 0;
  const shares = winners.map((b) => {
    const amount = Math.floor((pot * b.stake) / winStake);
    paid += amount;
    return { b, amount };
  });
  let rest = pot - paid;
  shares.sort((x, y) => y.b.stake - x.b.stake || x.b.user.localeCompare(y.b.user));
  for (const s of shares) {
    if (rest <= 0) break;
    s.amount++;
    rest--;
  }
  for (const s of shares) out.set(s.b.user, (out.get(s.b.user) ?? 0) + s.amount);
  return out;
}

// ---------------------------------------------------------------------------
// Seeded picks
// ---------------------------------------------------------------------------

/** FNV-1a. Enough to spread a date string over a list; nothing here needs to be secret. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG from a seed, so a restart re-derives the same day's pick. */
export function seeded(seed: string): () => number {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(list: readonly T[], rand: () => number): T {
  return list[Math.floor(rand() * list.length)];
}

export function isoDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** Monday-start week number, so bounties roll over at the start of a weekend's run-up. */
export function weekNumber(at: Date): number {
  // Day 0 (1970-01-01) was a Thursday; shift so weeks start on Monday.
  return Math.floor((dayNumber(at) + 3) / 7);
}

export function weekStart(week: number): Date {
  return new Date((week * 7 - 3) * 86_400_000);
}

// ---------------------------------------------------------------------------
// Bounties
// ---------------------------------------------------------------------------

export type Bounty =
  | { kind: "win"; count: number; category: string | null; reward: number }
  | { kind: "play"; count: number; reward: number }
  | { kind: "reflex"; ms: number; reward: number }
  | { kind: "daily"; count: number; reward: number };

export function describeBounty(b: Bounty): string {
  switch (b.kind) {
    case "win":
      return `Win ${b.count} ranked match${b.count === 1 ? "" : "es"}${b.category ? ` in ${b.category}` : ""}`;
    case "play":
      return `Play ${b.count} ranked matches`;
    case "reflex":
      return `Hit a /reflex under ${b.ms} ms`;
    case "daily":
      return `Claim /daily on ${b.count} days`;
  }
}

/**
 * Three bounties for a week: always one ranked-play goal, one ranked-win goal and one
 * Discord-side goal, so a week is never all grind and never all chat.
 */
export function bountiesForWeek(week: number, categories: readonly string[]): Bounty[] {
  const rand = seeded(`bounties:${week}`);
  const play: Bounty = { kind: "play", count: pick([5, 8, 10], rand), reward: 250 };
  const cat = rand() < 0.6 ? pick(categories, rand) : null;
  const winCount = cat ? pick([2, 3], rand) : pick([3, 5], rand);
  const win: Bounty = { kind: "win", count: winCount, category: cat, reward: cat ? 350 : 300 };
  const side: Bounty =
    rand() < 0.5
      ? { kind: "reflex", ms: pick([260, 280, 300], rand), reward: 150 }
      : { kind: "daily", count: pick([4, 5], rand), reward: 200 };
  return [play, win, side];
}

// ---------------------------------------------------------------------------
// Link codes
// ---------------------------------------------------------------------------

/** No 0/O/1/I: the code is read off one screen and typed into another. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function linkCode(rand: () => number): string {
  let s = "APX-";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

/** Steam id from a bare id64 or a /profiles/ URL. Vanity URLs are resolved by the caller. */
export function parseSteamInput(input: string): { id64: string } | { vanity: string } | null {
  const s = input.trim();
  const bare = /^7656\d{13}$/.exec(s);
  if (bare) return { id64: s };
  const prof = /steamcommunity\.com\/profiles\/(7656\d{13})/i.exec(s);
  if (prof) return { id64: prof[1] };
  const vanity = /steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,32})/i.exec(s);
  if (vanity) return { vanity: vanity[1] };
  if (/^[A-Za-z0-9_-]{2,32}$/.test(s)) return { vanity: s };
  return null;
}

// ---------------------------------------------------------------------------
// Mini-games
// ---------------------------------------------------------------------------

/**
 * A reaction time only counts if it is humanly possible. Discord adds the round trip on
 * top of the click, so anything under 100 ms means the click left before the green did:
 * a pre-fire, scored as a false start.
 */
export const REFLEX_FLOOR_MS = 100;

export const FLICK_ROUNDS = 5;
export const FLICK_MISS_PENALTY_MS = 750;

export function flickScore(totalMs: number, misses: number): number {
  return totalMs + misses * FLICK_MISS_PENALTY_MS;
}

/** Stars a #clips post needs before it is reposted to #hall-of-fame. */
export const STAR_THRESHOLD = 5;
export const STAR_REWARD = 100;

/** Weekend Stardust Storm: chat and daily stardust ×1.5 on Saturday and Sunday (UTC). */
export function stormMultiplier(at: Date): number {
  const d = at.getUTCDay();
  return d === 0 || d === 6 ? 1.5 : 1;
}
