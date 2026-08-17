/**
 * Grant or revoke admin, by SteamID.
 *
 * There is deliberately no in-app path to this. An admin can change what every player's
 * rank means, so the ability to create one lives with whoever holds the service role
 * key rather than with anyone who can reach the client - and RLS gives `admins` no
 * client write policy at all, so this is the only door.
 *
 *   npx tsx tools/grantAdmin.ts <steamId> [--note "why"]
 *   npx tsx tools/grantAdmin.ts <steamId> --revoke
 *   npx tsx tools/grantAdmin.ts --list
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

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${URL_BASE}/rest/v1/${path}`, { ...init, headers });
}

async function list(): Promise<void> {
  const res = await rest("admins?select=player_id,granted_at,note");
  const rows = (await res.json()) as { player_id: string; granted_at: string; note: string | null }[];

  if (rows.length === 0) {
    console.log("no admins");
    return;
  }

  // Names come from a second read: `admins` holds only the id, and joining would mean
  // granting this script knowledge of the players table it does not otherwise need.
  const ids = rows.map((r) => r.player_id);
  const playersRes = await rest(
    `players?select=id,display_name,steam_id&id=in.(${ids.join(",")})`,
  );
  const players = (await playersRes.json()) as
    { id: string; display_name: string; steam_id: string }[];
  const byId = new Map(players.map((p) => [p.id, p]));

  console.log(`${rows.length} admin(s):`);
  for (const row of rows) {
    const p = byId.get(row.player_id);
    console.log(
      `  ${(p?.display_name ?? "unknown").padEnd(20)} ${p?.steam_id ?? row.player_id}` +
        `  granted ${row.granted_at.slice(0, 10)}${row.note ? `  (${row.note})` : ""}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    await list();
    return;
  }

  const steamId = args.find((a) => !a.startsWith("--"));
  if (!steamId) {
    console.error("usage: npx tsx tools/grantAdmin.ts <steamId> [--note \"why\"] [--revoke]");
    process.exit(1);
  }

  const noteAt = args.indexOf("--note");
  const note = noteAt !== -1 ? args[noteAt + 1] : null;
  const revoking = args.includes("--revoke");

  const playerRes = await rest(
    `players?select=id,display_name,steam_id&steam_id=eq.${encodeURIComponent(steamId)}`,
  );
  const players = (await playerRes.json()) as
    { id: string; display_name: string; steam_id: string }[];

  const player = players[0];
  if (!player) {
    console.error(`no player with steam_id ${steamId}; they have to sign in once first`);
    process.exit(1);
  }

  if (revoking) {
    const res = await rest(`admins?player_id=eq.${player.id}`, { method: "DELETE" });
    if (!res.ok) {
      console.error(`could not revoke: HTTP ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    console.log(`revoked admin from ${player.display_name} (${player.steam_id})`);
    return;
  }

  const res = await rest("admins", {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ player_id: player.id, note }),
  });

  if (!res.ok) {
    console.error(`could not grant: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  console.log(`granted admin to ${player.display_name} (${player.steam_id})`);
  console.log("they can edit draft seasons; published ones stay frozen for everyone.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
