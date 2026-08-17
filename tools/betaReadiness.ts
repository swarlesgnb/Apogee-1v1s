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
  const bench = readJson("data", "benchmarks", "voltaic-s5.json");
  const scenarios = bench.difficulties.flatMap((d: any) =>
    d.categories.flatMap((c: any) => c.scenarios),
  );
  const empty = scenarios.filter((s: any) => !s.rankMaxes || s.rankMaxes.length === 0);
  return [empty.length === 0, `${scenarios.length - empty.length}/${scenarios.length} have thresholds`];
});

check("blocker", "rank ladder is well-formed", () => {
  const theme = readJson("data", "arena_ranks.json");
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

check("advisory", "rank tiers have real names", () => {
  const theme = readJson("data", "arena_ranks.json");
  const placeholder = theme.placeholderNames === true ||
    theme.tiers.some((t: any) => /^Tier [IVX]+$/.test(t.name));
  return [!placeholder, placeholder ? "still using placeholder names" : theme.tiers.map((t: any) => t.name).join(", ")];
});

check("advisory", "narrow tiers are deliberate, not accidental", () => {
  const theme = readJson("data", "arena_ranks.json");
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
  const protectedTables = ["ratings", "matches", "match_sides", "baselines", "verified_pbs"];
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
  const required = ["ARENA_SUPABASE_URL", "ARENA_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((k) => !new RegExp(`^${k}=.+`, "m").test(env));
  return [missing.length === 0, missing.length ? `unset: ${missing.join(", ")}` : "all keys set"];
});

check("advisory", "secrets are not committed", () => {
  const ignore = existsSync(file(".gitignore")) ? readFileSync(file(".gitignore"), "utf8") : "";
  return [/^\.env$/m.test(ignore), ignore.includes(".env") ? ".env is ignored" : ".env is NOT gitignored"];
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

console.log("\n── manual, cannot be automated ──────────────────");
for (const item of [
  "Play ten real matches end to end and confirm none settle wrongly",
  "Confirm a rejected run really does void a match, on a live account",
  "Confirm the Suspect tier fires without voiding, on a live account",
  "Decide what happens to ratings when the beta ends: reset, or carry over",
  "Write the one-paragraph public statement on what anti-cheat does and does not catch",
  "Talk to KovaaK's about the API usage before, not after, traffic appears",
  "Credit Voltaic prominently and confirm they are comfortable with benchmark use",
  "Decide how a player disputes a voided match, and who answers",
]) {
  console.log(`  [ ] ${item}`);
}

const failedBlockers = blockers.filter((r) => !r.ok);
const failedAdvisories = advisories.filter((r) => !r.ok);

console.log(
  `\n${blockers.length - failedBlockers.length}/${blockers.length} blockers clear, ` +
    `${advisories.length - failedAdvisories.length}/${advisories.length} advisories clear`,
);

if (failedBlockers.length > 0) {
  console.log("\nNOT READY for a closed beta. Outstanding blockers:");
  for (const r of failedBlockers) console.log(`  - ${r.label}: ${r.detail}`);
  process.exit(1);
}

console.log("\nAll automated blockers clear. The manual list above still stands.");
