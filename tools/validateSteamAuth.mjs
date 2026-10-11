/**
 * Steam sign-in assertions are single-use and bound to the sign-in that asked for them
 * (audit SEC-05).
 *
 *   node tools/validateSteamAuth.mjs
 *
 * Runs the shipped steam-auth function against every migration in PGlite. Supabase Auth's
 * admin calls and the two network calls (Steam's check_authentication, which answers
 * is_valid for the genuine signature only, and the optional profile lookup) are stubbed;
 * everything the function decides is the real code.
 *
 * The flow is the desktop client's: /start with a loopback port and a random state, then
 * the callback Steam would send. Then the attacks: the same callback again, an assertion
 * issued for another address, one whose return address Steam did not sign, a stale nonce,
 * a callback for a sign-in that never began, and a different port.
 */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { build } from "esbuild";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { migratedDatabase, restClient } from "./lib/postgrestOverPglite.mjs";

const FUNCTION_URL = "https://project.supabase.co/functions/v1/steam-auth";
const STEAM = "https://steamcommunity.com/openid/login";
const STEAM_ID = "76561198000000042";
let cases = 0;
const pass = (label) => { cases++; console.log(`  ok   ${label}`); };

const { db } = await migratedDatabase(PGlite, readFileSync, readdirSync);
const rest = restClient(db);
let tokens = 0;
globalThis.steamAuthClient = {
  from: (t) => rest.from(t),
  auth: {
    admin: {
      async createUser({ email, user_metadata }) {
        const existing = await db.query("select id from auth.users where email = $1", [email]);
        if (existing.rows.length) return { data: null, error: { message: "already registered" } };
        const id = (await db.query("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id;
        return { data: { user: { id, user_metadata } }, error: null };
      },
      async listUsers() {
        return { data: { users: (await db.query("select id, email from auth.users")).rows }, error: null };
      },
      async generateLink() { tokens++; return { data: { properties: { hashed_token: `one-time-token-${tokens}` } }, error: null }; },
    },
  },
};

mkdirSync(".cache", { recursive: true });
await build({
  entryPoints: ["supabase/functions/steam-auth/index.ts"], outfile: ".cache/steam-auth-test.mjs",
  bundle: true, platform: "node", format: "esm", logLevel: "error",
  plugins: [{ name: "isolated-auth", setup(b) {
    b.onResolve({ filter: /^jsr:/ }, () => ({ path: "client", namespace: "test" }));
    b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
      contents: "export function createClient(){ return globalThis.steamAuthClient; }", loader: "js",
    }));
  } }],
});

