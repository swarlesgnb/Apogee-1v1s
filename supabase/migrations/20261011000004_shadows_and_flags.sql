-- ---------------------------------------------------------------------------
-- Shadows and Flags: a ranked match for an empty pool, and a reason to come back
--
-- The ladder is asynchronous (PLAN.md §6), and with nobody in the pool find-match
-- hands out a seeding match that settle-match used to end with "Nothing was rated:
-- there was no opponent to play against". That was every player's first evening.
--
--   SHADOW  the seeding match is contested against a calibrated opponent: a day at
--           a stated percentile of genuine three-scenario match scores
--           (src/core/match/shadow.ts). It moves no rating. It is frozen here when the
--           match is created, so the client never names a Shadow or its score.
--
--   FLAG    the seeding run set becomes an open challenge. The first real player to
--           answer it inside seven days settles a rated match for both of them, and the
--           planter is told on their next launch (src/core/match/flags.ts).
--
-- Neither changes how a contested match is graded or rated. Both tables are written
-- only by the Edge Functions under the service role.
-- ---------------------------------------------------------------------------

create type shadow_result as enum ('win', 'loss', 'draw', 'void', 'forfeit');

-- One row per Shadow match: the Shadow it was played against, frozen at creation.
create table match_shadows (
  match_id       uuid primary key references matches (id) on delete cascade,
  player_id      uuid not null references players (id) on delete cascade,
  -- The player's nth Shadow. Unique per player, which is also what stops two racing
  -- queue calls from both opening a Shadow match: the second insert is refused.
  ordinal        integer not null check (ordinal >= 0),
  -- Ladder rung (0..6) and the percentile drawn on it, from the player's own history.
  rung           smallint not null check (rung between 0 and 6),
  percentile     smallint not null check (percentile between 1 and 99),
  skill          text not null check (skill in ('All', 'Clicking', 'Tracking', 'Switching')),
  -- The Shadow's day at that percentile as the mean of 1, 2 and 3 rounds. Settlement
  -- picks the one matching how many rounds the player could be measured on.
  quantiles      numeric[] not null check (cardinality(quantiles) = 3),
  table_version  integer not null,
  table_method   text not null check (table_method in ('model', 'corpus')),
  -- Null while the match is open. 'forfeit' is written only by the trigger below.
  result         shadow_result,
  player_score   numeric,
  shadow_score   numeric,
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,

  constraint match_shadows_ordinal unique (player_id, ordinal),
  constraint match_shadows_decided check ((result is null) = (decided_at is null))
);

comment on table match_shadows is
  'The synthetic opponent of a seeding match: a percentile of genuine match scores, frozen at '
  'creation by find-match and judged by settle-match. Moves no rating. Service role only.';

create index match_shadows_player_idx on match_shadows (player_id, ordinal desc);

create type flag_status as enum ('open', 'answered', 'expired');

-- A seeding run set planted as an open challenge.
create table flags (
  id               uuid primary key default gen_random_uuid(),
  planter_id       uuid not null references players (id) on delete cascade,
  -- The Shadow match whose side was planted.
  match_id         uuid not null unique references matches (id) on delete cascade,
  -- runSetId() of that side: owner and the instant it was played, to the millisecond.
  -- Every copy of the side carries the same identity, which is how settle-match knows
  -- an answer match is answering this flag.
  run_set_id       text not null unique,
  category         text not null,
  window_index     integer not null,
  band             text not null,
  status           flag_status not null default 'open',
  planted_at       timestamptz not null,
  expires_at       timestamptz not null,
  answer_match_id  uuid references matches (id) on delete set null,
  answered_by      uuid references players (id) on delete set null,
  answered_at      timestamptz,
  -- When the planter's client acknowledged the news, so it is announced once.
  seen_at          timestamptz,

  constraint flags_window check (expires_at > planted_at),
  constraint flags_answered check ((status = 'answered') = (answered_at is not null))
);

comment on table flags is
  'A seeding run set offered as an open challenge. Settled rated, once, by the first real '
  'answer inside its window. Written by settle-match through the functions below; read by '
  'queue-board for the planter. Service role only.';

create index flags_planter_idx on flags (planter_id, planted_at desc);

