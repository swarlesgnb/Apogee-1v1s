/**
 * Persist quest progress and XP between launches.
 *
 * Stored as plain JSON in the app's user-data directory. Deliberately not encrypted:
 * nothing here is a secret, and XP is cosmetic by design. It never touches Apogee
 * rating, so a player editing this file cheats only themselves out of the number going
 * up honestly.
 *
 * Writes are atomic (temp file then rename) because this is written on every run that
 * lands, and a half-written file would lose a player's lifetime XP for a crash that had
 * nothing to do with them.
 */

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  dayKey,
  emptyState,
  type QuestProgressState,
} from "../core/quests/progression.ts";

function storePath(): string {
  return join(app.getPath("userData"), "quests.json");
}

export function loadQuestState(now: Date): QuestProgressState {
  const path = storePath();
  if (!existsSync(path)) return emptyState(dayKey(now));

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as QuestProgressState;

    // Guard against a hand-edited or truncated file rather than trusting its shape.
    if (
      typeof parsed?.day !== "string" ||
      typeof parsed?.totalXp !== "number" ||
      !Number.isFinite(parsed.totalXp) ||
      typeof parsed?.completed !== "object" ||
      parsed.completed === null
    ) {
      return emptyState(dayKey(now));
    }

    return {
      day: parsed.day,
      completed: parsed.completed,
      totalXp: Math.max(0, parsed.totalXp),
    };
  } catch {
    // A corrupt file costs the day's completions, not the app.
    return emptyState(dayKey(now));
  }
}

export function saveQuestState(state: QuestProgressState): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}
