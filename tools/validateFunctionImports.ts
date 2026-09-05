/**
 * Check that every symbol the Edge Functions import from the core actually exists.
 *
 *   npx tsx tools/validateFunctionImports.ts
 *
 * WHY THIS EXISTS
 *
 * `tsconfig.json` includes `src/**` and nothing else, so `npm run typecheck` never looks at
 * `supabase/functions/**`. It cannot: those files are Deno, and they import `jsr:` and
 * `https:` specifiers that Node's resolver has no idea about. Excluding them is the right
 * call and it leaves a hole - the functions are the least-compiled code in the repo and the
 * only code that cannot be run locally, and they are also the code that moves ratings.
 *
 * The hole has a shape. Edge Functions import real logic from `../../../src/core/...` -
 * `baselineFromScores`, `apexTopFraction`, `topOfEachFamily` - so a rename or a deleted
 * export in the core breaks a function that nothing compiles and nothing tests, and the
 * break surfaces as a 500 in production. That is exactly the class of failure this checks:
 * every named import from the core has to resolve to something the core exports.
 *
 * It does not typecheck the functions. It cannot - it is a name check, not a type check -
 * and pretending otherwise would be worse than the gap it fills. What it buys is that the
 * one boundary the two halves share cannot silently drift.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FUNCTIONS = join(root, "supabase", "functions");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Every .ts file under a directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Names a module exports.
 *
 * Read with a regex rather than the compiler API, because the question is "does this name
 * appear after the word export" and that is all. `export * from` is followed, because the
 * core re-exports in a couple of places and a missed re-export would read as a false alarm.
 */
function exportsOf(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return new Set();
  seen.add(file);

  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return new Set();
  }

  const names = new Set<string>();

  for (const m of src.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }

  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const alias = part.split(/\s+as\s+/).pop()?.trim();
      if (alias) names.add(alias.replace(/^type\s+/, ""));
    }
  }

  for (const m of src.matchAll(/^export\s+\*\s+from\s+["']([^"']+)["']/gm)) {
    for (const n of exportsOf(resolve(dirname(file), m[1]), seen)) names.add(n);
  }

  return names;
}

const files = walk(FUNCTIONS);

console.log(
  `\n${BOLD}edge function imports${RESET}  ${files.length} file(s), which ` +
    `${DIM}npm run typecheck does not cover${RESET}`,
);

const missingFile: string[] = [];
const missingSymbol: string[] = [];
let checkedImports = 0;
let checkedSymbols = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const rel = file.slice(root.length + 1).replace(/\\/g, "/");

  // Only the imports that cross into the core. Deno and jsr specifiers are not ours.
  for (const m of src.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.\.[^"']*\/src\/[^"']+)["']/g,
  )) {
    checkedImports++;
    const target = resolve(dirname(file), m[2]);

    let exported: Set<string>;
    try {
      statSync(target);
      exported = exportsOf(target);
    } catch {
      missingFile.push(`${rel} imports ${m[2]}, which is not there`);
      continue;
    }

    for (const raw of m[1].split(",")) {
      const name = raw
        .replace(/^\s*type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim();
      if (!name) continue;
      checkedSymbols++;
      if (!exported.has(name)) {
        missingSymbol.push(`${rel} imports { ${name} } from ${m[2]}, which does not export it`);
      }
    }
  }
}

check(
  "every core module an edge function imports exists",
  missingFile.length === 0,
  missingFile.join("; "),
);
check(
  "every symbol an edge function imports from the core is exported",
  missingSymbol.length === 0,
  missingSymbol.length ? `\n       ${missingSymbol.join("\n       ")}` : `${checkedSymbols} symbol(s)`,
);

// ---- a function that exists but is not wired up ---------------------------------
//
// Three files have to name a new Edge Function and none of them fails loudly when one
// does not. Missing from the deploy chain, it is simply never deployed and the client
// gets a 404 nobody wrote. Missing from LIMITS, `enforceRateLimit` returns on an unknown
// key and it runs unlimited - stated outright in that file, and the reason it is stated
// is that it had already happened. Missing from verifyDeployment, nothing ever checks it
// refuses an anonymous caller.
//
// So the directory listing is the source of truth and the three lists are checked against
// it. `_shared` is not a function; `steam-auth` is deliberately reachable without a
// session, which is what signing in means, so it is exempt from the last list only.
const deployChain = readFileSync(join(root, "package.json"), "utf8");
const limitsFile = readFileSync(join(root, "supabase/functions/_shared/rateLimit.ts"), "utf8");
const deployCheck = readFileSync(join(root, "tools/verifyDeployment.ts"), "utf8");

const functionDirs = readdirSync(FUNCTIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "_shared")
  .map((e) => e.name)
  .sort();

const unshipped = functionDirs.filter(
  (name) => !deployChain.includes(`functions deploy ${name}`),
);
// steam-auth is exempt from both. It is the function you reach before you have a session,
// which is what signing in means, so it cannot refuse an anonymous caller and it cannot be
// rate limited by a player id that does not exist yet. Worth knowing rather than worth
// hiding: it is the one door with no per-caller ceiling on it.
const UNAUTHENTICATED = ["steam-auth"];

const unlimited = functionDirs.filter(
  (name) => !UNAUTHENTICATED.includes(name) && !limitsFile.includes(`"${name}":`),
);
const unchecked = functionDirs.filter(
  (name) => !UNAUTHENTICATED.includes(name) && !deployCheck.includes(`"${name}"`),
);

check("every edge function is in the deploy chain", unshipped.length === 0, unshipped.join(", "));
check("every edge function has a rate limit", unlimited.length === 0, unlimited.join(", "));
check(
  "every edge function is checked against the live project",
  unchecked.length === 0,
  unchecked.join(", "),
);
check(
  "the directory scan found functions to check",
  functionDirs.length > 0,
  `${functionDirs.length}: ${functionDirs.join(", ")}`,
);

// A check that cannot fail is worse than no check. If the import scan ever stops finding
// anything - a refactor to default imports, a moved directory - it would pass in silence.
check(
  "the scan actually found imports to check",
  checkedImports > 0 && checkedSymbols > 0,
  `${checkedImports} import(s) across the core boundary`,
);

console.log(
  failures === 0
    ? `\nOK: edge function imports resolve\n`
    : `\nFAILED: ${failures} check(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
