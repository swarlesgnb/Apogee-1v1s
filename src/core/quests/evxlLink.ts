/**
 * Resolve a pasted evxl link into a tracked benchmark.
 *
 * The player grinds whichever benchmark they care about, pastes its evxl URL, and
 * Arena generates quests against *that* benchmark's real scenarios and thresholds
 * (PLAN.md §10). Nothing is hardcoded to Voltaic.
 *
 *   https://evxl.app/benchmarks/Voltaic%20S5
 *        -> benchmarkName "Voltaic S5"
 *        -> data/evxl_registry.json  -> kovaaksBenchmarkId per difficulty
 *        -> data/benchmarks/*.json   -> scenarios, thresholds, rank colours
 *
 * Resolution is offline: both files are committed, so pasting a link works with no
 * network call and cannot be broken by evxl changing.
 */

export interface ResolvedLink {
  benchmarkName: string;
  /** Difficulty named in the URL, when it carried one. */
  difficulty: string | null;
  source: "benchmarks" | "leaderboards" | "groups" | "name";
}

export interface BenchmarkRegistryEntry {
  benchmarkName: string;
  abbreviation?: string | null;
  color?: string | null;
  difficulties?: {
    difficultyName: string;
    kovaaksBenchmarkId?: number | null;
    rankColors?: Record<string, string>;
  }[];
}

/**
 * Pull a benchmark name out of an evxl URL, or accept a bare name.
 *
 * Accepts the shapes players actually paste: the benchmark page, a leaderboard URL, a
 * group page, or just the name typed by hand. Returns null rather than guessing when
 * the input names nothing.
 */
export function parseEvxlLink(input: string): ResolvedLink | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  // A bare name, e.g. "Voltaic S5".
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.includes("/")) {
    return { benchmarkName: trimmed, difficulty: null, source: "name" };
  }

  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (!/(^|\.)evxl\.app$/i.test(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 2) return null;

  const [kind, ...rest] = segments;

  if (kind === "benchmarks") {
    return {
      benchmarkName: rest[0],
      // /benchmarks/Voltaic S5/Intermediate
      difficulty: rest[1] ?? url.searchParams.get("difficulty"),
      source: "benchmarks",
    };
  }

  if (kind === "groups") {
    // A group page names a family rather than one benchmark; still useful as a hint.
    return { benchmarkName: rest[0], difficulty: null, source: "groups" };
  }

  if (kind === "leaderboards") {
    // /leaderboards/460 - a numeric KovaaK's benchmark id, resolved by the caller.
    return { benchmarkName: rest[0], difficulty: null, source: "leaderboards" };
  }

  return null;
}

/**
 * Fold a benchmark name for comparison: lowercase, punctuation and spacing removed.
 *
 * Unicode letters and digits are KEPT. An earlier version stripped everything outside
 * `[a-z0-9]`, which reduced the registry's non-Latin entries (e.g.
 * `二三的三角洲行动瞄准基准测试`) to an empty string, and since every string starts
 * with "", that entry then matched *any* unknown input, so a typo silently resolved to
 * a benchmark the player had never heard of.
 */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Shortest name length that may be fuzzily matched, to stop tiny names swallowing queries. */
const MIN_FUZZY_LENGTH = 3;

export interface BenchmarkMatch {
  entry: BenchmarkRegistryEntry;
  difficulty: string | null;
  /** True when the name matched exactly rather than fuzzily. */
  exact: boolean;
}

/**
 * Find the registry entry a parsed link refers to.
 *
 * Tolerates the ways a name drifts in a URL (casing, punctuation, "S5" vs "s5") but
 * never silently resolves to something unrelated: a fuzzy match must be a prefix or
 * containment, not merely similar.
 */
export function resolveBenchmark(
  link: ResolvedLink,
  registry: BenchmarkRegistryEntry[],
): BenchmarkMatch | null {
  // A numeric leaderboard id resolves through the KovaaK's benchmark id instead.
  if (link.source === "leaderboards" && /^\d+$/.test(link.benchmarkName)) {
    const id = Number(link.benchmarkName);
    for (const entry of registry) {
      const diff = entry.difficulties?.find((d) => d.kovaaksBenchmarkId === id);
      if (diff) {
        return { entry, difficulty: diff.difficultyName, exact: true };
      }
    }
    return null;
  }

  const wanted = normalise(link.benchmarkName);
  if (wanted === "") return null;

  const exact = registry.find((e) => normalise(e.benchmarkName) === wanted);
  if (exact) return { entry: exact, difficulty: resolveDifficulty(exact, link.difficulty), exact: true };

  const partial = registry.filter((e) => {
    const name = normalise(e.benchmarkName);
    // Both sides must be substantial, or a very short registry name matches
    // everything and an empty one matches literally anything.
    if (name.length < MIN_FUZZY_LENGTH || wanted.length < MIN_FUZZY_LENGTH) return false;
    return name.startsWith(wanted) || wanted.startsWith(name) || name.includes(wanted);
  });

  // Ambiguity is a failure, not a coin flip: "Voltaic" matches S3, S4, S5 and S5.5,
  // and silently picking one would quietly track the wrong benchmark.
  if (partial.length !== 1) return null;

  return {
    entry: partial[0],
    difficulty: resolveDifficulty(partial[0], link.difficulty),
    exact: false,
  };
}

function resolveDifficulty(
  entry: BenchmarkRegistryEntry,
  wanted: string | null,
): string | null {
  if (!wanted) return null;
  const target = normalise(wanted);
  const found = entry.difficulties?.find((d) => normalise(d.difficultyName) === target);
  return found?.difficultyName ?? null;
}

export interface TrackRequest {
  benchmarkName: string;
  difficulty: string;
  kovaaksBenchmarkId: number | null;
}

/**
 * Turn a resolved match into something trackable, choosing a difficulty when the link
 * did not name one.
 *
 * @param preferDifficulty the difficulty the player has most history in, supplied by
 *   the caller; tracking the tier they actually play beats defaulting to the first.
 */
export function toTrackRequest(
  match: BenchmarkMatch,
  preferDifficulty?: string | null,
): TrackRequest | null {
  const difficulties = (match.entry.difficulties ?? []).filter(
    (d) => typeof d.kovaaksBenchmarkId === "number" && d.kovaaksBenchmarkId > 0,
  );
  if (difficulties.length === 0) return null;

  const chosen =
    difficulties.find((d) => d.difficultyName === match.difficulty) ??
    difficulties.find((d) => d.difficultyName === preferDifficulty) ??
    // Prefer an official tier over "Elite (Unofficial)" when defaulting.
    difficulties.find((d) => !/unofficial/i.test(d.difficultyName)) ??
    difficulties[0];

  return {
    benchmarkName: match.entry.benchmarkName,
    difficulty: chosen.difficultyName,
    kovaaksBenchmarkId: chosen.kovaaksBenchmarkId ?? null,
  };
}
