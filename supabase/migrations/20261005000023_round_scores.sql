-- Raw scores per round, so a ranked match can be decided round by round.
--
-- Ranked moved from mean delta to rounds: each scenario is a round won by the higher raw
-- score, and the side that wins more rounds wins (src/core/match/settle.ts). A stored side
-- has only ever kept its deltas, and a delta cannot be turned back into a score without
-- the baseline it was measured against, so the scores are stored alongside them.

alter table match_sides add column scores numeric[] not null default '{}';

comment on column match_sides.scores is
  'Raw score per round, in matches.scenario_ids order. What a rounds-format match is decided on.';

-- Originals: every side settled since run ids were recorded names its runs in scenario
-- order, and each run carries its score.
update match_sides ms
   set scores = (
     select array_agg(r.score order by u.ord)
       from unnest(ms.run_ids) with ordinality as u(run_id, ord)
       join runs r on r.id = u.run_id
   )
 where cardinality(ms.run_ids) > 0
   and ms.match_score is not null
   and cardinality(ms.scores) = 0;

-- A side whose runs did not all survive would get a short array, which settlement would
-- read as a score for the wrong scenario. Empty is honest; settle-match falls back.
update match_sides
   set scores = '{}'
 where cardinality(scores) <> cardinality(run_ids);

-- Copies: written by find-match, answer-duel and open_fixture_leg with the original's
-- deltas but no run ids. A copy keeps its original's owner and submitted_at
-- (runSetId in _shared/apogee.ts), which is how its scores are found.
update match_sides c
   set scores = o.scores
  from match_sides o
 where cardinality(c.scores) = 0
   and c.submitted_at is not null
   and o.player_id = c.player_id
   and o.submitted_at = c.submitted_at
   and cardinality(o.scores) > 0
   and (o.match_id, o.player_id) <> (c.match_id, c.player_id);

-- commit_match_result writes whichever side columns it is handed; it learns `scores`.
-- Otherwise identical to 20261002000022.
create or replace function commit_match_result(p_match_id uuid, p_status text, p_sides jsonb,
  p_ratings jsonb default '[]', p_forfeit boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m matches%rowtype; r ratings%rowtype; proposal jsonb; side jsonb;
  who uuid; receipt timestamptz := clock_timestamp();
begin
  select * into m from matches where id = p_match_id for update;
  if not found then raise exception 'no such match' using errcode = 'P0002'; end if;
  if m.status in ('settled','void') then
    return jsonb_build_object('committed',false,'reason','already-settled');
  end if;
  if p_status not in ('settled','void') or jsonb_array_length(p_sides) = 0 then
    raise exception 'invalid settlement';
  end if;
  if (p_status = 'void' or not m.rated) and jsonb_array_length(p_ratings) > 0 then
    raise exception 'this result cannot move ratings';
  end if;
  if (select count(*) from jsonb_array_elements(p_sides)) <>
     (select count(distinct value->>'player_id') from jsonb_array_elements(p_sides)) or
     (select count(*) from jsonb_array_elements(p_ratings)) <>
     (select count(distinct value->>'player_id') from jsonb_array_elements(p_ratings)) then
    raise exception 'duplicate settlement participant';
  end if;
  for side in select value from jsonb_array_elements(p_sides) loop
    who := (side->>'player_id')::uuid;
    if not exists(select 1 from match_sides where match_id = p_match_id and player_id = who) then
      raise exception 'settlement participant is not in the match';
    end if;
    if p_forfeit and who = (p_sides->0->>'player_id')::uuid and (
      exists(select 1 from match_sides where match_id = p_match_id and player_id = who and match_score is not null)
      or (select count(distinct scenario_id) from runs where match_id = p_match_id and player_id = who
        and scenario_id = any(m.scenario_ids)) >= cardinality(m.scenario_ids)
    ) then return jsonb_build_object('committed',false,'reason','already-played'); end if;
  end loop;

  -- Consistent lock order across different matches sharing a duel participant.
  for proposal in select value from jsonb_array_elements(p_ratings) order by value->>'player_id' loop
    who := (proposal->>'player_id')::uuid;
    if not exists(select 1 from jsonb_array_elements(p_sides) s where (s->>'player_id')::uuid = who) then
      raise exception 'rating has no submitted side';
    end if;
    insert into ratings(player_id) values(who) on conflict do nothing;
    select * into r from ratings where player_id = who for update;
    if r.rating is distinct from (proposal->'before'->>'rating')::numeric or
       r.rd is distinct from (proposal->'before'->>'rd')::numeric or
       r.volatility is distinct from (proposal->'before'->>'volatility')::numeric or
       r.matches_played is distinct from (proposal->>'matches_played')::int then
      raise exception 'rating changed during settlement; retry' using errcode = '40001';
    end if;
    if exists(select 1 from rating_history where player_id = who and match_id = p_match_id) then
      raise exception 'this match already has a rating receipt' using errcode = '40001';
    end if;
    update ratings set rating = (proposal->'after'->>'rating')::numeric,
      rd = (proposal->'after'->>'rd')::numeric, volatility = (proposal->'after'->>'volatility')::numeric,
      matches_played = r.matches_played + 1, updated_at = receipt where player_id = who;
    insert into rating_history(player_id,match_id,rating_before,rating_after,rd_before,rd_after,result,weight)
      values(who,p_match_id,r.rating,(proposal->'after'->>'rating')::numeric,
        r.rd,(proposal->'after'->>'rd')::numeric,(proposal->>'score')::numeric,(proposal->>'weight')::numeric);
  end loop;
  for side in select value from jsonb_array_elements(p_sides) loop
    update match_sides set
      run_ids = case when side ? 'run_ids' then array(select jsonb_array_elements_text(side->'run_ids')::uuid) else run_ids end,
      deltas = case when side ? 'deltas' then array(select jsonb_array_elements_text(side->'deltas')::numeric) else deltas end,
      scores = case when side ? 'scores' then array(select jsonb_array_elements_text(side->'scores')::numeric) else scores end,
      match_score = case when side ? 'match_score' then (side->>'match_score')::numeric else match_score end,
      result = case when side ? 'result' then (side->>'result')::match_result else result end,
      provisional = case when side ? 'provisional' then (side->>'provisional')::boolean else provisional end,
      rating_before = case when side ? 'rating_before' then (side->>'rating_before')::numeric else rating_before end,
      rating_after = case when side ? 'rating_after' then (side->>'rating_after')::numeric else rating_after end,
      rd_before = case when side ? 'rd_before' then (side->>'rd_before')::numeric else rd_before end,
      rd_after = case when side ? 'rd_after' then (side->>'rd_after')::numeric else rd_after end,
      submitted_at = case when coalesce((side->>'record_submission')::boolean,true) then receipt else submitted_at end
    where match_id = p_match_id and player_id = (side->>'player_id')::uuid;
  end loop;
  update matches set status = p_status::match_status, settled_at = receipt where id = p_match_id;
  return jsonb_build_object('committed',true);
end;
$$;
revoke all on function commit_match_result(uuid,text,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function commit_match_result(uuid,text,jsonb,jsonb,boolean) to service_role;
