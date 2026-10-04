/**
 * The social features' few remembered things: whether Discord may be told what is being
 * played, which band the Daily is played in, and which dailies were already posted to a
 * board.
 *
 * A file of its own (social.json in userData) rather than more keys in settings.json, so
 * this feature and the window/folder settings cannot collide. Nothing here is a secret or
 * decides anything anybody else sees: the board entry itself is the server's. Same atomic
 * temp-then-rename write as settings.ts.
 */

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SocialState {
  /** Discord Rich Presence. Off unless the player turns it on. */
  discord: boolean;
  /** The band the Daily is played in; null follows the queue's band. */
  dailyBand: number | null;
  /** "<daily>:<band>" keys already on the server's board, so a result is posted once. */
  posted: string[];
}

const DEFAULTS: SocialState = { discord: false, dailyBand: null, posted: [] };
/** Keys kept: a month of dailies across every band is far below this. */
const POSTED_MAX = 200;

function storePath(): string {
  return join(app.getPath("userData"), "social.json");
}

export function loadSocialState(): SocialState {
  const path = storePath();
  if (!existsSync(path)) return { ...DEFAULTS, posted: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as Partial<SocialState>;
    return {
      // Only an explicit true turns it on: a damaged file must never opt somebody in.
      discord: raw.discord === true,
      dailyBand: typeof raw.dailyBand === "number" && Number.isInteger(raw.dailyBand) && raw.dailyBand >= 0 && raw.dailyBand < 16 ? raw.dailyBand : null,
      posted: Array.isArray(raw.posted) ? raw.posted.filter((k): k is string => typeof k === "string" && /^\d{1,5}:\d{1,2}$/.test(k)).slice(-POSTED_MAX) : [],
    };
  } catch {
    return { ...DEFAULTS, posted: [] };
  }
}

export function saveSocialState(patch: Partial<SocialState>): SocialState {
  const merged = { ...loadSocialState(), ...patch };
  merged.posted = merged.posted.slice(-POSTED_MAX);
  try {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch {
    /* A preference that will not save is not a reason to interrupt anyone. */
  }
  return merged;
}
