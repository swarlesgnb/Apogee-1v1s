/**
 * Steam sign-in for the Apogee desktop client.
 *
 * Supabase has no native Steam provider, and cannot have one: Steam speaks OpenID 2.0,
 * which was superseded by OIDC and is not an OAuth2 flow at all. So this function is a
 * bridge: it runs the OpenID 2.0 dance, verifies the assertion with Steam directly,
 * and then mints a real Supabase session for the resulting SteamID64.
 *
 * Why this matters: the SteamID is the join key to KovaaK's leaderboards. Without a
 * trustworthy binding between an Apogee account and a Steam account, server-side score
 * verification (PLAN.md §5) is meaningless, and the ladder is unprotected. This is the
 * load-bearing piece of the whole anti-cheat design.
 *
 * Flow (RFC 8252 native-app loopback pattern):
 *
 *   desktop                      this function                 steam
 *   ───────                      ─────────────                 ─────
 *   listen on 127.0.0.1:PORT
 *   open browser ─────────────▶  /start?port&state
 *                                build openid request ───────▶ user logs in
 *                                                     ◀─────── redirect w/ assertion
 *                                /callback
 *                                verify with steam ──────────▶ check_authentication
 *                                                     ◀─────── is_valid:true
 *                                get-or-create user
 *                                generate one-time token
 *   ◀──── redirect to loopback ──┘
 *   verifyOtp -> session
 *
 * The one-time token, not a session, crosses the loopback boundary: it is single-use,
 * short-lived, and useless to anything watching the redirect.
 *
 * REPLAY. Steam's check_authentication says an assertion is genuine; it does not say it
 * is new. A callback URL seen anywhere (a proxy log, synced browser history, a shared
 * machine) used to verify again and mint a fresh token for that Steam account each time
 * (security audit SEC-05). So, as OpenID 2.0 section 11 requires of a relying party:
 *
 *   - the signed `openid.return_to` must be this function's callback, carrying the same
 *     `port` and `state` the request arrived with (11.1);
 *   - `openid.response_nonce` must be fresh and is stored, and a second use is refused
 *     (11.3, steam_openid_nonces);
 *   - the fields checked must be among those Steam signed, or the signature covers none
 *     of them;
 *   - the sign-in must have begun at /start, which records the hashed state and port,
 *     and each attempt completes once (steam_signin_attempts).
 *
 * The desktop flow is unchanged: it already sends `port` and `state` to /start, Steam
 * returns them in return_to, and the loopback client still checks `state` itself.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const STEAM_OPENID = "https://steamcommunity.com/openid/login";

/** Steam returns the identity as https://steamcommunity.com/openid/id/<steamid64>. */
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(7656\d{13})$/;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
/** Public URL of this function, used to build Steam's return_to. */
const FUNCTION_URL = Deno.env.get("STEAM_AUTH_FUNCTION_URL")!;
/** Optional: enriches the profile with name and avatar. Falls back gracefully. */
const STEAM_API_KEY = Deno.env.get("STEAM_WEB_API_KEY") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * The desktop client listens on an ephemeral loopback port. Only loopback is ever a
 * valid redirect target; accepting an arbitrary host here would turn this function
 * into an open redirect that leaks one-time auth tokens.
 */
