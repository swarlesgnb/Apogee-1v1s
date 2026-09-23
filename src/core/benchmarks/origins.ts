/**
 * Which published benchmarks a scenario belongs to, and what rank your score is worth
 * in each of them.
 *
 * Apogee's pool is not invented. Every family in it was picked out of the corpus the
 * community already grades itself against, and 184 of the season's 256 scenarios appear
 * in at least one of the 43 benchmarks under `data/benchmarks/`; the fun rebuild chose
 * some families for how much they are replayed rather than for benchmark membership. `1wall5targets_pasu Reload` is in Aimerz+ Easy, Aimerz+ Hard, snakbox Medium,
 * Voltaic All and Viscose Medium at once.
 *
 * That is worth saying out loud rather than leaving as a fact about the data. A session
 * on this ladder is a session on those ladders, and a player who already grinds Voltaic
 * is not being asked to start over - they are being asked to look at what they have.
 *
 * WHAT IS DERIVED HERE AND WHAT IS NOT
 *
 * The rank is per *scenario*, never per benchmark. Every benchmark file publishes score
 * thresholds for each scenario it names, so "your Pasu score is Gold in Voltaic S5" is a
 * fact read straight off the author's own table. "Your Voltaic S5 rank is Gold" is not,
 * and this deliberately will not say it: the pool takes 16 of Voltaic S5's 72 scenarios and
 * not all of them, so any overall figure would be computed from a partial sheet and would
 * be wrong in the flattering direction. A benchmark's overall rank belongs to the
 * benchmark.
 */

import { readdirSync, readFileSync } from "node:fs";

import { dataFile } from "../dataDir.ts";

/** One benchmark difficulty that names a scenario, with that scenario's own thresholds. */
export interface Origin {
  benchmark: string;
  /** The author's short form, which is what fits beside a score. "VT", "VSC", "A+". */
  abbreviation: string;
  /** The benchmark's own brand colour, so its mark is recognisable at a glance. */
  color: string;
  difficulty: string;
  rankNames: string[];
  rankColors: Record<string, string>;
  /** Ascending score thresholds, one per rank name. */
  rankMaxes: number[];
}

interface BenchmarkFile {
  benchmarkName?: string;
  abbreviation?: string;
  color?: string;
  difficulties?: {
    name?: string;
    rankNames?: string[];
    rankColors?: Record<string, string>;
    categories?: { scenarios?: { name?: string; rankMaxes?: number[] }[] }[];
  }[];
}

let cache: Map<string, Origin[]> | null = null;

/**
 * Scenario name to every benchmark difficulty that publishes it.
 *
 * Read once and held, because this is 43 files behind a screen that redraws on every
 * snapshot. Keyed on the exact KovaaK's scenario name, which is the only identifier the
 * benchmark files and the stats folder agree on.
 */
export function loadOrigins(): Map<string, Origin[]> {
  if (cache) return cache;

  const index = new Map<string, Origin[]>();
  const dir = dataFile("benchmarks");

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;

    let parsed: BenchmarkFile;
    try {
      parsed = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as BenchmarkFile;
    } catch {
      // A benchmark that will not parse is one benchmark missing from a chip row, not a
      // reason for the practice screen to fail to render.
      continue;
    }

    const benchmark = parsed.benchmarkName ?? file.replace(/\.json$/, "");
    const abbreviation = parsed.abbreviation ?? benchmark.slice(0, 3).toUpperCase();
    const color = parsed.color ?? "#8891a3";

    for (const difficulty of parsed.difficulties ?? []) {
      const rankNames = difficulty.rankNames ?? [];
      const rankColors = difficulty.rankColors ?? {};
      if (rankNames.length === 0) continue;

      for (const category of difficulty.categories ?? []) {
        for (const scenario of category.scenarios ?? []) {
          const maxes = scenario.rankMaxes ?? [];
          // A scenario whose thresholds do not line up with the rank names cannot be
          // scored against, and guessing which end to trim would invent a rank.
          if (!scenario.name || maxes.length !== rankNames.length) continue;

          index.set(scenario.name, [
            ...(index.get(scenario.name) ?? []),
            {
              benchmark,
              abbreviation,
              color,
              difficulty: difficulty.name ?? "",
              rankNames,
              rankColors,
              rankMaxes: maxes,
            },
          ]);
        }
      }
    }
  }

  cache = index;
  return index;
}

export interface OriginRank {
  benchmark: string;
  abbreviation: string;
  color: string;
  difficulty: string;
  /** The rank this score holds, or null when it is under the first threshold. */
  rankName: string | null;
  rankColor: string | null;
  /** The next rank up and what it costs, or null at the top. */
  nextName: string | null;
  nextScore: number | null;
}

/**
 * What `best` is worth in one benchmark.
 *
 * Highest threshold cleared, which is how every benchmark in the corpus reads its own
 * table. A score under the first threshold holds no rank and says so with a null rather
 * than with the bottom rank's name - "you are Iron" and "you have not reached Iron" are
 * different sentences, and the second one is the true one.
 */
export function rankIn(origin: Origin, best: number | null): OriginRank {
  let held = -1;
  if (best !== null) {
    for (let i = 0; i < origin.rankMaxes.length; i++) {
      if (best >= origin.rankMaxes[i]) held = i;
    }
  }

  const name = held >= 0 ? origin.rankNames[held] : null;
  const next = held + 1 < origin.rankNames.length ? held + 1 : -1;

  return {
    benchmark: origin.benchmark,
    abbreviation: origin.abbreviation,
    color: origin.color,
    difficulty: origin.difficulty,
    rankName: name,
    rankColor: name ? origin.rankColors[name] ?? null : null,
    nextName: next >= 0 ? origin.rankNames[next] : null,
    nextScore: next >= 0 ? origin.rankMaxes[next] : null,
  };
}

/**
 * Every benchmark that names `scenario`, with the rank `best` holds in each.
 *
 * Ordered by how far up the scenario's own ladder the score sits, so the benchmark the
 * player is doing best in comes first and the row reads as an achievement rather than as
 * a list. Ties break on the benchmark's name, so the order is stable between renders.
 */
export function originsOf(scenario: string, best: number | null): OriginRank[] {
  const origins = loadOrigins().get(scenario) ?? [];

  return origins
    .map((o) => ({ o, rank: rankIn(o, best) }))
    .sort((a, b) => {
      const at = a.rank.rankName ? a.o.rankNames.indexOf(a.rank.rankName) / a.o.rankNames.length : -1;
      const bt = b.rank.rankName ? b.o.rankNames.indexOf(b.rank.rankName) / b.o.rankNames.length : -1;
      return bt - at || a.o.benchmark.localeCompare(b.o.benchmark);
    })
    .map((x) => x.rank);
}
