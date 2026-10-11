/**
 * Shadows: the opponent a ranked match gets when nobody else is in the pool.
 *
 * WHY A SHADOW AND NOT "NOTHING WAS RATED"
 *
 * The ladder is asynchronous (PLAN.md §6), and an empty pool used to hand out a seeding
 * match that ended "Nothing was rated: there was no opponent to play against". With no
 * population that is every player's first evening. A Shadow makes that match contested
 * without inventing a person.
 *
 * WHAT A SHADOW IS
 *
 * A match is decided on each side's delta over its own baseline (PLAN.md §3), so the
 * opponent's half of any match is a single number: how far their three runs landed above
 * or below their own baselines. That makes "a typical player's day" definable without a
 * player: it is a quantile of the distribution of genuine three-scenario match scores. A
 * Shadow fielded at the 53rd percentile scores what 53% of genuine days fall below.
 *
 * The distribution is `data/shadow_days.json`, built by `npm run build:shadows` (see
 * `tools/buildShadowTable.ts` for which committed measurements it rests on, and how a real
 * stats folder replaces them). This module reads it; it never generates numbers of its own.
 *
 * WHAT IT DECIDES AND WHAT IT DOES NOT
 *
 *   rating      nothing. A Shadow is not evidence about the population, and letting it
 *               move Glicko-2 would be a rating anybody could farm against a table.
 *   the pool    nothing. The player's side is stored exactly as a seeding side always
 *               was, and becomes a Flag (flags.ts) for the next real player.
 *   placement   a read-out of where the player's recent days sit among genuine days.
 *
 * DETERMINISM
 *
 * Which Shadow a player meets is a pure function of server data: their Shadow history
 * (which rung of the ladder they are on, and how many Shadows they have met) and the
 * table. Requeueing cannot reroll it: the ordinal only advances when a Shadow match ends,
 * and ending one by abandoning it counts as a loss.
 */

import { seededRandom, type SelectableScenario, matchesCategory } from "./scenarioSelection.ts";
import { settleMatch, type RoundSubmission, type Settlement } from "./settle.ts";

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

export type ShadowSkill = "All" | "Clicking" | "Tracking" | "Switching";
export const SHADOW_SKILLS: ShadowSkill[] = ["All", "Clicking", "Tracking", "Switching"];

/** Quantiles of the mean of k genuine round deltas, at percentiles 1..99. */
export interface ShadowQuantiles {
  k1: number[];
  k2: number[];
  k3: number[];
  /** Days behind the k3 column, when built from a corpus. Null for the model. */
  n: number | null;
  /** Set when this skill had too few days of its own and borrowed another column. */
  borrowedFrom?: ShadowSkill;
}

export interface ShadowTable {
  version: number;
  /** "model" when derived from committed measurements, "corpus" when replayed from a stats folder. */
  method: "model" | "corpus";
  builtAt: string;
  percentiles: number[];
  skills: Record<ShadowSkill, ShadowQuantiles>;
  /** Where every number came from. Read by the validator and the doc, never by players. */
  inputs: Record<string, unknown>;
}

/** The skill a queue category belongs to, for picking a column. "Any" spans skills. */
export function skillOf(category: string | null | undefined): ShadowSkill {
  const c = String(category ?? "").trim();
  for (const skill of ["Clicking", "Tracking", "Switching"] as const) {
    if (c === skill || c.endsWith(" " + skill)) return skill;
  }
  return "All";
}

/**
 * The value at percentile p of the mean of k rounds.
 *
 * Linear between the integer percentiles the table carries; p is clamped to 1..99, which is
 * all the table can honestly say.
 */
export function shadowQuantile(table: ShadowTable, skill: ShadowSkill, k: 1 | 2 | 3, p: number): number {
  const column = (table.skills[skill] ?? table.skills.All)[`k${k}`];
  const x = Math.min(99, Math.max(1, p));
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  const a = column[lo - 1];
  const b = column[hi - 1];
  return lo === hi ? a : a + (b - a) * (x - lo);
}

// ---------------------------------------------------------------------------
// the ladder
// ---------------------------------------------------------------------------

