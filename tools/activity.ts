/**
 * Who has joined and who is playing, against the live project.
 *
 *   npm run activity [-- --days 7]
 *   npm run activity -- --count      just the totals, per release
 *
 * Nothing in the app reports usage, and nothing should: the client never phones home
 * beyond the runs it uploads. Everything worth knowing is already in the tables those
 * uploads land in, so this reads them with the service key. Every player is listed,
 * grouped by the GitHub release that was current when they signed up, followed by the
 * queue as it stands and recent matches.
 *
 * Read-only by construction: every request to the project is a GET.
 *
 * Bounded per player rather than per run. The first version paged every run uploaded in
 * the window and counted each player's runs with all requests in flight at once. Then
 * Steam sign-in started uploading a player's whole history, so one new player could put
 * ten thousand rows in the window, and the burst of parallel counts grew with every
 * sign-up. Now each player costs four small requests (a count, a latest, two windowed
 * counts), at most CONCURRENCY at a time, however much they have uploaded.
 *
 * `players.last_seen_at` is only stamped by steam-auth, so it means "last signed in",
 * not "last opened the app". The last upload is the better signal of someone actually
 * playing, and is shown beside it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MIN_RUNS_TO_QUEUE } from "../src/core/match/eligibility.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

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
if (!URL_BASE || !SECRET) {
  console.error("missing APOGEE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > 0 ? Number(process.argv[daysArg + 1]) || 7 : 7;
const now = Date.now();
const since = new Date(now - DAYS * 86_400_000).toISOString();
const dayAgo = new Date(now - 86_400_000).toISOString();

/** Requests in flight at once. Enough to be quick, few enough not to be refused. */
const CONCURRENCY = 8;

const headers = { apikey: SECRET, Authorization: `Bearer ${SECRET}` };

/**
 * One GET, retried on the answers that mean "not now" rather than "no".
 *
 * A failure names the request, because "fetch failed" on its own is what made the first
 * version impossible to diagnose once it broke.
 */
async function request(path: string, extra: Record<string, string> = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${URL_BASE}/rest/v1/${path}`, { headers: { ...headers, ...extra } });
    } catch (e) {
      if (attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
      throw new Error(`${path}: ${e instanceof Error ? e.message : e}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!res.ok && res.status !== 416) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    return res;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(path: string): Promise<T[]> {
  return (await (await request(path)).json()) as T[];
}

/** Exact row count without fetching rows. */
async function count(path: string): Promise<number> {
  const res = await request(path, { Prefer: "count=exact", Range: "0-0" });
  return Number(res.headers.get("content-range")?.split("/")[1] ?? 0);
}

