/**
 * Bundle the Electron app into dist/.
 *
 * Electron cannot execute TypeScript, and the main process imports the whole core
 * (parser, energy engine, matchmaking, quests). esbuild bundles it into one CommonJS
 * file so there is no loader hook in production and no `.ts` extension resolution at
 * runtime.
 *
 * `electron` itself is marked external: it is provided by the runtime, not bundled.
 *
 *   node tools/buildApp.mjs
 */

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist", "app");

/**
 * Bake the client's Supabase settings in at build time.
 *
 * Only values that are safe to ship: the project URL, the anon key (designed to be
 * public, with row-level security doing the actual protecting) and the auth function
 * URL. The service role key is never read here, and would be a serious mistake to
 * include, so it is not even looked up.
 */
function clientEnv() {
  const out = {
    APOGEE_SUPABASE_URL: "",
    APOGEE_SUPABASE_ANON_KEY: "",
    APOGEE_STEAM_AUTH_URL: "",
  };

  const envPath = join(root, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && m[1] in out) out[m[1]] = m[2].trim();
    }
  }

  const missing = Object.entries(out).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    console.warn(
      `warning: building without ${missing.join(", ")}; sign-in will be disabled in this build`,
    );
  }

  return {
    __APOGEE_SUPABASE_URL__: JSON.stringify(out.APOGEE_SUPABASE_URL),
    __APOGEE_SUPABASE_ANON_KEY__: JSON.stringify(out.APOGEE_SUPABASE_ANON_KEY),
    __APOGEE_STEAM_AUTH_URL__: JSON.stringify(out.APOGEE_STEAM_AUTH_URL),
  };
}

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "src", "app", "main.ts")],
  outfile: join(outDir, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // Provided by the Electron runtime; bundling it would shadow the real module.
  external: ["electron"],
  define: clientEnv(),
  sourcemap: true,
  logLevel: "info",
  // JSON data files are read at runtime via URLs relative to the source, so they must
  // resolve against the bundle location instead. Rewritten below by `define`.
  loader: { ".json": "json" },
});

// The renderer is plain HTML/CSS/JS and ships as-is.
cpSync(join(root, "src", "app", "renderer"), join(outDir, "renderer"), { recursive: true });
cpSync(join(root, "src", "app", "preload.cjs"), join(outDir, "preload.cjs"));

// Reference data the main process reads at runtime.
cpSync(join(root, "data"), join(root, "dist", "data"), { recursive: true });

console.log("built dist/app");
