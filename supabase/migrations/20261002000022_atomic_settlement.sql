-- Commit a terminal match transition and all affected ratings together. Only the
-- service role may call this; score calculation remains in the shared game core.
create function commit_match_result(p_match_id uuid, p_status text, p_sides jsonb,
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

-- Serialize new run attachment with settlement. A request that read an open match
-- before another request settled it must not write a late run afterward.
create or replace function claim_ranked_run() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare claimed uuid; target_status match_status;
begin
  if tg_op = 'UPDATE' and (old.match_id is not null or old.match_submitted_at is not null) then
    if new.match_id is distinct from old.match_id and not (
      new.match_id is null and old.match_id is not null and
      not exists(select 1 from matches where id = old.match_id)
    ) then raise exception 'a ranked run cannot move to another match' using errcode = '23505'; end if;
    new.match_submitted_at := old.match_submitted_at;
    return new;
  end if;
  if new.match_id is null then new.match_submitted_at := null; return new; end if;
  select status into target_status from matches where id = new.match_id for update;
  if target_status in ('settled','void') then
    raise exception 'match is already finished' using errcode = '55000';
  end if;
  new.match_submitted_at := clock_timestamp();
  if new.scenario_id is not null then
    insert into ranked_run_claims(player_id,scenario_id,played_at,first_run_id)
      values(new.player_id,new.scenario_id,new.played_at,new.id) on conflict do nothing;
    select first_run_id into claimed from ranked_run_claims
      where player_id = new.player_id and scenario_id = new.scenario_id and played_at = new.played_at;
    if claimed is distinct from new.id then
      raise exception 'this ranked run has already been submitted' using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;
