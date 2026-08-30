/**
 * Delete a player and everything belonging to them, by SteamID.
 *
 * PRIVACY.md promises deletion on request, and a promise with no mechanism behind it is
 * just a sentence. This is the mechanism. It is deliberately a service-role tool rather
 * than an in-app button: an account deletion is unrecoverable, and the client is never
 * given a door to anything unrecoverable (PLAN.md §7).
 *
 * Everything hangs off `players` with `on delete cascade`, which itself hangs off
 * `auth.users`, so deleting the auth user is the whole operation. The counts below are
 * therefore not the deletion - they are there so that whoever runs this can see the
 * size of what they are about to destroy *before* it happens, and notice if the SteamID
 * they were given resolves to an account with someone else's ten thousand runs on it.
 *
 *   npx tsx tools/deletePlayer.ts <steamId>              show what would be deleted
 *   npx tsx tools/deletePlayer.ts <steamId> --export     write a JSON copy first
 *   npx tsx tools/deletePlayer.ts <steamId> --confirm    actually delete
 *
 * Dry run is the default and `--confirm` is required, because the failure mode of
 * getting this wrong is not recoverable from a backup anyone here maintains.
 */

import { readFileSync, writeFileSync } from "node:fs";
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

const args = process.argv.slice(2);
const steamId = args.find((a) => !a.startsWith("--"));
const confirm = args.includes("--confirm");
const wantExport = args.includes("--export");

if (!steamId || !/^7656[0-9]{13}$/.test(steamId)) {
  console.error("usage: npx tsx tools/deletePlayer.ts <steamId64> [--export] [--confirm]");
  process.exit(1);
}

const headers = {
  apikey: SECRET,
  Authorization: `Bearer ${SECRET}`,
  "Content-Type": "application/json",
};

async function rest(path: string): Promise<Response> {
  return fetch(`${URL_BASE}/rest/v1/${path}`, { headers });
}

/**
 * Row count for a table, via PostgREST's exact count header.
 *
 * `select=id` with `limit=0` asks for none of the rows and all of the arithmetic, which
 * matters on `runs`: an account here already has eleven thousand of them and pulling
 * them back just to call `.length` would be silly.
 */
async function countOf(table: string, column: string, id: string): Promise<number> {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?${column}=eq.${id}&select=${column}&limit=0`, {
    headers: { ...headers, Prefer: "count=exact" },
  });
  if (!res.ok) return -1;
  const range = res.headers.get("content-range");
  return range ? Number(range.split("/")[1]) : -1;
}

const OWNED: Array<[string, string]> = [
  ["runs", "player_id"],
  ["baselines", "player_id"],
  ["ratings", "player_id"],
  ["verified_pbs", "player_id"],
  ["match_sides", "player_id"],
  ["tracked_benchmarks", "player_id"],
  ["quests", "player_id"],
];

const lookup = await rest(`players?steam_id=eq.${steamId}&select=id,display_name,created_at,last_seen_at`);
if (!lookup.ok) {
  console.error(`lookup failed: ${lookup.status} ${await lookup.text()}`);
  process.exit(1);
}

const players = (await lookup.json()) as Array<{
  id: string;
  display_name: string;
  created_at: string;
  last_seen_at: string;
}>;

if (players.length === 0) {
  console.log(`no player with steam_id ${steamId}. Nothing to delete.`);
  process.exit(0);
}

const player = players[0];

console.log(`player       : ${player.display_name}`);
console.log(`steam id     : ${steamId}`);
console.log(`account id   : ${player.id}`);
console.log(`created      : ${player.created_at}`);
console.log(`last seen    : ${player.last_seen_at}`);
console.log();

let total = 0;
for (const [table, column] of OWNED) {
  const n = await countOf(table, column, player.id);
  total += Math.max(0, n);
  console.log(`  ${table.padEnd(20)} ${n < 0 ? "count unavailable" : n}`);
}
console.log(`  ${"".padEnd(20)} ${total} rows in total, plus the player and auth rows`);
console.log();

if (wantExport) {
  const out: Record<string, unknown> = { player, exportedAt: new Date().toISOString() };
  for (const [table, column] of OWNED) {
    const res = await rest(`${table}?${column}=eq.${player.id}&select=*`);
    out[table] = res.ok ? await res.json() : `export failed: ${res.status}`;
  }
  const path = join(root, `player-export-${steamId}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2), "utf8");
  console.log(`wrote ${path}`);
  console.log();
}

if (!confirm) {
  console.log("DRY RUN. Nothing was deleted.");
  console.log("Re-run with --confirm to delete, and consider --export first.");
  process.exit(0);
}

// Deleting the auth user is the whole operation: players.id references auth.users with
// on delete cascade, and every table above references players the same way. Deleting
// the player row instead would leave an orphaned auth user able to sign in and be
// handed a brand new, empty player row by the signup trigger.
const del = await fetch(`${URL_BASE}/auth/v1/admin/users/${player.id}`, {
  method: "DELETE",
  headers,
});

if (!del.ok) {
  console.error(`delete failed: ${del.status} ${await del.text()}`);
  process.exit(1);
}

const stillThere = await rest(`players?steam_id=eq.${steamId}&select=id`);
const remaining = stillThere.ok ? ((await stillThere.json()) as unknown[]).length : -1;

console.log(`deleted ${player.display_name} (${steamId}).`);
console.log(
  remaining === 0
    ? "verified: the player row is gone, and the cascade took everything with it."
    : `WARNING: the player row is still present (${remaining}). Investigate before telling anyone it is done.`,
);
