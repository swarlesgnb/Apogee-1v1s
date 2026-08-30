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
const URL_BASE = env.APOGEE_SUPABASE_URL?.replace(/\/+$/, "");
const SECRET = env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes("--dry-run");

if (!URL_BASE || !SECRET) {
  console.error("APOGEE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  process.exit(1);
}

interface ScoreModel {
  stat: string;
  k: number;
}

interface WeaponScoreModel {
  scorePerDamage: number;
  damagePerShot: number;
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

/**
 * Push the sampled leaderboard shapes the apex board reads.
 *
 * Keyed on scenario id rather than name, because `scenario_boards` references
 * `scenarios(id)` - so this runs after the scenario upsert above and resolves ids from
 * the project rather than assuming them. A scenario the project has never heard of is
 * skipped rather than inserted: the apex board grades the season pool, and a board with
 * no scenario row is not in it.
 *
 * Both samplings go in one row. They are only ever read together, and storing them apart
 * would allow a state where the apex anchors are fresh and the percentiles are not, which
 * is precisely the disagreement `apexTopFraction` has to floor its handover against.
 */
async function syncBoards(): Promise<void> {
  const apex = readJson<{
    boards: { scenario: string; total: number; points: { rank: number; score: number }[]; sampledAt: string }[];
  }>("data", "leaderboard_apex.json").boards;

  const percentiles = readJson<{
    distributions: {
      scenario: string;
      total: number;
      points: { topFraction: number; score: number }[];
    }[];
  }>("data", "leaderboard_percentiles.json").distributions;

  const pctByName = new Map(percentiles.map((d) => [d.scenario, d]));

  const names = [...new Set(apex.map((b) => b.scenario))];
  const idByName = new Map<string, number>();

  // Resolved in chunks: a `name=in.(...)` filter is a URL, and 88 scenario names with
  // spaces and quotes in them is a long one.
  const CHUNK = 40;
  for (let i = 0; i < names.length; i += CHUNK) {
    const batch = names.slice(i, i + CHUNK);
    const filter = batch.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
    const res = await fetch(
      `${URL_BASE}/rest/v1/scenarios?select=id,name&name=in.(${encodeURIComponent(filter)})`,
      { headers: { apikey: SECRET!, Authorization: `Bearer ${SECRET}` } },
    );
    if (!res.ok) throw new Error(`resolving scenario ids: ${res.status} ${await res.text()}`);
    for (const row of (await res.json()) as { id: number; name: string }[]) {
      idByName.set(row.name, row.id);
    }
  }

  const rows = apex
    .filter((b) => idByName.has(b.scenario))
    .map((b) => ({
      scenario_id: idByName.get(b.scenario)!,
      board_total: b.total,
      apex_points: b.points,
      percentile_points: pctByName.get(b.scenario)?.points ?? [],
      sampled_at: b.sampledAt,
      synced_at: new Date().toISOString(),
    }));

  const missing = apex.length - rows.length;
  const withoutPercentiles = rows.filter((r) => r.percentile_points.length === 0).length;

  console.log(`\nsampled boards       : ${apex.length}`);
  console.log(`  resolved to an id  : ${rows.length}${missing ? ` (${missing} not in the project)` : ""}`);
  if (withoutPercentiles > 0) {
    // Not fatal: the apex anchors alone still place any score in the top 500, which is
    // the range the board exists for. Worth saying out loud, because below that the
    // standing falls back to the last anchor for everybody.
    console.log(`  without percentiles: ${withoutPercentiles}`);
  }

  if (rows.length > 0) await upsert("scenario_boards", rows, "scenario_id");
}

async function main(): Promise<void> {
  const learned = readJson<{
    models: Record<string, ScoreModel>;
    weaponModels: Record<string, WeaponScoreModel>;
    shotRates: Record<string, number>;
  }>("data", "score_models.json");
  const models = learned.models;
  const weaponModels = learned.weaponModels;
  // Only the scenarios whose shots are engine ticks appear here; the rest are absent
  // rather than zero, and absent means the check skips.
  const shotRates = learned.shotRates;
  const taxonomy = readJson<{ scenarios: { name: string; topScore: number | null }[] }>(
    "data",
    "scenario_taxonomy.json",
  ).scenarios;

  const worldRecords = new Map(
    taxonomy.filter((s) => s.topScore).map((s) => [s.name, s.topScore!]),
  );

  // Scenario length, so settlement can tell a crash from a bad run. Only scenarios with
  // a fixed length carry a number; the ones that end early by design carry null and are
  // never checked.
  const durations = new Map(
    readJson<{ durations: { scenario: string; seconds: number | null }[] }>(
      "data",
      "scenario_durations.json",
    )
      .durations.filter((d) => d.seconds != null)
      .map((d) => [d.scenario, d.seconds!]),
  );

  // What a scenario IS: its board, its aim type, and the sub-category the season pool
  // puts it in. Generated beside seed.sql by tools/generate_seed.py, from the same
  // sources, so the seed and this can never disagree about a scenario.
  //
  // This is the gap that made the header above only half true. Reference data does
  // change - "a corrected sub-category" is the example it gives - and until now the only
  // route for one was the seed, which `db push` skips on every deploy after the first.
  // sub_category is not cosmetic: find-match reads it, and a sub-category queue matches
  // scenarios on it, so a stale one is a queue that finds nothing.
  const identity = readJson<{
    scenarios: Record<
      string,
      { leaderboardId: number | null; aimType: string | null; subCategory: string | null }
    >;
  }>("data", "scenario_identity.json").scenarios;

  const existing = await fetch(`${URL_BASE}/rest/v1/scenarios?select=name`, {
    headers: { apikey: SECRET!, Authorization: `Bearer ${SECRET}` },
  }).then((r) => r.json() as Promise<{ name: string }[]>);

  const live = new Set(existing.map((s) => s.name));

  // Every scenario the committed definitions name, whether or not the project has it.
  //
  // It used to be only the ones already there, on the reasoning that this should not
  // invent rows. But a season built from a benchmark added since the first deploy names
  // scenarios the project has never heard of, and skipping them leaves find-match unable
  // to resolve half a pool. `scenarios` is reference data keyed on a unique name, and an
  // upsert of a row nothing points at is inert; a missing one breaks a match.
  const known = new Set([...live, ...Object.keys(identity)]);

  // Two batches, not one, because they carry different columns.
  //
  // A bulk upsert sends one shape, and a null in it is an UPDATE to null rather than
  // "leave this alone". So a scenario the committed definitions no longer name must not
  // travel in the same batch as the ones they do: it would arrive carrying three nulls
  // and clear an aim type that was perfectly correct. Its reference data is still sent -
  // that part this file really is the sole source of.
  const withIdentity: Record<string, unknown>[] = [];
  const referenceOnly: Record<string, unknown>[] = [];

  for (const name of known) {
    const model = models[name];
    const weaponModel = weaponModels[name];
    const wr = worldRecords.get(name);
    const duration = durations.get(name);
    const shotRate = shotRates[name];
    const ident = identity[name];
    if (
      !model &&
      !weaponModel &&
      wr == null &&
      duration == null &&
      shotRate == null &&
      !ident
    ) {
      continue;
    }

    // PostgREST requires every object in a bulk upsert to carry the same keys, so all of
    // these are always sent. Null is meaningful here rather than "leave alone": these
    // files are the source of truth, and a model that is no longer derivable should
    // stop being applied.
    (ident ? withIdentity : referenceOnly).push({
      name,
      ...(ident
        ? {
            leaderboard_id: ident.leaderboardId,
            aim_type: ident.aimType,
            sub_category: ident.subCategory,
          }
        : {}),
      score_model_stat: model?.stat ?? null,
      score_model_k: model?.k ?? null,
      weapon_score_per_damage: weaponModel?.scorePerDamage ?? null,
      weapon_damage_per_shot: weaponModel?.damagePerShot ?? null,
      world_record: wr ?? null,
      duration_seconds: duration ?? null,
      shots_per_second: shotRate ?? null,
    });
  }

  const rows = [...withIdentity, ...referenceOnly];

  console.log(`scenarios in project : ${live.size}`);
  console.log(`named by a benchmark : ${Object.keys(identity).length}`);
  console.log(`  new to the project : ${[...Object.keys(identity)].filter((n) => !live.has(n)).length}`);
  console.log(`rows to update       : ${rows.length}`);
  console.log(`  with an identity   : ${withIdentity.length}`);
  console.log(`  with a sub-category: ${withIdentity.filter((r) => r.sub_category).length}`);
  console.log(`  with a score model : ${rows.filter((r) => r.score_model_stat).length}`);
  console.log(
    `  with a weapon model: ${rows.filter((r) => r.weapon_score_per_damage != null).length}`,
  );
  console.log(`  with a world record: ${rows.filter((r) => r.world_record != null).length}`);
  console.log(`  with a duration    : ${rows.filter((r) => r.duration_seconds != null).length}`);
  console.log(`  with a shot rate   : ${rows.filter((r) => r.shots_per_second != null).length}`);

  if (DRY) {
    console.log("\n--dry-run, nothing written");
    return;
  }

  if (withIdentity.length > 0) await upsert("scenarios", withIdentity, "name");
  if (referenceOnly.length > 0) await upsert("scenarios", referenceOnly, "name");

  await syncBoards();

  const withModel = await count("scenarios", "score_model_stat=not.is.null");
  const withWeaponModel = await count("scenarios", "weapon_score_per_damage=not.is.null");
  const withWr = await count("scenarios", "world_record=not.is.null");

  console.log(`\nlive now:`);
  console.log(`  score models  : ${withModel}`);
  console.log(`  weapon models : ${withWeaponModel}`);
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
