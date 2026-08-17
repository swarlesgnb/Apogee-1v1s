/**
 * Call an Edge Function as a real player, from a terminal.
 *
 * The match functions require a session, which normally only the desktop client has.
 * That makes them awkward to exercise or repair from outside the app: a backfill that
 * needs its baselines computed, a match stuck mid-settlement, a function you have just
 * deployed and want to prove before asking someone to click a button.
 *
 * This mints a short-lived session for a player using the service role, exactly as the
 * steam-auth function does after Steam vouches for them, and calls the function with it.
 * Nothing here bypasses the security model: it uses the same session mechanism a signed
 * -in client would, so whatever it can do, that player could do.
 *
 *   npx tsx tools/runAsPlayer.ts <steamId> <function> [jsonBody]
 *
 * Example:
 *   npx tsx tools/runAsPlayer.ts 76561198710540626 refresh-baselines
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const env: Record<string, string> = {};
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m && m[2]) env[m[1]] = m[2].trim();
}

const URL_BASE = env.ARENA_SUPABASE_URL!.replace(/\/+$/, "");
const ANON = env.ARENA_SUPABASE_ANON_KEY!;
const SECRET = env.SUPABASE_SERVICE_ROLE_KEY!;

const [steamId, functionName, rawBody] = process.argv.slice(2);

if (!steamId || !functionName) {
  console.error("usage: npx tsx tools/runAsPlayer.ts <steamId> <function> [jsonBody]");
  process.exit(1);
}

const admin = createClient(URL_BASE, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const client = createClient(URL_BASE, ANON, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

async function main(): Promise<void> {
  const { data: player, error: playerError } = await admin
    .from("players")
    .select("id, display_name, steam_id")
    .eq("steam_id", steamId)
    .maybeSingle();

  if (playerError) throw new Error(playerError.message);
  if (!player) throw new Error(`no player with steam_id ${steamId}`);

  console.log(`player   : ${player.display_name} (${player.steam_id})`);

  const email = `steam_${steamId}@arena.invalid`;
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !link?.properties?.hashed_token) {
    throw new Error(linkError?.message ?? "could not mint a session");
  }

  const { data: session, error: otpError } = await client.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  if (otpError || !session.session) {
    throw new Error(otpError?.message ?? "could not redeem the session token");
  }

  console.log(`session  : ok`);
  console.log(`calling  : ${functionName}\n`);

  const res = await fetch(`${URL_BASE}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.session.access_token}`,
    },
    body: rawBody ?? "{}",
  });

  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text.slice(0, 800));
  }

  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