function loopbackRedirect(port: string, params: Record<string, string>): string {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error("invalid loopback port");
  }
  const url = new URL(`http://127.0.0.1:${n}/callback`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/**
 * How long a sign-in may take from /start to the callback, and how old a Steam nonce may
 * be. Steam stamps the nonce when it redirects back, seconds before the callback; the
 * attempt has to cover a Steam Guard prompt, which the desktop client allows three
 * minutes for. Fifteen covers both with room.
 */
const SIGN_IN_TTL_MS = 15 * 60_000;
/** Nonce timestamps are Steam's clock; allow it to run a little ahead of ours. */
const NONCE_FUTURE_SKEW_MS = 5 * 60_000;
/** Fields whose values this function relies on, and which Steam's signature must cover. */
const MUST_BE_SIGNED = ["op_endpoint", "claimed_id", "identity", "return_to", "response_nonce", "assoc_handle"];

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The callback URL Steam was told to return to, for this port and state. */
function returnToFor(port: string, state: string): URL {
  const returnTo = new URL(`${FUNCTION_URL.replace(/\/+$/, "")}/callback`);
  returnTo.searchParams.set("port", port);
  returnTo.searchParams.set("state", state);
  return returnTo;
}

/**
 * Why this assertion cannot be accepted, before asking Steam anything. Null when it is
 * well formed, bound to this request, and fresh.
 */
function assertionProblem(params: URLSearchParams, port: string, state: string, now: number): string | null {
  if (params.get("openid.mode") !== "id_res") return "not a sign-in response";
  if (params.get("openid.op_endpoint") !== STEAM_OPENID) return "not from Steam";

  const signed = new Set((params.get("openid.signed") ?? "").split(","));
  const unsigned = MUST_BE_SIGNED.filter((f) => !signed.has(f));
  if (unsigned.length) return `Steam did not sign ${unsigned.join(", ")}`;

  // 11.1: scheme, authority and path the same, and every return_to parameter present in
  // the request with the same value. Built from configuration rather than read off
  // req.url, which the platform may present with an internal host.
  let signedReturn: URL;
  try {
    signedReturn = new URL(params.get("openid.return_to") ?? "");
  } catch {
    return "no return address";
  }
  const expected = returnToFor(port, state);
  if (signedReturn.origin !== expected.origin || signedReturn.pathname.replace(/\/+$/, "") !== expected.pathname) {
    return "issued for a different address";
  }
  for (const [key, value] of signedReturn.searchParams) {
    if (params.get(key) !== value) return "issued for a different sign-in";
  }
  if (signedReturn.searchParams.get("port") !== port || signedReturn.searchParams.get("state") !== state) {
    return "issued for a different sign-in";
  }

  // 11.3: the nonce starts with Steam's UTC timestamp.
  const nonce = params.get("openid.response_nonce") ?? "";
  const stamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(nonce);
  if (!stamp) return "no sign-in nonce";
  const issued = Date.parse(stamp[1]);
  if (!(issued >= now - SIGN_IN_TTL_MS && issued <= now + NONCE_FUTURE_SKEW_MS)) return "this sign-in link has expired";
  return null;
}

/** Step 1: send the user to Steam. */
async function handleStart(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const port = url.searchParams.get("port") ?? "";
  const state = url.searchParams.get("state") ?? "";

  if (!state || state.length < 16 || state.length > 256) return badRequest("missing or weak state");
  try {
    loopbackRedirect(port, {}); // validate the port before we send the user away
  } catch {
    return badRequest("invalid port");
  }

  // Remember that this sign-in began, so its callback can be told from a replayed one.
  // Hashed: the row only has to prove the attempt existed. Old attempts are cleared here
  // rather than by a job, since this is the only writer.
  await admin.from("steam_signin_attempts").delete().lt("created_at", new Date(Date.now() - SIGN_IN_TTL_MS).toISOString());
  const { error: attemptError } = await admin
    .from("steam_signin_attempts")
    .insert({ state_hash: await sha256Hex(state), port: Number(port) });
  if (attemptError) {
    return badRequest(attemptError.code === "23505" ? "this sign-in was already started; try again" : "could not start sign-in");
  }

  const returnTo = returnToFor(port, state);

  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo.toString(),
    "openid.realm": new URL(FUNCTION_URL).origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });

  return Response.redirect(`${STEAM_OPENID}?${params}`, 302);
}

/**
 * Ask Steam whether the assertion it just handed us is genuine.
 *
 * This step is not optional and not skippable: without it, anyone can forge a callback
 * naming any SteamID and take over that account. We echo every openid.* parameter back
 * verbatim with mode switched to check_authentication.
 */
