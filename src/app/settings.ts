/**
 * Remember the handful of things a player should never have to tell Apogee twice.
 *
 * Two, currently: the stats folder they picked, and where they left the window. Both
 * are conveniences â€” nothing here is authoritative, and a missing or corrupt file costs
 * a re-pick and a default-sized window, never data. That is why it is deliberately
 * separate from quests.json, which holds earned XP and is worth being careful about.
 *
 * Same atomic write as the quest store (temp file then rename): this is written on every
 * window move, so a crash mid-write is a question of when, not if.
 */

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WindowBounds {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  maximized: boolean;
}

export interface Settings {
  /** The stats folder in use, remembered so auto-detection is a first-run job only. */
  statsDir: string | null;
  window: WindowBounds | null;
}

const DEFAULTS: Settings = { statsDir: null, window: null };

function storePath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function isBounds(value: unknown): value is WindowBounds {
  const b = value as WindowBounds | null;
  return (
    !!b &&
    typeof b === "object" &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height) &&
    b.width > 0 &&
    b.height > 0
  );
}

export function loadSettings(): Settings {
  const path = storePath();
  if (!existsSync(path)) return { ...DEFAULTS };

  try {
    // Strip a byte-order mark: this file is meant to be hand-editable, and a Windows
    // editor that adds one would otherwise silently reset every remembered setting.
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      statsDir: typeof parsed.statsDir === "string" && parsed.statsDir ? parsed.statsDir : null,
      window: isBounds(parsed.window)
        ? {
            x: Number.isFinite(parsed.window.x as number) ? (parsed.window.x as number) : null,
            y: Number.isFinite(parsed.window.y as number) ? (parsed.window.y as number) : null,
            width: Math.round(parsed.window.width),
            height: Math.round(parsed.window.height),
            maximized: parsed.window.maximized === true,
          }
        : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Merge a change into the stored settings. Never throws: this is a convenience. */
export function saveSettings(patch: Partial<Settings>): void {
  try {
    const merged = { ...loadSettings(), ...patch };
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch {
    /* A settings file that will not write is not a reason to interrupt anyone. */
  }
}

/** Where the settings file lives, for the status line and for `npm run doctor`. */
export function settingsPath(): string {
  return storePath();
}
