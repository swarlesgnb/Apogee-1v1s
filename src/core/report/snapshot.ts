/**
 * Build the player-state snapshot the UI renders.
 *
 * Shared by the CLI exporter and the Electron main process, so the desktop app and the
 * static preview cannot drift apart: there is one definition of "what the player's
 * state is", and both read it.
 */

import { readFileSync } from "node:fs";

import { evaluateBenchmark } from "../benchmarks/energy.ts";
import type { BenchmarkDef, DifficultyDef } from "../benchmarks/types.ts";
import { dataFile } from "../dataDir.ts";
import {
  hasSeason,
  loadSeason,
  matchPoolFor,
  matchPoolName,
  matchPoolWindow,
  seasonAsDifficulties,
  seasonAsDifficulty,
  seasonLabels,
  type MatchPool,
} from "../season/season.ts";
import { computeBaseline, scanStatsFolder, type ScenarioHistory } from "../history/history.ts";
import { windowCoverage, type WindowCoverage } from "../history/coverage.ts";
import { selectScenarios, type SelectableScenario } from "../match/scenarioSelection.ts";
import { explainVerdict, settleMatch, type RoundSubmission } from "../match/settle.ts";
import { boardView, playStreak, syncBoard, type BoardView, type QuestState, type QuestSync } from "../quests/board.ts";
import { defaultRating, updateRating, winProbability } from "../rating/glicko2.ts";
import { loadRankTheme, tierForPercentile, type RankTier } from "../ranks/apogeeRanks.ts";
import { floorsFor, overallGap } from "../consistency/floor.ts";

/**
 * One category's standing inside one band.
 *
 * Bands do not chain, so this is a complete answer on its own: `rankIndex` counts from
 * the band's own first rank and `rankNames` is the band's own four, never a slice of a
 * longer ladder that would have to be offset to read.
 */
export interface BandStanding {
  window: number;
  windowName: string;
  rankName: string | null;
  /** -1 when the band is unplayed, which is not the same as being at its bottom rank. */
  rankIndex: number;
  rankNames: string[];
  rankColors: Record<string, string>;
  rankMaxes: number[];
  energy: number;
  rankCount: number;
  progressToNextRank: number | null;
  /** Scenarios in this band with any history, and how many it has. */
  played: number;
  total: number;
  /**
   * The band's positional top rank, when it has one.
   *
   * `eligible` means the player holds the highest rank a score can prove. It is never a
   * claim to the rank itself: only the server sees the board order, so the client says
   * "eligible" and waits to be told.
   */
  positional: { rankName: string; topN: number; eligible: boolean } | null;
}

export interface SnapshotOptions {
  statsDir: string;
  /** Defaults to the committed Voltaic S5 definition. */
  benchmarkPath?: string | URL;
  now?: Date;
  /**
   * The stored quest board, folded into this rebuild's history.
   *
   * The board needs the same history and season this function already reads, and
   * scanning an 11k-run folder twice per landed run to get them is the cost of keeping
   * it out. The result goes back through `onSync` rather than on the snapshot, so the
   * renderer is sent the view and never the state it is computed from.
   */
  quests?: {
    state: QuestState | null;
    ranked: boolean;
    onSync?: (sync: QuestSync) => void;
  };
}

export interface Snapshot {
  expedition?: import("../expedition/types.ts").ExpeditionView;
  generatedAt: string;
  benchmark: {
    name: string;
    difficulty: string;
    rankNames: string[];
    rankColors: Record<string, string>;
    /**
     * Which window of the season's pool to queue into.
     *
     * An index rather than a name, so renaming a window is a display change and never a
     * change to what the server resolves. It is also separate from `difficulty` above,
     * which is a display string and is deliberately empty for a season - passing that to
     * the server returned a 400, because an empty difficulty resolves to no scenarios.
     */
    matchPool: MatchPool;
    /** Display name of the window matches are drawn from. */
    matchPoolName: string;
    /** Window names low to high, and how many ranks each covers. Null on a flat ladder. */
    windows: string[] | null;
    windowSize: number | null;
  };
  player: {
    totalRuns: number;
    scenarioCount: number;
    streak: number;
    benchmarkRank: string | null;
    benchmarkEnergy: number;
    progressToNextRank: number | null;
    nextRankName: string | null;
    apogee: {
      rating: number;
      rd: number;
      percentile: number;
      tier: RankTier;
    };
  };
  theme: RankTier[];
  categories: unknown[];
  weakest: string;
  /**
   * Which difficulties the player is actually measured on.
   *
   * A match is decided on delta against your own baseline, so a difficulty with little
   * history behind it turns the match on whose baseline is worse. With four windows this
   * stopped being a detail: most players
   * are measured on one of them, and nothing on screen said so.
   */
  coverage: WindowCoverage[];
  /** Floor rank and per-scenario gaps. See core/consistency. */
  consistency: {
    method: string;
    ceilingRank: string | null;
    ceilingEnergy: number;
    floorRank: string | null;
    floorEnergy: number;
    gap: number;
    scenarios: {
      name: string;
      label: string;
      ceiling: number;
      floor: number;
      median: number;
      gap: number;
    }[];
  };
  match: unknown;
  quests: BoardView;
}

