/**
 * Ghost Mode: a ranked-format match against the player's own past runs.
 *
 * The ladder needs a second player and, at launch, there is not one (PLAN.md §15). A ghost
 * match needs nobody: three scenarios from the player's own KovaaK's library, each raced
 * against a score frozen from an earlier session of theirs, scored the way a ranked match
 * is. It moves a quest and a streak and never a rating (docs/design/mechanics.md).
 *
 * Why the library and not the season pool: the pool is Apogee's own scenarios, which
 * nobody outside the project has played, so a pool-only ghost has nothing to be built
 * from. `validateGhost.ts` re-derives that on every run rather than trusting it.
 *
 * Pure: no `node:fs`, no clock of its own. Every function takes `now` or a timestamp, so
 * the Edge Function can import it the way `refresh-baselines` imports baseline.ts, and
 * the validator can replay two hundred past days through the same code the app runs.
 *
 * Time. Everything local is a Date built from a KovaaK's filename by `new Date(y, m, ...)`
 * on the player's own machine, which is the correct instant there, and a "session" is
 * one local calendar day read with the local getters. The server is different: its
 * runtime is UTC, so it shifts each stored instant by the player's offset before calling
 * in here (see supabase/functions/post-ghost).
 */

import { baselineFromScores, MIN_RUNS_FOR_BASELINE } from "../history/baseline.ts";
import { seededRandom } from "../match/scenarioSelection.ts";
import { settleMatch, type MatchVerdict, type RoundSubmission } from "../match/settle.ts";
import { dayKey } from "../quests/progression.ts";

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export type GhostKind = "month_ago" | "last_week" | "last_week_best";

export const GHOST_KINDS: readonly GhostKind[] = ["month_ago", "last_week", "last_week_best"];

export function isGhostKind(value: unknown): value is GhostKind {
  return typeof value === "string" && (GHOST_KINDS as readonly string[]).includes(value);
}

/**
 * What a match is raced against: one of the player's own past selves, or a friend's three
 * live runs fetched by code (links.ts). A separate kind rather than a flag, so every place
 * that reads a `GhostKind` off a match (the redraw, the share post, the chooser) has to say
 * what it does with a friend's ghost instead of silently treating it as last week's.
 */
export type MatchKind = GhostKind | "friend";

export function isMatchKind(value: unknown): value is MatchKind {
  return value === "friend" || isGhostKind(value);
}

/** Structurally a `ScenarioHistory`, minus what this module does not read. */
export interface GhostHistory {
  scenario: string;
  /** Oldest first is how history.ts stores them; nothing here relies on it. */
  runs: { score: number; playedAt: Date | null }[];
}

/** A run that landed during a match, as main hands it over. */
export interface IncomingRun {
  scenario: string;
  score: number;
  /** When the run ended: the filename's wall clock, as an epoch on this machine. */
  at: number;
  /**
   * Seconds of play, `runDurationSeconds` over one parse: the start and the end have to
   * be read in the same frame (docs/apogee-internals.html, on timestamps). Null when it
   * cannot be derived.
   */
  durationSeconds: number | null;
  /** `isAbandonedRun` over that duration and the scenario's known length. */
  abandoned: boolean;
}

export interface LiveRun {
  score: number;
  at: number;
  abandoned: boolean;
}

export interface GhostRound {
  scenario: string;
  /** The score to beat, frozen when the match was drawn. */
  ghost: number;
  /** Local calendar day of the session the ghost came from, YYYY-MM-DD. */
  sessionDay: string;
  /** Runs in that session, so "median of 1" can be told from "median of 20". */
  sessionRuns: number;
  /** Both sides are measured against this, frozen with the ghost. */
  baseline: number;
  /** Best score before the match: context on the result, never the thing to beat. */
  pb: number;
  live: LiveRun | null;
  /**
   * The ghost side's own baseline, when it is not the player's. Absent on a match against
   * the player's past self, where both sides share `baseline`. On a friend's ghost it is
   * the friend's baseline at the time they played, so each side is measured against its
   * own, as in ranked (PLAN.md §3).
   */
  ghostBaseline?: number;
  /**
   * False when the player has no baseline of their own on this scenario (fewer than
   * MIN_RUNS_FOR_BASELINE runs before the freeze). Only a friend's ghost can produce one:
   * a past-self match is drawn from scenarios that have a baseline. Such a round is
   * played, shown, and left out of the verdict; `baseline` is 0 on it. Absent means true.
   */
  measured?: boolean;
}

