/**
 * Apogee Daily: one seeded draw per day, the same three scenarios for everybody in a band.
 *
 * A daily puzzle in the shape of a match. Each day and each band has one draw of three
 * Season 1 scenarios, one per skill (Clicking, Tracking, Switching, in that order). The
 * player plays them in KovaaK's as normal, and the result is read from the stats folder
 * like everything else: the first run on each of the three inside the day counts, scored
 * as a delta over the player's own baseline (PLAN.md §3). It never moves rating.
 *
 * WHAT A DAY IS
 *
 * One fixed UTC day, from DAILY_RESET_UTC_HOUR to the same hour next day, not each
 * player's local calendar day. With local days, a player in UTC+14 starts tomorrow's
 * draw 26 hours before a player in UTC-12 finishes today's, so the draw is public for a
 * day before part of the board plays it, and "today's players" has no single meaning. A
 * fixed instant gives every player the same draw at the same moment, and the board one
 * day to rank. 08:00 UTC is 1am to 4am across North America and 9 to 10am in Europe,
 * the two regions this audience is mostly in, so the change of day lands while those
 * players are asleep or not yet playing. The cost is that it is a strange hour in Asia
 * and Oceania (5 to 6pm), and the app shows a countdown so nobody has to know the rule.
 *
 * THE SEED, AND WHAT IT DOES NOT HIDE
 *
 * The draw is a pure function of (season name, daily number, band), seeded through the
 * same `seededRandom` matches use, with the pool in a canonical order (by name, compared
 * by code unit, so Deno and Node sort it identically). The client draws offline and
 * signed out; the server draws the same three to check a board entry. Anything the client
 * can draw today it can draw for tomorrow, and the source is public under the AGPL, so a
 * determined reader can compute any future draw. No secret is kept, because no secret
 * kept from an offline client is a secret. What is held instead:
 *
 *   - the app never computes or shows a draw before its day has begun (`dailyFor` takes
 *     the clock, never a number), and the server refuses a board read or entry for a
 *     day that has not started;
 *   - a board entry is the first run on each scenario played *inside* the day, so
 *     practising tomorrow's three today earns nothing on tomorrow's board directly;
 *   - practice before the day raises the baseline the day is measured against (it is
 *     built from runs before the day began), so advance practice partly cancels itself.
 *
 * Nothing here is rated, and the board is a percentile among the day's players in a band.
 * Previewing the draw is worth what warming up on three scenarios is worth.
 *
 * Pure: no node:fs, no clock read. The Edge Functions import it, as they import
 * src/core/ghost, and validateDaily.ts drives both paths.
 */

import { baselineFromScores, MIN_RUNS_FOR_BASELINE } from "../history/baseline.ts";
import { seededRandom } from "../match/scenarioSelection.ts";

// ---------------------------------------------------------------------------
// the day
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
/** The hour, UTC, at which one daily ends and the next begins. See the header. */
export const DAILY_RESET_UTC_HOUR = 8;
/** Daily #1 begins here. Every number is counted from this instant. */
export const DAILY_EPOCH_MS = Date.UTC(2026, 9, 1, DAILY_RESET_UTC_HOUR);
export const DAILY_ROUNDS = 3;

/** The daily that is live at `instant` (epoch ms). 0 before Daily #1 began. */
export function dailyNumberAt(instant: number): number {
  if (!Number.isFinite(instant) || instant < DAILY_EPOCH_MS) return 0;
  return Math.floor((instant - DAILY_EPOCH_MS) / DAY_MS) + 1;
}

/** Daily #n runs over [start, end), both epoch ms. */
export function dailyWindow(n: number): { start: number; end: number } {
  const start = DAILY_EPOCH_MS + (n - 1) * DAY_MS;
  return { start, end: start + DAY_MS };
}

export function isDailyNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 99_999;
}

// ---------------------------------------------------------------------------
// bands
// ---------------------------------------------------------------------------

/**
 * Link and URL spelling of each band. The display names live in the season; these are
 * fixed so a link written today still opens the same band after a rename.
 */
