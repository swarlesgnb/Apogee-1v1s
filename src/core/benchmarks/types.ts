/** Shapes of the benchmark definitions in data/benchmarks/*.json. */

export interface ScenarioDef {
  name: string;
  leaderboardId: number | null;
  /**
   * Score thresholds, ascending. One per rank on a flat ladder; one per rank *in this
   * variant's window* on a windowed one.
   */
  rankMaxes: number[];
  /**
   * The family this scenario is a variant of, e.g. "Pasu" for all three of
   * `VT Pasu Novice S5`, `VT Pasu Intermediate S5` and `VT Pasu Advanced S5`.
   *
   * A family is what actually gets graded on a windowed ladder: the variants measure the
   * same skill over different score ranges, so summing them would ask a player to grind
   * every difficulty of every scenario. Absent on a flat ladder, where each scenario is
   * its own family and nothing changes.
   */
  family?: string;
  /**
   * Which window this variant grades, 0-based.
   *
   * Window w covers ranks `w * windowSize` to `w * windowSize + windowSize - 1`
   * (0-based), so a variant's thresholds are offset by `w * windowSize` ranks of energy.
   */
  window?: number;
}

export interface CategoryDef {
  name: string;
  /** Category-level energy thresholds, one per rank. */
  rankMaxes: number[];
  scenarios: ScenarioDef[];
  /**
   * How many ranks each scenario window covers. Absent on a flat ladder.
   *
   * The ladder is `windowSize * windows` ranks deep, and every family must carry one
   * variant per window - which `validateSeason` enforces, because a family missing a
   * window would make the ranks it covers unreachable and say nothing about why.
   */
  windowSize?: number;
  /**
   * This category's own ladder, when it has one.
   *
   * A season gives Clicking, Tracking and Switching separate ranks (PLAN.md §14), so
   * "Tier II at Tracking" is a different claim from "Tier II at Clicking" and the two
   * do not have to share a vocabulary. Absent on a Voltaic benchmark, where one ladder
   * covers all three, and the difficulty's names are used instead.
   */
  rankNames?: string[];
  rankColors?: Record<string, string>;
}

export interface DifficultyDef {
  name: string;
  kovaaksBenchmarkId: number;
  rankNames: string[];
  /** Hex colour per rank name, from evxl's registry. */
  rankColors: Record<string, string>;
  categories: CategoryDef[];
}

export interface BenchmarkDef {
  benchmarkName: string;
  abbreviation: string | null;
  color: string | null;
  evxlUrl: string;
  difficulties: DifficultyDef[];
}
