/**
 * Pull evxl's benchmark registry from the JSON route evxl publishes.
 *
 *   npx tsx tools/fetchEvxlRegistry.ts [--force] [--dry-run]
 *
 * The registry is the map from a benchmark name to its KovaaK's benchmark id, so
 * everything downstream starts here: tools/fetch_benchmark_defs.py turns those ids into
 * real thresholds, and an evxl link a player pastes is resolved against this file.
 *
 * This replaces scraping the same JSON literal out of evxl's client bundle. evxl's
 * author pointed at /data/benchmarks directly, which is a route he maintains rather than
 * a bundle layout that moves with every deploy — and the scrape had quietly gone stale,
 * leaving 15 benchmarks in the committed registry that evxl had already dropped.
 *
 * Requested by evxl and honoured here: the registry rarely changes, so a copy younger
 * than 24h is used as-is and no request goes out at all. When one does go out it carries
 * the stored ETag, so an unchanged registry costs a 304 and nothing is rewritten.
 *
 * Output: data/evxl_registry.json, committed — the app never reads evxl at runtime.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT = join(root, "data", "evxl_registry.json");

const SOURCE = "https://evxl.app/data/benchmarks";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 30_000;

/**
 * A refresh that would drop more than a third of the registry is treated as a bad
 * response, not as news. A truncated or half-deployed payload otherwise overwrites a
 * good file and the loss only surfaces later, when a player's link stops resolving.
 */
const MIN_RETAINED = 0.66;

interface RegistryEntry {
  benchmarkName: string;
  [key: string]: unknown;
}

interface RegistryFile {
  source: string;
  fetchedAt?: string;
  /** Sent back as If-None-Match, so an unchanged registry costs one 304. */
  etag?: string;
  count: number;
  benchmarks: RegistryEntry[];
}

const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

function readPrevious(): RegistryFile | null {
  try {
    const parsed = JSON.parse(readFileSync(OUT, "utf8")) as RegistryFile;
    return Array.isArray(parsed?.benchmarks) ? parsed : null;
  } catch {
    return null;
  }
}

function write(file: RegistryFile): void {
  if (dryRun) {
    console.log("--dry-run: not written");
    return;
  }
  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** Codepoint order, so the committed file diffs cleanly and never reorders on a whim. */
function byName(a: RegistryEntry, b: RegistryEntry): number {
  return a.benchmarkName < b.benchmarkName ? -1 : a.benchmarkName > b.benchmarkName ? 1 : 0;
}

async function main(): Promise<number> {
  const previous = readPrevious();
  const fetchedAt = previous?.fetchedAt ? Date.parse(previous.fetchedAt) : NaN;
  const age = Number.isFinite(fetchedAt) ? Date.now() - fetchedAt : Number.POSITIVE_INFINITY;

  if (!force && age < MAX_AGE_MS) {
    const hours = (age / 3_600_000).toFixed(1);
    console.log(`cached ${hours}h ago, ${previous!.count} benchmarks — inside the 24h window`);
    console.log("  --force to fetch anyway");
    return 0;
  }

  const res = await fetch(SOURCE, {
    headers: {
      Accept: "application/json",
      ...(previous?.etag ? { "If-None-Match": previous.etag } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 304 && previous) {
    console.log(`304 not modified — ${previous.count} benchmarks unchanged`);
    // Stamp it anyway, or every later run re-asks a question already answered.
    write({ ...previous, fetchedAt: new Date().toISOString() });
    return 0;
  }

  if (!res.ok) {
    console.error(`GET ${SOURCE} failed: HTTP ${res.status}`);
    return 1;
  }

  const payload: unknown = await res.json();
  if (!Array.isArray(payload) || payload.length === 0) {
    console.error("unexpected payload: expected a non-empty array of benchmarks");
    return 1;
  }

  const benchmarks = payload.filter(
    (entry): entry is RegistryEntry =>
      typeof entry === "object" && entry !== null && typeof (entry as RegistryEntry).benchmarkName === "string",
  );
  if (benchmarks.length !== payload.length) {
    console.error(`${payload.length - benchmarks.length} entries carry no benchmarkName — refusing`);
    return 1;
  }

  if (previous && benchmarks.length < previous.benchmarks.length * MIN_RETAINED) {
    console.error(
      `refusing: ${benchmarks.length} benchmarks would replace ${previous.benchmarks.length}`,
    );
    return 1;
  }

  benchmarks.sort(byName);

  if (previous) {
    const before = new Map(previous.benchmarks.map((b) => [b.benchmarkName, JSON.stringify(b)]));
    const after = new Map(benchmarks.map((b) => [b.benchmarkName, JSON.stringify(b)]));
    const added = [...after.keys()].filter((n) => !before.has(n));
    const removed = [...before.keys()].filter((n) => !after.has(n));
    const changed = [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n));

    for (const name of added) console.log(`  + ${name}`);
    for (const name of removed) console.log(`  - ${name}`);
    for (const name of changed) console.log(`  ~ ${name}`);
    if (!added.length && !removed.length && !changed.length) console.log("  (no changes)");
  }

  const etag = res.headers.get("etag");
  write({
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    ...(etag ? { etag } : {}),
    count: benchmarks.length,
    benchmarks,
  });

  const linked = benchmarks.filter((b) =>
    ((b.difficulties as { kovaaksBenchmarkId?: number | null }[] | undefined) ?? []).some(
      (d) => typeof d.kovaaksBenchmarkId === "number" && d.kovaaksBenchmarkId > 0,
    ),
  ).length;
  console.log(`\n${benchmarks.length} benchmarks (${linked} with a KovaaK's id) -> data/evxl_registry.json`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
