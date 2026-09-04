/**
 * Where an admin's look-and-copy overrides live on this machine.
 *
 * userData, not the repository and not `dist/data`. `build:app` rewrites `dist/data` from
 * `data/` on every build, so anything written there dies at the next build - and the
 * repository is public, so a machine's local theme has no business in it. What this does
 * mean is that overrides are per-machine and per-install: there is an export for moving a
 * set somewhere else, and that is deliberate rather than a gap.
 *
 * Same atomic write as the settings and quest stores - temp file, then rename - because
 * this is saved from a live editor while somebody is typing, so a crash mid-write is a
 * question of when rather than whether. A corrupt file costs the overrides and never the
 * app: `clean` treats anything unreadable as "no overrides" and the client falls back to
 * what the stylesheet and markup already say.
 */

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clean, emptyOverrides, type Overrides, type Rejection } from "../core/admin/overrides.ts";

export function overridesPath(): string {
  return join(app.getPath("userData"), "admin-overrides.json");
}

export interface LoadResult {
  overrides: Overrides;
  /** Values the file held that were not allowed. Surfaced, never silently dropped. */
  rejected: Rejection[];
  /** Set when the file exists but could not be read or parsed at all. */
  error: string | null;
}

export function loadOverrides(): LoadResult {
  const path = overridesPath();
  if (!existsSync(path)) {
    return { overrides: emptyOverrides(), rejected: [], error: null };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const { overrides, rejected } = clean(parsed);
    return { overrides, rejected, error: null };
  } catch (err) {
    return {
      overrides: emptyOverrides(),
      rejected: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Write what survived validation, and say what did not.
 *
 * Cleaned again on the way out rather than trusting the caller. The renderer is the only
 * caller today and it validates as it types, but the rule this codebase holds to is that
 * the side which decides is the side that checks - and here that is main.
 */
export function saveOverrides(input: unknown): LoadResult {
  const { overrides, rejected } = clean(input);
  overrides.updatedAt = new Date().toISOString();

  const path = overridesPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + ".tmp";
  writeFileSync(temp, JSON.stringify(overrides, null, 2) + "\n", "utf8");
  renameSync(temp, path);

  return { overrides, rejected, error: null };
}

/** Back to the stylesheet and the markup, with nothing left behind to explain later. */
export function clearOverrides(): LoadResult {
  const path = overridesPath();
  const empty = emptyOverrides();
  empty.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + ".tmp";
  writeFileSync(temp, JSON.stringify(empty, null, 2) + "\n", "utf8");
  renameSync(temp, path);
  return { overrides: empty, rejected: [], error: null };
}
