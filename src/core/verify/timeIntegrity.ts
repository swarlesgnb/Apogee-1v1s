/**
 * What the server can hold a client to about *when* a run was played.
 *
 * KovaaK's writes a bare local wall clock into the stats filename and records no offset.
 * Turning those digits into an instant takes the player's UTC offset, which only the
 * player's machine knows, so the client sends it. That made the offset the one number a
 * player could choose freely and that moved a genuine run in time: a run played five
 * hours before a match could be stamped inside it (the security audit's SEC-01), and one
 * run could be stamped into two matches at two different instants (SEC-02).
 *
 * The offset cannot be authenticated locally. Only KovaaK's server timestamp does that,
 * and only for players with a linked account. What can be done is to stop the offset
 * being a free choice per run, per match or per day, which is what the rules below do.
 * Each one closes a separate path, and none of them changes how a run is graded:
 *
 *   ONE OFFSET PER MATCH   every run in a match uses the offset the match started with,
 *                          so the best runs from different times of day cannot be slotted
 *                          into one match. A daylight-saving change during the match is
 *                          the only exception, and only when a real zone explains it.
 *
 *   CONTINUITY             the offset declared for a new match has to agree with the
 *                          offsets on the player's own uploads from the last few hours,
 *                          again allowing a real daylight-saving change. Travel waits out
 *                          the window.
 *
 *   NOTHING FROM THE FUTURE  a run whose corrected end time is later than the server's
 *                          receipt plus clock slack is refused. A run uploaded as it is
 *                          played therefore cannot be stamped later than it was played.
 *
 *   ON TIME                a ranked run that reaches the server long after its match ran
 *                          out of time is refused: it was played after the deadline, or
 *                          is being held back to be stamped into one.
 *
 * The first-seen rule (a performance keeps the play time it was first uploaded with) and
 * the KovaaK's contradiction rule live in the database trigger and in verifyRun; see
 * supabase/migrations/20261003000026_time_integrity_and_hardening.sql.
 *
 * Pure: Intl is in Deno and Node alike, so the Edge Functions and the validators run this
 * unchanged.
 */

import { FILENAME_STAMP } from "../stats/duration.ts";
import { offsetMinutesAt } from "../ghost/zone.ts";

/** The widest offset any zone has used: UTC-12 to UTC+14, with room either side. */
export const MAX_OFFSET_MINUTES = 840;

/**
 * Slack for a corrected end time later than the server's own clock.
 *
 * Fifteen minutes. The number answers "how far ahead of the server can an honest PC
 * clock be", and refusing an honest run is worse than any gain this slack hands an
 * attacker:
 *
 *   - A PC synchronised by Windows (the default) is within seconds. One that has not
 *     synchronised for months drifts by minutes; quartz clocks run around 20 ppm, about
 *     ten minutes a year.
 *   - What the slack buys a cheat is a run stamped up to fifteen minutes after it was
 *     played, and only if it was not uploaded first. The match window already accepts a
 *     clock three minutes slow, and a run fifteen minutes old is barely "pre-played".
 */
export const FUTURE_SKEW_MS = 15 * 60_000;

/**
 * How long an offset on the player's own uploads keeps a different one from being
 * declared for a new match.
 *
 * Six hours. Long enough that switching offsets mid-evening needs hours of silence from
 * the honest client, which uploads every run as it lands. Short enough that the cost to
 * an honest traveller is a short wait after a short flight: a long-haul flight is longer
 * than this on its own, and a daylight-saving change never waits at all, because a real
 * zone explains it.
 */
export const CLOCK_CONTINUITY_MS = 6 * 60 * 60_000;

/**
 * How late after a match's deadline a ranked run may still reach the server.
 *
 * The honest client submits a run the moment its file lands, so its receipt is seconds
 * after the run ended, and the run must have ended inside the window. The fifteen
 * minutes cover a PC clock that runs behind the server's (the deadline after the first
 * run is reckoned from the PC's own clock) and an upload that had to be retried. What
 * it stops is a run played, or held back, long after the match ran out of time and then
 * stamped back into it.
 */
export const LATE_RECEIPT_GRACE_MS = 15 * 60_000;

/** An offset a request may declare: whole minutes, in `getTimezoneOffset`'s convention. */
export function isOffsetMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= MAX_OFFSET_MINUTES;
}

/**
 * The filename's wall clock, read without any zone.
 *
 * `ms` is the digits taken as if they were UTC, so `ms + offset * 60_000` is the instant
 * (see playedAtUtc). `local` is the same digits as a Postgres `timestamp` literal: the
 * part of a run's identity no offset can move.
 */