async function verifyWithSteam(params: URLSearchParams): Promise<boolean> {
  const body = new URLSearchParams();
  for (const [key, value] of params) {
    if (key.startsWith("openid.")) body.set(key, value);
  }
  body.set("openid.mode", "check_authentication");

  const res = await fetch(STEAM_OPENID, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return false;

  const text = await res.text();
  return /is_valid\s*:\s*true/i.test(text);
}

interface SteamProfile {
  displayName: string;
  avatarUrl: string | null;
  country: string | null;
}

async function fetchSteamProfile(steamId: string): Promise<SteamProfile> {
  const fallback: SteamProfile = {
    displayName: `Player ${steamId.slice(-6)}`,
    avatarUrl: null,
    country: null,
  };
  if (!STEAM_API_KEY) return fallback;

  try {
    const res = await fetch(
      "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/" +
        `?key=${STEAM_API_KEY}&steamids=${steamId}`,
    );
    if (!res.ok) return fallback;
    const data = await res.json();
    const p = data?.response?.players?.[0];
    if (!p) return fallback;
    return {
      displayName: p.personaname || fallback.displayName,
      avatarUrl: p.avatarfull ?? null,
      country: p.loccountrycode ?? null,
    };
  } catch {
    // A profile lookup failure must never block sign-in.
    return fallback;
  }
}

/**
 * Deterministic internal email for a Steam identity. Never shown, never mailed:
 * Supabase Auth simply requires an identifier, and the SteamID is the real one.
 *
 * The domain still says arena, and must keep saying it. This string is not a label,
 * it is a lookup key: it is already stored in auth.users for every account that has
 * ever signed in, and generateLink() below finds an existing user by it. Change it and
 * an established player stops being found, createUser makes them a second empty
 * account, and the players upsert then fails on the steam_id unique constraint. The
 * project was renamed to Apogee; this identifier was deliberately left behind.
 */
const steamEmail = (steamId: string) => `steam_${steamId}@arena.invalid`;

async function getOrCreatePlayer(steamId: string, profile: SteamProfile): Promise<string> {
  const email = steamEmail(steamId);

  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { steam_id: steamId, display_name: profile.displayName },
  });

  let userId = created?.user?.id ?? null;

  if (error) {
    // Already registered. Look in public.players first, which is the cheap path.
    const { data: existing } = await admin
      .from("players")
      .select("id")
      .eq("steam_id", steamId)
      .maybeSingle();

    if (existing) {
      userId = existing.id;
    } else {
      // The auth user can exist without a players row: the first attempt may have
      // created the account and then failed before the profile was written. Falling
      // back only to `players` made that state permanent, since every later attempt
      // would fail to create AND fail to find, locking the account out for good.
      const { data: list, error: listError } = await admin.auth.admin.listUsers();
      if (listError) throw new Error(`could not look up existing user: ${listError.message}`);

      const found = list?.users.find(
        (u) => u.email?.toLowerCase() === email.toLowerCase(),
      );
      if (!found) throw new Error(`could not create or find user: ${error.message}`);
      userId = found.id;
    }
  }

  if (!userId) throw new Error("no user id after create");

  // Upsert the public profile. display_name refreshes on every login so a Steam
  // rename propagates without the player doing anything.
  const { error: upsertError } = await admin.from("players").upsert(
    {
      id: userId,
      steam_id: steamId,
      display_name: profile.displayName,
      avatar_url: profile.avatarUrl,
      country: profile.country,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (upsertError) throw new Error(`player upsert failed: ${upsertError.message}`);

  return userId;
}

/** Step 2: Steam has sent the user back. Verify, then mint a session. */
async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const params = url.searchParams;

  const port = params.get("port") ?? "";
  const state = params.get("state") ?? "";
  if (!state) return badRequest("missing state");

  let redirect: string;
  try {
    // Inside the try, so these reach the waiting app as an error it can show. Returned as
    // a bare 400 they left the browser on a JSON page and the app on "Waiting for Steam"
    // until its three-minute timeout.
    const claimedId = params.get("openid.claimed_id") ?? "";
    const match = CLAIMED_ID_RE.exec(claimedId);
    if (!match) throw new Error("Steam did not return a recognisable identity. Try signing in again.");
    const steamId = match[1];
    if (params.get("openid.identity") !== claimedId) {
      throw new Error("Steam did not return a recognisable identity. Try signing in again.");
    }

    const now = Date.now();
    const problem = assertionProblem(params, port, state, now);
    if (problem) throw new Error(`This sign-in could not be used (${problem}). Try signing in again.`);

    if (!(await verifyWithSteam(params))) {
      throw new Error("Steam could not confirm this sign-in. Try signing in again.");
    }

    // Single use, in both senses. The nonce is Steam's, so a captured callback cannot be
    // presented again; the attempt is ours, so each /start completes once.
    await admin.from("steam_openid_nonces").delete().lt("used_at", new Date(now - 24 * 60 * 60_000).toISOString());
    const { error: nonceError } = await admin
      .from("steam_openid_nonces")
      .insert({ nonce: params.get("openid.response_nonce"), steam_id: steamId });
    if (nonceError) {
      throw new Error(nonceError.code === "23505"
        ? "This sign-in link has already been used. Sign in with Steam again."
        : "Could not record this sign-in. Try signing in again.");
    }
    const { data: attempt } = await admin
      .from("steam_signin_attempts")
      .update({ used_at: new Date(now).toISOString() })
      .eq("state_hash", await sha256Hex(state))
      .eq("port", Number(port))
      .is("used_at", null)
      .gt("created_at", new Date(now - SIGN_IN_TTL_MS).toISOString())
      .select("state_hash")
      .maybeSingle();
    if (!attempt) throw new Error("This sign-in was not started here, or has already finished. Sign in with Steam again.");

    const profile = await fetchSteamProfile(steamId);
    await getOrCreatePlayer(steamId, profile);

    // Mint a single-use token the desktop client redeems for a real session. We hand
    // over the token rather than the session itself so nothing durable is exposed in
    // a URL, a browser history entry, or a local HTTP log.
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: steamEmail(steamId),
    });
    if (linkError || !link?.properties?.hashed_token) {
      throw new Error(linkError?.message ?? "could not generate session token");
    }

    redirect = loopbackRedirect(port, {
      state,
      steam_id: steamId,
      token_hash: link.properties.hashed_token,
    });
  } catch (err) {
    redirect = loopbackRedirect(port, {
      state,
      error: err instanceof Error ? err.message : "sign-in failed",
    });
  }

  // A real 302, not a meta refresh.
  //
  // The first version used `<meta http-equiv="refresh">`, which browsers treat far less
  // reliably than a Location header when the target is plain http on loopback from an
  // https page. The symptom was the worst kind: the page said "signed in", the account
  // really was created, and the token never reached the waiting app.
  //
  // The body is still sent, with a plain link, so a browser that declines to follow the
  // redirect leaves the user something to click rather than a dead end.
  const escaped = redirect
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");

  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Signed in</title>
     <body style="font:15px system-ui;padding:3rem;text-align:center;line-height:1.6">
       <p>Signed in with Steam. Returning you to Apogee…</p>
       <p style="color:#666;font-size:13px">
         If nothing happens, <a href="${escaped}">click here to finish</a>,
         then close this tab.
       </p>
     </body>`,
    {
      status: 302,
      headers: {
        location: redirect,
        "content-type": "text/html; charset=utf-8",
        // The token in this URL is single-use and short-lived, but there is no reason
        // for it to sit in any cache.
        "cache-control": "no-store",
      },
    },
  );
}

Deno.serve(async (req) => {
  const { pathname } = new URL(req.url);

  if (pathname.endsWith("/start")) return await handleStart(req);
  if (pathname.endsWith("/callback")) return await handleCallback(req);

  return new Response("Not found", { status: 404 });
});