/** The baseline the ghost side is measured against. */
export function ghostBaselineOf(round: Pick<GhostRound, "baseline" | "ghostBaseline">): number {
  return round.ghostBaseline ?? round.baseline;
}

export function isMeasured(round: Pick<GhostRound, "measured">): boolean {
  return round.measured !== false;
}

export type GhostEnd = "complete" | "abandoned" | "expired";

export interface GhostResultRound {
  scenario: string;
  live: number | null;
  ghost: number;
  baseline: number;
  pb: number;
  sessionDay: string;
  /** (live - baseline) / baseline, null for a round not played or not counted. */
  delta: number | null;
  /** (ghost - ghostBaseline) / ghostBaseline: the ghost side against its own baseline. */
  ghostDelta: number;
  /** delta - ghostDelta: the round's verdict in one number. (live - ghost) / baseline on a past self. */
  gap: number | null;
  abandoned: boolean;
  /** The ghost side's baseline; equal to `baseline` against a past self. */
  ghostBaseline: number;
  /** False on a round the player has no baseline on; it is shown and not scored. */
  measured: boolean;
}

export interface GhostResult {
  /** 'void' only when every round landed and settleMatch voided it (an abandoned run). */
  verdict: MatchVerdict;
  end: GhostEnd;
  /** Mean of the counted gaps. Null when nothing counted. */
  margin: number | null;
  rounds: GhostResultRound[];
  /** When it ended, epoch ms. */
  at: number;
  /** A sentence for the result screen, in the player's terms. */
  explanation: string;
}

export interface GhostMatch {
  /** `${day}:${kind}:${ordinal}`: the seed, and a stable id for the quest board. */
  id: string;
  kind: MatchKind;
  /** Set on a friend's ghost: the code it was fetched by and the name it races under. */
  link?: { code: string; sender: string };
  /** Local day the draw was made on. */
  day: string;
  ordinal: number;
  drawnAt: number;
  startedAt: number | null;
  /** Epoch ms after which no run is taken. Null until Start. */
  deadline: number | null;
  rounds: GhostRound[];
  result: GhostResult | null;
}

export type RunRefusal =
  | "not-started"
  | "finished"
  | "unrelated"
  | "before-start"
  | "already-counted"
  | "late";

export type ApplyOutcome =
  | { accepted: true; match: GhostMatch; round: number }
  | { accepted: false; match: GhostMatch; reason: RunRefusal };

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

/**
 * The ranked clock, copied rather than imported: `supabase/functions/_shared/apogee.ts`
 * holds `IDLE_ALLOWANCE_MS` (3 min) and `INITIAL_TTL_MS` (idle + 5 min launch allowance),
 * and that module imports Deno-only specifiers the client cannot load. The mode exists to
 * rehearse the ranked format, so if those change these change with them; a lenient clock
 * here would rehearse the wrong thing.
 */
export const GHOST_IDLE_ALLOWANCE_MS = 3 * 60_000;
export const GHOST_START_ALLOWANCE_MS = GHOST_IDLE_ALLOWANCE_MS + 5 * 60_000;

/**
 * After the deadline, how long a run already under way may take to land.
 *
 * `WINDOW_END_GRACE_MS` in submit-run, for the same reason: a filename carries when a run
 * *ended*, so a 60-second scenario begun ten seconds before the deadline lands fifty
 * after it. Ranked's rule is that the last run must be started in time, and so is this.
 */
export const GHOST_END_GRACE_MS = 90_000;

/**
 * How far a run's derived start may sit before Start and still count.
 *
 * The derived start is the filename's end (whole seconds) minus a duration built from
 * `Challenge Start:` (milliseconds) against that same whole-second end, so it can read up
 * to a second early for a run begun exactly on the click. Two seconds covers that and
 * nothing a player could use: nobody finishes a scenario in the two seconds before Start.
 */
export const GHOST_START_SLACK_MS = 2_000;

/** Draws prefer scenarios the player still plays: touched within this many days. */
export const GHOST_RECENT_DAYS = 90;

/** Scenarios in a match. The ranked format's three (PLAN.md §3). */
export const GHOST_ROUNDS = 3;

/**
 * Rounds a friend's-ghost match needs the player to have a baseline on before it can have
 * a result. Two of three is a majority of the ranked format; one would decide a match on
 * a single run against a single run, the variance §3's three scenarios exist to average
 * out. A raw-score comparison on the unmeasured rounds is not a fallback: §3 threw raw
 * scores out as the thing two players are compared on.
 */