export function wallClock(filename: string): { ms: number; local: string } | null {
  const m = FILENAME_STAMP.exec(filename);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (Number.isNaN(ms)) return null;
  return { ms, local: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` };
}

/** "UTC-5", "UTC+5:30", "UTC" for an offset in `getTimezoneOffset`'s convention. */
export function formatUtcOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const east = -offsetMinutes;
  const sign = east > 0 ? "+" : "-";
  const abs = Math.abs(east);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** One reading of a player's clock: the offset it declared and the instant it applied to. */
export interface ClockReading {
  /** `getTimezoneOffset` convention: minutes to add to local time to reach UTC. */
  offset: number;
  /** The instant, ms since epoch. */
  at: number;
}

let zones: string[] | null = null;
function allZones(): string[] {
  if (!zones) {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    zones = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  }
  return zones;
}

/**
 * A real time zone that was at `from.offset` at `from.at` and at `to.offset` at `to.at`,
 * or null when none was.
 *
 * This is how a genuine change of offset is told from a chosen one without asking the
 * client which zone it is in: a daylight-saving change is a fact about some zone's rules,
 * and the zone database says when every one of them happened. Two readings with the same
 * offset need no explanation and return "same".
 *
 * What it allows a cheat is bounded by the same facts. A change can be explained only
 * when some zone really changed offset between the two instants, by exactly that much.
 */
export function zoneExplaining(from: ClockReading, to: ClockReading): string | null {
  if (from.offset === to.offset) return "same";
  for (const zone of allZones()) {
    try {
      if (offsetMinutesAt(from.at, zone) === from.offset && offsetMinutesAt(to.at, zone) === to.offset) {
        return zone;
      }
    } catch {
      // A zone this runtime lists but cannot format explains nothing.
    }
  }
  return null;
}

function clockTime(at: number): string {
  return new Date(at).toISOString().slice(11, 16) + " UTC";
}

export type ContinuityVerdict =
  | { ok: true }
  | { ok: false; conflict: ClockReading; allowedFrom: number; message: string };

/**
 * May `declared` be used for a new match, given the offsets on the player's recent
 * uploads and matches?
 *
 * Evidence older than `windowMs` before the declaration says nothing. Evidence carrying
 * the declared offset, or one a real zone explains moving from, agrees. Anything else is
 * a different clock within the window, and the latest such reading says when the new one
 * will be accepted.
 */
export function clockContinuity(
  declared: ClockReading,
  evidence: ClockReading[],
  windowMs = CLOCK_CONTINUITY_MS,
): ContinuityVerdict {
  const conflicts = evidence
    .filter((e) => e.at >= declared.at - windowMs && e.at <= declared.at + FUTURE_SKEW_MS)
    .filter((e) => zoneExplaining(e, declared) === null)
    .sort((a, b) => b.at - a.at);

  if (conflicts.length === 0) return { ok: true };

  const latest = conflicts[0];
  const allowedFrom = latest.at + windowMs;
  const hours = Math.round(windowMs / 3_600_000);
  return {
    ok: false,
    conflict: latest,
    allowedFrom,
    message:
      `Your PC's clock is on ${formatUtcOffset(declared.offset)} now, but a run of yours that ended ` +
      `at ${clockTime(latest.at)} was uploaded on ${formatUtcOffset(latest.offset)}. Ranked accepts a ` +
      `new time zone ${hours} hours after your last run in the old one, which is ${clockTime(allowedFrom)}. ` +
      "If you have not travelled, check the time zone in your PC's date and time settings.",
  };
}

/**
 * May a run declaring `submitted` count in a match whose side declared `side`?
 *
 * `side.at` is when the match clock was declared, `submitted.at` the run's corrected end.
 * The same offset always may. A different one may only when a real zone changed offset
 * between the two, which is a daylight-saving change during the match.
 */
export function matchClockProblem(side: ClockReading, submitted: ClockReading): string | null {
  if (zoneExplaining(side, submitted) !== null) return null;
  return (
    `This match started with your PC's clock on ${formatUtcOffset(side.offset)}, and this run says ` +
    `${formatUtcOffset(submitted.offset)}. Every run in a match has to use the clock the match ` +
    "started with, so it was not counted."
  );
}

/** Is a corrected end time later than the server's receipt allows? */
export function isFutureDated(endedAt: number, receivedAt: number, skewMs = FUTURE_SKEW_MS): boolean {
  return endedAt > receivedAt + skewMs;
}

export function futureMessage(endedAt: number, receivedAt: number): string {
  const minutes = Math.round((endedAt - receivedAt) / 60_000);
  return (
    `This run's end time is ${minutes} minutes ahead of the server's clock, so it was not accepted. ` +
    "Check that your PC's date, time and time zone are set correctly."
  );
}

/**
 * Has a ranked run reached the server too long after its match ran out of time?
 *
 * `expiresAt` is the deadline as it stood when the run arrived; `windowEndGraceMs` is
 * the slack the match window itself already allows past it.
 */
export function isLateReceipt(
  receivedAt: number,
  expiresAt: number | null,
  windowEndGraceMs: number,
  graceMs = LATE_RECEIPT_GRACE_MS,
): boolean {
  return expiresAt !== null && Number.isFinite(expiresAt) && receivedAt > expiresAt + windowEndGraceMs + graceMs;
}
