/**
 * Verify the deployed project, against the live API rather than a local database.
 *
 * A schema that applies cleanly locally proves the SQL is valid. It does not prove the
 * security model survived deployment: that the anon key genuinely cannot write to
 * `ratings`, that reference data really is public, that the Steam function is reachable
 * without a JWT (Steam's servers call it directly and cannot supply one) and rejects a
 * forged assertion.
 *
 * Those are the claims the whole design rests on, so they are checked where they
 * actually matter.
 *
 *   npx tsx tools/verifyDeployment.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Minimal .env reader; avoids a dependency for five values. */
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
const ANON = env.APOGEE_SUPABASE_ANON_KEY;
const SECRET = env.SUPABASE_SERVICE_ROLE_KEY;
const FN = env.STEAM_AUTH_FUNCTION_URL?.replace(/\/+$/, "");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function rest(
  path: string,
  key: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.text() };
}

async function main(): Promise<void> {
  for (const [name, value] of Object.entries({ URL_BASE, ANON, SECRET, FN })) {
    if (!value) {
      console.error(`missing ${name} in .env`);
      process.exit(1);
    }
  }

  console.log(`project: ${URL_BASE}\n`);

  // ---- reference data is public ------------------------------------------------
  console.log("── public reference data ────────────────────────");

  const scenarios = await rest("scenarios?select=name,aim_type,sub_category&limit=3", ANON!);
  check("anon can read scenarios", scenarios.status === 200, `HTTP ${scenarios.status}`);

  const counted = await rest("scenarios?select=count", ANON!, {
    headers: { Prefer: "count=exact" },
  });
  const total = JSON.parse(counted.body || "[]")[0]?.count;
  check("all scenarios seeded", total === 248, `${total}`);

  const memberships = await rest("benchmark_scenarios?select=count", ANON!, {
    headers: { Prefer: "count=exact" },
  });
  const mTotal = JSON.parse(memberships.body || "[]")[0]?.count;
  check("all benchmark memberships seeded", mTotal === 261, `${mTotal}`);

  // The pool find-match actually queries.
  //
  // Every other check here would pass with that pool empty: the tables exist, the
  // functions are deployed, and queueing returns a 404 nobody has a reason to expect. This
  // is the precondition for a match being possible at all.
  //
  // Read with the service key, not the anon one, because that is the view find-match has.
  // A draft season is admin-only by RLS, so an anon check would report an empty pool for a
  // season that is in fact loaded and fine - a false alarm that costs an hour.
  const seasonRes = await rest(
    "seasons?select=id,name,status,windows,window_size&status=in.(published,draft)" +
      "&order=created_at.desc&limit=10",
    SECRET!,
  );
  const seasonRows = JSON.parse(seasonRes.body || "[]") as {
    id: string;
    name: string;
    status: string;
    windows: string[] | null;
  }[];

  // Published wins over draft, matching how find-match picks.
  const season = seasonRows.find((s) => s.status === "published") ?? seasonRows[0];

  check("a season is loaded for matches to draw from", !!season, season
    ? `${season.name} (${season.status})`
    : "none - run npm run push:season");

  if (season) {
    // Every window, not only the one matches currently use: a window with no scenarios is
    // a difficulty the editor will happily offer and the server cannot fulfil.
    const windows = season.windows ?? [];
    for (const [index, name] of windows.entries()) {
      const pool = await rest(
        `season_scenarios?select=count&season_id=eq.${season.id}&window_index=eq.${index}`,
        SECRET!,
        { headers: { Prefer: "count=exact" } },
      );
      const size = JSON.parse(pool.body || "[]")[0]?.count ?? 0;
      check(
        `${name} has scenarios to draw a match from`,
        size >= 3,
        `${size} scenarios`,
      );
    }

    const orphans = await rest(
      `season_scenarios?select=count&season_id=eq.${season.id}&window_index=is.null`,
      SECRET!,
      { headers: { Prefer: "count=exact" } },
    );
    const orphaned = JSON.parse(orphans.body || "[]")[0]?.count ?? 0;
    check(
      "every scenario in the season names a window",
      orphaned === 0,
      `${orphaned} without one`,
    );
  }

  const precise = await rest(
    "scenarios?select=name&sub_category=eq.Precise&name=like.*Intermediate*&order=name",
    ANON!,
  );
  const preciseNames = JSON.parse(precise.body || "[]").map((r: { name: string }) => r.name);
  check(
    "the corrected sub-category mapping is live",
    preciseNames.join(", ") === "VT PGT Intermediate S5, VT Snake Track Intermediate S5",
    preciseNames.join(", "),
  );

  // ---- the security model ------------------------------------------------------
  console.log("\n── row level security, live ─────────────────────");

  // The single most important claim in the design.
  const writeRating = await rest("ratings", ANON!, {
    method: "POST",
    body: JSON.stringify({
      player_id: "00000000-0000-0000-0000-000000000000",
      rating: 9999,
    }),
  });
  check(
    "anon CANNOT write to ratings",
    writeRating.status === 401 || writeRating.status === 403,
    `HTTP ${writeRating.status}`,
  );

  const writeMatch = await rest("matches", ANON!, {
    method: "POST",
    body: JSON.stringify({
      category: "Clicking",
      difficulty: "Intermediate",
      seed: "x",
      scenario_ids: [1, 2, 3],
    }),
  });
  check(
    "anon CANNOT create matches",
    writeMatch.status === 401 || writeMatch.status === 403,
    `HTTP ${writeMatch.status}`,
  );

  const writeScenario = await rest("scenarios", ANON!, {
    method: "POST",
    body: JSON.stringify({ name: "Injected Scenario" }),
  });
  check(
    "anon CANNOT write reference data",
    writeScenario.status === 401 || writeScenario.status === 403,
    `HTTP ${writeScenario.status}`,
  );

  // An unauthenticated caller has no auth.uid(), so the runs insert policy must reject.
  const writeRun = await rest("runs", ANON!, {
    method: "POST",
    body: JSON.stringify({
      player_id: "00000000-0000-0000-0000-000000000000",
      scenario_name: "VT Pasu Intermediate S5",
      score: 99999,
      played_at: new Date().toISOString(),
      csv_sha256: "f".repeat(64),
    }),
  });
  check(
    "anon CANNOT insert a run for someone else",
    writeRun.status === 401 || writeRun.status === 403,
    `HTTP ${writeRun.status}`,
  );

  // Private tables must not leak to an anonymous reader.
  //
  // Ground-truth these against the service role before asserting anything. The first
  // version of the players check asserted only that anon saw zero rows, which is what
  // an empty table returns however the policy is written: it passed for as long as
  // nobody had signed up, tested nothing while it did, and went red the day a real
  // account existed. A leak check that cannot fail is worse than no check, so each one
  // below first establishes that there is in fact something to leak.
  const rowsAs = async (path: string, key: string): Promise<unknown[] | null> => {
    const res = await rest(path, key);
    if (res.status !== 200) return null;
    try {
      const parsed = JSON.parse(res.body || "[]");
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const realPlayers = await rowsAs("players?select=id&limit=5", SECRET!);
  check(
    "there are player rows to leak, so the next checks mean something",
    (realPlayers?.length ?? 0) > 0,
    `${realPlayers?.length ?? 0} players`,
  );

  const readPlayers = await rest("players?select=steam_id&limit=1", ANON!);
  const players = readPlayers.status === 200 ? JSON.parse(readPlayers.body || "[]") : null;
  check(
    "anon CANNOT read player profiles",
    readPlayers.status === 401 || readPlayers.status === 403 ||
      (Array.isArray(players) && players.length === 0),
    `HTTP ${readPlayers.status}, ${players?.length ?? "?"} rows`,
  );

  // Moderation state is withheld from its subject too, which is a column privilege
  // rather than a policy: RLS chooses rows, not columns. A player who can read
  // under_review on their own row knows exactly when to stop.
  const readFlags = await rest("players?select=flags&limit=1", ANON!);
  check(
    "anon CANNOT read moderation flags",
    readFlags.status !== 200,
    `HTTP ${readFlags.status}`,
  );

  const realRuns = await rowsAs("runs?select=id&limit=5", SECRET!);
  check(
    "there are run rows to leak, so the next check means something",
    (realRuns?.length ?? 0) > 0,
    `${realRuns?.length ?? 0}+ runs`,
  );

  // This asserted the weaker of the two things that must be true, and so could not
  // fail. Accepting "HTTP 200 with an empty array" as a pass read green for the whole
  // time 20260825000013 sat unapplied: RLS was filtering the rows anon could see, while
  // the table-wide SELECT grant that migration revokes was still in place. A grant is
  // what is being verified, so the grant is what gets asserted - the same shape as the
  // players.flags check above, and for the same reason.
  const readRuns = await rest("runs?select=score&limit=1", ANON!);
  check(
    "anon CANNOT read runs at all",
    readRuns.status !== 200,
    `HTTP ${readRuns.status}`,
  );

  // Asked for by name, because a table-wide revoke and a per-column grant that let this
  // one back in are indistinguishable from the check above. verification_notes names
  // the check that caught a run, and is withheld even from the run's own author.
  const readNotes = await rest("runs?select=verification_notes&limit=1", ANON!);
  check(
    "anon CANNOT read verification notes",
    readNotes.status !== 200,
    `HTTP ${readNotes.status}`,
  );

  // ---- the steam auth function -------------------------------------------------
  console.log("\n── steam-auth edge function ─────────────────────");

  const start = await fetch(
    `${FN}/start?port=54999&state=${"a".repeat(32)}`,
    { redirect: "manual" },
  );
  const location = start.headers.get("location") ?? "";
  check(
    "function is reachable without a JWT",
    start.status !== 401 && start.status !== 404,
    `HTTP ${start.status}`,
  );
  check(
    "start redirects to Steam's OpenID endpoint",
    location.startsWith("https://steamcommunity.com/openid/login"),
    location.slice(0, 72) || "(no redirect)",
  );
  check(
    "the redirect asks Steam to return to our function",
    decodeURIComponent(location).includes("/functions/v1/steam-auth/callback"),
  );

  const badPort = await fetch(`${FN}/start?port=99999999&state=${"a".repeat(32)}`, {
    redirect: "manual",
  });
  check("an invalid loopback port is rejected", badPort.status === 400, `HTTP ${badPort.status}`);

  const noState = await fetch(`${FN}/start?port=54999`, { redirect: "manual" });
  check("a missing state is rejected", noState.status === 400, `HTTP ${noState.status}`);

  // A forged callback naming an arbitrary SteamID must not produce a session.
  const forged = await fetch(
    `${FN}/callback?port=54999&state=${"a".repeat(32)}` +
      `&openid.claimed_id=${encodeURIComponent("https://steamcommunity.com/openid/id/76561198000000000")}` +
      `&openid.mode=id_res&openid.sig=forged`,
    { redirect: "manual" },
  );
  const forgedBody = await forged.text();
  check(
    "a forged Steam assertion is rejected",
    forged.status === 400 && /rejected the assertion/i.test(forgedBody),
    `HTTP ${forged.status} ${forgedBody.slice(0, 80)}`,
  );

  // ---- the match engine ---------------------------------------------------------
  console.log("\n── match engine functions ───────────────────────");

  const fnBase = FN!.replace(/\/steam-auth$/, "");

  // These three move ratings and settle matches, so unlike steam-auth they must refuse
  // anyone without a session. An unauthenticated 200 here would be a total bypass.
  for (const name of ["submit-run", "find-match", "settle-match", "abandon-match", "refresh-baselines", "refresh-apex"]) {
    const res = await fetch(`${fnBase}/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    check(
      `${name} is deployed and refuses anonymous callers`,
      res.status === 401,
      `HTTP ${res.status}`,
    );
  }

  // A valid anon key is still not a session: it identifies the app, not a player.
  for (const name of ["find-match", "settle-match"]) {
    const res = await fetch(`${fnBase}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON!,
        Authorization: `Bearer ${ANON}`,
      },
      body: JSON.stringify({ category: "Clicking", difficulty: "Intermediate", matchId: "x" }),
    });
    check(
      `${name} rejects the anon key as a caller identity`,
      res.status === 401 || res.status === 403,
      `HTTP ${res.status}`,
    );
  }

  // ---- verification data reached the server ---------------------------------------
  console.log("\n── server-side verification data ────────────────");

  const withModels = await rest("scenarios?select=count&score_model_stat=not.is.null", ANON!, {
    headers: { Prefer: "count=exact" },
  });
  const modelCount = JSON.parse(withModels.body || "[]")[0]?.count ?? 0;
  check("score models are readable server-side", modelCount > 10,
    `${modelCount} scenarios (grows as players upload)`);

  const withWr = await rest("scenarios?select=count&world_record=not.is.null", ANON!, {
    headers: { Prefer: "count=exact" },
  });
  const wrCount = JSON.parse(withWr.body || "[]")[0]?.count ?? 0;
  check("world records are readable server-side", wrCount > 40, `${wrCount} scenarios`);

  const ratingHistory = await rest("rating_history?select=count", ANON!, {
    headers: { Prefer: "count=exact" },
  });
  check("rating history table exists and is empty",
    ratingHistory.status === 200 && JSON.parse(ratingHistory.body || "[]")[0]?.count === 0,
    `HTTP ${ratingHistory.status}`);

  // ---- rate limiting -------------------------------------------------------------
  console.log("\n── rate limiting ────────────────────────────────");

  // enforceRateLimit fails OPEN, deliberately: an unavailable limiter must not refuse
  // honest players. The cost of that choice is that a limiter which was never deployed
  // is indistinguishable at runtime from one nobody has hit yet - it logs and allows,
  // and every function keeps answering normally. So it is asserted here, where a missing
  // counter is loud, rather than discovered from a bill.
  const limits = await rest("rate_limits?select=player_id&limit=1", SECRET!);
  check("the rate limit counter exists", limits.status === 200, `HTTP ${limits.status}`);

  // A client that could reach this table could reset its own budget, which is the whole
  // limit gone. 20260824000012 revokes the grants outright rather than relying on the
  // policy-less RLS alone.
  const limitsAnon = await rest("rate_limits?select=player_id&limit=1", ANON!);
  check(
    "clients CANNOT touch the rate limit counter",
    limitsAnon.status !== 200,
    `HTTP ${limitsAnon.status}`,
  );

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK: deployment verified against the live project");
}

main();