export const MIN_MEASURED_ROUNDS = 2;

const KINDS: Record<GhostKind, { daysBack: number; pick: "median" | "best" }> = {
  month_ago: { daysBack: 30, pick: "median" },
  last_week: { daysBack: 7, pick: "median" },
  last_week_best: { daysBack: 7, pick: "best" },
};

/**
 * How often the live side won when each kind was replayed over the 14,150-run corpus
 * (`npm run validate:ghost`, which fails if a replay drifts more than five points from
 * these or lands on a different "N in 10"). The live side there was the *first* run of a
 * day, colder than a run played on purpose after Start.
 *
 * What these are replayed on is narrower than what the app draws from. A live side only
 * exists where the player played that day, so each day's three are drawn from the
 * scenarios touched that day, which skews toward what the player was practising. The app
 * draws from every eligible scenario in the library, recently played first, and that draw
 * cannot be replayed whole: on its real draws only 11-18% of rounds had a live run that
 * day. Over those rounds the live side won 60.0%, 55.7% and 48.7% of rounds for the three
 * kinds (validate:ghost prints both), the same order and a similar spread, but a
 * different quantity from the match rates here, and nothing guarantees the app's rates
 * equal these.
 *
 * The design quoted 55.3% and 47.6% for the two week-old kinds from a one-off script that
 * shuffled with its own generator; replayed through the app's seeded draw and settleMatch
 * (draws are not wins) they come out as below, and these are the ones the app runs.
 */
export const MEASURED_WIN_RATE: Record<GhostKind, number> = {
  month_ago: 0.746,
  last_week: 0.583,
  last_week_best: 0.49,
};

/**
 * The chooser's "about N in 10".
 *
 * Tenths rather than the quarters first drafted: in quarters the default and the hard
 * ghost both round to "2 in 4", and a chooser that says the same thing about both has not
 * told the player which one is harder.
 */
export function inTen(rate: number): number {
  return Math.round(rate * 10);
}

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

export function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local midnight `n` calendar days before `date`'s. Calendar arithmetic, so DST cannot shift it. */
export function daysBefore(date: Date, n: number): Date {
  const d = startOfLocalDay(date);
  d.setDate(d.getDate() - n);
  return d;
}

// ---------------------------------------------------------------------------
// the ghost
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface GhostScore {
  score: number;
  sessionDay: string;
  sessionRuns: number;
}

/**
 * The past self for one scenario: the median (or best) of the runs on the most recent
 * local day that ended at least `daysBack` whole days before `start`'s day began.
 *
 * A session is one local calendar day. "Last week" is therefore the last day played
 * before the same weekday a week ago, which is the definition the chooser's win rates
 * were measured on.
 */
export function ghostScore(
  runs: { score: number; playedAt: Date | null }[],
  start: Date,
  kind: GhostKind,
): GhostScore | null {
  const { daysBack, pick } = KINDS[kind];
  const cutoff = daysBefore(start, daysBack).getTime();

  let latest: Date | null = null;
  for (const r of runs) {
    if (!r.playedAt || !Number.isFinite(r.score)) continue;
    const t = r.playedAt.getTime();
    if (t < cutoff && (!latest || t > latest.getTime())) latest = r.playedAt;
  }
  if (!latest) return null;

  const day = dayKey(latest);
  const session = runs
    .filter((r) => r.playedAt && r.playedAt.getTime() < cutoff && dayKey(r.playedAt) === day && Number.isFinite(r.score))
    .map((r) => r.score);
  if (session.length === 0) return null;

  return {
    score: pick === "best" ? Math.max(...session) : median(session),
    sessionDay: day,
    sessionRuns: session.length,
  };
}

export interface GhostCandidate extends Omit<GhostRound, "live"> {
  /** Last run before the draw, epoch ms, for the recent-first preference. */
  lastPlayed: number;
}

/** Any "past self" definition, so the validator can replay the rejected ones through the same path. */
export type GhostDefinition = (
  runs: { score: number; playedAt: Date | null }[],
  start: Date,
) => GhostScore | null;

export function definitionOf(kind: GhostKind): GhostDefinition {
  return (runs, start) => ghostScore(runs, start, kind);
}

