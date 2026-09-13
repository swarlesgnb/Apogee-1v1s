-- ---------------------------------------------------------------------------
-- Tournaments: round-robin groups, then a single-elimination bracket
--
-- A tournament is not a new kind of match. Each fixture is played as two legs, exactly
-- the way a duel is: whoever presses Play first gets the one-sided match send-duel
-- creates, and when that settles the other player gets the contested match answer-duel
-- builds from the frozen side. Submission, verification, settlement, forfeit and the
-- match clock run on the paths that already exist. What this migration adds is the
-- bookkeeping around them, and one flag those paths now read.
--
-- UNRATED, AND WHO DECIDES THAT
--
-- `matches.rated`. Written only by the server, true for every match that existed before
-- this and every match the queue and duels create, false for a tournament leg. settle-match
-- and forfeitMatch read it and move no rating when it is false; find-match reads it and
-- never offers an unrated side to the pool. A tournament result arrives later and is
-- written over nothing, so there is no rating to write back and nothing to undo.
--
-- WHY THE AGGREGATE IS ONE DOCUMENT
--
-- The engine (src/core/tournament) is a pure reducer over one JSON state. Storing that
-- state whole, with a revision beside it, means a write is "the reducer's output, if nobody
-- else wrote first" - a compare-and-swap in one UPDATE - and a reload reads back exactly
-- what was written. The tables around it are projections the database can put
-- constraints on: who is entered, which match is which leg, which receipt was applied.
--
-- NOTHING HERE IS CLIENT-WRITABLE, OR CLIENT-READABLE
--
-- No policies on any of the five tables, and the grants revoked as well, the way
-- rate_limits does it. Everything a player sees about a tournament is built by
-- list-tournaments from the service role and carries no scores (src/core/tournament/view.ts).
-- ---------------------------------------------------------------------------

alter table matches add column rated boolean not null default true;

comment on column matches.rated is
  'False for a tournament leg. Set only by tournament_open_leg under the service role. '
  'settle-match and forfeitMatch write the result and move no rating when it is false, '
  'and find-match never draws an unrated side into the pool.';

create type tournament_phase as enum ('registration', 'groups', 'playoffs', 'completed', 'cancelled');

create table tournaments (
  id            uuid primary key default gen_random_uuid(),
  host_id       uuid not null references players (id) on delete cascade,
  name          text not null,
  -- Every fixture is drawn in this category from this window of the season pool. Chosen
  -- by the host at creation and checked against the pool then; fixed for the event, so
  -- the group stage and the final are the same kind of contest.
  category      text not null,
  window_index  integer not null,
  window_name   text not null,
  phase         tournament_phase not null default 'registration',
  revision      bigint not null default 0,
  state         jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint tournaments_name_length check (char_length(name) between 1 and 48),
  constraint tournaments_window check (window_index >= 0),
  constraint tournaments_revision check (revision >= 0),
  -- The columns beside the document are copies kept for indexing and listing. They must
  -- agree with it, or the list and the page would describe two different tournaments.
  constraint tournaments_state_is_this_row check (
    state->>'id' = id::text
    and (state->>'revision')::bigint = revision
    and state->>'phase' = phase::text
    and state->'config'->>'name' = name
  )
);

comment on table tournaments is
  'One tournament. `state` is the engine''s whole aggregate; `revision` is its '
  'compare-and-swap guard. Written only through tournament_commit and the create path '
  'of tournament-action, under the service role.';

-- One live tournament per host. Hosting is free and anybody signed in can do it, so
-- this is the cap that keeps the list a list.
create unique index tournaments_one_live_per_host
  on tournaments (host_id) where phase in ('registration', 'groups', 'playoffs');

create index tournaments_recent_idx on tournaments (updated_at desc);

-- Who is entered. A projection of state->'entrants', rewritten in the same transaction
-- as every commit, and here so the database can refuse what the engine should never
-- produce: the same player twice, or two players on one seed.
create table tournament_members (
  tournament_id uuid not null references tournaments (id) on delete cascade,
  player_id     uuid not null references players (id) on delete cascade,
  seed          smallint not null,
  checked_in    boolean not null,

  primary key (tournament_id, player_id),
  constraint tournament_members_one_seed unique (tournament_id, seed),
  constraint tournament_members_seed_range check (seed between 1 and 64)
);

-- "Which tournaments am I in", which is the list's first question.
create index tournament_members_player_idx on tournament_members (player_id);

