/**
 * Push scenario reference data to the live project.
 *
 * `supabase db push --include-seed` will not re-run a seed whose hash it has already
 * recorded: it updates the stored hash and reports success while applying nothing. That
 * is fine for a first deploy and useless for an update, which is exactly when reference
 * data changes (a corrected sub-category, a newly learned score model).
 *
 * So reference data is synced explicitly instead, by upsert, which is idempotent and
 * safe to run as often as you like. Nothing here touches player rows.
 *
 *   npx tsx tools/syncReferenceData.ts [--dry-run]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m && m[2]) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = loadEnv();
const URL_BASE = env.ARENA_SUPABASE_URL?.replace(/\/+$/, "");
const SECRET = env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes("--dry-run");

if (!URL_BASE || !SECRET) {
  console.error("ARENA_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  process.exit(1);
}

interface ScoreModel {
  stat: string;
  k: number;
}

function readJson<T>(...p: string[]): T {
  return JSON.parse(readFileSync(join(root, ...p), "utf8")) as T;
}

/** PostgREST upsert. `on_conflict` makes it an update when the row already exists. */
async function upsert(table: string, rows: unknown[], onConflict: string): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const res = await fetch(`${URL_BASE}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: {
        apikey: SECRET!,
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      throw new Error(`${table} upsert failed: HTTP ${res.status} ${await res.text()}`);
    }
  }
}

async function count(table: string, filter: string): Promise<number> {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?select=count&${filter}`, {
    headers: {
      apikey: SECRET!,
      Authorization: `Bearer ${SECRET}`,
      Prefer: "count=exact",
    },
  });
  const body = (await res.json()) as { count: number }[];
  return body[0]?.count ?? 0;
}

async function main(): Promise<void> {
  const models = readJson<{ models: Record<string, ScoreModel> }>("data", "score_models.json").models;
  const taxonomy = readJson<{ scenarios: { name: string; topScore: number | null }[] }>(
    "data",
    "scenario_taxonomy.json",
  ).scenarios;

  const worldRecords = new Map(
    taxonomy.filter((s) => s.topScore).map((s) => [s.name, s.topScore!]),
  );

  // Only scenarios that already exist are updated; this never invents rows, so a name
  // that is not in the benchmark set is simply skipped.
  const existing = await fetch(`${URL_BASE}/rest/v1/scenarios?select=name`, {
    headers: { apikey: SECRET!, Authorization: `Bearer ${SECRET}` },
  }).then((r) => r.json() as Promise<{ name: string }[]>);

  const known = new Set(existing.map((s) => s.name));

  const rows: Record<string, unknown>[] = [];
  for (const name of known) {
    const model = models[name];
    const wr = worldRecords.get(name);
    if (!model && wr == null) continue;

    // PostgREST requires every object in a bulk upsert to carry the same keys, so all
    // three are always sent. Null is meaningful here rather than "leave alone": these
    // files are the source of truth, and a model that is no longer derivable should
    // stop being applied.
    rows.push({
      name,
      score_model_stat: model?.stat ?? null,
      score_model_k: model?.k ?? null,
      world_record: wr ?? null,
    });
  }

  console.log(`scenarios in project : ${known.size}`);
  console.log(`rows to update       : ${rows.length}`);
  console.log(`  with a score model : ${rows.filter((r) => r.score_model_stat).length}`);
  console.log(`  with a world record: ${rows.filter((r) => r.world_record != null).length}`);

  if (DRY) {
    console.log("\n--dry-run, nothing written");
    return;
  }

  await upsert("scenarios", rows, "name");

  const withModel = await count("scenarios", "score_model_stat=not.is.null");
  const withWr = await count("scenarios", "world_record=not.is.null");

  console.log(`\nlive now:`);
  console.log(`  score models  : ${withModel}`);
  console.log(`  world records : ${withWr}`);

  if (withModel === 0) {
    console.error("nothing landed, something is wrong");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