/**
 * Every scenario a match could be drawn from at `start`, each with its ghost and baseline
 * frozen.
 *
 * Eligible means `MIN_RUNS_FOR_BASELINE` runs before `start`, a positive baseline (a
 * scenario scored at or below zero has no delta to take), and a ghost session for the
 * kind. The baseline is `baselineFromScores` over runs before `start` with no PB floor:
 * the verified PB lives on the server, and against a ghost both sides share the baseline,
 * so the floor would move both by the same amount and change no verdict.
 *
 * Sorted by name, because Map order is readdir order and the seeded draw has to see the
 * same list on every machine.
 */
export function ghostCandidatesBy(
  history: Map<string, GhostHistory>,
  start: Date,
  define: GhostDefinition,
): GhostCandidate[] {
  const t = start.getTime();
  const out: GhostCandidate[] = [];

  for (const [name, h] of history) {
    const before = h.runs.filter((r) => r.playedAt && r.playedAt.getTime() < t && Number.isFinite(r.score));
    if (before.length < MIN_RUNS_FOR_BASELINE) continue;

    const baseline = baselineFromScores(name, before.map((r) => r.score)).value;
    if (!(baseline > 0)) continue;

    const ghost = define(before, start);
    if (!ghost) continue;

    out.push({
      scenario: name,
      ghost: ghost.score,
      sessionDay: ghost.sessionDay,
      sessionRuns: ghost.sessionRuns,
      baseline,
      pb: Math.max(...before.map((r) => r.score)),
      lastPlayed: Math.max(...before.map((r) => r.playedAt!.getTime())),
    });
  }

  return out.sort((a, b) => (a.scenario < b.scenario ? -1 : a.scenario > b.scenario ? 1 : 0));
}

export function ghostCandidates(history: Map<string, GhostHistory>, start: Date, kind: GhostKind): GhostCandidate[] {
  return ghostCandidatesBy(history, start, definitionOf(kind));
}

/** Fisher-Yates over a seeded stream, so the draw is reproducible. */
function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function drawSeed(day: string, kind: string, ordinal: number): string {
  return `${day}:${kind}:${ordinal}`;
}

/**
 * Three of the candidates, recently played first.
 *
 * Two buckets shuffled from one stream and concatenated, the shape `selectScenarios` uses
 * for fresh and stale: a player with three scenarios touched in the last 90 days races
 * those, and one with fewer still gets a match from the rest rather than none.
 */
export function pickRounds(candidates: GhostCandidate[], at: Date, seed: string): GhostCandidate[] {
  if (candidates.length < GHOST_ROUNDS) return [];
  const random = seededRandom(seed);
  const recentFrom = daysBefore(at, GHOST_RECENT_DAYS).getTime();
  const recent = shuffle(candidates.filter((c) => c.lastPlayed >= recentFrom), random);
  const rest = shuffle(candidates.filter((c) => c.lastPlayed < recentFrom), random);
  return [...recent, ...rest].slice(0, GHOST_ROUNDS);
}

/**
 * Draw a match.
 *
 * Everything is frozen as of local midnight on the draw's day, not the moment of the
 * click: the eligible scenarios, each ghost and each baseline. That makes a draw a pure
 * function of (history before today, day, kind, ordinal), so restarting the app, warming
 * up first, or discarding an unstarted draw all bring back the same three, and a run
 * played during the match cannot move the bar it is measured against. It is also the
 * frame the win rates in MEASURED_WIN_RATE were replayed in.
 *
 * `ordinal` counts matches *started* today, so the only way to a different three is to
 * start this one and finish or abandon it, and abandoning is a loss.
 */
export function drawGhostMatch(
  history: Map<string, GhostHistory>,
  now: Date,
  kind: GhostKind,
  ordinal: number,
): GhostMatch | null {
  const day = dayKey(now);
  const frozenAt = startOfLocalDay(now);
  const seed = drawSeed(day, kind, ordinal);
  const picked = pickRounds(ghostCandidates(history, frozenAt, kind), frozenAt, seed);
  if (picked.length < GHOST_ROUNDS) return null;

  return {
    id: seed,
    kind,
    day,
    ordinal,
    drawnAt: now.getTime(),
    startedAt: null,
    deadline: null,
    rounds: picked.map(({ lastPlayed: _lastPlayed, ...round }) => ({ ...round, live: null })),
    result: null,
  };
}

