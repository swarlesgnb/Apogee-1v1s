-- ---------------------------------------------------------------------------
-- Crowns (asynchronous king of the hill) and live races
--
-- Neither is a new kind of match. A Crown challenge is the contested match answer-duel
-- builds, with the holder's stored side copied in; a claim on a vacant Crown is a one-sided
-- match like a seeding match; a race is two one-sided matches created together. All of
-- them are unrated (`matches.rated = false`, the path tournaments use), so settle-match and
-- forfeitMatch move no rating and find-match never draws them into the pool. Submission,
-- verification, settlement and the match clock are the paths that already exist.
--
-- What this adds is the bookkeeping around those matches, and the decision. The decision is
-- taken here, in SQL, by an AFTER UPDATE trigger on `matches` that runs inside the same
-- transaction as commit_match_result (migration 20261002000022). The result of a challenge
-- and what it does to the Crown therefore commit together or not at all, and the trigger
-- takes a row lock on the Crown before it reads anything, so two challenges that settle at
-- the same instant are decided one after the other. The rules are written out once in
-- src/core/crowns/crowns.ts; tools/validateCrownsDb.ts holds this SQL to them.
--
-- NOTHING HERE IS CLIENT-WRITABLE. One table is client-readable: a player's own notices.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

-- One holder's time with one Crown, from the run set that took it to whatever ended it.
create table crown_reigns (
  id             uuid primary key default gen_random_uuid(),
  category       text not null,
  window_index   integer not null,
  cycle          integer not null,
  holder_id      uuid not null references players (id) on delete cascade,
  -- The match the holder's run set was played in. Their side of it is what every challenger
  -- of this reign plays against, copied into each challenge match.
  match_id       uuid not null references matches (id) on delete cascade,
  match_score    numeric not null,
  provisional    boolean not null default false,
  lowest_tier    verification_tier not null,
  started_at     timestamptz not null default now(),
  -- Distinct challengers beaten, and every qualifying challenge survived.
  defences       integer not null default 0,
  challenges     integer not null default 0,
  ended_at       timestamptz,
  end_reason     text,
  ended_by       uuid references players (id) on delete set null,
  ended_match_id uuid,

  constraint crown_reigns_end check ((ended_at is null) = (end_reason is null)),
  constraint crown_reigns_reason check (end_reason is null or end_reason in ('dethroned', 'lapsed', 'reset')),
  constraint crown_reigns_counts check (defences >= 0 and challenges >= defences),
  constraint crown_reigns_tier check (lowest_tier in ('verified', 'consistent'))
);

create index crown_reigns_crown_idx on crown_reigns (category, window_index, started_at desc);

-- One row per Crown that has ever been claimed or drawn. A Crown with no row is vacant on
-- cycle 0 with nothing drawn yet; the board lists it from the season, not from here.
create table crowns (
  category       text not null,
  window_index   integer not null,
  -- Bumps each time the Crown falls vacant. One cycle, one set of three scenarios.
  cycle          integer not null default 0,
  -- Null until the first claim of a cycle draws them, so every claimant plays the same three.
  scenario_ids   bigint[],
  seed           text,
  benchmark_name text,
  difficulty     text,
  reign_id       uuid references crown_reigns (id) on delete set null,
  updated_at     timestamptz not null default now(),

  primary key (category, window_index),
  constraint crowns_three check (scenario_ids is null or cardinality(scenario_ids) = 3),
  constraint crowns_window check (window_index >= 0),
  constraint crowns_category check (char_length(category) between 1 and 40)
);

-- A reign is the live reign of at most one Crown.
create unique index crowns_one_reign on crowns (reign_id) where reign_id is not null;