export const BAND_SLUGS = ["novice", "intermediate", "advanced", "expert"] as const;
export type BandSlug = (typeof BAND_SLUGS)[number];

export function bandIndex(slug: string): number | null {
  const i = (BAND_SLUGS as readonly string[]).indexOf(slug);
  return i >= 0 ? i : null;
}

// ---------------------------------------------------------------------------
// the draw
// ---------------------------------------------------------------------------

export const SKILLS = ["Clicking", "Tracking", "Switching"] as const;
export type Skill = (typeof SKILLS)[number];

/** One scenario of the season's pool, as either side has it. */
export interface DailyPoolEntry {
  name: string;
  /** The season's category ("Static Clicking"); its last word names the skill. */
  category: string;
  window: number;
}

/** The skill a season category belongs to, or null for a name that does not end in one. */
export function skillOf(category: string | null | undefined): Skill | null {
  const last = String(category ?? "").trim().split(/\s+/).pop() ?? "";
  return (SKILLS as readonly string[]).includes(last) ? (last as Skill) : null;
}

/** By code unit, never by locale, so two runtimes order the same names the same way. */
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function dailySeed(seasonName: string, n: number, windowIndex: number): string {
  return `apogee-daily:v1:${seasonName}:${n}:${windowIndex}`;
}

export interface DailyDraw {
  number: number;
  window: number;
  /** One per skill, Clicking then Tracking then Switching. */
  scenarios: string[];
  skills: (Skill | null)[];
}

/**
 * The day's three for one band.
 *
 * One scenario per skill, in skill order, so the share grid reads the same way every day
 * (first glyph Clicking, then Tracking, then Switching) without naming a scenario. A
 * skill with nothing in the band is filled from what is left, uniformly. Null when the
 * band holds fewer than three distinct scenarios, which no shipped season does.
 */
export function drawDaily(pool: DailyPoolEntry[], seasonName: string, n: number, windowIndex: number): DailyDraw | null {
  if (!isDailyNumber(n)) return null;
  const inBand = [...new Map(pool.filter((p) => p.window === windowIndex).map((p) => [p.name, p])).values()]
    .sort((a, b) => byName(a.name, b.name));
  if (inBand.length < DAILY_ROUNDS) return null;

  const random = seededRandom(dailySeed(seasonName, n, windowIndex));
  const taken = new Set<string>();
  const picks: { name: string; skill: Skill | null }[] = [];
  for (const skill of SKILLS) {
    const group = inBand.filter((p) => skillOf(p.category) === skill);
    // Always draw, even from an empty group, so one skill missing from a band does not
    // shift the stream the other two are drawn from.
    const r = random();
    if (group.length === 0) continue;
    const pick = group[Math.floor(r * group.length)];
    picks.push({ name: pick.name, skill });
    taken.add(pick.name);
  }
  while (picks.length < DAILY_ROUNDS) {
    const rest = inBand.filter((p) => !taken.has(p.name));
    const pick = rest[Math.floor(random() * rest.length)];
    picks.push({ name: pick.name, skill: skillOf(pick.category) });
    taken.add(pick.name);
  }
  return { number: n, window: windowIndex, scenarios: picks.map((p) => p.name), skills: picks.map((p) => p.skill) };
}

/** The live daily, from the clock and nothing else: no caller can ask for a future one. */
export function dailyFor(pool: DailyPoolEntry[], seasonName: string, now: number, windowIndex: number): DailyDraw | null {
  return drawDaily(pool, seasonName, dailyNumberAt(now), windowIndex);
}

// ---------------------------------------------------------------------------
// the result
// ---------------------------------------------------------------------------

/**
 * Inside this, either way, a round reads as "near" its baseline.
 *
 * One percent. The baseline is a median (PLAN.md §3), measured to centre genuine runs at
 * +0.4% with 58% above, so a typical run is a few percent either side; a narrower band
 * would make "near" almost never happen and a wider one would swallow ordinary good and
 * bad days. The settle draw epsilon (0.05%) is about ties, not about this.
 */
export const NEAR_BAND = 0.01;