export function shortName(scenario: string, difficulty: string): string {
  return scenario
    .replace(/^VT /, "")
    .replace(new RegExp(`\\s*${difficulty.split(" ")[0]}\\s*`, "i"), " ")
    .replace(/\s*S\d(\.\d)?\s*$/i, "")
    .trim();
}

/**
 * Choose the difficulty worth showing: the one the player is still climbing, not one
 * they have already capped. Counting scenarios-touched picks the wrong tier for anyone
 * who ran each Novice scenario twice to max it.
 */
export function pickDifficulty(
  benchmark: BenchmarkDef,
  history: Map<string, ScenarioHistory>,
): DifficultyDef {
  let best = benchmark.difficulties[0];
  let bestRuns = -1;

  for (const difficulty of benchmark.difficulties) {
    const scenarios = difficulty.categories.flatMap((c) => c.scenarios);
    const runs = scenarios.reduce((n, s) => n + (history.get(s.name)?.runs.length ?? 0), 0);

    const scores = new Map<string, number>();
    for (const s of scenarios) {
      const h = history.get(s.name);
      if (h) scores.set(s.name, h.best);
    }
    const maxed =
      evaluateBenchmark(difficulty, scores).rankIndex === difficulty.rankNames.length - 1;

    if (!maxed && runs > bestRuns) {
      best = difficulty;
      bestRuns = runs;
    }
  }
  return best;
}