-- Which match is a challenge of which Crown, and what it came to.
create table crown_challenges (
  match_id         uuid primary key references matches (id) on delete cascade,
  category         text not null,
  window_index     integer not null,
  cycle            integer not null,
  challenger_id    uuid not null references players (id) on delete cascade,
  -- The reign it was opened against; null for a claim on a vacant Crown.
  reign_id         uuid references crown_reigns (id) on delete set null,
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  outcome          text,
  -- The reign it was measured against, which is whoever held the Crown when it settled.
  judged_reign_id  uuid references crown_reigns (id) on delete set null,
  challenger_score numeric,
  holder_score     numeric,
  reason           text,

  constraint crown_challenges_outcome check (outcome is null or outcome in ('took', 'defended', 'void', 'forfeit', 'stale')),
  constraint crown_challenges_decided check ((decided_at is null) = (outcome is null))
);

-- The cooldown: this player's challenges on this Crown, newest first.
create index crown_challenges_cooldown_idx on crown_challenges (challenger_id, category, window_index, created_at desc);
-- Outstanding work, and the "is somebody playing it right now" question a lapse asks.
create index crown_challenges_open_idx on crown_challenges (category, window_index) where decided_at is null;
-- "Has this challenger already been counted as a defence of this reign?"
create index crown_challenges_defended_idx on crown_challenges (judged_reign_id, challenger_id) where outcome = 'defended';

-- What a player is told the next time they open the client.
create table crown_notices (
  id               uuid primary key default gen_random_uuid(),
  player_id        uuid not null references players (id) on delete cascade,
  kind             text not null,
  category         text not null,
  window_index     integer not null,
  reign_id         uuid references crown_reigns (id) on delete cascade,
  other_id         uuid references players (id) on delete set null,
  -- Kept with the notice: `players` is owner-only (20260817000004), so a notice the owner
  -- reads directly has to carry the name it is about.
  other_name       text,
  defences         integer not null default 0,
  reign_seconds    integer not null default 0,
  challenger_score numeric,
  holder_score     numeric,
  created_at       timestamptz not null default now(),
  seen_at          timestamptz,

  constraint crown_notices_kind check (kind in ('dethroned', 'defended', 'lapsed', 'reset'))
);

create index crown_notices_inbox_idx on crown_notices (player_id, created_at desc);

-- A race: two players, the same three scenarios, played at the same time.
create table races (
  id               uuid primary key default gen_random_uuid(),
  inviter_id       uuid not null references players (id) on delete cascade,
  invitee_id       uuid not null references players (id) on delete cascade,
  category         text not null,
  window_index     integer not null,
  benchmark_name   text not null,
  difficulty       text not null,
  seed             text not null,
  -- Drawn when the invitation is sent, so both players see the three before agreeing.
  scenario_ids     bigint[] not null,
  status           text not null default 'invited',
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  started_at       timestamptz,
  finished_at      timestamptz,
  inviter_match_id uuid references matches (id) on delete set null,
  invitee_match_id uuid references matches (id) on delete set null,
  result           text,
  by_forfeit       boolean not null default false,
  inviter_score    numeric,
  invitee_score    numeric,

  constraint races_not_self check (inviter_id <> invitee_id),
  constraint races_three check (cardinality(scenario_ids) = 3),
  constraint races_status check (status in ('invited', 'live', 'finished', 'declined', 'cancelled', 'expired')),
  constraint races_result check (result is null or result in ('inviter', 'invitee', 'draw', 'void')),
  constraint races_finished check ((status = 'finished') = (result is not null))
);

create unique index races_inviter_match on races (inviter_match_id) where inviter_match_id is not null;
create unique index races_invitee_match on races (invitee_match_id) where invitee_match_id is not null;
-- One invitation out at a time.
create unique index races_one_outgoing on races (inviter_id) where status = 'invited';
create index races_inbox_idx on races (invitee_id, created_at desc);
create index races_outbox_idx on races (inviter_id, created_at desc);

-- ---------------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------------

alter table crown_reigns     enable row level security;
alter table crowns           enable row level security;
alter table crown_challenges enable row level security;
alter table crown_notices    enable row level security;
alter table races            enable row level security;

