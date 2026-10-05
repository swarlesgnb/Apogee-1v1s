/**
 * How many different sets of three the live ladder has actually played, per category.
 *
 * The check for the repeat that shipped with the first ranked week: a match answered from
 * the pool used to inherit its opponent's three scenarios, so a category's first seeding
 * match decided what nearly everyone in it played (src/core/match/matchmaking.ts). Run it
 * before and after the find-match deploy. Before, a category with a dozen matches shows
 * one or two sets; after, new matches should spread across the window.
 *
 * Read-only: GETs with the service key, nothing written.
 *
 *   npx tsx tools/countTriples.ts [--since 2026-10-05]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Minimal .env reader, the same one verifyDeployment uses. */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m && m[2]) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = loadEnv();
const URL_BASE = env.APOGEE_SUPABASE_URL?.replace(/\/+$/, "");
const SECRET = env.SUPABASE_SERVICE_ROLE_KEY;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    headers: { apikey: SECRET!, Authorization: `Bearer ${SECRET}` },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  if (!URL_BASE || !SECRET) {
    console.error("missing APOGEE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  const sinceArg = process.argv.indexOf("--since");
  const since = sinceArg >= 0 ? process.argv[sinceArg + 1] : null;

  const filter = since ? `&created_at=gte.${encodeURIComponent(new Date(since).toISOString())}` : "";
  const matches = await get<{ category: string; scenario_ids: number[]; status: string; created_at: string }[]>(
    `matches?select=category,scenario_ids,status,created_at&rated=eq.true&mode=eq.async${filter}` +
      "&order=created_at.asc&limit=5000",
  );

  const ids = [...new Set(matches.flatMap((m) => m.scenario_ids ?? []))];
  const names = new Map<number, string>();
  if (ids.length > 0) {
    const rows = await get<{ id: number; name: string }[]>(`scenarios?select=id,name&id=in.(${ids.join(",")})`);
    for (const r of rows) names.set(r.id, r.name);
  }

  const byCategory = new Map<string, Map<string, number>>();
  for (const m of matches) {
    if (!m.scenario_ids || m.scenario_ids.length === 0) continue;
    const key = [...m.scenario_ids].sort((a, b) => a - b).join(",");
    const sets = byCategory.get(m.category) ?? new Map<string, number>();
    sets.set(key, (sets.get(key) ?? 0) + 1);
    byCategory.set(m.category, sets);
  }

  console.log(`${matches.length} rated async matches${since ? ` since ${since}` : ""}\n`);

  for (const [category, sets] of [...byCategory].sort()) {
    const total = [...sets.values()].reduce((a, b) => a + b, 0);
    const scenarios = new Set([...sets.keys()].flatMap((k) => k.split(",")));
    console.log(`${category}: ${total} matches, ${sets.size} distinct set(s), ${scenarios.size} scenario(s)`);
    for (const [key, count] of [...sets].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      const label = key.split(",").map((id) => names.get(Number(id)) ?? `#${id}`).join(" / ");
      console.log(`  ${String(count).padStart(4)}×  ${label}`);
    }
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