/** Same three, same ghosts, a fresh clock: what Rematch asks for. */
export function rematchOf(match: GhostMatch, now: Date, ordinal: number): GhostMatch {
  return {
    ...match,
    id: `${drawSeed(dayKey(now), match.kind, ordinal)}:rematch`,
    day: dayKey(now),
    ordinal,
    drawnAt: now.getTime(),
    startedAt: null,
    deadline: null,
    rounds: match.rounds.map((r) => ({ ...r, live: null })),
    result: null,
  };
}

// ---------------------------------------------------------------------------
// availability
// ---------------------------------------------------------------------------

export interface KindAvailability {
  kind: GhostKind;
  available: boolean;
  /** Scenarios a match of this kind could be drawn from today. */
  scenarios: number;
  /** The most recent session day any of them would draw from. */
  sessionDay: string | null;
  /** Why not, in the player's terms, when it is not available. */
  reason: string | null;
}

function unavailableReason(kind: GhostKind, scenarios: number): string {
  const when = kind === "month_ago" ? "30 or more days ago" : "7 or more days ago";
  return scenarios === 0
    ? `No scenario has a session ${when} and ${MIN_RUNS_FOR_BASELINE} runs of history.`
    : `Only ${scenarios} scenario${scenarios === 1 ? " has" : "s have"} a session ${when}; a match needs ${GHOST_ROUNDS}.`;
}

export function availableKinds(history: Map<string, GhostHistory>, now: Date): Record<GhostKind, KindAvailability> {
  const frozenAt = startOfLocalDay(now);
  const out = {} as Record<GhostKind, KindAvailability>;
  for (const kind of GHOST_KINDS) {
    const c = ghostCandidates(history, frozenAt, kind);
    const days = c.map((x) => x.sessionDay).sort();
    const available = c.length >= GHOST_ROUNDS;
    out[kind] = {
      kind,
      available,
      scenarios: c.length,
      sessionDay: days.length ? days[days.length - 1] : null,
      reason: available ? null : unavailableReason(kind, c.length),
    };
  }
  return out;
}

/**
 * Any ghost at all today: what decides whether a beat-a-ghost quest is honest to issue.
 *
 * Asked on every snapshot rebuild, so it stops at the third eligible scenario instead of
 * building every candidate. Month-ago's cutoff is earlier than last week's, so any
 * scenario with a month-old session also has a week-old one: last_week is the only kind
 * that needs asking, and its median and best share one session.
 */
export function ghostReady(history: Map<string, GhostHistory>, now: Date): boolean {
  const frozenAt = startOfLocalDay(now);
  let found = 0;
  for (const h of history.values()) {
    if (h.runs.length < MIN_RUNS_FOR_BASELINE) continue;
    if (ghostCandidatesBy(new Map([[h.scenario, h]]), frozenAt, definitionOf("last_week")).length === 0) continue;
    if (++found >= GHOST_ROUNDS) return true;
  }
  return false;
}

/**
 * The kind the chooser selects first.
 *
 * `month_ago` for an install's first ghost match, because it is the one most players win
 * (MEASURED_WIN_RATE) and the first match is the hook. `last_week` after that, and
 * `month_ago` again whenever last week has no ghost to offer.
 */
export function defaultKind(available: Record<GhostKind, KindAvailability>, playedBefore: boolean): GhostKind | null {
  const order: GhostKind[] = playedBefore
    ? ["last_week", "month_ago", "last_week_best"]
    : ["month_ago", "last_week", "last_week_best"];
  return order.find((k) => available[k].available) ?? null;
}

// ---------------------------------------------------------------------------
// playing it
// ---------------------------------------------------------------------------

export function startMatch(match: GhostMatch, now: number): GhostMatch {
  if (match.startedAt !== null || match.result) return match;
  return { ...match, startedAt: now, deadline: now + GHOST_START_ALLOWANCE_MS };
}

/**
 * Offer a landed run to the match. Never mutates; returns the new state and, when the run
 * does not count, which rule refused it.
 *
 * The first run on each scenario after Start counts, in any order, the way a ranked match
 * counts one attempt (PLAN.md §3). A later run on the same scenario is practice. A run on
 * a scenario outside the three is none of this match's business.
 */