/** Every row, a page at a time; the project caps a page at 1000. */
async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = (await (await request(path, { Range: `${from}-${from + 999}` })).json()) as T[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

/** `fn` over `items`, at most CONCURRENCY at a time, results in input order. */
async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return "-";
  const s = (now - new Date(iso).getTime()) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const pad = (v: unknown, n: number) => String(v).slice(0, n).padEnd(n);
const lpad = (v: unknown, n: number) => String(v).slice(0, n).padStart(n);

interface Release {
  tag: string;
  publishedAt: string;
}
interface Player {
  id: string;
  display_name: string;
  country: string | null;
  created_at: string;
  last_seen_at: string | null;
}
interface Rating {
  player_id: string;
  rating: number;
  rd: number;
  matches_played: number;
}
interface Side {
  player_id: string;
  result: string | null;
  rating_before: number | null;
  rating_after: number | null;
  submitted_at: string | null;
}
interface Match {
  id: string;
  category: string;
  difficulty: string;
  status: string;
  rated: boolean;
  created_at: string;
  match_sides: Side[];
}
interface Usage {
  total: number;
  lastUpload: string | null;
  window: number;
  day: number;
}

/**
 * The project's GitHub releases, oldest first.
 *
 * Read through `gh` because it is already signed in on this machine; the public API is
 * the fallback. With neither, everyone is listed in one group rather than not at all.
 */
function releases(): Release[] {
  try {
    const raw = execFileSync("gh", ["release", "list", "--limit", "100", "--json", "tagName,publishedAt"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return (JSON.parse(raw) as { tagName: string; publishedAt: string }[])
      .map((r) => ({ tag: r.tagName, publishedAt: r.publishedAt }))
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  } catch {
    return [];
  }
}

async function publicReleases(): Promise<Release[]> {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim();
    const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(remote);
    if (!m) return [];
    const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/releases?per_page=100`);
    if (!res.ok) return [];
    return ((await res.json()) as { tag_name: string; published_at: string | null }[])
      .filter((r) => r.published_at)
      .map((r) => ({ tag: r.tag_name, publishedAt: r.published_at! }))
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  } catch {
    return [];
  }
}

/** The release that was current when `at` happened, or null before the first. */
function releaseAt(list: Release[], at: string): Release | null {
  // As instants, not strings: GitHub writes "…24Z" and Postgres "…24.123+00:00", and
  // those do not sort the same way as text.
  const t = Date.parse(at);
  let current: Release | null = null;
  for (const r of list) if (Date.parse(r.publishedAt) <= t) current = r;
  return current;
}

/** Runs not rejected, which is what the queue gate counts, plus recent upload activity. */
async function usage(p: Player): Promise<Usage> {
  const [total, latest, window, day] = await Promise.all([
    count(`runs?select=id&player_id=eq.${p.id}&verification_tier=neq.rejected`),
    get<{ created_at: string }>(`runs?select=created_at&player_id=eq.${p.id}&order=created_at.desc&limit=1`),
    count(`runs?select=id&player_id=eq.${p.id}&created_at=gte.${since}`),
    count(`runs?select=id&player_id=eq.${p.id}&created_at=gte.${dayAgo}`),
  ]);
  return { total, lastUpload: latest[0]?.created_at ?? null, window, day };
}

async function main(): Promise<void> {
  const countOnly = process.argv.includes("--count");

  let list = releases();
  if (list.length === 0) list = await publicReleases();

  console.log(`project:  ${URL_BASE}`);
  console.log(`releases: ${list.length ? list.map((r) => r.tag).join(", ") : "none found (gh and the GitHub API both failed)"}`);
  if (!countOnly) console.log(`window:   last ${DAYS} day(s)`);
  console.log();

  const [players, ratings] = await Promise.all([
    all<Player>("players?select=id,display_name,country,created_at,last_seen_at&order=created_at.asc"),
    all<Rating>("ratings?select=player_id,rating,rd,matches_played"),
  ]);
  const name = new Map(players.map((p) => [p.id, p.display_name]));
  const rating = new Map(ratings.map((r) => [r.player_id, r]));

  process.stderr.write(`reading uploads for ${players.length} players...`);
  const usages = await pool(players, usage);
  process.stderr.write(" done\n\n");
  const use = new Map(players.map((p, i) => [p.id, usages[i]]));

  // ---- by release ---------------------------------------------------------------
  // Oldest release first, players in the order they joined. A player's release is the
  // one that was current when their account was created.
  const groups = new Map<string, Player[]>();
  const label = (r: Release | null) => (r ? r.tag : "before the first release");
  for (const p of players) {
    const key = label(releaseAt(list, p.created_at));
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const order = [label(null), ...list.map((r) => r.tag)].filter((k) => groups.has(k));

  const stats = (ps: Player[]) => ({
    joined: ps.length,
    played: ps.filter((p) => (use.get(p.id)?.total ?? 0) > 0).length,
    eligible: ps.filter((p) => (use.get(p.id)?.total ?? 0) >= MIN_RUNS_TO_QUEUE).length,
    matched: ps.filter((p) => (rating.get(p.id)?.matches_played ?? 0) > 0).length,
    activeWindow: ps.filter((p) => (use.get(p.id)?.window ?? 0) > 0).length,
  });

  console.log("── by release ───────────────────────────────────");
  console.log(`  ${pad("release", 26)} ${lpad("joined", 6)} ${lpad("uploaded", 9)} ${lpad(`can queue`, 10)} ${lpad("matched", 8)} ${lpad(`active ${DAYS}d`, 10)}`);
  for (const key of order) {
    const s = stats(groups.get(key)!);
    console.log(`  ${pad(key, 26)} ${lpad(s.joined, 6)} ${lpad(s.played, 9)} ${lpad(s.eligible, 10)} ${lpad(s.matched, 8)} ${lpad(s.activeWindow, 10)}`);
  }
  const t = stats(players);
  console.log(`  ${pad("total", 26)} ${lpad(t.joined, 6)} ${lpad(t.played, 9)} ${lpad(t.eligible, 10)} ${lpad(t.matched, 8)} ${lpad(t.activeWindow, 10)}`);
  console.log(`  uploaded = at least one run; can queue = ${MIN_RUNS_TO_QUEUE}+ runs not rejected; matched = a rated match settled\n`);

  if (countOnly) return;

  // ---- everyone -------------------------------------------------------------------
  const header =
    `  ${pad("name", 20)} ${pad("cc", 3)} ${pad("joined", 9)} ${pad("signed in", 10)} ${pad("last upload", 11)} ` +
    `${lpad("24h", 5)} ${lpad(`${DAYS}d`, 5)} ${lpad("total", 6)} ${lpad("mt", 4)} ${lpad("rating", 10)}`;
  for (const key of order) {
    console.log(`── joined under ${key} ${"─".repeat(Math.max(3, 34 - key.length))}`);
    console.log(header);
    for (const p of groups.get(key)!) {
      const u = use.get(p.id)!;
      const r = rating.get(p.id);
      const gate = u.total >= MIN_RUNS_TO_QUEUE ? " " : "*";
      // A seeded rating exists from a player's first queue, before any match settles;
      // shown in brackets so it does not read as a rating somebody played their way to.
      const shown = !r ? "-"
        : r.matches_played > 0 ? `${Math.round(r.rating)}±${Math.round(r.rd)}`
        : `(${Math.round(r.rating)})`;
      console.log(
        `  ${pad(p.display_name, 20)} ${pad(p.country ?? "", 3)} ${pad(ago(p.created_at), 9)} ${pad(ago(p.last_seen_at), 10)} ` +
          `${pad(ago(u.lastUpload), 11)} ${lpad(u.day, 5)} ${lpad(u.window, 5)} ${lpad(u.total, 5)}${gate} ` +
          `${lpad(r?.matches_played ?? 0, 4)} ${lpad(shown, 10)}`,
      );
    }
    console.log();
  }
  console.log(`  * under the ${MIN_RUNS_TO_QUEUE}-run queue gate; (rating) seeded, no match settled yet\n`);

  // ---- queue right now ----------------------------------------------------------
  const live = await get<Match>(
    "matches?select=id,category,difficulty,status,rated,created_at,match_sides(player_id,result,rating_before,rating_after,submitted_at)&status=in.(open,awaiting_runs)&order=created_at.desc&limit=50",
  );
  console.log("── in progress ──────────────────────────────────");
  if (live.length === 0) console.log("  nothing open");
  for (const m of live) {
    const who = m.match_sides
      .map((s) => `${name.get(s.player_id) ?? s.player_id.slice(0, 8)}${s.submitted_at ? " (done)" : ""}`)
      .join(" vs ");
    console.log(
      `  ${pad(m.status, 13)} ${pad(`${m.category} ${m.difficulty}`, 24)} started ${pad(ago(m.created_at), 8)} ${who || "(waiting for an opponent)"}`,
    );
  }
  console.log();

  // ---- recent matches -------------------------------------------------------------
  const recent = await get<Match>(
    `matches?select=id,category,difficulty,status,rated,created_at,match_sides(player_id,result,rating_before,rating_after,submitted_at)&status=in.(settled,void)&created_at=gte.${since}&order=created_at.desc&limit=40`,
  );
  const byStatus = await Promise.all(
    ["settled", "void"].map(async (s) => `${s} ${await count(`matches?select=id&status=eq.${s}&created_at=gte.${since}`)}`),
  );
  console.log(`── recent matches (${byStatus.join(", ")}) ─────────────`);
  if (recent.length === 0) console.log("  none in window");
  for (const m of recent) {
    const sides = m.match_sides
      .map((s) => {
        const who = name.get(s.player_id) ?? s.player_id.slice(0, 8);
        const delta =
          s.rating_before != null && s.rating_after != null
            ? ` ${s.rating_after >= s.rating_before ? "+" : ""}${Math.round(s.rating_after - s.rating_before)}`
            : "";
        return `${who} ${s.result ?? "-"}${delta}`;
      })
      .join("  |  ");
    const tag = m.status === "void" ? "void" : m.rated ? "rated" : "unrated";
    console.log(`  ${pad(ago(m.created_at), 8)} ${pad(tag, 7)} ${pad(`${m.category} ${m.difficulty}`, 24)} ${sides}`);
  }
  console.log();

  // ---- duels and tournaments --------------------------------------------------------
  const duelCounts = await Promise.all(
    ["open", "accepted", "declined", "expired"].map(
      async (s) => `${s} ${await count(`duels?select=id&status=eq.${s}&created_at=gte.${since}`)}`,
    ),
  );
  const tournaments = await get<{ name: string; phase: string }>(
    "tournaments?select=name,phase&phase=in.(registration,groups,playoffs)",
  );
  console.log("── social ───────────────────────────────────────");
  console.log(`  duels in window: ${duelCounts.join(", ")}`);
  console.log(
    `  tournaments running: ${tournaments.length ? tournaments.map((t) => `${t.name} (${t.phase})`).join(", ") : "none"}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
