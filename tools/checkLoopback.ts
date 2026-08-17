/**
 * Test the desktop half of Steam sign-in without launching a browser.
 *
 * `signInWithSteam` binds a loopback listener, sends the user to the Edge Function,
 * and waits for a single-use token to come back. Steam's part needs a human, but
 * everything around it can be checked: that the listener binds, that the URL handed to
 * the browser is correct, that a callback with the right state resolves, and that one
 * with the wrong state is ignored.
 *
 *   npx tsx tools/checkLoopback.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { signInWithSteam } from "../src/core/sync/steamAuth.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const env: Record<string, string> = {};
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m && m[2]) env[m[1]] = m[2].trim();
}

const FUNCTION_URL = env.ARENA_STEAM_AUTH_URL!;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log(`function: ${FUNCTION_URL}\n`);

  // ---- the happy path, with the browser replaced by a direct callback -----------
  console.log("── loopback flow ────────────────────────────────");

  let openedUrl = "";
  const signIn = signInWithSteam({
    functionUrl: FUNCTION_URL,
    timeoutMs: 15_000,
    open: (url) => {
      openedUrl = url;
      // Stand in for the browser plus Steam plus the Edge Function redirect.
      const parsed = new URL(url);
      const port = parsed.searchParams.get("port")!;
      const state = parsed.searchParams.get("state")!;
      setTimeout(() => {
        void fetch(
          `http://127.0.0.1:${port}/callback?state=${encodeURIComponent(state)}` +
            `&steam_id=76561198710540626&token_hash=deadbeef`,
        ).catch(() => undefined);
      }, 50);
    },
  });

  const result = await signIn;

  check("the loopback listener bound and resolved", true);
  check("the browser was sent to the Edge Function", openedUrl.startsWith(FUNCTION_URL),
    openedUrl.split("?")[0]);
  check("the URL carries a loopback port", /[?&]port=\d+/.test(openedUrl));
  check("the URL carries a state of usable length",
    (new URL(openedUrl).searchParams.get("state") ?? "").length >= 16);
  check("the steam id came back", result.steamId === "76561198710540626", result.steamId);
  check("the token came back", result.tokenHash === "deadbeef");

  // ---- a callback with the wrong state must be ignored ---------------------------
  console.log("\n── state validation ─────────────────────────────");

  let settled = false;
  const guarded = signInWithSteam({
    functionUrl: FUNCTION_URL,
    timeoutMs: 3_000,
    open: (url) => {
      const port = new URL(url).searchParams.get("port")!;
      // Wrong state: an unrelated request hitting the loopback port.
      setTimeout(() => {
        void fetch(
          `http://127.0.0.1:${port}/callback?state=not-the-right-state` +
            `&steam_id=76561198000000000&token_hash=attacker`,
        ).catch(() => undefined);
      }, 50);
    },
  }).then(
    () => { settled = true; return "resolved"; },
    (e) => { settled = true; return e instanceof Error ? e.message : String(e); },
  );

  const outcome = await guarded;
  check("a callback with the wrong state does not sign you in",
    settled && outcome.includes("timed out"), outcome);

  // ---- the live function still redirects to Steam ---------------------------------
  console.log("\n── edge function ────────────────────────────────");
  const res = await fetch(
    `${FUNCTION_URL}/start?port=54999&state=${"a".repeat(32)}`,
    { redirect: "manual" },
  );
  const location = res.headers.get("location") ?? "";
  check("start redirects to Steam", location.startsWith("https://steamcommunity.com/openid/login"),
    `HTTP ${res.status}`);
  check("the return address points back at the function",
    decodeURIComponent(location).includes("/functions/v1/steam-auth/callback"));

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK: the desktop half of Steam sign-in works");
}

main();
