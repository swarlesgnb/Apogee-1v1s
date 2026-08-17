/**
 * How long a run actually lasted, and whether it was abandoned partway.
 *
 * KovaaK's records no duration field, but it records both ends: `Challenge Start:` is
 * the wall-clock time play began, and the filename carries the moment the file was
 * written, which is when play stopped. The difference is the run's length, and it is
 * available for every run in the corpus without exception.
 *
 * This matters because a match counts only a player's first attempt on each scenario
 * (PLAN.md §3). A crash or an alt-F4 produces a file that parses perfectly well and
 * simply says eight seconds and a terrible score. Without this, that becomes the
 * attempt of record, the match settles complete, and the player takes a loss for a
 * game that stopped working. With it, the round is excluded, the sides no longer match
 * on round count, and the existing guard in settleMatch voids at zero rating weight.
 *
 * No filesystem or network access, so it runs in an Edge Function unchanged.
 */

/**
 * Fraction of a scenario's normal length a run must reach to count as played.
 *
 * Measured across 672 real runs on the 54 benchmark scenarios: every one of them is a
 * 60-second scenario, and the shortest run ever recorded was 59 seconds. Nothing
 * legitimate came within 10% of this line, so it rejects abandonment without ever
 * rejecting play.
 */
export const MIN_COMPLETION_FRACTION = 0.9;

/**
 * Shortest scenario this check will judge at all.
 *
 * Start and end are recorded a whole second apart at best, so on a 2-second scenario
 * the rounding band *is* the scenario and a 10% margin means nothing. Measured: the
 * check's only false positives were exactly there, on 2-second and 6-second nevermiss
 * variants where finishing early is the scenario working as designed. Below this
 * length there is no signal to read, so none is claimed. Every benchmark scenario is
 * 60 seconds, so nothing a match uses is affected.
 */
export const MIN_CHECKABLE_SECONDS = 20;

/** `VT Aether Intermediate S5 - Challenge - 2026.08.17-13.01.16 Stats.csv` */
const FILENAME_STAMP = /(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}) Stats\.csv$/;

/**
 * The instant a run finished, from its filename and the player's UTC offset.
 *
 * KovaaK's writes a bare local wall clock into the filename and records no offset
 * anywhere, so those digits are not a moment in time until someone says where they were
 * read. Parsing them with `new Date(y, m, d, ...)` silently supplies whatever timezone
 * the *runtime* is in, which is right on the player's machine and wrong on a server.
 *
 * That is what rejected the first real match: three runs played at 13:01 local were
 * stored as 13:01Z by an Edge Function running in UTC, six hours before a match window
 * that had not opened yet, and every one came back "outside the match window". The
 * backfill path never showed it, because that parses on the player's own machine where
 * the accident happens to be correct.
 *
 * @param tzOffsetMinutes what `Date.prototype.getTimezoneOffset` reports on the
 *        player's machine: minutes to *add* to local time to reach UTC, so UTC-6 is
 *        +360. Sent with the run, because only the client can know it.
 */
export function playedAtUtc(filename: string, tzOffsetMinutes: number): Date | null {
  const m = FILENAME_STAMP.exec(filename);
  if (!m || !Number.isFinite(tzOffsetMinutes)) return null;

  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (Number.isNaN(wall)) return null;

  return new Date(wall + tzOffsetMinutes * 60_000);
}

/**
 * Parse a `Challenge Start:` value ("17:31:49.055") to seconds past midnight.
 * Returns null rather than guessing when the shape is not what we expect.
 */
export function challengeStartSeconds(challengeStart: string | null): number | null {
  if (!challengeStart) return null;

  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(challengeStart.trim());
  if (!m) return null;

  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (h > 23 || min > 59 || s > 59) return null;

  return h * 3600 + min * 60 + s + (m[4] ? Number(`0.${m[4]}`) : 0);
}

/**
 * Seconds of play, from the start time in the file and the end time in the filename.
 *
 * @param challengeStart the `Challenge Start:` field, a time of day with no date.
 * @param endedAt        `playedAt`, derived from the filename, i.e. when writing finished.
 *
 * A run that begins before midnight and ends after it yields a negative raw difference;
 * that is a wrap, not an error, so a day is added back. Anything still outside a
 * sane range is reported as unknown rather than forced into a number, because a wrong
 * duration here would exclude a legitimate run.
 */
export function runDurationSeconds(
  challengeStart: string | null,
  endedAt: Date | null,
): number | null {
  const start = challengeStartSeconds(challengeStart);
  if (start === null || !endedAt || Number.isNaN(endedAt.getTime())) return null;

  const end =
    endedAt.getHours() * 3600 + endedAt.getMinutes() * 60 + endedAt.getSeconds();

  let seconds = end - start;
  if (seconds < 0) seconds += 86_400;

  // Beyond a couple of hours the pairing is more likely wrong than the run that long.
  if (seconds > 7_200) return null;

  return seconds;
}

/**
 * Was this run abandoned before the scenario finished?
 *
 * Unknowns answer false in both directions on purpose. If the duration cannot be
 * derived, or the scenario's normal length is not known, the run is treated as played:
 * a check that cannot be confident must not be the thing that voids someone's match.
 * That is the same rule the verification checks follow (PLAN.md §5).
 */
export function isAbandonedRun(
  durationSeconds: number | null,
  expectedSeconds: number | null | undefined,
): boolean {
  if (durationSeconds === null) return false;
  if (expectedSeconds == null || expectedSeconds <= 0) return false;
  if (expectedSeconds < MIN_CHECKABLE_SECONDS) return false;

  return durationSeconds < expectedSeconds * MIN_COMPLETION_FRACTION;
}