export function applyRun(match: GhostMatch, run: IncomingRun): ApplyOutcome {
  if (match.result) return { accepted: false, match, reason: "finished" };
  if (match.startedAt === null || match.deadline === null) return { accepted: false, match, reason: "not-started" };

  const index = match.rounds.findIndex((r) => r.scenario === run.scenario);
  if (index < 0) return { accepted: false, match, reason: "unrelated" };

  // Judged on when the run *began*, where the duration says: a run already under way when
  // Start was pressed was begun knowing nothing was at stake.
  const began = run.durationSeconds !== null ? run.at - run.durationSeconds * 1000 : run.at;
  if (began < match.startedAt - GHOST_START_SLACK_MS) return { accepted: false, match, reason: "before-start" };

  if (match.rounds[index].live) return { accepted: false, match, reason: "already-counted" };

  if (run.at > match.deadline + GHOST_END_GRACE_MS) return { accepted: false, match, reason: "late" };

  const rounds = match.rounds.map((r, i) =>
    i === index ? { ...r, live: { score: run.score, at: run.at, abandoned: run.abandoned } } : r,
  );
  // The clock only runs between runs: each landed run buys the next idle allowance, as
  // `deadlineAfterRun` does for a ranked match.
  let next: GhostMatch = { ...match, rounds, deadline: run.at + GHOST_IDLE_ALLOWANCE_MS };
  if (rounds.every((r) => r.live)) next = { ...next, result: judge(next, "complete", run.at) };
  return { accepted: true, match: next, round: index };
}

/** The deadline, checked. Main calls it on a timer and on every run; the renderer never does. */
export function expireIfLate(match: GhostMatch, now: number): GhostMatch {
  if (match.result || match.deadline === null) return match;
  if (now <= match.deadline + GHOST_END_GRACE_MS) return match;
  return { ...match, result: judge(match, "expired", now) };
}

/**
 * Give up on a match.
 *
 * Before Start it is a discard and records nothing: the draw is seeded, so discarding it
 * and drawing again brings back the same three. After Start it is a loss, whatever the
 * score. Each round is revealed as it lands, which is the drama of the mode, and without
 * this a player two rounds behind would walk away with no result on the record.
 */
export function abandonMatch(match: GhostMatch, now: number): GhostMatch | null {
  if (match.result) return match;
  if (match.startedAt === null) return null;
  return { ...match, result: judge(match, "abandoned", now) };
}

function pct(v: number): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;
}

export const KIND_NAME: Record<GhostKind, string> = {
  month_ago: "last month's you",
  last_week: "last week's you",
  last_week_best: "last week's best",
};

/** Who the ghost is, in the words the screen uses: "last week's you", "Sam's ghost". */
export function opponentName(match: Pick<GhostMatch, "kind" | "link">): string {
  if (match.kind === "friend") return `${match.link?.sender ?? "a friend"}'s ghost`;
  return KIND_NAME[match.kind];
}

/**
 * A friend's-ghost match with too few measured rounds to have a result. It is still
 * played, for practice and to start building the baseline it lacks, and it ends void
 * however it ends: nothing was at stake, so leaving it is not a loss either.
 */
export function isPractice(match: Pick<GhostMatch, "kind" | "rounds">): boolean {
  return match.kind === "friend" && match.rounds.filter(isMeasured).length < MIN_MEASURED_ROUNDS;
}

/**
 * Score the match with `settleMatch`, so a ghost result is decided by exactly the rules
 * that decide a ranked one: both sides are `RoundSubmission`s on the same frozen
 * baseline, the ghost side's score is the frozen ghost, and void rules, the draw epsilon
 * and abandoned-run handling come with it. `ratingWeight` is ignored; nothing is rated.
 *
 * A match that ended before all three landed is a loss, not a void: `settleMatch` would
 * call a short side void, and that is exactly the door abandoning must not open.
 */
