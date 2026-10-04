-- ---------------------------------------------------------------------------
-- Time integrity for ranked runs, and the rest of the October security audit
--
-- docs/fleet/security.md has the findings, the reasoning and the tests. In short:
--
--   SEC-01/02  The UTC offset a client sends decides when a run was played, and it was a
--              free choice per run. A run played hours before a match could be stamped
--              inside it, and one run could be stamped into two matches at two instants,
--              because ranked_run_claims (20261002000021) is keyed on that instant.
--   SEC-03     players_update_self pinned kovaaks_username and nothing else, so a client
--              could rewrite its own steam_id, display_name and moderation flags.
--   SEC-04     verified_pbs was read in three places and written in none, so the
--              documented baseline floor never engaged.
--   SEC-05     Steam OpenID assertions could be replayed: no nonce store.
--   SEC-06     ratings_read_all handed every session an ordered list of every player_id.
--
-- Nothing here changes how a run is graded or how a rating moves. A run refused below is
-- one the documented rules already say cannot count: played outside its match, submitted
-- twice, or stamped later than it could have been played.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 1. The offset a run was uploaded with, and the wall clock it implies
-- ===========================================================================
--
-- `played_at` is an instant: the filename's bare wall clock plus the player's UTC offset.
-- The offset was thrown away once applied, so nothing could later ask whether two uploads
-- of one run agreed about it, or whether a player's offset had changed. Both are kept
-- now. `ended_local` is the wall clock back again, derived by the trigger below and never
-- taken from a client: the part of a run's identity no offset can move.

alter table runs add column if not exists tz_offset_minutes smallint;
alter table runs add column if not exists ended_local timestamp;

comment on column runs.tz_offset_minutes is
  'getTimezoneOffset() convention: minutes to add to the filename''s wall clock to reach '
  'played_at. Sent by the client for history, set by submit-run for ranked runs. Null for '
  'uploads from clients that predate it. When a performance was seen before, the trigger '
  'replaces it with the offset implied by the first-seen time.';

comment on column runs.ended_local is
  'The filename''s wall clock with no zone, derived as played_at - tz_offset_minutes by '
  'enforce_run_time_integrity. Not granted to clients.';

-- History is a direct client insert (20260825000013 lists the columns), so the new field
-- has to be granted or every batch from an updated client fails. ended_local is not.
grant insert (tz_offset_minutes) on runs to authenticated;

-- The first-seen lookup below: one player, one scenario, one challenge start.
create index if not exists runs_identity_idx
  on runs (player_id, scenario_id, (coalesce(challenge_start, '')));


-- ===========================================================================
-- 2. The clock a match was started with
-- ===========================================================================
--
-- Written on the player's own side when the match is created or joined (find-match,
-- send-duel, answer-duel, play-fixture), or by submit-run on the first ranked run when
-- the client that created the match did not send one. Every run in the match is held to
-- it; see src/core/verify/timeIntegrity.ts.

alter table match_sides add column if not exists tz_offset_minutes smallint;
alter table match_sides add column if not exists tz_declared_at timestamptz;

alter table match_sides add constraint match_sides_tz_offset_range
  check (tz_offset_minutes is null or tz_offset_minutes between -840 and 840);

comment on column match_sides.tz_offset_minutes is
  'The UTC offset (getTimezoneOffset convention) this player''s match clock was declared '
  'with. Every ranked run submitted to the match must carry it, except across a real '
  'daylight-saving change. Null on opponents'' copied sides and on matches from before it.';


-- ===========================================================================
-- 3. One ranked claim per performance
-- ===========================================================================
--
-- ranked_run_claims reserves (player, scenario, played_at), and played_at is the instant
-- the client's offset produced, so a second offset produced a second key. That table and
-- its rows stay exactly as they are - they are evidence, and claim_ranked_run still
-- consults them - and this one is added beside it.
--
-- The key here is what a re-export, a different offset or a renamed file cannot change:
-- the scenario, the challenge start to the millisecond and the score. Two genuine runs
-- agreeing on all three would have to start in the same millisecond of the day and score
-- exactly the same; for ranked runs, which are tens per player per scenario, that is not a
-- collision anybody will meet. A file with no Challenge Start line (KovaaK's always writes
-- one) is keyed on the empty string, so stripping the line does not escape the key.
--
-- Backfilled from every run a match has ever counted. Where the old replay hole let one
-- performance into two matches, the first receipt keeps the claim and the later rows stay
-- as they are: no historical result is rewritten.

create table if not exists ranked_run_fingerprints (
  player_id       uuid not null references players (id) on delete cascade,
  scenario_id     bigint not null references scenarios (id),
  challenge_start text not null,
  score           numeric not null,
  first_run_id    uuid not null,
  match_id        uuid,
  claimed_at      timestamptz not null default now(),

  primary key (player_id, scenario_id, challenge_start, score)
);

alter table ranked_run_fingerprints enable row level security;
revoke all on ranked_run_fingerprints from public, anon, authenticated;

comment on table ranked_run_fingerprints is
  'Reserved ranked performances, keyed on what no offset, filename or byte edit moves. '
  'Rows outlive deleted runs, like ranked_run_claims. Service role only.';

insert into ranked_run_fingerprints (player_id, scenario_id, challenge_start, score, first_run_id, match_id, claimed_at)
select distinct on (player_id, scenario_id, coalesce(challenge_start, ''), score)
  player_id, scenario_id, coalesce(challenge_start, ''), score, id, match_id,
  coalesce(match_submitted_at, created_at)