// Steam signs with a key only it holds; this stand-in says is_valid for the one signature
// it issued and nothing else, which is what check_authentication answers.
const GENUINE_SIG = "c2lnbmVkLWJ5LXN0ZWFt";
const steamChecks = [];
globalThis.fetch = async (url, init) => {
  if (String(url) === STEAM && init?.method === "POST") {
    const body = new URLSearchParams(String(init.body));
    steamChecks.push(body);
    const valid = body.get("openid.mode") === "check_authentication" && body.get("openid.sig") === GENUINE_SIG;
    return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n`, { status: 200 });
  }
  throw new Error(`unexpected network call: ${url}`);
};
const env = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", STEAM_AUTH_FUNCTION_URL: FUNCTION_URL };
let serve;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (fn) => { serve = fn; } };
await import(pathToFileURL(resolve(".cache/steam-auth-test.mjs")).href);
assert.equal(typeof serve, "function", "the real steam-auth handler registered");

const call = (url) => serve(new Request(url));
const loopback = (res) => new URL(res.headers.get("location"));

async function start(port, state) {
  const res = await call(`${FUNCTION_URL}/start?port=${port}&state=${state}`);
  assert.equal(res.status, 302, "start redirects to Steam");
  const to = new URL(res.headers.get("location"));
  assert.equal(to.origin + to.pathname, STEAM);
  return new URL(to.searchParams.get("openid.return_to"));
}

/** The callback Steam sends after the player signs in: return_to plus the signed assertion. */
function assertion(returnTo, { nonceAt = Date.now(), nonce = "a1b2c3", signed, sig = GENUINE_SIG, returnToOverride } = {}) {
  const url = new URL(returnTo);
  const fields = {
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM,
    "openid.claimed_id": `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    "openid.identity": `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    "openid.return_to": returnToOverride ?? returnTo.toString(),
    "openid.response_nonce": `${new Date(nonceAt).toISOString().slice(0, 19)}Z${nonce}`,
    "openid.assoc_handle": "1234567890",
    "openid.signed": signed ?? "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": sig,
  };
  for (const [k, v] of Object.entries(fields)) url.searchParams.set(k, v);
  return url.toString();
}
const state = (n) => `state-${n}-${"x".repeat(40)}`;

// ---- the honest sign-in ---------------------------------------------------------------
const returnTo = await start(51234, state(1));
assert.equal(returnTo.searchParams.get("port"), "51234");
const captured = assertion(returnTo);
const first = loopback(await call(captured));
assert.equal(first.host, "127.0.0.1:51234");
assert.equal(first.searchParams.get("state"), state(1));
assert.equal(first.searchParams.get("steam_id"), STEAM_ID);
assert.ok(first.searchParams.get("token_hash"), "the desktop client receives a one-time token");
assert.equal(first.searchParams.get("error"), null);
assert.equal(steamChecks.length, 1, "Steam was asked once");
pass("the desktop flow: /start, Steam's callback, a one-time token on the loopback port");

// ---- the same callback again ------------------------------------------------------------
const replay = loopback(await call(captured));
assert.equal(replay.searchParams.get("token_hash"), null, "a replayed callback mints no token");
assert.match(replay.searchParams.get("error") ?? "", /already been used/);
assert.equal(tokens, 1);
pass("the same captured parameter set presented twice: the second is refused");

// A replay with a fresh state of the attacker's own: the signed return_to names the
// victim's state, so the assertion is bound to the victim's sign-in.
const attackerReturn = await start(51235, state(2));
const rebound = new URL(captured);
rebound.searchParams.set("port", "51235");
rebound.searchParams.set("state", state(2));
const reboundRes = loopback(await call(rebound.toString()));
assert.equal(reboundRes.searchParams.get("token_hash"), null);
assert.match(reboundRes.searchParams.get("error") ?? "", /different sign-in/);
void attackerReturn;
pass("a captured assertion moved onto another sign-in attempt is refused");

// ---- assertions that are not this function's ---------------------------------------------
const r3 = await start(51236, state(3));
const elsewhere = loopback(await call(assertion(r3, { nonce: "n3", returnToOverride: "https://evil.invalid/callback?port=51236&state=" + state(3) })));
assert.match(elsewhere.searchParams.get("error") ?? "", /different address/);
pass("an assertion whose signed return_to names another address is refused");

const r4 = await start(51237, state(4));
const unsigned = loopback(await call(assertion(r4, { nonce: "n4", signed: "signed,op_endpoint,claimed_id,identity,response_nonce,assoc_handle" })));
assert.match(unsigned.searchParams.get("error") ?? "", /did not sign return_to/);
pass("an assertion whose return_to Steam did not sign is refused");

const r5 = await start(51238, state(5));
const stale = loopback(await call(assertion(r5, { nonce: "n5", nonceAt: Date.now() - 20 * 60_000 })));
assert.match(stale.searchParams.get("error") ?? "", /expired/);
pass("a nonce more than fifteen minutes old is refused");

const never = new URL(`${FUNCTION_URL}/callback?port=51239&state=${state(6)}`);
const orphan = loopback(await call(assertion(never, { nonce: "n6" })));
assert.match(orphan.searchParams.get("error") ?? "", /not started here/);
pass("a callback for a sign-in that never began at /start is refused");

const r7 = await start(51240, state(7));
const forged = loopback(await call(assertion(r7, { nonce: "n7", sig: "Zm9yZ2Vk" })));
assert.match(forged.searchParams.get("error") ?? "", /could not confirm/);
pass("a signature Steam did not issue is refused, as before");

// The attempt the forged signature was presented on is still unused, and the genuine
// assertion for it completes: a refusal does not burn an honest sign-in.
const late = loopback(await call(assertion(r7, { nonce: "n7b" })));
assert.ok(late.searchParams.get("token_hash"));
pass("an honest sign-in still completes after a refused attempt on it");

await db.exec("set role authenticated");
await assert.rejects(db.query("select * from steam_openid_nonces"), (e) => e.code === "42501");
await assert.rejects(db.query("delete from steam_signin_attempts"), (e) => e.code === "42501");
await db.exec("reset role");
pass("clients can neither read nor clear the nonce and attempt stores");

await db.close();
console.log(`\nOK: ${cases} Steam sign-in cases against the shipped steam-auth function`);