/**
 * Percentile centres of the Shadow ladder, easiest first.
 *
 * The first Shadow sits at the median, so the opening match is an even contest against an
 * ordinary day. A win moves one rung up, a loss one down: the classic one-up one-down
 * staircase, which converges on the level a player beats half the time. That keeps every
 * Shadow match contested, which is the whole job.
 *
 * The bottom rung is the 20th rather than lower because a Shadow weaker than four days in
 * five stops being an opponent; the top is the 95th because above it the table's tail rests
 * on too few days to state a number to a percent.
 */
export const SHADOW_RUNGS = [20, 35, 50, 65, 80, 90, 95] as const;
export const SHADOW_START_RUNG = 2;

/**
 * Spread around a rung's centre, in percentile points.
 *
 * So consecutive Shadows on one rung are not the same number to the decimal, and "you beat
 * a 53rd-percentile day" is a statement about this Shadow rather than a rung label. Small
 * enough that rungs never overlap.
 */
export const SHADOW_JITTER = 3;

export type ShadowResult = "win" | "loss" | "draw" | "void" | "forfeit";

export interface ShadowRecord {
  ordinal: number;
  percentile: number;
  /** Null while the match is still open. */
  result: ShadowResult | null;
  decidedAt?: string | null;
}

/** How a result moves the ladder. Forfeit is a loss: otherwise abandoning would be the free way out of one. */
export function rungStep(result: ShadowResult | null): -1 | 0 | 1 {
  if (result === "win") return 1;
  if (result === "loss" || result === "forfeit") return -1;
  return 0;
}

/** The rung the next Shadow is fielded on, replaying every decided result in order. */
export function ladderRung(records: ShadowRecord[]): number {
  let rung = SHADOW_START_RUNG;
  for (const r of [...records].sort((a, b) => a.ordinal - b.ordinal)) {
    rung = Math.min(SHADOW_RUNGS.length - 1, Math.max(0, rung + rungStep(r.result)));
  }
  return rung;
}

/** The next ordinal: one past the highest a player has been fielded. */
export function nextOrdinal(records: ShadowRecord[]): number {
  return records.reduce((max, r) => Math.max(max, r.ordinal + 1), 0);
}

export function shadowSeed(playerId: string, ordinal: number): string {
  return `shadow:${playerId}:${ordinal}`;
}

/** The percentile fielded on a rung: its centre, plus or minus the jitter, from the seed. */
export function drawPercentile(rung: number, seed: string): number {
  const centre = SHADOW_RUNGS[Math.min(SHADOW_RUNGS.length - 1, Math.max(0, rung))];
  const random = seededRandom(seed);
  const offset = Math.floor(random() * (2 * SHADOW_JITTER + 1)) - SHADOW_JITTER;
  return Math.min(98, Math.max(2, centre + offset));
}

export interface ShadowPlan {
  ordinal: number;
  rung: number;
  percentile: number;
  skill: ShadowSkill;
  /** The Shadow's day at this percentile, as the mean of 1, 2 or 3 rounds. */
  quantiles: [number, number, number];
  tableVersion: number;
  tableMethod: ShadowTable["method"];
}

/** Everything a Shadow match freezes at creation. */
export function planShadow(
  table: ShadowTable,
  playerId: string,
  records: ShadowRecord[],
  category: string,
): ShadowPlan {
  const ordinal = nextOrdinal(records);
  const rung = ladderRung(records);
  const percentile = drawPercentile(rung, shadowSeed(playerId, ordinal));
  const skill = skillOf(category);
  return {
    ordinal,
    rung,
    percentile,
    skill,
    quantiles: [1, 2, 3].map((k) => round5(shadowQuantile(table, skill, k as 1 | 2 | 3, percentile))) as [number, number, number],
    tableVersion: table.version,
    tableMethod: table.method,
  };
}

// ---------------------------------------------------------------------------
// which three scenarios
// ---------------------------------------------------------------------------

/**
 * Scenarios for a Shadow match, preferring ones the player can be measured on.
 *
 * A round on a scenario with no earlier runs reads 0% by construction (settle-match uses
 * the run as its own baseline), so it cannot be contested by anybody, Shadow or person. The
 * draw therefore takes scenarios with a full baseline first, then ones with some history,
 * then the rest, each bucket shuffled by the match seed. Still seeded and still the server's
 * choice; only the order of preference is new, and only for Shadow matches.
 *
 * Cycles when the category has fewer than three scenarios, exactly as selectScenarios does.
 */
