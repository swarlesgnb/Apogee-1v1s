/**
 * Publish evxl's benchmark listing with a measured audience beside each entry.
 *
 *   npx tsx tools/benchmarkPopularity.ts [--top 15] [--sample 8] [--delay 400]
 *
 * WHY THIS EXISTS
 *
 * The pool used to be gated on this: a scenario was allowed only if it came from one of
 * the fifteen most-played benchmarks on evxl. It is not any more - `data/pool.json` names
 * its own sources, because a top-fifteen cut cannot reach Viscose or Jade Palace and lets
 * in nothing from outside the list however good it is.
 *
 * So this is a report rather than a gate, and it is still worth having. "Season 1 is built
 * out of what people actually play" is a claim about a website, and the sources list needs
 * a number beside each entry that says whether that is true of it - 60,536 next to Viscose
 * and 83 next to snakbox are both facts the pool should have to show.
 *
 * THE RANKING IS EVXL'S OWN ORDER, NOT A DERIVED ONE
 *
 * evxl serves its benchmark list from /data/benchmarks in a deliberate order - Sparky, the
 * five Voltaic seasons, Revosect, Aimerz+, Community, cA - which is neither alphabetical
 * nor by date added. It is the order a visitor to evxl.app sees, chosen by the one person
 * who can see the traffic. Nobody outside evxl can see that traffic, so this order is the
 * best available answer to "most played on evxl.app". It is what `evxlListingRank` records
 * and what this file is sorted by.
 *
 * Deriving the ranking from KovaaK's data instead was tried twice and does not work, which
 * is worth writing down so it is not tried a third time:
 *
 *   Median leaderboard entries over a benchmark's scenarios ranks TZY SpeedClicking, cR
 *   Main and Speedclick Archive above every Voltaic season. Those are built out of
 *   Gridshot, Tile Frenzy and 1wall6targets - half a million scores each, accumulated over
 *   years by people who had never heard of the benchmark. It measures the age of the
 *   scenarios, not the reach of the benchmark.
 *
 *   Restricting that to a benchmark's *own* scenarios - the ones no other benchmark in the
 *   registry names - fixes the inflation and introduces the opposite bias: it penalises a
 *   benchmark precisely for being copied. Voltaic S5 falls out of the top thirty because
 *   Voltaic S5.5, Astro and Anima all reuse its scenarios, which is a symptom of its
 *   importance rather than its obscurity.
 *
 * SO WHAT IS MEASURED IS REACH, AND IT IS A CHECK RATHER THAN THE RANKING
 *
 *   players = median accounts holding a score on the benchmark's own scenarios,
 *             sampled evenly across all of its difficulties
 *
 * Own scenarios only, so a decade of Tile Frenzy scores cannot be claimed as an audience.
 * Sampled per difficulty because a single stride through the name-sorted list aliases:
 * "VT Pasu Advanced S5" sorts before "Intermediate" sorts before "Novice", so a stride
 * equal to the family count lands on one tier every time - which is how the first cut
 * measured Voltaic S5 entirely on its Advanced scenarios.
 *
 * Read it as a **floor** on the audience, not a count of it: a benchmark whose scenarios
 * were widely copied is undercounted by exactly the copying. A benchmark that borrowed
 * every scenario it uses carries a null, which is the honest answer rather than a zero.
 *
 * Polite by construction: one request at a time with a pause between, everything cached
 * under `.cache/`, and the whole job only needs doing when the registry changes.
 *
 * Output: data/benchmark_popularity.json, committed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const REGISTRY = join(root, "data", "evxl_registry.json");
const OUT = join(root, "data", "benchmark_popularity.json");
const CACHE = join(root, ".cache", "kovaaks");
const ENTRIES_CACHE = join(CACHE, "entries.json");

const PROGRESS =
  "https://kovaaks.com/webapp-backend/benchmarks/player-progress-rank-benchmark";
const BOARD = "https://kovaaks.com/webapp-backend/leaderboard/scores/global";
/** A syntactically valid but unused SteamID: returns the thresholds with zeroed scores. */
const ANON = "76561198000000000";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";

