/**
 * Re-seed every rating for the move to rounds.
 *
 * Ratings earned under mean delta measured almost nothing about skill (PLAN.md §3:
 * `npm run compare:formats`), and ranked is now decided on raw score, so carrying them
 * over would put people at levels unrelated to how they play. Each player is re-seeded
 * from where their verified PBs sit on the season's thresholds, the same rule a new
 * player's first queue uses (core/rating/seed.ts), with the seeded RD so placements move
 * them quickly. A player with too few verified PBs for a standing keeps their rating and
 * has their RD widened to the same value, which says "uncertain" without inventing a
 * number.
 *
 * Match history, rating history and matches_played are left alone: this changes where
 * people stand, not what they played.
 *
 * Dry run by default; prints old and new for everyone and writes nothing.
 *
 *   npx tsx tools/softResetRatings.ts            what would change
 *   npx tsx tools/softResetRatings.ts --apply    write it
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SEED_RD, seasonStanding, seedRating } from "../src/core/rating/seed.ts";

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
const headers = () => ({ apikey: SECRET!, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" });

/** Every row, a page at a time: PostgREST caps a single response. */
async function all<T>(path: string): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${URL_BASE}/rest/v1/${path}${sep}limit=${PAGE}&offset=${offset}`, { headers: headers() });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    const page = (await res.json()) as T[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function main(): Promise<void> {
  if (!URL_BASE || !SECRET) {
    console.error("missing APOGEE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");

  // The season find-match plays: the published one, else the newest draft.
  const seasons = await all<{ id: string; name: string; status: string; window_size: number | null }>(
    "seasons?select=id,name,status,window_size&status=in.(published,draft)&order=created_at.desc",
  );
  const season = seasons.find((s) => s.status === "published") ?? seasons[0];
  if (!season) throw new Error("no season is loaded");

  const scenarios = (await all<{ scenario_id: number; family: string | null; window_index: number | null; rank_maxes: number[] }>(
    `season_scenarios?select=scenario_id,family,window_index,rank_maxes&season_id=eq.${season.id}`,
  )).map((s) => ({
    scenarioId: Number(s.scenario_id),
    family: s.family,
    windowIndex: Number(s.window_index ?? 0),
    rankMaxes: (s.rank_maxes ?? []).map(Number),
  }));

  const pbRows = await all<{ player_id: string; scenario_id: number; score: number }>(
    "verified_pbs?select=player_id,scenario_id,score",
  );
  const pbsByPlayer = new Map<string, Map<number, number>>();
  for (const r of pbRows) {
    const map = pbsByPlayer.get(r.player_id) ?? new Map<number, number>();
    map.set(Number(r.scenario_id), Number(r.score));
    pbsByPlayer.set(r.player_id, map);
  }

  const ratings = await all<{ player_id: string; rating: number; rd: number; volatility: number; matches_played: number }>(
    "ratings?select=player_id,rating,rd,volatility,matches_played",
  );
  const names = new Map(
    (await all<{ id: string; display_name: string }>("players?select=id,display_name")).map((p) => [p.id, p.display_name]),
  );

  console.log(`${season.name} (${season.status}), ${scenarios.length} scenarios, ${ratings.length} ratings\n`);
  console.log("  player                      matches   old rating / rd      new rating / rd    standing");

  const plans: { player_id: string; rating: number; rd: number; volatility: number }[] = [];
  for (const r of ratings.sort((a, b) => Number(b.rating) - Number(a.rating))) {
    const standing = seasonStanding(scenarios, pbsByPlayer.get(r.player_id) ?? new Map(), season.window_size);
    const next = standing
      ? seedRating(standing.standing)
      : { rating: Number(r.rating), rd: Math.max(Number(r.rd), SEED_RD), volatility: Number(r.volatility) };
    plans.push({ player_id: r.player_id, ...next });

    const name = (names.get(r.player_id) ?? r.player_id).slice(0, 26).padEnd(26);
    console.log(
      `  ${name}  ${String(r.matches_played).padStart(7)}   ` +
        `${Number(r.rating).toFixed(0).padStart(6)} / ${Number(r.rd).toFixed(0).padStart(3)}      ` +
        `${next.rating.toFixed(0).padStart(6)} / ${next.rd.toFixed(0).padStart(3)}    ` +
        (standing ? `${standing.standing.toFixed(3)} over ${standing.families}` : "too few verified PBs, kept"),
    );
  }

  if (!apply) {
    console.log("\nDry run: nothing written. Run again with --apply to write these.");
    return;
  }

  let written = 0;
  for (const p of plans) {
    const res = await fetch(`${URL_BASE}/rest/v1/ratings?player_id=eq.${p.player_id}`, {
      method: "PATCH",
      headers: { ...headers(), Prefer: "return=minimal" },
      body: JSON.stringify({ rating: p.rating, rd: p.rd, volatility: p.volatility, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`ratings ${p.player_id}: HTTP ${res.status} ${await res.text()} (${written} written before this)`);
    written++;
  }
  console.log(`\nWrote ${written} of ${plans.length} ratings.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
