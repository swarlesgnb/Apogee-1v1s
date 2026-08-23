/**
 * Answer "why is it not working" in one command.
 *
 *   npm run doctor
 *
 * Every line here exists because the answer to a real half-hour of confusion was
 * further up the stack than where the looking started: a stale bundle, a stats folder
 * that moved, a .env that was never filled in, a season that no longer parses. None of
 * them announce themselves; all of them are visible in under a second if something
 * looks.
 *
 * Read-only, offline apart from one optional reachability probe, and safe to run at any
 * time. Values of secrets are never printed - only whether they are set.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { candidateStatsFolders, findStatsFolder } from "../src/app/watcher.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

type Level = "ok" | "warn" | "bad";

let worst: Level = "ok";
const RANK: Record<Level, number> = { ok: 0, warn: 1, bad: 2 };

function say(level: Level, label: string, detail: string, fix?: string): void {
  if (RANK[level] > RANK[worst]) worst = level;
  const mark = level === "ok" ? "  ok  " : level === "warn" ? " warn " : " BAD  ";
  console.log(`${mark}${label.padEnd(16)}${detail}`);
  if (fix) console.log(`${" ".repeat(22)}-> ${fix}`);
}

function ageOf(path: string): number {
  return Date.now() - statSync(path).mtimeMs;
}

function human(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 90) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Newest mtime under a directory, ignoring the noise directories and `skip`. */
function newestUnder(dir: string, skip?: string): { path: string; mtime: number } | null {
  let newest: { path: string; mtime: number } | null = null;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (full === skip) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const mtime = statSync(full).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path: full, mtime };
    }
  };

  try {
    walk(dir);
  } catch {
    return null;
  }
  return newest;
}

console.log("");
console.log("apogee doctor");
console.log("");

// ---- toolchain ------------------------------------------------------------
say("ok", "node", process.version);

try {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const wanted = pkg.devDependencies?.electron ?? "?";
  const installed = JSON.parse(
    readFileSync(join(root, "node_modules", "electron", "package.json"), "utf8"),
  ) as { version: string };
  say("ok", "electron", `${installed.version} (package.json wants ${wanted})`);
} catch {
  say("bad", "electron", "not installed", "npm install");
}

// ---- client settings ------------------------------------------------------
const envPath = join(root, ".env");
if (!existsSync(envPath)) {
  say(
    "warn",
    ".env",
    "missing - the client builds, but sign-in and matches are disabled",
    "copy the keys from the Supabase dashboard into .env",
  );
} else {
  const env = new Map<string, string>();
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m && m[2]) env.set(m[1], m[2].trim());
  }

  const client = ["APOGEE_SUPABASE_URL", "APOGEE_SUPABASE_ANON_KEY", "APOGEE_STEAM_AUTH_URL"];
  const missing = client.filter((key) => !env.get(key));
  if (missing.length === 0) {
    say("ok", ".env", `client keys set (${client.length}/${client.length})`);
  } else {
    say(
      "warn",
      ".env",
      `missing ${missing.join(", ")}`,
      "the build warns about this too; sign-in stays disabled without them",
    );
  }

  say(
    env.get("SUPABASE_SERVICE_ROLE_KEY") ? "ok" : "warn",
    "service key",
    env.get("SUPABASE_SERVICE_ROLE_KEY")
      ? "set (needed by sync:reference and verify:deployment)"
      : "not set - the deploy tools will refuse to run",
  );
}

// ---- the bundle -----------------------------------------------------------
//
// The renderer is copied, not bundled, so it has to be compared against its own copy.
// Comparing all of src/ against main.cjs called a renderer edit a stale bundle, which
// is both wrong and unfixable by the command it then tells you to run.
const bundle = join(root, "dist", "app", "main.cjs");
const rendererCopy = join(root, "dist", "app", "renderer");

if (!existsSync(bundle)) {
  say("warn", "bundle", "dist/app/main.cjs does not exist", "npm run build:app");
} else {
  const built = statSync(bundle).mtimeMs;
  const bundled = newestUnder(join(root, "src"), join(root, "src", "app", "renderer"));
  const copied = newestUnder(join(root, "src", "app", "renderer"));
  const copiedAt = existsSync(rendererCopy) ? newestUnder(rendererCopy)?.mtime ?? 0 : 0;

  const staleBundle = bundled && bundled.mtime > built ? bundled : null;
  const staleRenderer = copied && copied.mtime > copiedAt ? copied : null;
  const stale = staleBundle ?? staleRenderer;

  if (stale) {
    say(
      "bad",
      "bundle",
      `stale: ${stale.path.replace(root, ".")} is newer than the build`,
      "npm run build:app, then relaunch - a running window keeps the old bundle",
    );
  } else {
    say("ok", "bundle", `built ${human(Date.now() - built)}, newer than every source file`);
  }
}

// ---- the stats folder -----------------------------------------------------
const stats = findStatsFolder();
if (!stats) {
  say("bad", "stats folder", "not found", "open Apogee and use Choose folder…, or check the list below");
  for (const candidate of candidateStatsFolders()) console.log(`${" ".repeat(22)}   ${candidate}`);
} else {
  const runs = readdirSync(stats).filter((f) => f.endsWith("Stats.csv"));
  const level: Level = runs.length === 0 ? "warn" : "ok";
  say(level, "stats folder", `${runs.length.toLocaleString()} runs - ${stats}`);
}

// ---- reference data -------------------------------------------------------
try {
  const registryPath = join(root, "data", "evxl_registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { count?: number };
  const age = ageOf(registryPath);
  say(
    age > 30 * 24 * 3_600_000 ? "warn" : "ok",
    "evxl registry",
    `${registry.count ?? "?"} benchmarks, refreshed ${human(age)}`,
    age > 30 * 24 * 3_600_000 ? "npm run fetch:evxl" : undefined,
  );
} catch {
  say("bad", "evxl registry", "data/evxl_registry.json missing or unreadable", "npm run fetch:evxl");
}

try {
  const seasonPath = join(root, "data", "seasons", "season-1.json");
  const season = JSON.parse(readFileSync(seasonPath, "utf8")) as {
    name?: string;
    published?: boolean;
    categories?: unknown[];
  };
  say(
    "ok",
    "season",
    `${season.name ?? "unnamed"} - ${season.categories?.length ?? 0} categories, ${
      season.published ? "published (frozen)" : "draft (editable)"
    }`,
  );
} catch (err) {
  say("bad", "season", `will not parse: ${err instanceof Error ? err.message : String(err)}`);
}

console.log("");
console.log(
  worst === "ok"
    ? "everything checks out"
    : worst === "warn"
      ? "usable, with the warnings above"
      : "something above needs fixing first",
);
console.log("");

process.exit(worst === "bad" ? 1 : 0);