export function judge(match: GhostMatch, end: GhostEnd, at: number): GhostResult {
  const live: RoundSubmission[] = [];
  const ghost: RoundSubmission[] = [];
  match.rounds.forEach((r, i) => {
    // A round the player has no baseline on is left out of both sides, not scored raw:
    // settleMatch needs equal counts, and §3 does not compare raw scores.
    if (!r.live || !isMeasured(r)) return;
    // The tier matters to settleSide only when it is "rejected". Nothing on the local path
    // is verified, and the core's tier type has no "unverified" (that exists only in the
    // database enum), so both sides carry the same tier and it decides nothing.
    const base = { scenarioId: i, scenarioName: r.scenario, provisional: false, verificationTier: "consistent" as const };
    live.push({ ...base, baseline: r.baseline, score: r.live.score, abandoned: r.live.abandoned });
    // Each side against its own baseline: the player's, and the ghost's (the same one on
    // a past self, the friend's own on a friend's ghost).
    ghost.push({ ...base, baseline: ghostBaselineOf(r), score: r.ghost });
  });

  const settlement = live.length > 0 ? settleMatch({ playerRounds: live, opponentRounds: ghost }) : null;
  const rounds: GhostResultRound[] = match.rounds.map((r, i) => {
    const counted = settlement?.player.rounds.find((o) => o.scenarioId === i);
    const delta = counted?.counted ? counted.delta : null;
    const gb = ghostBaselineOf(r);
    const ghostDelta = (r.ghost - gb) / gb;
    return {
      scenario: r.scenario,
      live: r.live?.score ?? null,
      ghost: r.ghost,
      baseline: r.baseline,
      pb: r.pb,
      sessionDay: r.sessionDay,
      delta,
      ghostDelta,
      gap: delta === null ? null : delta - ghostDelta,
      abandoned: r.live?.abandoned ?? false,
      ghostBaseline: gb,
      measured: isMeasured(r),
    };
  });
  const gaps = rounds.map((r) => r.gap).filter((g): g is number => g !== null);
  const margin = gaps.length ? gaps.reduce((a, g) => a + g, 0) / gaps.length : null;
  const who = opponentName(match);
  const measured = match.rounds.filter(isMeasured).length;

  if (isPractice(match)) {
    return {
      verdict: "void",
      end,
      margin: null,
      rounds,
      at,
      explanation:
        `Practice: you have a baseline on ${measured} of these ${GHOST_ROUNDS}, and a result needs ${MIN_MEASURED_ROUNDS}. ` +
        `Nothing was scored, so nothing was lost. ${MIN_RUNS_FOR_BASELINE} runs on a scenario give you a baseline on it.`,
    };
  }

  if (end !== "complete") {
    const played = rounds.filter((r) => r.live !== null).length;
    return {
      verdict: "loss",
      end,
      margin,
      rounds,
      at,
      explanation: end === "abandoned"
        ? `Abandoned after ${played} of ${GHOST_ROUNDS}. A match left partway is a loss to ${who}.`
        : `Time ran out after ${played} of ${GHOST_ROUNDS}. The clock is the ranked one: three minutes between runs.`,
    };
  }

  const verdict = settlement!.verdict;
  let explanation: string;
  if (verdict === "void") explanation = `No result: ${settlement!.voidReason ?? "a round did not count"}.`;
  else if (verdict === "draw") explanation = `Dead level with ${who}.`;
  else if (match.kind === "friend") {
    const over = measured === GHOST_ROUNDS ? "three rounds" : `the ${measured} rounds you have a baseline on`;
    explanation = `${verdict === "win" ? "Beat" : "Lost to"} ${who} by ${pct(Math.abs(margin ?? 0))}, averaged over ${over}, each of you against your own baseline.`;
  } else explanation = `${verdict === "win" ? "Beat" : "Lost to"} ${who} by ${pct(Math.abs(margin ?? 0))}, averaged over three rounds against your own baseline.`;

  return { verdict, end, margin, rounds, at, explanation };
}

// ---------------------------------------------------------------------------
// the streak
// ---------------------------------------------------------------------------

export interface GhostOutcome {
  at: string;
  verdict: MatchVerdict;
}

/**
 * Consecutive local days with at least one ghost win, ending today or, if today has none
 * yet, yesterday: a streak is not broken by a day that is still in progress.
 *
 * Losses and voids add nothing. An abandoned match is recorded as a loss (`abandonMatch`),
 * so walking away from one cannot leave the day looking like it was never played.
 */
