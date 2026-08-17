-- How long a run lasted, and how long its scenario is supposed to last.
--
-- Together these let settlement tell a crash from a bad performance. A match counts
-- only the first attempt on each scenario, so without this an alt-F4 eight seconds in
-- becomes the attempt of record: the file parses perfectly, the match settles complete,
-- and the player takes a loss for a game that stopped working.
--
-- Why the run's duration is stored rather than derived at settlement time: KovaaK's
-- records the start as a local wall-clock time of day and nothing else, while
-- runs.played_at is a timestamptz normalised to UTC. Subtracting one from the other
-- yields the player's timezone offset, not a duration. submit-run computes it instead,
-- from a single parse of the raw file, where both ends are in the same frame.
--
-- And why submit-run computes it rather than the client sending it: a client that could
-- name its own duration could claim a full run was a crash, and a crash voids the match
-- (no loss) where a bad run does not. That is precisely the dodge the rule exists to
-- close, so the number has to come from the server's own read of the file.

alter table runs
  add column if not exists duration_seconds numeric;

comment on column runs.duration_seconds is
  'Seconds of play, computed server-side by submit-run as the gap between the file''s '
  'Challenge Start and the end time in its filename. Null when either was unreadable, '
  'which means the run is simply never checked for abandonment.';

alter table scenarios
  add column if not exists duration_seconds integer;

comment on column scenarios.duration_seconds is
  'Modal run length in seconds, learned from real history rather than hardcoded. Null '
  'for scenarios with no fixed length - pressure and nevermiss scenarios end the moment '
  'you miss - and a null here disables the abandonment check for that scenario rather '
  'than failing it.';

-- A scenario is either a positive number of seconds long or unknown. Zero or negative
-- would silently disable the check while looking configured.
alter table scenarios
  add constraint scenarios_duration_positive
    check (duration_seconds is null or duration_seconds > 0);
