/**
 * Persist the quest board and XP between launches.
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

import { emptyQuestState, type QuestState } from "../core/quests/board.ts";

function storePath(): string {
  return join(app.getPath("userData"), "quests.json");
}

export function loadQuestState(): QuestState {
  const path = storePath();
  if (!existsSync(path)) return emptyQuestState();

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<QuestState> & { totalXp?: unknown };
    const totalXp =
      typeof parsed?.totalXp === "number" && Number.isFinite(parsed.totalXp) ? Math.max(0, parsed.totalXp) : 0;

    // The first format held only `{ day, completed, totalXp }`. Its board cannot be
    // carried over - it never stored one - but the XP it paid is the player's.
    if (parsed?.version !== 2) return emptyQuestState(totalXp);

    // Guard against a hand-edited or truncated file rather than trusting its shape.
    if (
      typeof parsed.day !== "string" ||
      typeof parsed.week !== "string" ||
      !Array.isArray(parsed.daily) ||
      !Array.isArray(parsed.reserve) ||
      !Array.isArray(parsed.matches)
    ) {
      return emptyQuestState(totalXp);
    }

    return { ...emptyQuestState(totalXp), ...parsed, totalXp } as QuestState;
  } catch {
    // A corrupt file costs the day's board, not the app.
    return emptyQuestState();
  }
}

export function saveQuestState(state: QuestState): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}