/** 400ms was arrived at by being throttled at 120ms - the same figure sampleLeaderboard uses. */
const DEFAULT_DELAY_MS = 400;
const BACKOFF_MS = [5_000, 15_000, 45_000];

/**
 * Fewest own scenarios a benchmark needs before its median means anything.
 *
 * Below this the number is one or two scenarios' luck rather than a benchmark's reach,
 * and reporting it next to a figure drawn from twenty would invite the comparison.
 */
const MIN_OWN_SCENARIOS = 3;

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const at = args.indexOf(`--${name}`);
  const value = at !== -1 ? Number(args[at + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};

const TOP = flag("top", 15);
const SAMPLE = flag("sample", 8);
const DELAY_MS = flag("delay", DEFAULT_DELAY_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RegistryEntry {
  benchmarkName: string;
  abbreviation?: string;
  difficulties?: { difficultyName?: string; kovaaksBenchmarkId?: number | null }[];
}

interface Scenario {
  name: string;
  leaderboardId: number;
  difficulty: string;
}

interface BenchmarkPopularity {
  benchmark: string;
  abbreviation: string | null;
  /** Position in evxl's own published listing order, 1-based. */
  evxlListingRank: number;
  difficulties: string[];
  scenarios: number;
  /** Of those, the ones no other benchmark in the registry names. */
  ownScenarios: number;
  sampled: number;
  /**
   * Median leaderboard entries across the sampled own scenarios, or null when the
   * benchmark has too few of its own to measure.
   */
  players: number | null;
  /** What each sampled scenario carries, so the median can be re-derived by eye. */
  samples: { scenario: string; difficulty: string; entries: number }[];
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      // A 404 or a 400 is an answer: there is nothing here.
      if (res.status !== 429 && res.status < 500) return null;
      if (attempt === BACKOFF_MS.length) return null;
      await sleep(BACKOFF_MS[attempt]);
    } catch {
      if (attempt === BACKOFF_MS.length) return null;
      await sleep(BACKOFF_MS[attempt]);
    }
  }
  return null;
}

/** Benchmark definitions never change once published, so a cached one is used forever. */
async function definition(benchmarkId: number): Promise<Record<string, unknown> | null> {
  const file = join(CACHE, `benchmark-${benchmarkId}.json`);
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      // A truncated cache entry is refetched rather than trusted.
    }
  }

  const data = await getJson(`${PROGRESS}?benchmarkId=${benchmarkId}&steamId=${ANON}`);
  await sleep(DELAY_MS);
  if (!data) return null;

  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify(data), "utf8");
  return data;
}

function scenariosOf(data: Record<string, unknown>, difficultyName: string): Scenario[] {
  const out: Scenario[] = [];
  const categories = (data.categories ?? {}) as Record<
    string,
    { scenarios?: Record<string, { leaderboard_id?: number }> }
  >;

  for (const cat of Object.values(categories)) {
    for (const [name, scenario] of Object.entries(cat.scenarios ?? {})) {
      const id = scenario.leaderboard_id;
      if (typeof id === "number" && id > 0) {
        out.push({ name, leaderboardId: id, difficulty: difficultyName });
      }
    }
  }
  return out;
}

/**
 * How many accounts hold a score on a board.
 *
 * Cached to disk as well as in memory: the same board serves many benchmarks, and a rerun
 * after a registry change should not re-ask several hundred questions already answered.
 */
const entries = new Map<number, number | null>(
  existsSync(ENTRIES_CACHE)
    ? Object.entries(JSON.parse(readFileSync(ENTRIES_CACHE, "utf8")) as Record<string, number>).map(
        ([id, total]) => [Number(id), total] as [number, number],
      )
    : [],
);
let entriesDirty = false;

async function entriesFor(leaderboardId: number): Promise<number | null> {
  if (entries.has(leaderboardId)) return entries.get(leaderboardId)!;

  const data = await getJson(`${BOARD}?leaderboardId=${leaderboardId}&page=0&max=1`);
  await sleep(DELAY_MS);

  const total = typeof data?.total === "number" ? data.total : null;
  entries.set(leaderboardId, total);
  entriesDirty = true;
  return total;
}

