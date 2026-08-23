/**
 * Watch, rebuild, relaunch.
 *
 *   npm run dev
 *
 * The single most expensive thing about working on this client is that a source change
 * does nothing until the bundle is rebuilt *and* the window is closed and reopened:
 * Electron's single-instance lock means `npm start` with a window already open focuses
 * the old process, which is still running the old code. The failure looks like the fix
 * not working. This loop removes the step entirely — save a file, the window comes back
 * on the new bundle a second later, in the same place and size.
 *
 * esbuild's own watcher covers everything reachable from src/app/main.ts, which is the
 * whole core. The renderer and the preload script are copied rather than bundled, so
 * they are watched here.
 *
 * `data/` is deliberately not watched: the season editor writes it while the app is
 * running, and restarting the app underneath someone mid-edit would be a strange reward
 * for saving a season.
 */

import { context } from "esbuild";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";
import { bundleOptions, cleanDist, copyStatic } from "./buildApp.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Editors save in bursts; one save should cost one restart. */
const DEBOUNCE_MS = 250;

let child = null;
let restartTimer = null;
let pendingReasons = new Set();
let restarting = false;
let shuttingDown = false;
/** Rebuilds before the first launch are the startup build, not a change to react to. */
let started = false;

let firstBuildDone;
const firstBuild = new Promise((resolve) => {
  firstBuildDone = resolve;
});

function launch() {
  child = spawn(electron, ["."], { cwd: root, stdio: "inherit" });

  child.on("exit", (code) => {
    child = null;
    // The window was closed by hand rather than by a restart: that is how you stop the
    // dev loop, so stop it, instead of leaving a watcher running in a terminal that
    // looks finished.
    if (!shuttingDown && !restarting) {
      console.log("\nwindow closed — dev loop finished");
      process.exit(code ?? 0);
    }
  });
}

function restart(reason) {
  pendingReasons.add(reason);
  if (restartTimer) clearTimeout(restartTimer);

  restartTimer = setTimeout(() => {
    const why = [...pendingReasons].join(", ");
    pendingReasons = new Set();
    restartTimer = null;

    console.log(`\n↻ ${why} — relaunching`);

    if (!child) {
      launch();
      return;
    }

    // Wait for the old process to actually be gone before starting the next one, or the
    // new instance loses the single-instance lock to a process that is still exiting and
    // quits immediately, leaving the old window on screen and the old bundle running.
    restarting = true;
    child.once("exit", () => {
      restarting = false;
      launch();
    });
    child.kill();
  }, DEBOUNCE_MS);
}

/** Rebuild the copied assets, then restart. */
function staticChanged(file) {
  try {
    copyStatic();
  } catch (err) {
    console.error(`could not copy static assets: ${err.message}`);
    return;
  }
  restart(file);
}

cleanDist();

const options = bundleOptions();

// esbuild bakes `define` values once, when the context is created, so a real timestamp
// here would report the moment `npm run dev` started for the rest of the session — the
// exact wrong answer, since the whole point of the stamp is spotting a stale window.
// Under the dev loop the window is never stale, so it says so instead.
options.define.__APOGEE_BUILD__ = JSON.stringify("dev");

const ctx = await context({
  ...options,
  // esbuild's own "build finished" lines would drown the restart lines that matter.
  logLevel: "silent",
  plugins: [
    {
      name: "apogee-dev-restart",
      setup(build) {
        build.onEnd((result) => {
          // esbuild builds once when watching starts. That is this process doing its job,
          // not a change to react to, and restarting on it would relaunch the app the
          // moment it appeared.
          if (!started) {
            firstBuildDone(result);
            return;
          }

          if (result.errors.length > 0) {
            // Keep the window up: a typo mid-edit should not close what you were looking at.
            console.error(`\n✗ ${result.errors.length} build error(s) — window left on the last good build`);
            for (const error of result.errors) {
              const where = error.location ? `${error.location.file}:${error.location.line}` : "";
              console.error(`  ${error.text} ${where}`);
            }
            return;
          }

          restart("main rebuilt");
        });
      },
    },
  ],
});

for (const target of ["src/app/renderer", "src/app/preload.cjs"]) {
  watch(join(root, target), { recursive: true }, (_event, file) => {
    staticChanged(file ? String(file) : target);
  });
}

await ctx.watch();

const first = await firstBuild;
if (first.errors.length > 0) {
  console.error("the first build failed; fix it and run npm run dev again");
  process.exit(1);
}

copyStatic();

console.log("apogee dev: watching src/ — save to rebuild and relaunch, close the window to stop");
started = true;
launch();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    child?.kill();
    void ctx.dispose().then(() => process.exit(0));
  });
}