-- ---------------------------------------------------------------------------
-- abandoning a Shadow match counts as losing it
-- ---------------------------------------------------------------------------
--
-- forfeitMatch voids a seeding match for nothing, which stays true for the ladder. For
-- the Shadow ladder it must not be free, or abandoning would be the way to keep a
-- streak. Every other route to a void (an abandoned round) records its result before
-- the match closes, so a void Shadow with no result left is an abandon or an expiry.
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
-- settling a Shadow match, and planting its flag, as one unit
-- ---------------------------------------------------------------------------
create function commit_shadow_match(p_match_id uuid, p_status text, p_sides jsonb,
  p_result shadow_result, p_player_score numeric, p_shadow_score numeric,
  p_plant boolean, p_flag_ttl_seconds integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m matches%rowtype; s match_shadows%rowtype; side match_sides%rowtype;
  f flags%rowtype; receipt jsonb;
begin
  select * into m from matches where id = p_match_id for update;
  if not found then raise exception 'no such match' using errcode = 'P0002'; end if;
  select * into s from match_shadows where match_id = p_match_id for update;
  if not found then raise exception 'not a shadow match'; end if;
  if m.status in ('settled', 'void') then
    return jsonb_build_object('committed', false, 'reason', 'already-settled');
  end if;
  -- A void match has a void Shadow. A settled one can too: a round that failed
  -- verification leaves the side recorded but nothing for the Shadow to be judged on.
  if p_result = 'forfeit' or (p_status = 'void' and p_result <> 'void') then
    raise exception 'shadow result disagrees with the match';
  end if;
  if jsonb_array_length(p_sides) <> 1 or (p_sides->0->>'player_id')::uuid <> s.player_id then
    raise exception 'a shadow match has one side, the player''s';
  end if;
  if p_plant and (p_flag_ttl_seconds is null or p_flag_ttl_seconds <= 0) then
    raise exception 'a flag needs a window';
  end if;

  update match_shadows set result = p_result, player_score = p_player_score,
    shadow_score = p_shadow_score, decided_at = clock_timestamp()
    where match_id = p_match_id;

  receipt := commit_match_result(p_match_id, p_status, p_sides, '[]'::jsonb, false);
  if not coalesce((receipt->>'committed')::boolean, false) then
    raise exception 'shadow settlement did not commit';
  end if;

  if p_plant and p_status = 'settled' and m.rated then
    select * into side from match_sides where match_id = p_match_id and player_id = s.player_id;
    if side.match_score is not null and side.submitted_at is not null then
      insert into flags (planter_id, match_id, run_set_id, category, window_index, band,
        planted_at, expires_at)
      values (s.player_id, p_match_id,
        s.player_id::text || '@' ||
          to_char(side.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        m.category, coalesce(m.window_index, 0), coalesce(m.difficulty, ''),
        side.submitted_at, side.submitted_at + make_interval(secs => p_flag_ttl_seconds))
      on conflict (match_id) do nothing
      returning * into f;
    end if;
  end if;

  return receipt || jsonb_build_object('flag', case when f.id is null then null else
    jsonb_build_object('id', f.id, 'category', f.category, 'band', f.band,
      'planted_at', f.planted_at, 'expires_at', f.expires_at) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- answering a flag: the match result, both ratings and the claim, as one unit
-- ---------------------------------------------------------------------------
--
-- The claim is the row lock on the flag. Two answer matches settling at once both
-- reach here; the second finds the flag answered and is told 'flag-closed', and
-- settle-match settles it again as an ordinary pool match that rates only its player.
create function commit_flag_answer(p_flag_id uuid, p_match_id uuid, p_status text,
  p_sides jsonb, p_ratings jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare f flags%rowtype; created timestamptz; answerer uuid; receipt jsonb;
begin
  select * into f from flags where id = p_flag_id for update;
  if not found then raise exception 'no such flag' using errcode = 'P0002'; end if;
  select created_at into created from matches where id = p_match_id;
  if not found then raise exception 'no such match' using errcode = 'P0002'; end if;
  if f.status <> 'open' or created >= f.expires_at then
    return jsonb_build_object('committed', false, 'reason', 'flag-closed');
  end if;
  if p_status <> 'settled' then raise exception 'only a settled answer settles a flag'; end if;
  if not exists (select 1 from jsonb_array_elements(p_ratings) r
                 where (r->>'player_id')::uuid = f.planter_id) then
    raise exception 'a flag answer must rate its planter';
  end if;
  if not exists (select 1 from match_sides ms where ms.match_id = p_match_id
      and ms.player_id = f.planter_id and ms.submitted_at is not null
      and f.planter_id::text || '@' ||
        to_char(ms.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = f.run_set_id) then
    raise exception 'that match does not answer this flag';
  end if;
  select (s->>'player_id')::uuid into answerer from jsonb_array_elements(p_sides) s
    where (s->>'player_id')::uuid <> f.planter_id limit 1;
  if answerer is null then raise exception 'a flag is answered by somebody else'; end if;

  receipt := commit_match_result(p_match_id, p_status, p_sides, p_ratings, false);
  if coalesce((receipt->>'committed')::boolean, false) then
    update flags set status = 'answered', answer_match_id = p_match_id,
      answered_by = answerer, answered_at = clock_timestamp()
      where id = p_flag_id;
  end if;
  return receipt || jsonb_build_object('flag_id', p_flag_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------

alter table match_shadows enable row level security;
alter table flags enable row level security;

-- No policies, and the grants revoked, the way ghost_results and the tournament tables
-- are: the queue-board function serves the planter's own view and decides what it says.
-- A client that could read flags could see a stranger's planted score before answering
-- it, which is the cherry-pick duels refuse; one that could write them could mint an
-- answer.
revoke all on match_shadows, flags from anon, authenticated;

revoke all on function shadow_forfeit_on_void() from public, anon, authenticated;
revoke all on function commit_shadow_match(uuid, text, jsonb, shadow_result, numeric, numeric, boolean, integer)
  from public, anon, authenticated;
revoke all on function commit_flag_answer(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function commit_shadow_match(uuid, text, jsonb, shadow_result, numeric, numeric, boolean, integer)
  to service_role;
grant execute on function commit_flag_answer(uuid, uuid, text, jsonb, jsonb) to service_role;