from runs
where scenario_id is not null and (match_id is not null or match_submitted_at is not null)
order by player_id, scenario_id, coalesce(challenge_start, ''), score,
  match_submitted_at nulls last, created_at, id
on conflict do nothing;


-- ===========================================================================
-- 4. A performance keeps the time it was first seen with
-- ===========================================================================
--
-- The rules, in the order they run:
--
--   FROZEN      a run a match has counted keeps its time, offset and wall clock.
--
--   FIRST SEEN  a run whose performance the server has already stored takes the stored
--               play time. "The same performance" is the same scenario and challenge
--               start plus either the same filename wall clock (any upload) or the same
--               score (a ranked submission, which also catches a renamed file). The
--               client uploads every run as history the moment it lands, so a run
--               uploaded live is pinned to the instant it was played, and submitting it
--               to a later match with another offset gives it its real time back - which
--               fails that match's window, the existing rule. History takes the stored
--               time silently; a ranked insert that disagrees is refused (TI409), because
--               submit-run graded it against the time it looked up first and a race would
--               leave the grade describing a different instant.
--
--   NOT FUTURE  a time seen for the first time may not be later than the server's clock
--               plus sixteen minutes: submit-run refuses at fifteen with a message, and
--               this is the backstop, a minute wider so a request the function accepted is
--               never then dropped here. History is skipped (one bad row must not fail a
--               500-row batch, and it uploads normally once the time has passed); a ranked
--               insert is refused (TI422).
--
--   ONE CLAIM   a ranked run takes its performance's fingerprint, or is refused as a
--               replay (23505, the code submit-run already reports as "already submitted").
--
-- Named to run after runs_resolve_scenario (it needs scenario_id) and after
-- runs_zz_ranked_claim (which refuses a run for a finished match first, 55000).

create or replace function enforce_run_time_integrity() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ranked boolean := new.match_id is not null;
  cs text := coalesce(new.challenge_start, '');
  pin_at timestamptz;
  pin_offset smallint;
  pin_seen timestamptz;
  implied numeric;
  claimed uuid;
begin
  if tg_op = 'UPDATE' and (old.match_id is not null or old.match_submitted_at is not null) then
    new.played_at := old.played_at;
    new.tz_offset_minutes := old.tz_offset_minutes;
    new.ended_local := old.ended_local;
    return new;
  end if;

  if new.tz_offset_minutes is not null and abs(new.tz_offset_minutes) > 840 then
    new.tz_offset_minutes := null;
  end if;
  new.ended_local := case when new.tz_offset_minutes is null then null
    else (new.played_at at time zone 'UTC') - make_interval(mins => new.tz_offset_minutes) end;

  -- The same file again: the backfill upsert will ignore it, or submit-run will claim the
  -- stored row, and the stored row already holds this performance's time.
  if tg_op = 'INSERT' and exists (
    select 1 from runs where player_id = new.player_id and csv_sha256 = new.csv_sha256
  ) then
    return new;
  end if;

  if new.scenario_id is not null then
    select r.played_at, r.tz_offset_minutes, r.created_at into pin_at, pin_offset, pin_seen
      from runs r
     where r.player_id = new.player_id
       and r.scenario_id = new.scenario_id
       and coalesce(r.challenge_start, '') = cs
       and r.id <> new.id
       and ((new.ended_local is not null and r.ended_local = new.ended_local)
            or (ranked and r.score = new.score))
     order by r.created_at, r.id
     limit 1;

    -- A stored history row being claimed or rewritten is itself the first sighting of
    -- its file, unless an earlier row of the same performance exists.
    if tg_op = 'UPDATE' and (pin_seen is null or old.created_at <= pin_seen) then
      pin_at := old.played_at;
      pin_offset := old.tz_offset_minutes;
      pin_seen := old.created_at;
    end if;

    if pin_at is not null and pin_at is distinct from new.played_at then
      if ranked then
        raise exception 'this run was first uploaded ending at %, and a ranked run keeps that time', pin_at
          using errcode = 'TI409';
      end if;
      new.played_at := pin_at;
      -- Keep the wall clock this row really carries; the offset becomes whatever joins it
      -- to the pinned instant.
      if new.ended_local is not null then
        implied := round(extract(epoch from (pin_at - (new.ended_local at time zone 'UTC'))) / 60);
        if abs(implied) <= 840 then
          new.tz_offset_minutes := implied::smallint;
        else
          new.tz_offset_minutes := null;
          new.ended_local := null;
        end if;
      else
        new.tz_offset_minutes := pin_offset;
      end if;
    end if;
  end if;

  if pin_at is null and new.played_at > clock_timestamp() + interval '16 minutes' then
    if ranked then
      raise exception 'this run ends at %, later than the server''s clock allows', new.played_at
        using errcode = 'TI422';
    end if;
    return null;
  end if;

  if ranked and new.scenario_id is not null then
    insert into ranked_run_fingerprints (player_id, scenario_id, challenge_start, score, first_run_id, match_id)
      values (new.player_id, new.scenario_id, cs, new.score, new.id, new.match_id)
      on conflict do nothing;
    select first_run_id into claimed from ranked_run_fingerprints
     where player_id = new.player_id and scenario_id = new.scenario_id
       and challenge_start = cs and score = new.score;
    if claimed is distinct from new.id then
      raise exception 'this ranked run has already been submitted' using errcode = '23505';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function enforce_run_time_integrity() from public, anon, authenticated;

drop trigger if exists runs_zzz_time_integrity on runs;
create trigger runs_zzz_time_integrity before insert or update on runs
  for each row execute function enforce_run_time_integrity();