export type Glyph = "above" | "near" | "below" | "first" | "pending";

/**
 * The share grid's characters. Shapes, not colours, so the grid survives a colour-blind
 * reader, a plain-text channel and a monospace font alike. All four are in Unicode's
 * Geometric Shapes block, which every platform font covers.
 */
export const GLYPH_CHAR: Record<Glyph, string> = {
  above: "▲",
  near: "◆",
  below: "▼",
  first: "○",
  pending: "·",
};

export const GLYPH_WORD: Record<Glyph, string> = {
  above: "Above baseline",
  near: "Near baseline",
  below: "Below baseline",
  first: "First run: sets your baseline",
  pending: "Not played yet",
};

export interface DailyRound {
  scenario: string;
  skill: Skill | null;
  /** The first run inside the day, or null while unplayed. */
  score: number | null;
  playedAt: number | null;
  /** Runs before the day began. Below MIN_RUNS_FOR_BASELINE the baseline is provisional. */
  priorRuns: number;
  /** Null when there was no run before the day: the run stands as its own baseline. */
  baseline: number | null;
  delta: number | null;
  provisional: boolean;
  glyph: Glyph;
}

export interface DailyResult {
  number: number;
  window: number;
  scenarios: string[];
  rounds: DailyRound[];
  complete: boolean;
  /** Mean delta over rounds that had a baseline. Null until complete, or with none. */
  meanDelta: number | null;
  /**
   * A measured round leaned on fewer than MIN_RUNS_FOR_BASELINE earlier runs. A first run
   * is not counted here: it has no baseline at all, and its own glyph says so.
   */
  provisional: boolean;
}

export interface DailyHistory {
  runs: { score: number; playedAt: Date | null }[];
}

export function glyphFor(delta: number | null, priorRuns: number, played: boolean): Glyph {
  if (!played) return "pending";
  if (priorRuns === 0 || delta === null) return "first";
  if (delta > NEAR_BAND) return "above";
  if (delta < -NEAR_BAND) return "below";
  return "near";
}

/**
 * One round from the scores before the day and the first score inside it.
 *
 * The baseline rule is ranked's, as settle-match applies it (PLAN.md §3, "New players
 * and unplayed scenarios"): the median of the last 50 earlier runs, provisional under
 * five, and with no earlier run at all the run stands as its own baseline for a
 * provisional 0%. That last case is the common one on Season 1, whose scenarios exist
 * only in Apogee, so it is drawn as its own glyph ("first") rather than as a "near" that
 * claims a comparison nobody made. PB floor: none here, as in Ghost Mode, since verified
 * PBs live on the server; the board's figures carry it.
 */
export function scoreRound(
  scenario: string,
  skill: Skill | null,
  before: number[],
  first: { score: number; at: number } | null,
  pbFloor?: number | null,
): DailyRound {
  const priorRuns = before.length;
  const baseline = priorRuns > 0 ? baselineFromScores(scenario, before, pbFloor ?? null).value : null;
  const usable = baseline !== null && baseline > 0;
  const delta = first && usable ? (first.score - (baseline as number)) / (baseline as number) : null;
  return {
    scenario,
    skill,
    score: first?.score ?? null,
    playedAt: first?.at ?? null,
    priorRuns,
    baseline: usable ? baseline : null,
    delta,
    provisional: priorRuns < MIN_RUNS_FOR_BASELINE,
    glyph: glyphFor(delta, usable ? priorRuns : 0, first !== null),
  };
}

export function summarise(n: number, windowIndex: number, scenarios: string[], rounds: DailyRound[]): DailyResult {
  const complete = rounds.length === DAILY_ROUNDS && rounds.every((r) => r.score !== null);
  const measured = rounds.filter((r) => r.delta !== null);
  return {
    number: n,
    window: windowIndex,
    scenarios,
    rounds,
    complete,
    meanDelta: complete && measured.length > 0 ? measured.reduce((s, r) => s + (r.delta as number), 0) / measured.length : null,
    provisional: measured.some((r) => r.provisional),
  };
}