export function buildSnapshot(options: SnapshotOptions): Snapshot | null {
  const now = options.now ?? new Date();

  // The season is the source of truth for what a rank means (PLAN.md §14). The
  // benchmark file stays as a fallback so an install without a season still works and
  // so `--benchmark` keeps doing what it says, but nothing normal reads it any more.
  const useSeason = !options.benchmarkPath && hasSeason();

  const benchmark = useSeason
    ? null
    : (JSON.parse(
        readFileSync(options.benchmarkPath ?? dataFile("benchmarks", "voltaic-s5.json"), "utf8"),
      ) as BenchmarkDef);
  const subcats = (
    JSON.parse(readFileSync(dataFile("subcategories.json"), "utf8")) as {
      families: Record<string, { skill: string; subCategory: string }>;
    }
  ).families;
  const theme = loadRankTheme();

  const history = scanStatsFolder(options.statsDir);
  if (history.size === 0) return null;

  // A season has no difficulties to pick between: splitting one benchmark into four
  // was Voltaic's way of covering a skill range, and owning the pool means the split is
  // six categories, each banded into four windows of its own.
  const season = useSeason ? loadSeason() : null;

  /** Scenario -> the sub-skill its family trains, as the season declares it. */
  const seasonSubCategory = new Map<string, string>(
    (season?.scenarios ?? [])
      .filter((s): s is typeof s & { subCategory: string } => typeof s.subCategory === "string")
      .map((s) => [s.scenario, s.subCategory]),
  );
  const difficulty = season
    ? seasonAsDifficulty(season)
    : pickDifficulty(benchmark!, history);

  // A season carries its own short labels. Deriving them from the difficulty name was
  // fine while the difficulty was "Intermediate" and wrong the moment it became
  // "Season 1": labels came out as "Pasu Intermediate", and since the sub-category map
  // is keyed on the label, every scenario quietly lost its sub-category too.
  const seasonLabel = season ? seasonLabels(season) : null;
  const labelFor = (name: string) =>
    seasonLabel?.get(name) ?? shortName(name, difficulty.name);

  // Which window each scenario belongs to, by name.
  //
  // Three variants of a family share a label - all three of these are "Pasu" - so
  // anything listing scenarios rather than families has to say which one it means. The
  // family rows do not need this, because only one variant appears per row.
  const windowNameOf = new Map<string, string>();
  if (season?.windows) {
    for (const s of season.scenarios) {
      const w = season.windows[s.window ?? 0];
      if (w) windowNameOf.set(s.scenario, w);
    }
  }

  /** Label that survives being listed next to its own siblings. */
  const variantLabel = (name: string) => {
    const w = windowNameOf.get(name);
    return w ? `${labelFor(name)} ${w.slice(0, 3).toLowerCase()}` : labelFor(name);
  };

  const scores = new Map<string, number>();
  for (const cat of difficulty.categories) {
    for (const s of cat.scenarios) {
      const h = history.get(s.name);
      if (h) scores.set(s.name, h.best);
    }
  }

  const result = evaluateBenchmark(difficulty, scores);

  // Each band graded as its own benchmark, which is what a season now is: four of them,
  // not four stretches of one ladder. A player holds a rank in each band they have
  // played, so there is no single number to reduce these to and the UI shows all four.
  //
  // `seasonAsDifficulties` yields nothing for a season built before the split, and every
  // reader below treats an empty list as 'not split yet' rather than 'no ranks'.
  const bandResults = (season ? seasonAsDifficulties(season) : []).map((def) => ({
    def,
    result: evaluateBenchmark(def, scores),
  }));

  /** Each category's standing in every band, in band order. */
  const bandsOf = new Map<string, BandStanding[]>(
    difficulty.categories.map((cat) => [
      cat.name,
      bandResults.map(({ def, result: banded }, window) => {
        const ladder = def.categories.find((c) => c.name === cat.name);
        const stood = banded.categories.find((c) => c.name === cat.name);
        const scenarios = ladder?.scenarios ?? [];
        // Played, not maxed: a band nobody has touched is unmeasured rather than bottom
        // rank, and the two look identical if only the rank is shown.
        const played = scenarios.filter((sc) => history.has(sc.name)).length;
        return {
          window,
          windowName: season?.windows?.[window] ?? `Band ${window + 1}`,
          rankName: played === 0 ? null : (stood?.rankName ?? null),
          rankIndex: played === 0 ? -1 : (stood?.rankIndex ?? -1),
          rankNames: ladder?.rankNames ?? [],
          rankColors: ladder?.rankColors ?? {},
          rankMaxes: ladder?.rankMaxes ?? [],
          energy: Math.round(stood?.energy ?? 0),
          rankCount: stood?.rankCount ?? (ladder?.rankNames?.length ?? 0),
          progressToNextRank: played === 0 ? null : (stood?.progressToNextRank ?? null),
          played,
          total: scenarios.length,
          positional: played === 0 ? null : (stood?.positional ?? null),
        };
      }),
    ]),
  );

  // With no live population, tier placement is estimated from benchmark standing and
  // labelled as provisional in the UI. Replaced by a real percentile once the ladder
  // has players.
  const percentile = Math.max(
    0,
    Math.min(
      99.9,
      ((result.rankIndex + 1 + (result.progressToNextRank ?? 0)) /
        (difficulty.rankNames.length + 1)) *
        100,
    ),
  );
  const tier = tierForPercentile(theme, percentile);

  let rating = defaultRating();
  for (let i = 0; i < 12; i++) {
    rating = updateRating(rating, [
      { opponent: { rating: 1500, rd: 90, volatility: 0.06 }, score: i % 3 === 0 ? 0 : 1 },
    ]);
  }

  // The ladder each category was graded against, by name.
  //
  // Clicking, Tracking and Switching each name and colour their own ranks (PLAN.md §14),
  // so `benchmark.rankColors` - the overall ladder - contains neither "D" nor
  // "Neanderthal", and every category and scenario rank rendered grey when looked up
  // there. The ladder that graded a rank has to travel with it.
  const ladderOf = new Map(
    difficulty.categories.map((c) => [
      c.name,
      {
        rankNames: c.rankNames ?? difficulty.rankNames,
        rankColors: c.rankColors ?? difficulty.rankColors,
        rankMaxes: c.rankMaxes,
      },
    ]),
  );

  const categories = result.categories.map((cat) => ({
    name: cat.name,
    energy: Math.round(cat.energy),
    rankName: cat.rankName,
    rankNames: ladderOf.get(cat.name)?.rankNames ?? difficulty.rankNames,
    rankColors: ladderOf.get(cat.name)?.rankColors ?? difficulty.rankColors,
    // Energy per rank, so the ladder can say what each rung costs rather than only which
    // one the player is standing on.
    rankMaxes: ladderOf.get(cat.name)?.rankMaxes ?? [],
    rankCount: cat.rankCount,
    progressToNextRank: cat.progressToNextRank,
    bands: bandsOf.get(cat.name) ?? [],
    perScenario: Math.round(cat.energy / Math.max(1, cat.scenarios.length)),
    scenarios: cat.scenarios.map((s) => ({
      name: s.scenario.name,
      label: labelFor(s.scenario.name),
      family: s.family,
      // Which window the shown variant belongs to, so the UI can say "Pasu, Intermediate"
      // rather than leaving three different scenarios all called Pasu.
      window: s.scenario.window ?? null,
      windowName: season?.windows?.[s.scenario.window ?? 0] ?? null,
      // The season's own declaration first. Voltaic's sheet is the fallback and can only
      // answer for Voltaic's eighteen families, so leaning on it left every scenario from
      // the other twenty-two benchmarks with a null sub-skill - and a null sub-skill is
      // a scenario the weakness map cannot place.
      subCategory:
        seasonSubCategory.get(s.scenario.name) ??
        subcats[labelFor(s.scenario.name)]?.subCategory ??
        null,
      score: s.score,
      rankName: s.rankName,
      energy: Math.round(s.energy),
      nextRankName: s.nextRankName,
      nextRankScore: s.nextRankScore,
      // The next rank can be graded by a harder variant than the one being shown, and a
      // target score means nothing without the scenario it is scored on.
      nextRankScenario: s.nextRankScenario,
      nextRankLabel: s.nextRankScenario ? labelFor(s.nextRankScenario) : null,
      nextRankWindowName: s.nextRankScenario
        ? (windowNameOf.get(s.nextRankScenario) ?? null)
        : null,
      nextRankIsNewScenario: !!s.nextRankScenario && s.nextRankScenario !== s.scenario.name,
      gap: s.gapToNextRank,
      runs: history.get(s.scenario.name)?.runs.length ?? 0,
    })),
  }));

  const weakest = [...result.categories].sort((a, b) => a.energy - b.energy)[0];

  // The illustrative match draws from the same window a real one would (see
  // `matchPool`), not from the whole ladder: showing a beginner an Advanced scenario in
  // the demo match would advertise a match they will never be handed.
  const poolWindow = season ? matchPoolWindow(season) : -1;

  let nextId = 1;
  const pool: SelectableScenario[] = difficulty.categories.flatMap((cat) =>
    cat.scenarios
      .filter((s) => poolWindow < 0 || (s.window ?? 0) === poolWindow)
      .map((s) => {
        const family = labelFor(s.name);
        return {
          id: nextId++,
          name: s.name,
          aimType: subcats[family]?.skill ?? cat.name,
          subCategory: subcats[family]?.subCategory ?? null,
        };
      }),
  );

  const seed = "apogee-demo-match-01";
  const chosen = selectScenarios(pool, seed, { category: weakest.name });

  const playerRounds: RoundSubmission[] = [];
  const opponentRounds: RoundSubmission[] = [];

  for (const scenario of chosen) {
    const h = history.get(scenario.name);
    if (!h || h.runs.length === 0) continue;

    const baseline = computeBaseline(h, h.best);
    const latest = h.runs[h.runs.length - 1].score;

    playerRounds.push({
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      score: latest,
      baseline: baseline.value,
      provisional: baseline.provisional,
      verificationTier: "verified",
    });

    const oppBaseline = baseline.value * 0.97;
    const oppDelta = [0.031, -0.012, 0.018][opponentRounds.length % 3];
    opponentRounds.push({
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      score: Math.round(oppBaseline * (1 + oppDelta)),
      baseline: oppBaseline,
      provisional: false,
      verificationTier: "consistent",
    });
  }

  const settlement = settleMatch({ playerRounds, opponentRounds });
  const opponentRating = { rating: rating.rating - 40, rd: 85, volatility: 0.06 };

  // With no stored board (the CLI exporter, the preview) this issues today's afresh, which
  // is exactly what a first launch would show.
  const questSync = syncBoard(options.quests?.state ?? null, {
    difficulty,
    history,
    now,
    // A quest names a scenario the player has to go and launch, so it has to be the name
    // KovaaK's shows and it has to say which of a family's variants it means.
    labelFor: variantLabel,
    ranked: options.quests?.ranked ?? false,
  });
  options.quests?.onSync?.(questSync);
  const quests = boardView(questSync.state, history, now);

  const totalRuns = [...history.values()].reduce((n, h) => n + h.runs.length, 0);

  // ---- consistency: the floor rank, alongside the ceiling everyone else ranks ----
  const scoreHistory = new Map<string, number[]>();
  for (const cat of difficulty.categories) {
    for (const s of cat.scenarios) {
      const h = history.get(s.name);
      if (h) scoreHistory.set(s.name, h.runs.map((r) => r.score));
    }
  }

  const floors = floorsFor(scoreHistory);
  const floorScores = new Map<string, number>();
  for (const [name, f] of floors) floorScores.set(name, f.floor);

  const floorResult = evaluateBenchmark(difficulty, floorScores);

  const consistency = {
    method: "worstOfLast5",
    ceilingRank: result.rankName,
    ceilingEnergy: Math.round(result.totalEnergy),
    floorRank: floorResult.rankName,
    floorEnergy: Math.round(floorResult.totalEnergy),
    gap: overallGap(floors.values()),
    scenarios: [...floors.values()]
      .filter((f) => !f.provisional)
      .sort((a, b) => b.gap - a.gap)
      .map((f) => ({
        name: f.scenario,
        // A row per scenario, not per family - reliability on the Novice variant is a
        // different fact from reliability on the Advanced one - so the label has to say
        // which of the three it is.
        label: variantLabel(f.scenario),
        ceiling: f.ceiling,
        floor: f.floor,
        median: f.median,
        gap: f.gap,
      })),
  };

  const coverage = season ? windowCoverage(season, history) : [];

  return {
    generatedAt: now.toISOString(),
    coverage,
    benchmark: {
      name: season ? season.name : benchmark!.benchmarkName,
      // A season has no difficulty, and repeating its name in that slot printed
      // "Season 1 Season 1" everywhere the two are shown together. Empty is the honest
      // value; every reader already joins these with a space and trims.
      difficulty: season ? "" : difficulty.name,
      rankNames: difficulty.rankNames,
      rankColors: difficulty.rankColors,
      matchPool: season ? matchPoolFor(season) : { window: 0 },
      // Named as well as numbered, so the Queue tab can say which difficulty it is about
      // to hand out without having to index the window list itself.
      matchPoolName: season ? matchPoolName(season) : difficulty.name,
      windows: season?.windows ?? null,
      windowSize: season?.windowSize ?? null,
    },
    player: {
      totalRuns,
      scenarioCount: history.size,
      streak: playStreak(history, now),
      benchmarkRank: result.rankName,
      benchmarkEnergy: Math.round(result.totalEnergy),
      progressToNextRank: result.progressToNextRank,
      nextRankName: difficulty.rankNames[result.rankIndex + 1] ?? null,
      apogee: {
        rating: Math.round(rating.rating),
        rd: Math.round(rating.rd),
        percentile: Number(percentile.toFixed(1)),
        tier,
      },
    },
    theme: theme.tiers,
    categories,
    weakest: weakest.name,
    consistency,
    match: {
      seed,
      category: weakest.name,
      opponent: {
        name: "ravenous",
        rating: Math.round(opponentRating.rating),
        tier: tierForPercentile(theme, Math.max(0, percentile - 6)),
      },
      winProbability: winProbability(rating, opponentRating),
      verdict: settlement.verdict,
      explanation: explainVerdict(settlement),
      ratingWeight: settlement.ratingWeight,
      playerMatchScore: settlement.player.matchScore,
      opponentMatchScore: settlement.opponent.matchScore,
      rounds: settlement.player.rounds.map((r, i) => ({
        label: variantLabel(r.scenarioName),
        you: { score: r.score, baseline: Math.round(r.baseline), delta: r.delta },
        them: {
          score: settlement.opponent.rounds[i]?.score ?? 0,
          baseline: Math.round(settlement.opponent.rounds[i]?.baseline ?? 0),
          delta: settlement.opponent.rounds[i]?.delta ?? 0,
        },
      })),
    },
    quests,
  };
}
