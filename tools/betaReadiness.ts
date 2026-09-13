/**
 * Pre-flight check for the closed beta.
 *
 * Inviting people is the one step that cannot be undone quietly: a ladder that eats a
 * tester's first ten matches, or a rank that displays a wrong number, costs credibility
 * that is expensive to win back in a small community.
 *
 * So this enumerates everything that must be true before the first invite goes out,
 * separated into what BLOCKS a beta and what merely should be known. Automated items
 * are checked here; the rest are printed as a manual list, because pretending a human
 * decision has been verified is worse than admitting it hasn't.
 *
 *   npx tsx tools/betaReadiness.ts
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

type Severity = "blocker" | "advisory";

interface Result {
  severity: Severity;
  label: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];

function check(severity: Severity, label: string, fn: () => [boolean, string]): void {
  let ok = false;
  let detail = "";
  try {
    [ok, detail] = fn();
  } catch (err) {
    ok = false;
    detail = err instanceof Error ? err.message : String(err);
  }
  results.push({ severity, label, ok, detail });
}

const file = (...p: string[]) => join(root, ...p);
const readJson = (...p: string[]) => JSON.parse(readFileSync(file(...p), "utf8"));

// ---------------------------------------------------------------------------
// data integrity
// ---------------------------------------------------------------------------

check("blocker", "benchmark definitions present", () => {
  const dir = file("data", "benchmarks");
  if (!existsSync(dir)) return [false, "data/benchmarks is missing"];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return [files.length > 0, `${files.length} benchmark definitions`];
});

check("blocker", "thresholds are populated, not placeholders", () => {
  // The season, not a benchmark file. This read voltaic-s5.json, which is nothing the app
  // grades against any more - it reported 72/72 for a benchmark the pool draws 27
  // scenarios from and would have said the same with the season empty.
  const season = readJson("data", "seasons", "season-1.json");
  const scenarios = season.scenarios ?? [];
  const empty = scenarios.filter((s: any) => !s.rankMaxes || s.rankMaxes.length === 0);
  return [
    scenarios.length > 0 && empty.length === 0,
    `${scenarios.length - empty.length}/${scenarios.length} season scenarios have thresholds`,
  ];
});

check("blocker", "rank ladder is well-formed", () => {
  const theme = readJson("data", "apogee_ranks.json");
  const tiers = theme.tiers ?? [];
  if (tiers.length === 0) return [false, "no tiers"];

  const sorted = [...tiers].sort((a: any, b: any) => a.percentile[0] - b.percentile[0]);
  if (sorted[0].percentile[0] !== 0) return [false, "does not start at 0"];
  if (sorted[sorted.length - 1].percentile[1] !== 100) return [false, "does not end at 100"];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].percentile[0] !== sorted[i - 1].percentile[1]) {
      return [false, `gap before ${sorted[i].name}`];
    }
  }
  return [true, `${tiers.length} tiers, contiguous`];
});

// The advisory below reads apogee_ranks.json, which holds the eight OVERALL tiers. It
// passed the whole time the season's per-category ladders were unnamed, because it never
// looks at them - and those are the names on the ranks screen, three ladders of sixteen
// against one overall tier. A blocker rather than an advisory: the ladder is the product,
// and a tester who is told they are "Advanced 2" has been told nothing.
//
// Only the editor's own generated default is flagged - `addWindow` in renderer.js names
// each new rank `${name} ${i + 1}`, so "Rank 3" and "Advanced 2" are provably un-renamed
// rather than merely plain. Anything else is a naming judgement, and this file has no
// business making one.
check("blocker", "season rank ladders have been named", () => {
  const season = readJson("data", "seasons", "season-1.json");
  const size = season.windowSize ?? 4;

  // `addWindow` in renderer.js names each new rank `${name} ${i + 1}`, where i is the
  // rank's position WITHIN its window. Reproducing that exactly is what separates an
  // un-renamed default from a real name that happens to end in a number: matching
  // `\S+ \d+` alone flags Tracking's "HAL 9000", which is deliberate and coloured
  // #ff0000. Colour is no help on its own either - "Rank 1..4" carries a real gradient,
  // renamed never, recoloured already.
  const unnamed: string[] = [];
  for (const cat of season.categories ?? []) {
    (cat.rankNames ?? []).forEach((name: string, i: number) => {
      const m = /^(\S+) (\d+)\**$/.exec(name);
      if (m && Number(m[2]) === (i % size) + 1) unnamed.push(`${cat.name}: ${name}`);
    });
  }

  const total = (season.categories ?? []).reduce(
    (n: number, c: any) => n + (c.rankNames?.length ?? 0),
    0,
  );
  if (unnamed.length === 0) {
    return [true, `${total} ranks named across ${(season.categories ?? []).length} ladders`];
  }
  return [
    false,
    `${unnamed.length}/${total} still on the editor default: ${unnamed.slice(0, 4).join(", ")}`,
  ];
});

// Every rank must have a scenario behind it.
//
// validateSeasonEdits already owns this rule - "a family missing a window is refused,
// so ranks 5-8 cannot be reached" - but it only ever exercises it against synthetic
// fixtures. Nothing pointed it at the pair that actually ships, and the gap is not
// theoretical: the season declared a fourth window, Extreme, that the pool had no
// families for and the server had no season_scenarios rows for. Ranks 13-16 rendered
// normally, filled in as the player trained because ranks are computed locally, and
// could never be drawn by find-match. A tier that looks alive and is not is worse than
// one that is visibly broken, so this is a blocker.
check("blocker", "every rank has scenarios behind it", () => {
  const pool = readJson("data", "pool.json");
  const season = readJson("data", "seasons", "season-1.json");
  const size = season.windowSize ?? pool.windowSize ?? 4;

  // Which window indices the pool can actually fill, per category.
  const filled = new Map<string, Set<number>>();
  for (const family of pool.families ?? []) {
    const seen = filled.get(family.category) ?? new Set<number>();
    for (const v of family.variants ?? []) seen.add(v.window);
    filled.set(family.category, seen);
  }

  const unreachable: string[] = [];
  for (const cat of season.categories ?? []) {
    const depth = cat.rankNames?.length ?? 0;
    const seen = filled.get(cat.name) ?? new Set<number>();
    for (let w = 0; w * size < depth; w++) {
      if (!seen.has(w)) {
        const first = w * size + 1;
        unreachable.push(`${cat.name} ranks ${first}-${Math.min(depth, first + size - 1)}`);
      }
    }
  }

  if (unreachable.length === 0) {
    const windows = Math.max(
      ...(season.categories ?? []).map((c: any) => Math.ceil((c.rankNames?.length ?? 0) / size)),
    );
    return [true, `every rank is backed, ${windows} window(s) deep`];
  }
  return [false, `no scenarios for ${unreachable.join("; ")}`];
});

check("advisory", "rank tiers have real names", () => {
  const theme = readJson("data", "apogee_ranks.json");
  const placeholder = theme.placeholderNames === true ||
    theme.tiers.some((t: any) => /^Tier [IVX]+$/.test(t.name));
  return [!placeholder, placeholder ? "still using placeholder names" : theme.tiers.map((t: any) => t.name).join(", ")];
});

check("advisory", "narrow tiers are deliberate, not accidental", () => {
  const theme = readJson("data", "apogee_ranks.json");
  const narrow = theme.tiers.filter((t: any) => t.percentile[1] - t.percentile[0] <= 1);
  if (narrow.length === 0) return [true, "all tiers are 2%+ wide"];

  // A narrow tier is only a problem when it is an oversight. A prestige tier is
  // supposed to be nearly empty, and a fixed cap makes it mean the same thing at
  // every population, which a bare percentage does not.
  const accidental = narrow.filter(
    (t: any) => !t.deliberatelyNarrow && typeof t.maxHolders !== "number",
  );
  if (accidental.length === 0) {
    const described = narrow.map((t: any) =>
      typeof t.maxHolders === "number" ? `${t.name} capped at ${t.maxHolders}` : `${t.name} (marked deliberate)`,
    );
    return [true, described.join(", ")];
  }

  return [
    false,
    `${accidental.length} tier(s) at ≤1% with no cap and no deliberate flag ` +
      `(${accidental.map((t: any) => t.name).join(", ")}): at 200 players that is ~2 people`,
  ];
});

check("blocker", "the apex board has a sampled board for every scenario it grades", () => {
  // The apex board is player-facing, and an empty one is worse than an absent one: it
  // reads as "you have no standing" rather than as "this is not sampled yet". The
  // graded scenarios are the top-window variant of each family - see standing.ts - so
  // this checks the set the board actually reads rather than the whole pool.
  const apexPath = file("data", "leaderboard_apex.json");
  if (!existsSync(apexPath)) return [false, "leaderboard_apex.json missing: run npm run sample:apex"];

  const boards = new Set<string>(
    (JSON.parse(readFileSync(apexPath, "utf8")).boards ?? []).map(
      (b: { scenario: string }) => b.scenario,
    ),
  );

  const season = JSON.parse(readFileSync(file("data", "seasons", "season-1.json"), "utf8"));
  const top = new Map<string, { scenario: string; window: number }>();
  for (const sc of season.scenarios ?? []) {
    const family = sc.family ?? sc.scenario;
    const window = sc.window ?? 0;
    const prior = top.get(family);
    if (!prior || window > prior.window) top.set(family, { scenario: sc.scenario, window });
  }

  const missing = [...top.values()].filter((v) => !boards.has(v.scenario));
  return [
    missing.length === 0,
    missing.length
      ? `${missing.length} unsampled: ${missing.map((m) => m.scenario).join(", ")}`
      : `${top.size} graded scenarios, all sampled`,
  ];
});

check("blocker", "score models exist for local verification", () => {
  if (!existsSync(file("data", "score_models.json"))) return [false, "not generated"];
  const models = readJson("data", "score_models.json").models ?? {};
  const count = Object.keys(models).length;
  return [count > 50, `${count} scenarios modelled`];
});

check("advisory", "sub-category mapping has been reviewed", () => {
  const subcats = readJson("data", "subcategories.json");
  return [
    subcats.provisional !== true,
    subcats.provisional === true
      ? "still marked provisional: derived from descriptions, not confirmed against Voltaic"
      : "marked reviewed",
  ];
});

// ---------------------------------------------------------------------------
// backend
// ---------------------------------------------------------------------------

check("blocker", "database migrations exist", () => {
  const dir = file("supabase", "migrations");
  if (!existsSync(dir)) return [false, "supabase/migrations is missing"];
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  return [files.length > 0, `${files.length} migration(s)`];
});

check("blocker", "row level security is enabled on every player table", () => {
  const dir = file("supabase", "migrations");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

  // `if not exists` sits between the keyword and the name, so it must be skipped or
  // the table is recorded as being called "if" and reported as unsecured.
  const created = [...sql.matchAll(/create table\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)].map(
    (m) => m[1],
  );
  const secured = new Set(
    [...sql.matchAll(/alter table\s+(?:if\s+exists\s+)?(\w+)\s+enable row level security/gi)].map(
      (m) => m[1],
    ),
  );
  const missing = created.filter((t) => !secured.has(t));
  return [missing.length === 0, missing.length ? `unsecured: ${missing.join(", ")}` : `${created.length} tables, all secured`];
});

check("blocker", "clients cannot write ratings or match results", () => {
  const dir = file("supabase", "migrations");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

  // Any insert/update/all policy on these tables would let a client write its own
  // rating, which is the one thing the whole security model forbids.
  const protectedTables = [
    "ratings",
    "matches",
    "match_sides",
    "baselines",
    "verified_pbs",
    // A client write here posts its own place on a public leaderboard, which is the
    // same class of thing as writing its own rating.
    "apex_standing",
  ];
  const offending: string[] = [];
  for (const table of protectedTables) {
    const policies = [...sql.matchAll(new RegExp(`create policy \\w+ on ${table}\\s+for (\\w+)`, "g"))];
    for (const p of policies) {
      if (p[1] !== "select") offending.push(`${table}:${p[1]}`);
    }
  }
  return [offending.length === 0, offending.length ? offending.join(", ") : "read-only to clients"];
});

check("blocker", "steam auth function exists", () => {
  const p = file("supabase", "functions", "steam-auth", "index.ts");
  if (!existsSync(p)) return [false, "not found"];
  const src = readFileSync(p, "utf8");
  // Skipping the check_authentication step would let anyone forge any SteamID.
  return [
    src.includes("check_authentication"),
    src.includes("check_authentication")
      ? "verifies assertions with Steam"
      : "DOES NOT verify assertions with Steam",
  ];
});

check("blocker", "environment is configured", () => {
  if (!existsSync(file(".env"))) return [false, ".env not created: copy .env.example"];
  const env = readFileSync(file(".env"), "utf8");
  const required = ["APOGEE_SUPABASE_URL", "APOGEE_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((k) => !new RegExp(`^${k}=.+`, "m").test(env));
  return [missing.length === 0, missing.length ? `unset: ${missing.join(", ")}` : "all keys set"];
});

check("advisory", "secrets are not committed", () => {
  const ignore = existsSync(file(".gitignore")) ? readFileSync(file(".gitignore"), "utf8") : "";
  return [/^\.env$/m.test(ignore), ignore.includes(".env") ? ".env is ignored" : ".env is NOT gitignored"];
});

// A public repository with no LICENSE is all rights reserved, which is the opposite of
// what publishing one is for: readable, but nobody may fork it, package it or run their
// own. This was on the manual list until the choice was made; it is checkable, so it is
// checked. The README has to name the same licence the file grants, because that section
// is what anyone actually reads before the 661 lines.
check("advisory", "a licence is chosen and stated", () => {
  if (!existsSync(file("LICENSE"))) return [false, "no LICENSE: all rights reserved"];
  const text = readFileSync(file("LICENSE"), "utf8");
  if (!text.includes("GNU AFFERO GENERAL PUBLIC LICENSE")) {
    return [false, "LICENSE is not the AGPL text package.json declares"];
  }
  const readme = readFileSync(file("README.md"), "utf8");
  if (!readme.includes("AGPL")) return [false, "LICENSE grants the AGPL, README does not say so"];
  return [true, "AGPL-3.0-or-later, stated in the README"];
});

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

check("blocker", "desktop client builds", () => {
  const built = existsSync(file("dist", "app", "main.cjs"));
  return [built, built ? "dist/app/main.cjs present" : "run npm run build:app"];
});

check("blocker", "renderer is locked down", () => {
  const html = readFileSync(file("src", "app", "renderer", "index.html"), "utf8");
  const main = readFileSync(file("src", "app", "main.ts"), "utf8");
  const problems: string[] = [];
  if (!html.includes("Content-Security-Policy")) problems.push("no CSP");
  if (!main.includes("contextIsolation: true")) problems.push("context isolation off");
  if (main.includes("nodeIntegration: true")) problems.push("node integration on");
  return [problems.length === 0, problems.length ? problems.join(", ") : "CSP set, context isolated, no node"];
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const blockers = results.filter((r) => r.severity === "blocker");
const advisories = results.filter((r) => r.severity === "advisory");

function print(list: Result[], heading: string): void {
  console.log(`\n${heading}`);
  for (const r of list) {
    console.log(`  ${r.ok ? "ok  " : "NO  "} ${r.label.padEnd(52)} ${r.detail}`);
  }
}

print(blockers, "── blockers ─────────────────────────────────────");
print(advisories, "── advisories ───────────────────────────────────");

// Written work, which can be checked for existence even though its quality cannot.
//
// These sat on the manual list and stayed ticked-off-by-nobody for months after they
// were actually done, which is how a preflight list stops being read: a checklist that
// never shrinks is one people learn to scroll past. Presence and a plausible length is
// a weak check, and a weak check that shrinks the list beats a strong one nobody runs.
const written: { label: string; path: string[]; needs: string[] }[] = [
  {
    label: "public statement on what anti-cheat does and does not catch",
    path: ["FAIR-PLAY.md"],
    needs: ["cannot catch", "Suspect", "Rejected"],
  },
  {
    label: "how a player disputes a voided match, and who answers",
    path: ["FAIR-PLAY.md"],
    needs: ["Disputing a voided match"],
  },
  {
    label: "what is collected, who can see it, and how it is deleted",
    path: ["PRIVACY.md"],
    needs: ["What leaves your machine", "Deleting your data"],
  },
  {
    label: "benchmark authors credited where players will see it",
    path: ["README.md"],
    needs: ["## Credits", "benchmark authors"],
  },
];

console.log("\n── written and committed ────────────────────────");
const missingWritten: string[] = [];
for (const item of written) {
  let ok = false;
  let detail = `${item.path.join("/")} not found`;
  try {
    const text = readFileSync(file(...item.path), "utf8");
    const absent = item.needs.filter((n) => !text.includes(n));
    ok = absent.length === 0;
    detail = ok ? item.path.join("/") : `${item.path.join("/")} is missing: ${absent.join(", ")}`;
  } catch {
    /* detail already says so */
  }
  if (!ok) missingWritten.push(item.label);
  console.log(`  ${ok ? "ok  " : "NO  "} ${item.label.padEnd(52)} ${detail}`);
}