/**
 * The day so far from the player's own history: for each of the three, the first run
 * that ended inside the day and the baseline from every run that ended before it began.
 * A run's moment is the end its filename records (`playedAt`), on both sides.
 */
export function evaluateDaily(history: Map<string, DailyHistory>, draw: DailyDraw): DailyResult {
  const { start, end } = dailyWindow(draw.number);
  const rounds = draw.scenarios.map((scenario, i) => {
    const runs = (history.get(scenario)?.runs ?? []).filter((r) => r.playedAt && Number.isFinite(r.score));
    const before = runs.filter((r) => (r.playedAt as Date).getTime() < start).map((r) => r.score);
    const inside = runs
      .filter((r) => {
        const t = (r.playedAt as Date).getTime();
        return t >= start && t < end;
      })
      .sort((a, b) => (a.playedAt as Date).getTime() - (b.playedAt as Date).getTime());
    const first = inside[0] ? { score: inside[0].score, at: (inside[0].playedAt as Date).getTime() } : null;
    return scoreRound(scenario, draw.skills[i] ?? null, before, first);
  });
  return summarise(draw.number, draw.window, draw.scenarios, rounds);
}

// ---------------------------------------------------------------------------
// the streak
// ---------------------------------------------------------------------------

/** How far back a streak is followed. A year of dailies, and a bound on the loop. */
export const STREAK_HORIZON = 400;

/**
 * Consecutive dailies played, in any band, ending today or yesterday.
 *
 * Counted in daily numbers, never in local calendar days, so a time zone, a flight or a
 * daylight-saving change cannot break one or pad one: every player's day changes at the
 * same instant. A streak whose last daily is yesterday is still alive (today is not over),
 * and one whose last daily is older is 0. `played(n)` says whether daily n was completed.
 */
export function dailyStreak(played: (n: number) => boolean, today: number): number {
  if (today < 1) return 0;
  let n = played(today) ? today : played(today - 1) ? today - 1 : 0;
  let count = 0;
  while (n >= 1 && count < STREAK_HORIZON && played(n)) {
    count++;
    n--;
  }
  return count;
}

/**
 * Which dailies a history completed, in any band: the days on which all three of some
 * band's draw have a run inside the day. Built once per history, so the streak walk is a
 * set lookup per band per day rather than a scan of every run.
 */
export function playedDailies(
  history: Map<string, DailyHistory>,
  pool: DailyPoolEntry[],
  seasonName: string,
  today: number,
  windows: number,
): (n: number) => boolean {
  const poolNames = new Set(pool.map((p) => p.name));
  const seen = new Set<string>();
  for (const [name, h] of history) {
    if (!poolNames.has(name)) continue;
    for (const r of h.runs) {
      if (!r.playedAt) continue;
      const n = dailyNumberAt(r.playedAt.getTime());
      if (n >= 1 && n <= today) seen.add(`${n}|${name}`);
    }
  }
  const memo = new Map<number, boolean>();
  return (n: number) => {
    if (n < 1 || n > today) return false;
    const known = memo.get(n);
    if (known !== undefined) return known;
    let done = false;
    for (let w = 0; w < windows && !done; w++) {
      const draw = drawDaily(pool, seasonName, n, w);
      done = !!draw && draw.scenarios.every((s) => seen.has(`${n}|${s}`));
    }
    memo.set(n, done);
    return done;
  };
}

// ---------------------------------------------------------------------------
// the share text
// ---------------------------------------------------------------------------

/** A signed percentage with one decimal; a true zero is "0.0%", never "+0.0%". */
export function signedPercent(d: number): string {
  const pct = d * 100;
  if (Math.abs(pct) < 0.05) return "0.0%";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
}

export interface ShareTextInput {
  result: DailyResult;
  bandName: string;
  streak: number;
  /** The https landing for this daily (deepLinks.ts `landingUrl`). */
  link: string;
}

/**
 * What a player pastes: the number, the band, one glyph per scenario, the mean delta, the
 * streak, and a link that opens the same daily. No scenario name, family or score, so
 * the post spoils nothing for somebody who has not played yet. validate:daily holds every
 * text it builds to that against the whole pool.
 */