export function ghostStreak(records: GhostOutcome[], now: Date): number {
  const won = new Set(records.filter((r) => r.verdict === "win").map((r) => dayKey(new Date(r.at))));
  const cursor = startOfLocalDay(now);
  if (!won.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (won.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// ---------------------------------------------------------------------------
// what the renderer is sent
// ---------------------------------------------------------------------------

export interface GhostRoundView {
  scenario: string;
  ghost: number;
  sessionDay: string;
  sessionRuns: number;
  /** The player's baseline; null on a round they have none on. */
  baseline: number | null;
  /** The ghost side's baseline: the player's own on a past self, the friend's on theirs. */
  ghostBaseline: number;
  measured: boolean;
  pb: number;
  live: number | null;
  abandoned: boolean;
  /** Each side's delta over its own baseline, differenced, once landed and measured. */
  gap: number | null;
  /**
   * 0..1 on a scale centred on the baseline (BAR_BASELINE), BAR_SPAN either side. Scaled
   * against the raw scores instead, every bar filled to within a few percent of the end
   * and a 4% win looked like a tie, which is the one thing the board exists to show.
   */
  ghostBar: number;
  liveBar: number | null;
}

/** Where the baseline sits on a lane's bar, and how far either side of it the bar reaches. */
export const BAR_BASELINE = 0.5;
export const BAR_SPAN = 0.25;

function barOf(score: number, baseline: number): number {
  const delta = (score - baseline) / baseline;
  return Math.min(1, Math.max(0.02, BAR_BASELINE + (delta / BAR_SPAN) * BAR_BASELINE));
}

export interface GhostMatchView {
  id: string;
  kind: MatchKind;
  kindName: string;
  /** A friend's ghost: whose, by what code, and how many rounds can count. */
  link: { code: string; sender: string; measured: number; practice: boolean } | null;
  started: boolean;
  startedAt: number | null;
  deadline: number | null;
  rounds: GhostRoundView[];
  landed: number;
  /** Mean gap over the rounds landed so far. */
  runningMargin: number | null;
  /** The first round still to play, for the launch button. */
  next: string | null;
  result: GhostResult | null;
  /**
   * The result's best round against the player's best before the match, for the card's
   * small "N% off your best" line. `newBest` only when the live score is strictly above
   * the old best: equalling it is not a new one.
   */
  best: { scenario: string; pbGap: number; newBest: boolean } | null;
}

/** The best counted round of a result, measured against the best before the match. */
export function bestRoundOf(result: GhostResult | null): GhostMatchView["best"] {
  if (!result) return null;
  const round = result.rounds
    .filter((r) => r.live !== null && r.gap !== null && r.pb > 0)
    .sort((a, b) => b.gap! - a.gap!)[0];
  if (!round) return null;
  return { scenario: round.scenario, pbGap: (round.live! - round.pb) / round.pb, newBest: round.live! > round.pb };
}

/**
 * Everything the screen draws, computed here so the renderer computes nothing: bar
 * lengths, gaps and the running margin included.
 */
export function viewOf(match: GhostMatch): GhostMatchView {
  const rounds: GhostRoundView[] = match.rounds.map((r) => {
    const gb = ghostBaselineOf(r);
    const measured = isMeasured(r);
    // Against a past self both baselines are one and this is (live - ghost) / baseline; in
    // general it is the difference of the two deltas, which is what judge settles on.
    const gap = r.live && !r.live.abandoned && measured
      ? r.ghostBaseline === undefined
        ? (r.live.score - r.ghost) / r.baseline
        : (r.live.score - r.baseline) / r.baseline - (r.ghost - gb) / gb
      : null;
    return {
      scenario: r.scenario,
      ghost: r.ghost,
      sessionDay: r.sessionDay,
      sessionRuns: r.sessionRuns,
      baseline: measured ? r.baseline : null,
      ghostBaseline: gb,
      measured,
      pb: r.pb,
      live: r.live?.score ?? null,
      abandoned: r.live?.abandoned ?? false,
      gap,
      // Each bar on its own side's baseline scale, so the middle of every bar reads "par
      // for whoever played it". An unmeasured round has no scale of the player's own: its
      // live bar is drawn on the ghost's, as a picture only, and the lane says so.
      ghostBar: barOf(r.ghost, gb),
      liveBar: r.live ? barOf(r.live.score, measured ? r.baseline : gb) : null,
    };
  });
  const gaps = rounds.map((r) => r.gap).filter((g): g is number => g !== null);
  return {
    id: match.id,
    kind: match.kind,
    kindName: opponentName(match),
    link: match.link
      ? { ...match.link, measured: match.rounds.filter(isMeasured).length, practice: isPractice(match) }
      : null,
    started: match.startedAt !== null,
    startedAt: match.startedAt,
    deadline: match.deadline,
    rounds,
    landed: match.rounds.filter((r) => r.live).length,
    runningMargin: gaps.length ? gaps.reduce((a, g) => a + g, 0) / gaps.length : null,
    next: match.rounds.find((r) => !r.live)?.scenario ?? null,
    result: match.result,
    best: bestRoundOf(match.result),
  };
}