-- Which ordinary match is which leg of which attempt at which fixture.
--
-- The primary key is the reservation: one first leg and one second leg per attempt, so
-- two presses of Play by two people at once produce one match and a refusal, not two
-- matches. `match_id` is unique so one match can never be read as two legs, and
-- (fixture, attempt, player) is unique so nobody plays both.
--
-- `ingested_at` null is the outstanding work. A leg whose match has finished and whose
-- result has not been folded into the aggregate is found by the partial index below and
-- picked up by the next request that touches the tournament; there is no worker to stop.
create table tournament_legs (
  tournament_id uuid not null references tournaments (id) on delete cascade,
  fixture_id    text not null,
  attempt       integer not null,
  leg           smallint not null,
  player_id     uuid not null references players (id) on delete cascade,
  match_id      uuid not null references matches (id) on delete cascade,
  created_at    timestamptz not null default now(),
  ingested_at   timestamptz,

  primary key (tournament_id, fixture_id, attempt, leg),
  constraint tournament_legs_one_per_match unique (match_id),
  constraint tournament_legs_one_per_player unique (tournament_id, fixture_id, attempt, player_id),
  constraint tournament_legs_leg check (leg in (1, 2)),
  constraint tournament_legs_attempt check (attempt >= 1),
  constraint tournament_legs_fixture check (char_length(fixture_id) between 1 and 128)
);

create index tournament_legs_pending_idx on tournament_legs (tournament_id) where ingested_at is null;

-- Every result applied to a tournament, append-only.
--
-- The receipt also lives in the fixture's history inside `state`; this copy is the one the
-- database can hold to uniqueness. One receipt per match, and one per id within a
-- tournament, so a settlement delivered twice cannot become two results even if the
-- engine's own check were bypassed. No foreign key to `matches`, deliberately: this is the
-- tournament's record of what was decided, and it should not vanish with the match.
create table tournament_receipts (
  tournament_id uuid not null references tournaments (id) on delete cascade,
  receipt_id    text not null,
  fixture_id    text not null,
  attempt       integer not null,
  match_id      uuid not null,
  outcome       jsonb not null,
  recorded_at   timestamptz not null default now(),

  primary key (tournament_id, receipt_id),
  constraint tournament_receipts_one_per_match unique (match_id),
  constraint tournament_receipts_attempt check (attempt >= 1),
  constraint tournament_receipts_kind check (outcome->>'kind' in ('win', 'draw', 'void', 'forfeit'))
);

create or replace function tournament_receipts_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'tournament receipts are append-only';
end;
$$;

create trigger tournament_receipts_no_update
  before update on tournament_receipts
  for each row execute function tournament_receipts_append_only();

-- What happened, one row per revision. The primary key is the second guard on the
-- compare-and-swap: two writers that both believed they had revision n+1 cannot both
-- log it.
create table tournament_log (
  tournament_id uuid not null references tournaments (id) on delete cascade,
  revision      bigint not null,
  kind          text not null,
  -- Null when the server did it on its own, which is what folding in a settled match is.
  actor_id      uuid references players (id) on delete set null,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),

  primary key (tournament_id, revision),
  constraint tournament_log_kind check (kind in (
    'created', 'joined', 'left', 'checked-in', 'checked-out', 'removed',
    'started', 'cancelled', 'result', 'replay'
  ))
);

-- ---------------------------------------------------------------------------
-- row level security: none of this is the client's
-- ---------------------------------------------------------------------------

alter table tournaments         enable row level security;
alter table tournament_members  enable row level security;
alter table tournament_legs     enable row level security;
alter table tournament_receipts enable row level security;
alter table tournament_log      enable row level security;