console.log("\n── manual, cannot be automated ──────────────────");
for (const item of [
  "Play ten real matches end to end and confirm none settle wrongly",
  "Confirm a rejected run really does void a match, on a live account",
  "Confirm the Suspect tier fires without voiding, on a live account",
  "Decide what happens to ratings when the beta ends: reset, or carry over",
  "Talk to KovaaK's about the API usage before, not after, traffic appears",
  "Confirm the benchmark authors are comfortable with their work being used",
]) {
  console.log(`  [ ] ${item}`);
}

const failedBlockers = blockers.filter((r) => !r.ok);
const failedAdvisories = advisories.filter((r) => !r.ok);

console.log(
  `\n${blockers.length - failedBlockers.length}/${blockers.length} blockers clear, ` +
    `${advisories.length - failedAdvisories.length}/${advisories.length} advisories clear, ` +
    `${written.length - missingWritten.length}/${written.length} documents written`,
);

if (failedBlockers.length > 0) {
  console.log("\nNOT READY for a closed beta. Outstanding blockers:");
  for (const r of failedBlockers) console.log(`  - ${r.label}: ${r.detail}`);
  process.exit(1);
}

// A document is a blocker for *publishing*, not for building, so it fails the run
// without the "NOT READY" framing above. Reported rather than merely counted: an
// assertion whose result nothing reads is the one that hides a real gap.
if (missingWritten.length > 0) {
  console.log("\nBlockers are clear, but the repository is not ready to be public:");
  for (const label of missingWritten) console.log(`  - ${label}`);
  process.exit(1);
}

console.log("\nAll automated blockers clear. The manual list above still stands.");
