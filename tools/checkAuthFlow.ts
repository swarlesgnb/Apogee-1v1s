/**
 * Test the half of Steam sign-in that does not need a browser.
 *
 * The flow is: Edge Function creates/loads a user, mints a single-use magiclink token,
 * and the desktop app redeems it with verifyOtp. Steam's part cannot be automated, but
 * everything after it can, and that is where a silent failure would hide.
 *
 * Creates a throwaway user and deletes it again.
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

const URL_BASE = env.ARENA_SUPABASE_URL!;
const ANON = env.ARENA_SUPABASE_ANON_KEY!;
const SECRET = env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(URL_BASE, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const client = createClient(URL_BASE, ANON, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const TEST_STEAM_ID = "76561199999999999";
const email = `steam_${TEST_STEAM_ID}@arena.invalid`;

let userId: string | null = null;

async function main() {
  console.log("1. create user");
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { steam_id: TEST_STEAM_ID },
  });
  if (created.error) {
    console.log(`   createUser error: ${created.error.message}`);
    // Might already exist from a previous run.
    const { data: list } = await admin.auth.admin.listUsers();
    const found = list?.users.find((u) => u.email === email);
    if (!found) throw new Error("could not create or find the test user");
    userId = found.id;
    console.log(`   reused existing user ${userId}`);
  } else {
    userId = created.data.user!.id;
    console.log(`   ok ${userId}`);
  }

  console.log("2. insert player row");
  const player = await admin.from("players").upsert(
    { id: userId, steam_id: TEST_STEAM_ID, display_name: "auth flow test" },
    { onConflict: "id" },
  );
  console.log(player.error ? `   ERROR ${player.error.message}` : "   ok");

  console.log("3. generateLink (magiclink)");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) {
    console.log(`   ERROR ${link.error.message}`);
    console.log(`   status: ${(link.error as { status?: number }).status}`);
    return;
  }
  const tokenHash = link.data.properties?.hashed_token;
  console.log(`   ok, token_hash ${tokenHash ? tokenHash.slice(0, 16) + "..." : "MISSING"}`);
  if (!tokenHash) return;

  console.log("4. verifyOtp (what the desktop app does)");
  const verified = await client.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (verified.error) {
    console.log(`   ERROR ${verified.error.message}`);
    console.log(`   status: ${(verified.error as { status?: number }).status}`);
    return;
  }
  console.log(`   ok, session for ${verified.data.session?.user.email}`);
  console.log(`   access token: ${verified.data.session?.access_token.slice(0, 20)}...`);

  console.log("5. call find-match with that session");
  const res = await fetch(`${URL_BASE}/functions/v1/find-match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON,
      Authorization: `Bearer ${verified.data.session!.access_token}`,
    },
    body: JSON.stringify({ category: "Clicking", difficulty: "Intermediate" }),
  });
  console.log(`   HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

main()
  .catch((e) => console.error("FAILED:", e instanceof Error ? e.message : e))
  .finally(async () => {
    if (userId) {
      await admin.from("players").delete().eq("id", userId);
      await admin.auth.admin.deleteUser(userId);
      console.log("\ncleaned up test user");
    }
  });
