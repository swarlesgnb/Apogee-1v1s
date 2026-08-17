/**
 * Load a season definition into the project as a draft.
 *
 * Drafts only. Publishing is a separate, deliberate act, and the database refuses to
 * change a season once published (migration 20260817000006) - so this cannot quietly
 * re-cut anybody's rank, whatever it is pointed at.
 *
 *   npx tsx tools/pushSeason.ts [data/seasons/season-1.json] [--dry-run]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const env: Record<string, string> = {};
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m && m[2]) env[m[1]] = m[2].trim();
}

const URL_BASE = env.APOGEE_SUPABASE_URL?.replace(/\/+$/, "");
const SECRET = env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_BASE || !SECRET) {
  console.error("APOGEE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  process.exit(1);
}

const headers = {
  apikey: SECRET,
  Authorization: `Bearer ${SECRET}`,
  "Content-Type": "application/json",
};

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${URL_BASE}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });

interface SeasonFile {
  name: string;
  rankNames: string[];
  rankColors: Record<string, string>;
  scenarios: { scenario: string; category: string; rankMaxes: number[] }[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const file = args.find((a) => !a.startsWith("--")) ?? "data/seasons/season-1.json";

  const season: SeasonFile = JSON.parse(readFileSync(join(root, file), "utf8"));

  // Every threshold list must match the ladder, or a rank would exist with no score
  // attached to it and the season would be unusable in a way nothing else would catch.
  const wrong = season.scenarios.filter((s) => s.rankMaxes.length !== season.rankNames.length);
  if (wrong.length > 0) {
    console.error(
      `${wrong.length} scenario(s) have a threshold count that does not match ` +
        `${season.rankNames.length} ranks: ${wrong.map((s) => s.scenario).join(", ")}`,
    );
    process.exit(1);
  }

  // Resolve names to ids. A season may only name scenarios the project knows about.
  const names = season.scenarios.map((s) => s.scenario);
  const res = await rest(
    `scenarios?select=id,name&name=in.(${names.map((n) => `"${n}"`).join(",")})`,
  );
  const rows = (await res.json()) as { id: number; name: string }[];
  const idByName = new Map(rows.map((r) => [r.name, r.id]));

  const missing = names.filter((n) => !idByName.has(n));
  if (missing.length > 0) {
    console.error(`not in the scenarios table: ${missing.join(", ")}`);
    console.error("run npm run sync:reference first, or correct the names");
    process.exit(1);
  }

  console.log(`${season.name}: ${season.scenarios.length} scenarios, ` +
    `${season.rankNames.length} ranks (${season.rankNames.join(" · ")})`);

  const existingRes = await rest(
    `seasons?select=id,status&name=eq.${encodeURIComponent(season.name)}`,
  );

  // Say which thing is missing. Without this the array method below fails on an error
  // object and reports "existing.find is not a function", which describes this script
  // rather than the project.
  if (!existingRes.ok) {
    const body = await existingRes.text();
    console.error(`could not read seasons: HTTP ${existingRes.status} ${body.slice(0, 200)}`);
    if (existingRes.status === 404 || /does not exist/i.test(body)) {
      console.error("the seasons table is not deployed yet: npx supabase db push --yes");
    }
    process.exit(1);
  }

  const existing = (await existingRes.json()) as { id: string; status: string }[];

  const published = existing.find((s) => s.status !== "draft");
  if (published) {
    console.error(
      `"${season.name}" is already ${published.status} and is frozen. ` +
        "Rename this one, or edit the next draft.",
    );
    process.exit(1);
  }

  if (dry) {
    console.log("\n--dry-run, nothing written");
    return;
  }

  // Replace the draft outright rather than merging. A season is one document, and a
  // half-updated pool is worse than a replaced one.
  const draft = existing.find((s) => s.status === "draft");
  if (draft) {
    await rest(`seasons?id=eq.${draft.id}`, { method: "DELETE" });
    console.log("replaced the existing draft");
  }

  const created = await (
    await rest("seasons", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        name: season.name,
        status: "draft",
        rank_names: season.rankNames,
        rank_colors: season.rankColors,
      }),
    })
  ).json() as { id: string }[];

  const seasonId = created[0]?.id;
  if (!seasonId) {
    console.error("could not create the season row");
    process.exit(1);
  }

  const insertRes = await rest("season_scenarios", {
    method: "POST",
    body: JSON.stringify(
      season.scenarios.map((s) => ({
        season_id: seasonId,
        scenario_id: idByName.get(s.scenario),
        category: s.category,
        rank_maxes: s.rankMaxes,
      })),
    ),
  });

  if (!insertRes.ok) {
    console.error(`could not write the pool: HTTP ${insertRes.status} ${await insertRes.text()}`);
    process.exit(1);
  }

  console.log(`\nwrote draft season ${seasonId.slice(0, 8)}`);
  console.log("editable until it is published; publishing freezes it for good.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