revoke all on tournaments, tournament_members, tournament_legs, tournament_receipts, tournament_log
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- tournament_commit
-- ---------------------------------------------------------------------------
--
-- Write the engine's next state if nobody else has written since, and everything that
-- has to change with it, in one transaction.
--
-- The UPDATE is the compare-and-swap: it matches only while `revision` is still the one
-- the caller read. A second writer blocks on the row lock, and when the first commits
-- Postgres re-checks the WHERE against the new row, finds the revision moved, and updates
-- nothing - so it gets null back and reloads, rather than overwriting. Everything below it
-- (members, receipt, the leg it came from, the log line) either all lands or none of it
-- does.
--
-- Returns the new revision, or null when the caller was stale.
create or replace function tournament_commit(
  p_id        uuid,
  p_expected  bigint,
  p_state     jsonb,
  p_members   jsonb,
  p_receipt   jsonb,
  p_ingest    uuid,
  p_kind      text,
  p_actor     uuid,
  p_detail    jsonb
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next bigint := (p_state->>'revision')::bigint;
begin
  if v_next is null or v_next <= p_expected then
    raise exception 'the new state must carry a later revision than %', p_expected;
  end if;

  update tournaments
     set state = p_state,
         revision = v_next,
         phase = (p_state->>'phase')::tournament_phase,
         updated_at = now()
   where id = p_id and revision = p_expected;

  if not found then
    return null;
  end if;

  if p_members is not null then
    delete from tournament_members where tournament_id = p_id;
    insert into tournament_members (tournament_id, player_id, seed, checked_in)
    select p_id, m.player_id, m.seed, m.checked_in
      from jsonb_to_recordset(p_members) as m(player_id uuid, seed smallint, checked_in boolean);
  end if;

  if p_receipt is not null then
    insert into tournament_receipts (tournament_id, receipt_id, fixture_id, attempt, match_id, outcome)
    values (
      p_id,
      p_receipt->>'id',
      p_receipt->>'fixtureId',
      (p_receipt->>'attempt')::integer,
      (p_receipt->>'matchId')::uuid,
      p_receipt->'outcome'
    );
  end if;

  if p_ingest is not null then
    update tournament_legs set ingested_at = now()
     where match_id = p_ingest and tournament_id = p_id and ingested_at is null;
  end if;

  insert into tournament_log (tournament_id, revision, kind, actor_id, detail)
  values (p_id, v_next, p_kind, p_actor, coalesce(p_detail, '{}'::jsonb));

  return v_next;
end;
$$;

comment on function tournament_commit is
  'Compare-and-swap write of a tournament aggregate, with its members, receipt, leg and '
  'log line in the same transaction. Returns the new revision, or null if stale.';

-- ---------------------------------------------------------------------------
-- tournament_open_leg
-- ---------------------------------------------------------------------------
--
-- Create the match a player is about to play for a fixture, or hand back the one they
-- already have.
--
-- Everything that decides whether the player may is checked here, with the tournament row
-- locked, rather than in the Edge Function that called it. The function decides which
-- scenarios a first leg gets, because the season pool and the seeded selection live in
-- TypeScript; everything else - that the fixture is still pending at this attempt, that
-- the caller is in it, that they have no other live match, that the first leg really
-- finished and scored before a second is built from it - is read inside the transaction
-- that writes.
--
-- Lock order is the tournament, then the player. tournament_commit takes only the
-- tournament, so the two cannot deadlock each other. The one-match check is as strong as
-- the paths it shares a rule with and no stronger: find-match and send-duel check the same
-- thing without taking this lock, a window those two already have with each other.
--
-- The second leg copies its scenarios, category and window off the first leg's match, and
-- the first player's side off their own row, in SQL. Nothing about the opponent's result
-- passes through the caller at all.
--
-- Raises TN404 / TN403 / TN409 with a message fit to show the player.
create or replace function tournament_open_leg(
  p_tournament  uuid,
  p_fixture     text,
  p_attempt     integer,
  p_player      uuid,
  p_seed        text,
  p_scenarios   bigint[],
  p_category    text,
  p_benchmark   text,
  p_difficulty  text,
  p_window      integer,
  p_ttl_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state        jsonb;
  v_phase        tournament_phase;
  v_fixture      jsonb;
  v_opponent     uuid;
  v_existing     record;
  v_first        record;
  v_first_status match_status;
  v_first_score  numeric;
  v_rating       numeric;
  v_rd           numeric;
  v_match        uuid;
  v_leg          smallint;
begin
  select state, phase into v_state, v_phase
    from tournaments where id = p_tournament
     for update;

  if not found then
    raise exception using errcode = 'TN404', message = 'That tournament does not exist.';
  end if;
  if v_phase not in ('groups', 'playoffs') then
    raise exception using errcode = 'TN409', message = 'That tournament is not being played right now.';
  end if;

  select value into v_fixture
    from jsonb_array_elements(v_state->'fixtures')
   where value->>'id' = p_fixture
   limit 1;

  if v_fixture is null then
    raise exception using errcode = 'TN404', message = 'That fixture is not part of this tournament.';
  end if;
  if v_fixture->>'status' <> 'pending' or (v_fixture->>'attempt')::integer <> p_attempt then
    raise exception using errcode = 'TN409', message = 'That fixture has moved on since you looked. Refresh and try again.';
  end if;

  if v_fixture->>'playerA' = p_player::text then
    v_opponent := (v_fixture->>'playerB')::uuid;
  elsif v_fixture->>'playerB' = p_player::text then
    v_opponent := (v_fixture->>'playerA')::uuid;
  else
    raise exception using errcode = 'TN403', message = 'You are not playing in that fixture.';
  end if;

  -- Pressing Play twice, or retrying after a dropped response, returns the same match.
  select l.match_id, l.leg into v_existing
    from tournament_legs l
   where l.tournament_id = p_tournament and l.fixture_id = p_fixture
     and l.attempt = p_attempt and l.player_id = p_player;

  if found then
    return jsonb_build_object('matchId', v_existing.match_id, 'leg', v_existing.leg, 'created', false);
  end if;

  -- One match at a time, the rule the queue and duels hold to.
  perform 1 from players where id = p_player for update;
  if exists (
    select 1
      from match_sides ms
      join matches m on m.id = ms.match_id
     where ms.player_id = p_player
       and m.status in ('open', 'awaiting_runs')
       and (m.expires_at is null or m.expires_at > now())
  ) then
    raise exception using errcode = 'TN409', message = 'Finish or abandon your current match first.';
  end if;

  select r.rating, r.rd into v_rating, v_rd from ratings r where r.player_id = p_player;

  select l.match_id, l.player_id into v_first
    from tournament_legs l
   where l.tournament_id = p_tournament and l.fixture_id = p_fixture
     and l.attempt = p_attempt and l.leg = 1;

  if not found then
    insert into matches (mode, category, benchmark_name, difficulty, window_index, seed,
                         scenario_ids, status, expires_at, rated)
    values ('async', p_category, p_benchmark, p_difficulty, p_window, p_seed,
            p_scenarios, 'awaiting_runs', now() + make_interval(secs => p_ttl_seconds), false)
    returning id into v_match;

    insert into match_sides (match_id, player_id, rating_before, rd_before)
    values (v_match, p_player, coalesce(v_rating, 1500), coalesce(v_rd, 350));

    v_leg := 1;
  else
    if v_first.player_id <> v_opponent then
      raise exception using errcode = 'TN409', message = 'That fixture''s first leg belongs to somebody else.';
    end if;

    select m.status into v_first_status from matches m where m.id = v_first.match_id;
    select ms.match_score into v_first_score
      from match_sides ms where ms.match_id = v_first.match_id and ms.player_id = v_first.player_id;

    if v_first_status in ('open', 'awaiting_runs') then
      raise exception using errcode = 'TN409', message = 'Your opponent is playing their three now. You play the same three after them.';
    end if;
    if v_first_status <> 'settled' or v_first_score is null then
      raise exception using errcode = 'TN409', message = 'That first leg did not count, so the fixture is being replayed. Refresh and try again.';
    end if;

    insert into matches (mode, category, benchmark_name, difficulty, window_index, seed,
                         scenario_ids, status, expires_at, rated)
    select 'async', m.category, m.benchmark_name, m.difficulty, m.window_index, p_seed,
           m.scenario_ids, 'awaiting_runs', now() + make_interval(secs => p_ttl_seconds), false
      from matches m where m.id = v_first.match_id
    returning id into v_match;

    insert into match_sides (match_id, player_id, rating_before, rd_before)
    values (v_match, p_player, coalesce(v_rating, 1500), coalesce(v_rd, 350));

    insert into match_sides (match_id, player_id, deltas, match_score, provisional,
                             rating_before, rd_before, submitted_at)
    select v_match, ms.player_id, ms.deltas, ms.match_score, ms.provisional,
           ms.rating_before, ms.rd_before, ms.submitted_at
      from match_sides ms
     where ms.match_id = v_first.match_id and ms.player_id = v_first.player_id;

    v_leg := 2;
  end if;

  insert into tournament_legs (tournament_id, fixture_id, attempt, leg, player_id, match_id)
  values (p_tournament, p_fixture, p_attempt, v_leg, p_player, v_match);

  return jsonb_build_object('matchId', v_match, 'leg', v_leg, 'created', true);
end;
$$;

comment on function tournament_open_leg is
  'Creates (or returns) the unrated match for one leg of a tournament fixture, with the '
  'tournament locked and every eligibility rule checked in the same transaction.';

-- Functions are executable by PUBLIC unless that is taken away, and anon and
-- authenticated are both members of PUBLIC - revoking from the two roles alone would
-- leave them the grant they inherit. Only the service role calls these.
revoke all on function tournament_commit(uuid, bigint, jsonb, jsonb, jsonb, uuid, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function tournament_open_leg(uuid, text, integer, uuid, text, bigint[], text, text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function tournament_receipts_append_only() from public, anon, authenticated;

grant execute on function tournament_commit(uuid, bigint, jsonb, jsonb, jsonb, uuid, text, uuid, jsonb)
  to service_role;
grant execute on function tournament_open_leg(uuid, text, integer, uuid, text, bigint[], text, text, text, integer, integer)
  to service_role;