-- Built into views by list-crowns and race-status under the service role, the way the
-- tournament tables are. No policies, and the grants revoked as well.
revoke all on crown_reigns, crowns, crown_challenges, races from anon, authenticated;

-- A notice is its owner's, and only its owner's. Readable directly so a client can show
-- one without a round trip; never writable, because a notice is the record that something
-- happened and only the decision that made it happen writes one.
revoke all on crown_notices from anon, authenticated;
grant select on crown_notices to authenticated;
create policy crown_notices_read_own on crown_notices
  for select using (auth.uid() = player_id);

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

-- Whether a player is playing a match right now: an open, unexpired match where their side
-- is their own and not a copy of a stored run set in somebody else's match (a copy carries
-- the submitted_at of the set it came from, which predates the match it sits in).
create function arena_has_live_match(p_player uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from match_sides ms join matches m on m.id = ms.match_id
     where ms.player_id = p_player
       and m.status in ('open', 'awaiting_runs')
       and (m.expires_at is null or m.expires_at > now())
       and (ms.submitted_at is null or ms.submitted_at >= m.created_at)
  );
$$;

-- The verification tiers of the runs settlement counted for one side, one per run.
create function arena_side_tiers(p_match uuid, p_player uuid) returns verification_tier[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(r.verification_tier), '{}')
    from match_sides ms
    join runs r on r.id = any(ms.run_ids) and r.match_id = ms.match_id and r.player_id = ms.player_id
   where ms.match_id = p_match and ms.player_id = p_player;
$$;

-- ---------------------------------------------------------------------------
-- crown_vacate / crown_lapse_due / crown_lapse_all / crown_reset_off_pool
-- ---------------------------------------------------------------------------