export function shareText(input: ShareTextInput): string | null {
  const { result, bandName, streak, link } = input;
  if (!result.complete) return null;
  const grid = result.rounds.map((r) => GLYPH_CHAR[r.glyph]).join(" ");
  const figure = result.meanDelta === null ? "baselines set" : signedPercent(result.meanDelta);
  const notes = [streak > 1 ? `Streak ${streak}` : null, result.provisional ? "provisional baselines" : null].filter(Boolean);
  return [
    `Apogee Daily #${result.number} · ${bandName}`,
    `${grid}  ${figure}`,
    ...(notes.length ? [notes.join(" · ")] : []),
    link,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// the board (server side)
// ---------------------------------------------------------------------------

/** One letter per round in daily_results.glyphs (the migration's check holds the alphabet). */
export const GLYPH_LETTER: Record<Exclude<Glyph, "pending">, string> = { above: "A", near: "N", below: "B", first: "F" };
const LETTER_GLYPH: Record<string, Glyph> = { A: "above", N: "near", B: "below", F: "first" };

export function glyphLetters(rounds: DailyRound[]): string | null {
  if (rounds.length !== DAILY_ROUNDS || rounds.some((r) => r.glyph === "pending")) return null;
  return rounds.map((r) => GLYPH_LETTER[r.glyph as Exclude<Glyph, "pending">]).join("");
}

export function glyphsFromLetters(letters: string): Glyph[] {
  return [...letters].map((c) => LETTER_GLYPH[c] ?? "pending");
}

export interface BoardRow {
  player_id: string;
  mean_delta: number | string | null;
  glyphs: string;
  provisional: boolean;
}

export interface DailyBoard {
  dailyNumber: number;
  window: number;
  band: string;
  /** Everyone with an entry today in this band. */
  players: number;
  /** Entries with a mean delta, which the percentile is taken over. */
  ranked: number;
  /** p25, p50, p75 of the mean delta among ranked entries, once there are four of them. */
  quartiles: [number, number, number] | null;
  you: {
    meanDelta: number | null;
    glyphs: Glyph[];
    provisional: boolean;
    /** Share of the other ranked entries below yours, ties counted half. Null alone or unranked. */
    percentile: number | null;
    /** 1 for the best mean delta today; null when unranked. */
    rank: number | null;
  } | null;
  /** Consecutive dailies with an entry on the server, ending today or yesterday. */
  streak: number;
}

/** Everything except the rows' owners: a board never names another player. */
export function boardFromRows(
  rows: BoardRow[],
  callerId: string,
  meta: { dailyNumber: number; window: number; band: string; streak: number },
): DailyBoard {
  const figures = rows
    .map((r) => (r.mean_delta === null ? null : Number(r.mean_delta)))
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  const q = (p: number) => figures[Math.min(figures.length - 1, Math.floor(p * figures.length))];
  const mine = rows.find((r) => r.player_id === callerId) ?? null;
  let you: DailyBoard["you"] = null;
  if (mine) {
    const m = mine.mean_delta === null ? null : Number(mine.mean_delta);
    const ranked = m !== null && Number.isFinite(m);
    const others = ranked ? figures.length - 1 : 0;
    const below = ranked ? figures.filter((v) => v < (m as number)).length : 0;
    const tied = ranked ? figures.filter((v) => v === m).length - 1 : 0;
    you = {
      meanDelta: ranked ? m : null,
      glyphs: glyphsFromLetters(mine.glyphs),
      provisional: !!mine.provisional,
      percentile: ranked && others > 0 ? Math.round((1000 * (below + tied / 2)) / others) / 10 : null,
      rank: ranked ? figures.filter((v) => v > (m as number)).length + 1 : null,
    };
  }
  return {
    dailyNumber: meta.dailyNumber,
    window: meta.window,
    band: meta.band,
    players: rows.length,
    ranked: figures.length,
    quartiles: figures.length >= 4 ? [q(0.25), q(0.5), q(0.75)] : null,
    you,
    streak: meta.streak,
  };
}