function saveEntries(): void {
  if (!entriesDirty) return;
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(
    ENTRIES_CACHE,
    JSON.stringify(Object.fromEntries([...entries].filter(([, v]) => v !== null))),
    "utf8",
  );
  entriesDirty = false;
}

/**
 * Spread `count` picks evenly across a list.
 *
 * Only ever applied within one difficulty. Applied across a whole benchmark it aliases:
 * the name-sorted list of "VT <family> <tier> S5" runs Advanced, Elite, Intermediate,
 * Novice inside each family, so a stride equal to the family count lands on one tier every
 * time - which is how Voltaic S5 came to be measured entirely on its Advanced scenarios.
 */
function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]);
}

/** Sample evenly across difficulties, in proportion to how many scenarios each holds. */
function stratified(scenarios: Scenario[], count: number): Scenario[] {
  const byDifficulty = new Map<string, Scenario[]>();
  for (const s of scenarios) {
    byDifficulty.set(s.difficulty, [...(byDifficulty.get(s.difficulty) ?? []), s]);
  }

  const out: Scenario[] = [];
  for (const [, group] of [...byDifficulty].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const share = Math.max(1, Math.round((count * group.length) / scenarios.length));
    out.push(...spread([...group].sort((a, b) => (a.name < b.name ? -1 : 1)), share));
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

async function main(): Promise<number> {
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8")) as {
    fetchedAt?: string;
    benchmarks: RegistryEntry[];
  };

  // evxl's registry is committed sorted by name so it diffs cleanly, which discards the
  // listing order the site publishes. Re-read that from the live route when it is
  // reachable; fall back to the committed order and say so.
  let listingOrder: string[] = registry.benchmarks.map((b) => b.benchmarkName);
  try {
    const res = await fetch("https://evxl.app/data/benchmarks", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const live = (await res.json()) as RegistryEntry[];
      if (Array.isArray(live) && live.length > 0) listingOrder = live.map((b) => b.benchmarkName);
    }
  } catch {
    console.log("evxl unreachable - listing rank falls back to the committed order");
  }
  const listingRank = new Map(listingOrder.map((name, i) => [name, i + 1]));

  // ---- every benchmark's scenarios, and who else names them -------------------------
  console.log(`reading ${registry.benchmarks.length} benchmark definitions`);

  const scenariosPerBenchmark = new Map<string, Scenario[]>();
  const namedBy = new Map<string, Set<string>>();

  for (const entry of registry.benchmarks) {
    const linked = (entry.difficulties ?? []).filter(
      (d) => typeof d.kovaaksBenchmarkId === "number" && d.kovaaksBenchmarkId > 0,
    );

    const byName = new Map<string, Scenario>();
    for (const d of linked) {
      const data = await definition(d.kovaaksBenchmarkId!);
      if (!data) continue;
      for (const s of scenariosOf(data, d.difficultyName ?? "")) {
        if (!byName.has(s.name)) byName.set(s.name, s);
        const owners = namedBy.get(s.name) ?? new Set<string>();
        owners.add(entry.benchmarkName);
        namedBy.set(s.name, owners);
      }
    }
    scenariosPerBenchmark.set(entry.benchmarkName, [...byName.values()]);
  }

  // ---- measure ----------------------------------------------------------------------
  const results: BenchmarkPopularity[] = [];
  let done = 0;

  for (const entry of registry.benchmarks) {
    done++;
    const all = scenariosPerBenchmark.get(entry.benchmarkName) ?? [];
    if (all.length === 0) continue;

    const own = all.filter((s) => (namedBy.get(s.name)?.size ?? 0) === 1);

    const linked = (entry.difficulties ?? [])
      .filter((d) => typeof d.kovaaksBenchmarkId === "number" && d.kovaaksBenchmarkId > 0)
      .map((d) => d.difficultyName ?? "");

    const base: Omit<BenchmarkPopularity, "players" | "samples" | "sampled"> = {
      benchmark: entry.benchmarkName,
      abbreviation: entry.abbreviation ?? null,
      evxlListingRank: listingRank.get(entry.benchmarkName) ?? Number.MAX_SAFE_INTEGER,
      difficulties: linked,
      scenarios: all.length,
      ownScenarios: own.length,
    };

    if (own.length < MIN_OWN_SCENARIOS) {
      results.push({ ...base, sampled: 0, players: null, samples: [] });
      console.log(
        `${String(done).padStart(3)}/${registry.benchmarks.length} ` +
          `${entry.benchmarkName.slice(0, 44).padEnd(46)}` +
          `${"unmeasurable".padStart(14)}  ${own.length} own scenario(s)`,
      );
      continue;
    }

    const samples: { scenario: string; difficulty: string; entries: number }[] = [];
    for (const s of stratified(own, SAMPLE)) {
      const total = await entriesFor(s.leaderboardId);
      if (total !== null) {
        samples.push({ scenario: s.name, difficulty: s.difficulty, entries: total });
      }
    }
    saveEntries();

    results.push({
      ...base,
      sampled: samples.length,
      players: samples.length > 0 ? median(samples.map((s) => s.entries)) : null,
      samples,
    });

    console.log(
      `${String(done).padStart(3)}/${registry.benchmarks.length} ` +
        `${entry.benchmarkName.slice(0, 44).padEnd(46)}` +
        `${(results[results.length - 1].players ?? 0).toLocaleString().padStart(12)} players  ` +
        `${own.length}/${all.length} own`,
    );
  }

  // evxl's own order. The reach measured above rides alongside it and never reorders it -
  // see the header for the two ways deriving an order from KovaaK's data goes wrong.
  results.sort((a, b) => a.evxlListingRank - b.evxlListingRank);

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        source: `${BOARD} (leaderboard entries per scenario)`,
        measuredAt: new Date().toISOString(),
        registryFetchedAt: registry.fetchedAt ?? null,
        sampleSize: SAMPLE,
        order:
          "evxl's own published listing order, read live from https://evxl.app/data/benchmarks. " +
          "That order is chosen by the one person who can see evxl's traffic and is what a " +
          "visitor to the site sees, so it is what most-played-on-evxl means here. The " +
          "measured reach below never reorders it.",
        method:
          "A benchmark's reach is the median number of accounts holding a score on its own " +
          "scenarios - the ones no other benchmark in evxl's registry names - sampled " +
          `evenly across all of its difficulties, up to ${SAMPLE} of them. Own scenarios ` +
          "only, because a benchmark assembled from Gridshot and Tile Frenzy would " +
          "otherwise inherit a decade of other people's scores; per difficulty, because a " +
          "single stride through the name-sorted list lands on one tier every time. Read it " +
          "as a floor on the audience: a benchmark whose scenarios were widely copied is " +
          `undercounted by exactly the copying. Fewer than ${MIN_OWN_SCENARIOS} own ` +
          "scenarios means there is nothing to measure, and the entry carries a null.",
        benchmarks: results,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`\nevxl's first ${TOP} listings, and the audience each can be shown to have:\n`);
  console.log(
    `    ${"benchmark".padEnd(44)}${"players".padStart(10)}  ${"own".padStart(7)}  difficulties`,
  );
  const top = results.slice(0, TOP);
  for (const r of top) {
    console.log(
      `${String(r.evxlListingRank).padStart(3)} ${r.benchmark.slice(0, 42).padEnd(44)}` +
        `${(r.players === null ? "unmeasured" : r.players.toLocaleString()).padStart(10)}  ` +
        `${`${r.ownScenarios}/${r.scenarios}`.padStart(7)}  ${r.difficulties.join(" / ")}`,
    );
  }

  const scenarios = top.reduce((n, r) => n + r.scenarios, 0);
  const unmeasured = top.filter((r) => r.players === null);
  console.log(
    `\n${scenarios} scenarios across the top ${TOP}; ` +
      `${top.filter((r) => (r.players ?? 0) >= 10_000).length} of them carry at least ` +
      `10,000 accounts on their own scenarios`,
  );
  if (unmeasured.length > 0) {
    console.log(
      `${unmeasured.length} borrow every scenario they use, so their audience cannot be ` +
        `measured: ${unmeasured.map((r) => r.benchmark).join(", ")}`,
    );
  }
  console.log(`written to ${OUT}`);
  return 0;
}

main().then(
  (code) => {
    saveEntries();
    process.exit(code);
  },
  (err: unknown) => {
    saveEntries();
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