-- End the live reign, if there is one, and empty the Crown for a new cycle. Takes the
-- Crown's lock itself; callers that already hold it simply hold it again.
create function crown_vacate(p_category text, p_window integer, p_kind text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare c crowns%rowtype; r crown_reigns%rowtype;
begin
  if p_kind not in ('lapsed', 'reset') then raise exception 'unknown vacate kind %', p_kind; end if;
  select * into c from crowns where category = p_category and window_index = p_window for update;
  if not found then return false; end if;
  if c.reign_id is not null then
    select * into r from crown_reigns where id = c.reign_id;
    update crown_reigns set ended_at = now(), end_reason = p_kind where id = r.id;
    insert into crown_notices (player_id, kind, category, window_index, reign_id, defences, reign_seconds, holder_score)
    values (r.holder_id, p_kind, p_category, p_window, r.id, r.defences,
            greatest(0, floor(extract(epoch from now() - r.started_at)))::integer, r.match_score);
  end if;
  update crowns
     set reign_id = null, cycle = cycle + 1, scenario_ids = null, seed = null,
         benchmark_name = null, difficulty = null, updated_at = now()
   where category = p_category and window_index = p_window;
  return true;
end;
$$;

-- Lapse a reign that has reached the cap, unless somebody is playing a challenge of it.
create function crown_lapse_due(p_category text, p_window integer, p_cap_seconds integer) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare c crowns%rowtype; r crown_reigns%rowtype;
begin
  select * into c from crowns where category = p_category and window_index = p_window for update;
  if not found or c.reign_id is null then return false; end if;
  select * into r from crown_reigns where id = c.reign_id;
  if r.started_at > now() - make_interval(secs => p_cap_seconds) then return false; end if;
  if exists (
    select 1 from crown_challenges cc join matches m on m.id = cc.match_id
     where cc.category = p_category and cc.window_index = p_window and cc.decided_at is null
       and m.status in ('open', 'awaiting_runs') and (m.expires_at is null or m.expires_at > now())
  ) then return false; end if;
  return crown_vacate(p_category, p_window, 'lapsed');
end;
$$;

-- Every reign past the cap. Returns how many lapsed.
create function crown_lapse_all(p_cap_seconds integer) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; n integer := 0;
begin
  for c in
    select cr.category, cr.window_index
      from crowns cr join crown_reigns rg on rg.id = cr.reign_id
     where rg.started_at <= now() - make_interval(secs => p_cap_seconds)
     order by cr.category, cr.window_index
  loop
    if crown_lapse_due(c.category, c.window_index, p_cap_seconds) then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

-- The season no longer has this Crown's scenarios, so nobody can play them: reset it. The
-- caller says which cycle it looked at, so a Crown that already moved on is left alone.
create function crown_reset_off_pool(p_category text, p_window integer, p_cycle integer) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare c crowns%rowtype;
begin
  select * into c from crowns where category = p_category and window_index = p_window for update;
  if not found or c.cycle <> p_cycle or c.scenario_ids is null then return false; end if;
  return crown_vacate(p_category, p_window, 'reset');
end;
$$;

-- ---------------------------------------------------------------------------
-- crown_open_challenge
-- ---------------------------------------------------------------------------
--
-- Create the match a player is about to play for a Crown, or hand back the one they have.
--
-- The Edge Function draws a candidate three (the season pool and the seeded selection
-- live in TypeScript); this uses them only when the Crown has none for its cycle yet.
-- Everything that decides whether the player may is checked here with the Crown locked:
-- that a due reign has lapsed first, that they do not hold it, the cooldown, and that they
-- have no other live match. Lock order is the Crown, then the player, the order
-- tournament_open_leg uses for its tournament and player.
--
-- Raises CR400 / CR409 / CR429 with a message fit to show the player.
create function crown_open_challenge(
  p_category text, p_window integer, p_player uuid, p_seed text, p_scenarios bigint[],
  p_benchmark text, p_difficulty text, p_ttl_seconds integer, p_cooldown_seconds integer,
  p_reign_cap_seconds integer
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c crowns%rowtype; r crown_reigns%rowtype; v_existing uuid; v_last timestamptz;
  v_rating numeric; v_rd numeric; v_match uuid;
begin
  if p_category is null or char_length(p_category) not between 1 and 40 or p_window is null or p_window < 0 then
    raise exception using errcode = 'CR400', message = 'That is not a Crown.';
  end if;

  insert into crowns (category, window_index) values (p_category, p_window) on conflict do nothing;
  select * into c from crowns where category = p_category and window_index = p_window for update;

  -- Pressing Challenge twice, or retrying after a dropped response, returns the same match.
  select cc.match_id into v_existing
    from crown_challenges cc join matches m on m.id = cc.match_id
   where cc.challenger_id = p_player and cc.category = p_category and cc.window_index = p_window
     and cc.decided_at is null and m.status in ('open', 'awaiting_runs')
     and (m.expires_at is null or m.expires_at > now())
   limit 1;
  if found then
    return jsonb_build_object('matchId', v_existing, 'created', false,
      'claim', not exists (select 1 from match_sides where match_id = v_existing and player_id <> p_player),
      'cycle', c.cycle);
  end if;

  if crown_lapse_due(p_category, p_window, p_reign_cap_seconds) then
    select * into c from crowns where category = p_category and window_index = p_window;
  end if;

  if c.reign_id is not null then
    select * into r from crown_reigns where id = c.reign_id;
    if r.holder_id = p_player then
      raise exception using errcode = 'CR409',
        message = 'You hold this Crown. Other players defend it for you by challenging it.';
    end if;
  end if;

  select max(created_at) into v_last from crown_challenges
   where challenger_id = p_player and category = p_category and window_index = p_window;
  if v_last is not null and v_last > now() - make_interval(secs => p_cooldown_seconds) then
    raise exception using errcode = 'CR429',
      message = 'One challenge per Crown every 20 hours. This one opens to you again at '
        || to_char((v_last + make_interval(secs => p_cooldown_seconds)) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC.';
  end if;

  perform 1 from players where id = p_player for update;
  if arena_has_live_match(p_player) then
    raise exception using errcode = 'CR409', message = 'Finish or abandon your current match first.';
  end if;

  if c.scenario_ids is null then
    if p_scenarios is null or cardinality(p_scenarios) <> 3 then
      raise exception using errcode = 'CR409', message = 'This band has no three scenarios for that category.';
    end if;
    update crowns set scenario_ids = p_scenarios, seed = p_seed, benchmark_name = p_benchmark,
           difficulty = p_difficulty, updated_at = now()
     where category = p_category and window_index = p_window
     returning * into c;
  end if;

  select rating, rd into v_rating, v_rd from ratings where player_id = p_player;

  insert into matches (mode, category, benchmark_name, difficulty, window_index, seed,
                       scenario_ids, status, expires_at, rated)
  values ('async', p_category, coalesce(c.benchmark_name, p_benchmark), coalesce(c.difficulty, p_difficulty),
          p_window, p_seed, c.scenario_ids, 'awaiting_runs',
          now() + make_interval(secs => p_ttl_seconds), false)
  returning id into v_match;

  insert into match_sides (match_id, player_id, rating_before, rd_before)
  values (v_match, p_player, coalesce(v_rating, 1500), coalesce(v_rd, 350));

  if r.id is not null then
    insert into match_sides (match_id, player_id, deltas, match_score, provisional,
                             rating_before, rd_before, submitted_at)
    select v_match, ms.player_id, ms.deltas, ms.match_score, ms.provisional,
           ms.rating_before, ms.rd_before, ms.submitted_at
      from match_sides ms
     where ms.match_id = r.match_id and ms.player_id = r.holder_id and ms.match_score is not null;
    if not found then
      raise exception using errcode = 'CR500', message = 'The holder''s run set is missing.';
    end if;
  end if;

  insert into crown_challenges (match_id, category, window_index, cycle, challenger_id, reign_id)
  values (v_match, p_category, p_window, c.cycle, p_player, r.id);

  return jsonb_build_object('matchId', v_match, 'created', true, 'claim', r.id is null,
    'reignId', r.id, 'cycle', c.cycle);
end;
$$;

-- ---------------------------------------------------------------------------
-- crown_resolve
-- ---------------------------------------------------------------------------
--
-- Decide a challenge whose match has ended. Run by the trigger below inside the
-- transaction that ended the match, and safe to run again: a decided challenge returns
-- its stored outcome and changes nothing.
--
-- The checks run in the order `qualifies` and `judge` state them in crowns.ts.
create function crown_resolve(p_match_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare ch crown_challenges%rowtype; c crowns%rowtype; m matches%rowtype; side match_sides%rowtype;
  cur crown_reigns%rowtype; tiers verification_tier[]; v_outcome text; v_reason text;
  v_new uuid; v_repeat boolean; v_judged uuid; v_holder_score numeric;
begin
  select * into ch from crown_challenges where match_id = p_match_id;
  if not found then return null; end if;

  -- The Crown first, then the challenge: the order crown_open_challenge takes them in.
  select * into c from crowns where category = ch.category and window_index = ch.window_index for update;
  select * into ch from crown_challenges where match_id = p_match_id for update;
  if ch.decided_at is not null then
    return jsonb_build_object('outcome', ch.outcome, 'decided', false);
  end if;

  select * into m from matches where id = p_match_id;
  if m.status not in ('settled', 'void') then
    return jsonb_build_object('outcome', null, 'decided', false);
  end if;

  select * into side from match_sides where match_id = p_match_id and player_id = ch.challenger_id;
  tiers := arena_side_tiers(p_match_id, ch.challenger_id);

  if m.status = 'settled' and side.match_score is null and side.result = 'loss' then
    v_outcome := 'forfeit'; v_reason := 'the challenge was abandoned or ran out of time';
  elsif m.status <> 'settled' or side.match_score is null then
    v_outcome := 'void'; v_reason := 'the match did not count';
  elsif cardinality(side.run_ids) <> cardinality(m.scenario_ids) or cardinality(tiers) <> cardinality(m.scenario_ids) then
    v_outcome := 'void'; v_reason := 'not every scenario has a run';
  elsif 'rejected' = any(tiers) then
    v_outcome := 'void'; v_reason := 'a run failed verification';
  elsif exists (select 1 from unnest(tiers) t where t not in ('verified', 'consistent')) then
    v_outcome := 'void'; v_reason := 'a run is held for review, and a Crown needs Verified or Consistent runs';
  elsif ch.cycle <> c.cycle then
    v_outcome := 'stale'; v_reason := 'the Crown moved on to new scenarios while this was played';
  else
    if c.reign_id is not null then
      select * into cur from crown_reigns where id = c.reign_id;
    end if;
    if cur.id is null then
      v_outcome := 'took'; v_reason := 'the Crown was vacant';
    elsif cur.holder_id = ch.challenger_id then
      v_outcome := 'stale'; v_reason := 'a holder cannot challenge their own Crown';
    elsif side.match_score - cur.match_score >= 0.0005 then
      v_outcome := 'took'; v_reason := 'beat the holder''s match score';
    elsif cur.match_score - side.match_score >= 0.0005 then
      v_outcome := 'defended'; v_reason := 'did not beat the holder''s match score';
    else
      v_outcome := 'defended'; v_reason := 'drew with the holder, and a draw is a defence';
    end if;
  end if;

  v_judged := cur.id;
  v_holder_score := cur.match_score;

  if v_outcome = 'took' then
    if cur.id is not null then
      update crown_reigns
         set ended_at = now(), end_reason = 'dethroned', ended_by = ch.challenger_id, ended_match_id = p_match_id
       where id = cur.id;
      insert into crown_notices (player_id, kind, category, window_index, reign_id, other_id, other_name,
                                 defences, reign_seconds, challenger_score, holder_score)
      values (cur.holder_id, 'dethroned', ch.category, ch.window_index, cur.id, ch.challenger_id,
              (select display_name from players where id = ch.challenger_id), cur.defences,
              greatest(0, floor(extract(epoch from now() - cur.started_at)))::integer,
              side.match_score, cur.match_score);
    end if;
    insert into crown_reigns (category, window_index, cycle, holder_id, match_id, match_score,
                              provisional, lowest_tier, started_at)
    values (ch.category, ch.window_index, c.cycle, ch.challenger_id, p_match_id, side.match_score,
            side.provisional, case when 'consistent' = any(tiers) then 'consistent' else 'verified' end::verification_tier,
            now())
    returning id into v_new;
    update crowns set reign_id = v_new, updated_at = now()
     where category = ch.category and window_index = ch.window_index;
  elsif v_outcome = 'defended' then
    v_repeat := exists (
      select 1 from crown_challenges
       where judged_reign_id = cur.id and challenger_id = ch.challenger_id and outcome = 'defended'
    );
    update crown_reigns
       set defences = defences + case when v_repeat then 0 else 1 end, challenges = challenges + 1
     where id = cur.id
    returning * into cur;
    insert into crown_notices (player_id, kind, category, window_index, reign_id, other_id, other_name,
                               defences, reign_seconds, challenger_score, holder_score)
    values (cur.holder_id, 'defended', ch.category, ch.window_index, cur.id, ch.challenger_id,
            (select display_name from players where id = ch.challenger_id), cur.defences,
            greatest(0, floor(extract(epoch from now() - cur.started_at)))::integer,
            side.match_score, cur.match_score);
  end if;

  update crown_challenges
     set decided_at = now(), outcome = v_outcome, reason = v_reason, judged_reign_id = v_judged,
         challenger_score = side.match_score, holder_score = v_holder_score
   where match_id = p_match_id;

  return jsonb_build_object('outcome', v_outcome, 'decided', true, 'reason', v_reason,
    'reignId', coalesce(v_new, v_judged));
end;
$$;

-- ---------------------------------------------------------------------------
-- races: race_start / race_resolve
-- ---------------------------------------------------------------------------

-- Start an accepted race: both matches, created together, with the same three and the same
-- start. Both players are locked in id order, and both must be free, inside the transaction
-- that creates the matches. Raises RC403 / RC404 / RC409 with a message fit to show.
create function race_start(p_race uuid, p_player uuid, p_ttl_seconds integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r races%rowtype; v_a uuid; v_b uuid; ra ratings%rowtype; rb ratings%rowtype;
begin
  select * into r from races where id = p_race for update;
  if not found then raise exception using errcode = 'RC404', message = 'That race does not exist.'; end if;
  if r.invitee_id <> p_player then
    raise exception using errcode = 'RC403', message = 'Only the player who was invited can accept a race.';
  end if;
  if r.status = 'live' then
    return jsonb_build_object('inviterMatchId', r.inviter_match_id, 'inviteeMatchId', r.invitee_match_id, 'created', false);
  end if;
  if r.status <> 'invited' or r.expires_at <= now() then
    raise exception using errcode = 'RC409', message = 'That invitation is no longer open.';
  end if;

  perform 1 from players where id = least(r.inviter_id, r.invitee_id) for update;
  perform 1 from players where id = greatest(r.inviter_id, r.invitee_id) for update;
  if arena_has_live_match(r.invitee_id) then
    raise exception using errcode = 'RC409', message = 'Finish or abandon your current match first.';
  end if;
  if arena_has_live_match(r.inviter_id) then
    raise exception using errcode = 'RC409', message = 'They are in another match right now. Try again when it ends.';
  end if;

  select * into ra from ratings where player_id = r.inviter_id;
  select * into rb from ratings where player_id = r.invitee_id;

  insert into matches (mode, category, benchmark_name, difficulty, window_index, seed, scenario_ids, status, expires_at, rated)
  values ('live', r.category, r.benchmark_name, r.difficulty, r.window_index, r.seed || ':inviter', r.scenario_ids,
          'awaiting_runs', now() + make_interval(secs => p_ttl_seconds), false)
  returning id into v_a;
  insert into match_sides (match_id, player_id, rating_before, rd_before)
  values (v_a, r.inviter_id, coalesce(ra.rating, 1500), coalesce(ra.rd, 350));

  insert into matches (mode, category, benchmark_name, difficulty, window_index, seed, scenario_ids, status, expires_at, rated)
  values ('live', r.category, r.benchmark_name, r.difficulty, r.window_index, r.seed || ':invitee', r.scenario_ids,
          'awaiting_runs', now() + make_interval(secs => p_ttl_seconds), false)
  returning id into v_b;
  insert into match_sides (match_id, player_id, rating_before, rd_before)
  values (v_b, r.invitee_id, coalesce(rb.rating, 1500), coalesce(rb.rd, 350));

  update races set status = 'live', started_at = now(), inviter_match_id = v_a, invitee_match_id = v_b
   where id = r.id;
  return jsonb_build_object('inviterMatchId', v_a, 'inviteeMatchId', v_b, 'created', true);
end;
$$;

-- A leg finished: settled, scored, a counted run on every scenario.
create function race_leg_finished(p_match uuid, p_player uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select m.status = 'settled' and ms.match_score is not null
       and cardinality(ms.run_ids) = cardinality(m.scenario_ids)
       and cardinality(arena_side_tiers(p_match, p_player)) = cardinality(m.scenario_ids)
       and not exists (select 1 from unnest(arena_side_tiers(p_match, p_player)) t where t in ('rejected', 'unverified'))
      from matches m join match_sides ms on ms.match_id = m.id and ms.player_id = p_player
     where m.id = p_match
  ), false);
$$;

-- Decide a race once both legs have ended. The race row is locked first, so when the two
-- legs end at the same moment exactly one of the two transactions sees both ended.
create function race_resolve(p_match uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r races%rowtype; sa text; sb text; a_ok boolean; b_ok boolean; a_score numeric; b_score numeric;
  v_result text; v_forfeit boolean := false;
begin
  select * into r from races where inviter_match_id = p_match or invitee_match_id = p_match for update;
  if not found then return null; end if;
  if r.status <> 'live' then return jsonb_build_object('result', r.result, 'decided', false); end if;
  select status into sa from matches where id = r.inviter_match_id;
  select status into sb from matches where id = r.invitee_match_id;
  if sa not in ('settled', 'void') or sb not in ('settled', 'void') then
    return jsonb_build_object('result', null, 'decided', false);
  end if;

  a_ok := race_leg_finished(r.inviter_match_id, r.inviter_id);
  b_ok := race_leg_finished(r.invitee_match_id, r.invitee_id);
  select match_score into a_score from match_sides where match_id = r.inviter_match_id and player_id = r.inviter_id;
  select match_score into b_score from match_sides where match_id = r.invitee_match_id and player_id = r.invitee_id;

  if not a_ok and not b_ok then v_result := 'void';
  elsif a_ok and not b_ok then v_result := 'inviter'; v_forfeit := true;
  elsif b_ok and not a_ok then v_result := 'invitee'; v_forfeit := true;
  elsif abs(a_score - b_score) < 0.0005 then v_result := 'draw';
  elsif a_score > b_score then v_result := 'inviter';
  else v_result := 'invitee';
  end if;

  update races
     set status = 'finished', result = v_result, by_forfeit = v_forfeit, finished_at = now(),
         inviter_score = case when a_ok then a_score end, invitee_score = case when b_ok then b_score end
   where id = r.id;
  return jsonb_build_object('result', v_result, 'decided', true, 'byForfeit', v_forfeit);
end;
$$;

-- ---------------------------------------------------------------------------
-- the trigger: a match ending decides whatever it was played for
-- ---------------------------------------------------------------------------
--
-- AFTER the status changes, inside commit_match_result's transaction, which has already
-- locked the match and written the sides. For every other match this is two index probes
-- that find nothing.
create function arena_match_ended() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from crown_challenges where match_id = new.id) then
    perform crown_resolve(new.id);
  end if;
  if exists (select 1 from races where inviter_match_id = new.id or invitee_match_id = new.id) then
    perform race_resolve(new.id);
  end if;
  return null;
end;
$$;

create trigger matches_arena_ended
  after update of status on matches
  for each row
  when (new.status in ('settled', 'void') and old.status in ('open', 'awaiting_runs'))
  execute function arena_match_ended();

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
--
-- Functions are executable by PUBLIC unless that is taken away, and anon and authenticated
-- inherit through PUBLIC (the lesson of 20260921000019). Only the service role calls these.
revoke all on function arena_has_live_match(uuid) from public, anon, authenticated;
revoke all on function arena_side_tiers(uuid, uuid) from public, anon, authenticated;
revoke all on function crown_vacate(text, integer, text) from public, anon, authenticated;
revoke all on function crown_lapse_due(text, integer, integer) from public, anon, authenticated;
revoke all on function crown_lapse_all(integer) from public, anon, authenticated;
revoke all on function crown_reset_off_pool(text, integer, integer) from public, anon, authenticated;
revoke all on function crown_open_challenge(text, integer, uuid, text, bigint[], text, text, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function crown_resolve(uuid) from public, anon, authenticated;
revoke all on function race_start(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function race_leg_finished(uuid, uuid) from public, anon, authenticated;
revoke all on function race_resolve(uuid) from public, anon, authenticated;
revoke all on function arena_match_ended() from public, anon, authenticated;

grant execute on function crown_lapse_all(integer) to service_role;
grant execute on function crown_reset_off_pool(text, integer, integer) to service_role;
grant execute on function crown_open_challenge(text, integer, uuid, text, bigint[], text, text, integer, integer, integer)
  to service_role;
grant execute on function crown_resolve(uuid) to service_role;
grant execute on function race_start(uuid, uuid, integer) to service_role;
grant execute on function race_resolve(uuid) to service_role;
