-- ---------------------------------------------------------------------------
-- Shadows and Flags, on ranked v2
--
-- With nobody suitable in the pool, find-match hands out a seeding match, and settlement
-- used to end it "Nothing was rated: there was no opponent to play against".
--
--   SHADOW  the seeding match is contested against a stated percentile score on each of
--           its three scenarios, read from Season 1's committed thresholds and decided
--           like ranked, best of three on raw score (src/core/match/shadow.ts). It moves
--           no rating. Frozen here when the match is created, so the client never names
--           a Shadow or its scores.
--
--   FLAG    news: when somebody plays a match drawn from your banked rounds and it
--           settles, you are told on your next launch (src/core/match/flags.ts). Read
--           from the copies ranked v2 already writes; the only new state is how far each
--           player has read. Unrated for the owner, as ranked v2 intends.
--
-- Nothing here changes how a contested match is created, graded or rated.
-- ---------------------------------------------------------------------------

create type shadow_result as enum ('win', 'loss', 'draw', 'void', 'forfeit');

-- One row per Shadow match: the Shadow it was played against, frozen at creation.
create table match_shadows (
  match_id       uuid primary key references matches (id) on delete cascade,
  player_id      uuid not null references players (id) on delete cascade,
  -- The player's nth Shadow, which seeds the percentile drawn, so the same history always
  -- fields the same Shadow.
  ordinal        integer not null check (ordinal >= 0),
  -- Ladder rung (0..6) and the percentile drawn on it.
  rung           smallint not null check (rung between 0 and 6),
  percentile     smallint not null check (percentile between 1 and 99),
  -- The Shadow's score on each scenario, in matches.scenario_ids order. A null element is a
  -- scenario with no committed score at that percentile: that round is not contested.
  scores         numeric[] not null check (cardinality(scores) between 1 and 5),
  table_version  integer not null,
  -- Null while the match is open. 'forfeit' is written only by the trigger below.
  result         shadow_result,
  rounds_won     smallint,
  rounds_lost    smallint,
  rounds_tied    smallint,
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,

  constraint match_shadows_ordinal unique (player_id, ordinal),
  constraint match_shadows_decided check ((result is null) = (decided_at is null))
);

comment on table match_shadows is
  'The synthetic opponent of a seeding match: a percentile score on each scenario, frozen at '
  'creation by find-match and judged on raw rounds by settlement. Moves no rating. Service role only.';

create index match_shadows_player_idx on match_shadows (player_id, ordinal desc);

-- How far a player has read the news about their banked rounds.
create table flag_reads (
  player_id     uuid primary key references players (id) on delete cascade,
  seen_through  timestamptz not null
);

comment on table flag_reads is
  'The settled_at up to which a player has been told that others played their banked rounds. '
  'Written by queue-board when the client acknowledges. Service role only.';

-- ---------------------------------------------------------------------------
-- abandoning a Shadow match counts as losing it
-- ---------------------------------------------------------------------------
--
-- forfeitMatch voids a seeding match for nothing, which stays true for the ladder. For the
-- Shadow ladder it must not be free, or abandoning would be the way to keep a streak. The
-- other route to a void (a round left early) records the Shadow result before the match
-- closes, so a void Shadow match with no result left is an abandon or an expiry.
create function shadow_forfeit_on_void() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update match_shadows set result = 'forfeit', decided_at = clock_timestamp()
    where match_id = new.id and result is null;
  return null;
end;
$$;

create trigger matches_shadow_forfeit after update of status on matches
  for each row when (new.status = 'void' and old.status is distinct from 'void')
  execute function shadow_forfeit_on_void();

-- ---------------------------------------------------------------------------
-- settling a Shadow match: the side, and the Shadow's verdict, as one unit
-- ---------------------------------------------------------------------------
create function commit_shadow_match(p_match_id uuid, p_sides jsonb, p_result shadow_result,
  p_won integer, p_lost integer, p_tied integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m matches%rowtype; s match_shadows%rowtype; receipt jsonb;
begin
  select * into m from matches where id = p_match_id for update;
  if not found then raise exception 'no such match' using errcode = 'P0002'; end if;
  select * into s from match_shadows where match_id = p_match_id for update;
  if not found then raise exception 'not a shadow match'; end if;
  if m.status in ('settled', 'void') then
    return jsonb_build_object('committed', false, 'reason', 'already-settled');
  end if;
  if p_result = 'forfeit' then raise exception 'a forfeit is recorded by the trigger'; end if;
  if jsonb_array_length(p_sides) <> 1 or (p_sides->0->>'player_id')::uuid <> s.player_id then
    raise exception 'a shadow match has one side, the player''s';
  end if;

  update match_shadows set result = p_result, rounds_won = p_won, rounds_lost = p_lost,
    rounds_tied = p_tied, decided_at = clock_timestamp()
    where match_id = p_match_id;

  -- Settled, with no rating proposals: a Shadow moves nothing.
  receipt := commit_match_result(p_match_id, 'settled', p_sides, '[]'::jsonb, false);
  if not coalesce((receipt->>'committed')::boolean, false) then
    raise exception 'shadow settlement did not commit';
  end if;
  return receipt;
end;
$$;

-- ---------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------

alter table match_shadows enable row level security;
alter table flag_reads enable row level security;

-- No policies, and the grants revoked, the way ghost_results and the tournament tables are:
-- queue-board serves the player's own view and decides what it says.
revoke all on match_shadows, flag_reads from anon, authenticated;

revoke all on function shadow_forfeit_on_void() from public, anon, authenticated;
revoke all on function commit_shadow_match(uuid, jsonb, shadow_result, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function commit_shadow_match(uuid, jsonb, shadow_result, integer, integer, integer)
  to service_role;