export function selectShadowScenarios(
  pool: SelectableScenario[],
  seed: string,
  category: string,
  runCounts: Map<number, number>,
  fullBaseline = 5,
): SelectableScenario[] {
  const eligible = pool.filter((s) => matchesCategory(s, category));
  if (eligible.length === 0) return [];
  const random = seededRandom(seed);
  const shuffle = <T>(items: T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const runs = (s: SelectableScenario) => runCounts.get(s.id) ?? 0;
  const ordered = [
    ...shuffle(eligible.filter((s) => runs(s) >= fullBaseline)),
    ...shuffle(eligible.filter((s) => runs(s) > 0 && runs(s) < fullBaseline)),
    ...shuffle(eligible.filter((s) => runs(s) === 0)),
  ];
  return [0, 1, 2].map((i) => ordered[i % ordered.length]);
}

// ---------------------------------------------------------------------------
// judging a Shadow match
// ---------------------------------------------------------------------------

/**
 * The Shadow's delta on each round.
 *
 * On a round where the player had earlier runs, the Shadow's day at this percentile for the
 * number of such rounds (k). On a round with none, 0%: the player's round reads 0% by
 * construction, and a first attempt reads 0% for anybody, so both sides are level there and
 * the match is decided on the rounds that can be compared. The mean over all three is then
 * exactly k/3 of the Shadow's k-round day, the same scale as the player's own match score.
 */
export function shadowRoundDeltas(quantiles: readonly number[], hasHistory: boolean[]): number[] {
  const k = hasHistory.filter(Boolean).length;
  const day = k > 0 ? quantiles[k - 1] : 0;
  return hasHistory.map((h) => (h ? day : 0));
}

export interface ShadowJudgement {
  settlement: Settlement;
  verdict: "win" | "loss" | "draw" | "void";
  shadowDeltas: number[];
  /** Rounds with earlier runs, which are the only rounds the Shadow contests. */
  comparable: number;
  playerScore: number | null;
  shadowScore: number | null;
}

/**
 * Decide a Shadow match with the same settleMatch every ranked match uses.
 *
 * The Shadow becomes an opponent side whose rounds reproduce its deltas exactly (score
 * 1 + delta over baseline 1, the same device settle-match uses for a frozen stored side).
 * So voids, the draw margin and rejected or abandoned rounds behave exactly as they would
 * against a person.
 */
export function judgeShadow(
  playerRounds: RoundSubmission[],
  hasHistory: boolean[],
  quantiles: readonly number[],
): ShadowJudgement {
  const shadowDeltas = shadowRoundDeltas(quantiles, hasHistory);
  const opponentRounds: RoundSubmission[] = playerRounds.map((r, i) => ({
    scenarioId: r.scenarioId,
    scenarioName: r.scenarioName,
    score: 1 + shadowDeltas[i],
    baseline: 1,
    provisional: false,
    verificationTier: "consistent",
  }));
  const settlement = settleMatch({ playerRounds, opponentRounds });
  return {
    settlement,
    verdict: settlement.verdict,
    shadowDeltas,
    comparable: hasHistory.filter(Boolean).length,
    playerScore: settlement.player.matchScore,
    shadowScore: settlement.opponent.matchScore,
  };
}

// ---------------------------------------------------------------------------
// words
// ---------------------------------------------------------------------------

export function ordinalSuffix(n: number): string {
  const v = Math.round(n);
  const teen = v % 100;
  if (teen >= 11 && teen <= 13) return `${v}th`;
  return `${v}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[v % 10] ?? "th"}`;
}

/** "a 53rd-percentile day", "an 80th-percentile day". */
export function shadowLabel(percentile: number): string {
  const word = ordinalSuffix(percentile);
  return `${/^(8|11th|18th)/.test(word) ? "an" : "a"} ${word}-percentile day`;
}

const pct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;

/** The line under a Shadow verdict. States the numbers, the reason, and that nothing was rated. */
export function explainShadow(j: ShadowJudgement, percentile: number, rounds: number, provisional: boolean): string {
  const label = shadowLabel(percentile);
  if (j.verdict === "void") {
    return `No result against the Shadow: ${j.settlement.voidReason ?? "the match could not be settled"}. Shadows move no rating.`;
  }
  if (j.comparable === 0) {
    return `None of these ${rounds} scenarios had earlier runs, so every round read 0% for both sides and there ` +
      `was nothing to compare. Each run is now that scenario's first entry, so the next Shadow has something to measure. ` +
      `Shadows move no rating.`;
  }
  const you = j.playerScore ?? 0;
  const them = j.shadowScore ?? 0;
  const head = j.verdict === "win"
    ? `You beat ${label}: ${pct(you)} vs ${pct(them)} against baselines.`
    : j.verdict === "loss"
      ? `${label[0].toUpperCase()}${label.slice(1)} beat you: ${pct(you)} vs ${pct(them)} against baselines.`
      : `Level with ${label} at ${pct(you)} against baselines.`;
  const level = j.comparable < rounds
    ? ` ${rounds - j.comparable} of the ${rounds} had no earlier runs, so ${rounds - j.comparable === 1 ? "it reads" : "they read"} 0% ` +
      `for both sides and the Shadow was compared on the other ${j.comparable === 1 ? "one" : j.comparable}.`
    : "";
  const noisy = provisional ? " Some baselines rest on fewer than 5 runs, so this read is noisier than usual." : "";
  return `${head}${level}${noisy} Shadows move no rating.`;
}

// ---------------------------------------------------------------------------
// the read-out
// ---------------------------------------------------------------------------

/**
 * Where a player's recent days sit among genuine days, from their Shadow results.
 *
 * If a player's day lands at reference percentile U, they beat a Shadow at p exactly when
 * U > p. A player whose days look like everyone's has U uniform on 0..100, so beats a
 * p-th percentile Shadow with probability 1 - p/100, which is what a percentile means. A
 * player who shows up sharper is that same spread shifted to centre theta, and theta is
 * what this estimates: the maximum likelihood over the last results, with a weak prior at
 * 50 so two matches cannot claim the 95th. Draws count half; forfeits count as losses;
 * voids say nothing.
 */
export const PLACEMENT_WINDOW = 12;
export const PLACEMENT_MIN = 3;

export interface Placement {
  estimate: number;
  decided: number;
  wins: number;
  losses: number;
  draws: number;
}

export function placement(records: ShadowRecord[]): Placement | null {
  const decided = [...records]
    .filter((r) => r.result && r.result !== "void")
    .sort((a, b) => b.ordinal - a.ordinal)
    .slice(0, PLACEMENT_WINDOW);
  if (decided.length < PLACEMENT_MIN) return null;

  const win = (theta: number, p: number) => Math.min(0.98, Math.max(0.02, (theta + 50 - p) / 100));
  let best = 50;
  let bestScore = -Infinity;
  for (let theta = 5; theta <= 95; theta++) {
    let ll = -((theta - 50) ** 2) / (2 * 30 ** 2);
    for (const r of decided) {
      const w = win(theta, r.percentile);
      const s = r.result === "win" ? 1 : r.result === "draw" ? 0.5 : 0;
      ll += s * Math.log(w) + (1 - s) * Math.log(1 - w);
    }
    if (ll > bestScore) {
      bestScore = ll;
      best = theta;
    }
  }
  return {
    estimate: best,
    decided: decided.length,
    wins: decided.filter((r) => r.result === "win").length,
    losses: decided.filter((r) => r.result === "loss" || r.result === "forfeit").length,
    draws: decided.filter((r) => r.result === "draw").length,
  };
}

/** Consecutive Shadow wins, newest first. A void neither extends nor breaks it. */
export function shadowStreak(records: ShadowRecord[]): number {
  let streak = 0;
  for (const r of [...records].sort((a, b) => b.ordinal - a.ordinal)) {
    if (r.result === null || r.result === "void") continue;
    if (r.result !== "win") break;
    streak++;
  }
  return streak;
}

function round5(v: number): number {
  return Math.round(v * 100000) / 100000;
}
