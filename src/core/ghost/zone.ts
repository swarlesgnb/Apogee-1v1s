/**
 * Local time on a machine that is not the player's.
 *
 * A ghost's session is one of the player's local calendar days. On the player's machine
 * that is free: `new Date(y, m, d, ...)` and the local getters are already in their zone.
 * The server runs in UTC, and the first server draft shifted every stored run by the one
 * offset the client sent with the post. That is right for runs from the same side of a
 * daylight-saving change and an hour wrong for everything across one, which moves any
 * run within an hour of midnight onto the neighbouring day: a ghost from the wrong
 * evening, twice a year, for most of the players this app is aimed at.
 *
 * So the client sends its IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
 * and every instant is shifted by *its own* offset in that zone. Pure: Intl is in Deno
 * and Node alike, and validate:ghost exercises it across both 2026 US changes.
 */

import { FILENAME_STAMP } from "../stats/duration.ts";

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, f);
  }
  return f;
}

/** A zone Intl knows. Anything else is refused rather than guessed at. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset in force at `instant` in `zone`, in `getTimezoneOffset`'s convention:
 * minutes to add to local time to reach UTC, so Chicago in summer is +300.
 */
export function offsetMinutesAt(instant: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(instant))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((Math.floor(instant / 1000) * 1000 - wall) / 60_000);
}

/**
 * `instant` moved so that the *UTC* getters read the player's wall clock. What the core's
 * local-getter code needs when it runs in a UTC runtime.
 */
export function toLocalFrame(instant: number, zone: string): Date {
  return new Date(instant - offsetMinutesAt(instant, zone) * 60_000);
}

/** The inverse: a local-frame date (UTC getters read the wall clock) back to an instant. */
export function fromLocalFrame(local: number, zone: string): Date {
  // Two passes: the offset at the guess, then at the answer. Exact everywhere except
  // the repeated hour when clocks go back, where either reading is a real instant and
  // the first occurrence is returned (validate:ghost pins this); see wallClockToInstant.
  const first = local + offsetMinutesAt(local, zone) * 60_000;
  return new Date(local + offsetMinutesAt(first, zone) * 60_000);
}

/**
 * The instant a KovaaK's filename's bare wall clock names, in `zone`.
 *
 * Ambiguous once a year: in the hour that repeats when clocks go back, the digits name two
 * instants an hour apart and the file does not say which. This takes the first, as
 * `fromLocalFrame` does. Both are on the same local day, which is all a session needs;
 * a duration is never computed from this (runDurationSeconds reads the unshifted parse).
 */
export function wallClockToInstant(filename: string, zone: string): Date | null {
  const m = FILENAME_STAMP.exec(filename);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (Number.isNaN(wall)) return null;
  return fromLocalFrame(wall, zone);
}
