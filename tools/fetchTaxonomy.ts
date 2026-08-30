/**
 * Fetch KovaaK's own metadata for every scenario the season pool names.
 *
 *   npx tsx tools/fetchTaxonomy.ts [--delay 350] [--force]
 *
 * Four things per scenario that cannot be invented and must not be guessed:
 *
 *   aimType      KovaaK's authoritative Clicking / Tracking / Switching classification.
 *                `generate_seed.py` prefers this over everything else, and the whole
 *                match-category system keys off the `aim_type` column it fills.
 *   topScore     the world record. Verification uses it as a ceiling: a submitted score
 *                above the best score any human has posted is not a score.
 *   plays        how much the scenario is actually run, which is what a pool drawn from
 *                "the benchmarks people play" has to be able to show.
 *   leaderboardId the board the thresholds are sampled from.
 *
 * WHY THIS REPLACES tools/fetch_scenario_taxonomy.py
 *
 * That script carried the seventeen Voltaic S5 families as a literal list and rewrote the
 * whole file from them. Correct while the season was Voltaic's eighteen scenarios and a
 * loaded gun afterwards: run it once against a pool drawn from fifteen benchmarks and
 * every scenario outside Voltaic silently loses its aim type, which the seed then fills
 * from the benchmark's own category name - and Voltaic's Elite tier names its categories
 * by sub-category, so Pasu comes back classified as "Dynamic". Two tools writing one file
 * from two different ideas of what belongs in it is the trap, not the list.
 *
 * So the pool is the list. Existing entries are kept and refreshed rather than dropped,
 * because a scenario that has left the pool is still named by `data/benchmarks/*.json`
 * and the seed still wants its aim type.
 *
 * The search is fuzzy - "Popcorn Voltaic" returns "Popcorn Voltaic Easy" first - so only
 * an exact name match counts, and a scenario with no exact match is reported rather than
 * approximated.
 *
 * Output: data/scenario_taxonomy.json, committed.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const POOL = join(root, "data", "pool.json");
const BENCH_DIR = join(root, "data", "benchmarks");
const OUT = join(root, "data", "scenario_taxonomy.json");

const API = "https://kovaaks.com/webapp-backend/scenario/popular";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";
const BACKOFF_MS = [5_000, 15_000, 45_000];

const args = process.argv.slice(2);
const delayAt = args.indexOf("--delay");
const DELAY_MS = delayAt !== -1 ? Number(args[delayAt + 1]) : 350;
/** Refresh entries that are already present. Off by default: they rarely move. */
const FORCE = args.includes("--force");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TaxonomyEntry {
  name: string;
  /** Which window of the pool this grades, when it is in the pool. */
  difficulty: string;
  leaderboardId: number | null;
  aimType: string | null;
  description: string;
  plays: number | null;
  entries: number | null;
  topScore: number | null;
}

interface TaxonomyFile {
  source: string;
  fetchedAt: string;
  scenarios: TaxonomyEntry[];
  missing?: string[];
}

interface Pool {
  windows: string[];
  families: {
    family: string;
    category: string;
    variants: { window: number; scenario: string }[];
  }[];
}

interface SearchRow {
  scenarioName?: string;
  leaderboardId?: number;
  scenario?: { aimType?: string; description?: string };
  counts?: { plays?: number; entries?: number };
  topScore?: { score?: number };
}

/**
 * Every scenario worth having metadata for: the pool first, then anything a committed
 * benchmark definition names.
 *
 * The benchmarks matter because `supabase/seed.sql` is built from them, and a scenario
 * there with no aim type is a scenario no category queue can ever draw.
 */
function wanted(): Map<string, string> {
  const out = new Map<string, string>();

  const pool = JSON.parse(readFileSync(POOL, "utf8")) as Pool;
  for (const family of pool.families) {
    for (const v of family.variants) {
      out.set(v.scenario, pool.windows[v.window] ?? `window ${v.window + 1}`);
    }
  }

  for (const file of readdirSync(BENCH_DIR).filter((f) => f.endsWith(".json"))) {
    const def = JSON.parse(readFileSync(join(BENCH_DIR, file), "utf8")) as {
      difficulties?: { name: string; categories?: { scenarios?: { name: string }[] }[] }[];
    };
    for (const difficulty of def.difficulties ?? []) {
      for (const category of difficulty.categories ?? []) {
        for (const scenario of category.scenarios ?? []) {
          if (!out.has(scenario.name)) out.set(scenario.name, difficulty.name);
        }
      }
    }
  }

  return out;
}

async function search(name: string): Promise<SearchRow | null> {
  const url =
    `${API}?page=0&max=20&scenarioNameSearch=${encodeURIComponent(name)}`;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const payload = (await res.json()) as { data?: SearchRow[] };
        // Fuzzy search: only the exact name is this scenario.
        return (payload.data ?? []).find((r) => r.scenarioName === name) ?? null;
      }
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

async function main(): Promise<number> {
  let existing: TaxonomyFile = {
    source: "kovaaks.com/webapp-backend/scenario/popular",
    fetchedAt: "",
    scenarios: [],
  };
  try {
    existing = JSON.parse(readFileSync(OUT, "utf8")) as TaxonomyFile;
  } catch {
    // First run.
  }

  const known = new Map(existing.scenarios.map((s) => [s.name, s]));
  const list = wanted();
  const todo = [...list.keys()].filter((n) => FORCE || !known.has(n));

  console.log(
    `${list.size} scenarios wanted, ${known.size} already known, ${todo.length} to fetch`,
  );

  const missing: string[] = [];
  let done = 0;

  for (const name of todo) {
    done++;
    const row = await search(name);
    await sleep(DELAY_MS);

    if (!row) {
      missing.push(name);
      console.log(`${String(done).padStart(3)}/${todo.length} ?? ${name}`);
      continue;
    }

    known.set(name, {
      name,
      difficulty: list.get(name) ?? "",
      leaderboardId: row.leaderboardId ?? null,
      aimType: row.scenario?.aimType ?? null,
      description: (row.scenario?.description ?? "").trim(),
      plays: row.counts?.plays ?? null,
      entries: row.counts?.entries ?? null,
      topScore: row.topScore?.score ?? null,
    });

    console.log(
      `${String(done).padStart(3)}/${todo.length} ${name.slice(0, 46).padEnd(48)}` +
        `${(row.scenario?.aimType ?? "?").padEnd(18)}` +
        `${(row.counts?.plays ?? 0).toLocaleString().padStart(12)} plays`,
    );
  }

  // Keep the window label current even for entries that were not refetched: the pool
  // moves between seasons and a stale label reads as a scenario in the wrong band.
  for (const [name, window] of list) {
    const entry = known.get(name);
    if (entry) entry.difficulty = window;
  }

  const scenarios = [...known.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        source: "kovaaks.com/webapp-backend/scenario/popular",
        fetchedAt: new Date().toISOString(),
        scenarios,
        ...(missing.length > 0 ? { missing } : {}),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const typed = scenarios.filter((s) => s.aimType).length;
  const records = scenarios.filter((s) => s.topScore).length;
  console.log(
    `\n${scenarios.length} scenarios -> ${OUT}\n` +
      `  ${typed} with an aim type, ${records} with a world record`,
  );
  if (missing.length > 0) {
    console.log(
      `  ${missing.length} with no exact match on KovaaK's: ${missing.join(", ")}`,
    );
  }
  return missing.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
