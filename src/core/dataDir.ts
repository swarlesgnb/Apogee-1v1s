/**
 * Locate the committed reference data (benchmarks, ranks, sub-categories).
 *
 * The same core code runs in two very different layouts:
 *
 *   DEV       `tsx src/...` from the repo root, with data/ alongside src/.
 *   BUNDLED   Electron running dist/app/main.cjs, with data copied to dist/data.
 *
 * Resolving via `import.meta.url` works in the first and breaks in the second: the
 * bundle collapses many source directories into one file, so relative depth no longer
 * means anything. So the location is resolved explicitly instead: the host sets it if
 * it knows, and otherwise it is found by walking up from the working directory.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let override: string | null = null;

/** Point the core at a specific data directory. Called by the Electron main process. */
export function setDataDir(dir: string): void {
  override = dir;
}

/** How far up to search before giving up. */
const MAX_DEPTH = 6;

function looksLikeDataDir(candidate: string): boolean {
  // `benchmarks/` is the one subdirectory that only ever exists in ours, so it
  // distinguishes the real directory from some unrelated `data/` further up the tree.
  return existsSync(join(candidate, "benchmarks")) || existsSync(join(candidate, "apogee_ranks.json"));
}

export function dataDir(): string {
  if (override) return override;

  let current = resolve(process.cwd());
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const candidate = join(current, "data");
    if (looksLikeDataDir(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fall back to the conventional location so the error names a real path rather
  // than failing somewhere less obvious.
  return join(resolve(process.cwd()), "data");
}

/** Absolute path to a file inside the data directory. */
export function dataFile(...segments: string[]): string {
  return join(dataDir(), ...segments);
}

/**
 * The *source* data directory, ignoring any override, or null when there is none.
 *
 * The Electron app points the core at `dist/data`, which is a copy: `build:app` writes
 * it fresh from `data/` on every build. Anything the app writes back therefore lives
 * exactly until the next build and then silently disappears - which is fine for a cache
 * and ruinous for the season definition, where the thing being overwritten is somebody's
 * afternoon of naming ranks.
 *
 * So an editor writes both: the runtime copy, so the change is visible now, and the
 * source, so it is still there tomorrow. In a packaged app there is no source tree and
 * this returns null, which is the correct answer rather than a failure.
 */
export function sourceDataDir(): string | null {
  let current = resolve(process.cwd());

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const candidate = join(current, "data");
    // `src/` alongside it is what distinguishes a source tree from a build output:
    // dist/data looks otherwise identical.
    if (looksLikeDataDir(candidate) && existsSync(join(current, "src"))) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}
