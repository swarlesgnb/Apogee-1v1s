/** Shapes of the benchmark definitions in data/benchmarks/*.json. */

export interface ScenarioDef {
  name: string;
  leaderboardId: number | null;
  /** Score thresholds, ascending, one per rank in `rankNames`. */
  rankMaxes: number[];
}

export interface CategoryDef {
  name: string;
  /** Category-level energy thresholds, one per rank. */
  rankMaxes: number[];
  scenarios: ScenarioDef[];
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
