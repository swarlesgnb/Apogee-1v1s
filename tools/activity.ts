/**
 * Who is playing, against the live project.
 *
 *   npm run activity [-- --days 7]
 *   npm run activity -- --count      just the number of players who have played
 *
 * Nothing in the app reports usage, and nothing should: the client never phones home
 * beyond the runs it uploads. Everything worth knowing is already in the tables those
 * uploads land in, so this reads them with the service key and prints four views -
 * players, uploads, the queue as it stands, and recent matches.
 *
 * Read-only by construction: every request is a GET.
 *
 * `players.last_seen_at` is only stamped by steam-auth, so it means "last signed in",
 * not "last opened the app". The last upload is the better signal of someone actually
 * playing, and is shown beside it.
 */

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

const headers = { apikey: SECRET, Authorization: `Bearer ${SECRET}` };

async function get<T>(path: string): Promise<T[]> {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T[];
}

/** Exact row count without fetching rows; the project caps a page at 1000. */
async function count(path: string): Promise<number> {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
  });
  if (!res.ok && res.status !== 416) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return Number(res.headers.get("content-range")?.split("/")[1] ?? 0);
}

/** Every row, a page at a time. */
async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
      headers: { ...headers, Range: `${from}-${from + 999}` },
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
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

interface Player {
  id: string;
  display_name: string;
  country: string | null;
  created_at: string;
  last_seen_at: string;
}
interface Rating {
  player_id: string;
  rating: number;
  rd: number;
  matches_played: number;
}
interface RunRow {
  player_id: string;
  created_at: string;
}
interface Side {
  player_id: string;
  result: string | null;
  match_score: number | null;
  rating_before: number | null;
  rating_after: number | null;
  submitted_at: string | null;
}
interface Match {
  id: string;
  mode: string;
  category: string;
  difficulty: string;
  status: string;
  rated: boolean;
  created_at: string;
  expires_at: string | null;
  settled_at: string | null;
  match_sides: Side[];
}

/**
 * "Played" means uploaded at least one run, rejected or not: signing in through Steam
 * and closing the app makes a `players` row but is not playing. The !inner embed turns
 * the count into players with a matching run, so no run rows are fetched.
 */
async function playedCount(): Promise<void> {
  const [played, signedUp] = await Promise.all([
    count("players?select=id,runs!inner(id)"),
    count("players?select=id"),
  ]);
  console.log(`${played} players have played (${signedUp} signed up)`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--count")) return playedCount();

  console.log(`project: ${URL_BASE}`);
  console.log(`window:  last ${DAYS} day(s)\n`);

  const [players, ratings, recentRuns] = await Promise.all([
    all<Player>("players?select=id,display_name,country,created_at,last_seen_at&order=created_at.asc"),
    all<Rating>("ratings?select=player_id,rating,rd,matches_played"),
    all<RunRow>(`runs?select=player_id,created_at&created_at=gte.${since}&order=created_at.desc`),
  ]);
  const name = new Map(players.map((p) => [p.id, p.display_name]));
  const rating = new Map(ratings.map((r) => [r.player_id, r]));

  // The queue gate counts runs not rejected, so this does too.
  const totals = new Map<string, number>();
  await Promise.all(
    players.map(async (p) =>
      totals.set(p.id, await count(`runs?select=id&player_id=eq.${p.id}&verification_tier=neq.rejected`)),
    ),
  );

  const lastUpload = new Map<string, string>();
  const uploadsWindow = new Map<string, number>();
  const uploadsDay = new Map<string, number>();
  for (const r of recentRuns) {
    if (!lastUpload.has(r.player_id)) lastUpload.set(r.player_id, r.created_at);
    uploadsWindow.set(r.player_id, (uploadsWindow.get(r.player_id) ?? 0) + 1);
    if (r.created_at >= dayAgo) uploadsDay.set(r.player_id, (uploadsDay.get(r.player_id) ?? 0) + 1);
  }

  // ---- summary ----------------------------------------------------------------
  const newPlayers = players.filter((p) => p.created_at >= since).length;
  const activeDay = uploadsDay.size;
  const activeWindow = uploadsWindow.size;
  const eligible = players.filter((p) => (totals.get(p.id) ?? 0) >= MIN_RUNS_TO_QUEUE).length;
  const rated = ratings.filter((r) => r.matches_played > 0).length;
  console.log("── summary ──────────────────────────────────────");
  console.log(`  players signed up       ${players.length}  (${newPlayers} in window)`);
  console.log(`  uploaded in last 24h    ${activeDay}`);
  console.log(`  uploaded in window      ${activeWindow}  (${recentRuns.length} runs)`);
  console.log(`  can queue (>=${MIN_RUNS_TO_QUEUE} runs)   ${eligible}`);
  console.log(`  have played a match     ${rated}\n`);

  // ---- players ----------------------------------------------------------------
  // Most recently active first: an upload beats a sign-in, a sign-in beats nothing.
  const recency = (p: Player) => lastUpload.get(p.id) ?? p.last_seen_at;
  const sorted = [...players].sort((a, b) => recency(b).localeCompare(recency(a)));
  console.log("── players ──────────────────────────────────────");
  console.log(
    `  ${pad("name", 20)} ${pad("cc", 3)} ${pad("joined", 9)} ${pad("signed in", 10)} ${pad("last upload", 11)} ${lpad("24h", 5)} ${lpad(`${DAYS}d`, 5)} ${lpad("total", 6)} ${lpad("mt", 4)} ${lpad("rating", 10)}`,
  );
  for (const p of sorted) {
    const r = rating.get(p.id);
    const total = totals.get(p.id) ?? 0;
    const gate = total >= MIN_RUNS_TO_QUEUE ? " " : "*";
    console.log(
      `  ${pad(p.display_name, 20)} ${pad(p.country ?? "", 3)} ${pad(ago(p.created_at), 9)} ${pad(ago(p.last_seen_at), 10)} ${pad(ago(lastUpload.get(p.id)), 11)} ${lpad(uploadsDay.get(p.id) ?? 0, 5)} ${lpad(uploadsWindow.get(p.id) ?? 0, 5)} ${lpad(total, 5)}${gate} ${lpad(r?.matches_played ?? 0, 4)} ${lpad(r && r.matches_played > 0 ? `${Math.round(r.rating)}±${Math.round(r.rd)}` : "-", 10)}`,
    );
  }
  console.log(`  * under the ${MIN_RUNS_TO_QUEUE}-run queue gate\n`);

  // ---- queue right now ----------------------------------------------------------
  const live = await get<Match>(
    "matches?select=id,mode,category,difficulty,status,rated,created_at,expires_at,settled_at,match_sides(player_id,result,match_score,rating_before,rating_after,submitted_at)&status=in.(open,awaiting_runs)&order=created_at.desc&limit=50",
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
    `matches?select=id,mode,category,difficulty,status,rated,created_at,expires_at,settled_at,match_sides(player_id,result,match_score,rating_before,rating_after,submitted_at)&status=in.(settled,void)&created_at=gte.${since}&order=created_at.desc&limit=40`,
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
