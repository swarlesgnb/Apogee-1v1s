-- Ranked v2's database half: two columns and two service-role functions.
--
-- Additive on purpose. Nothing the live functions (find-match, settle-match,
-- abandon-match) read or write changes meaning, so this can be pushed while v2 is still
-- only reachable from a development build (find-match-v2 and friends, admin-gated).

-- Which ranked engine created a match. 1 is everything that exists today; find-match-v2
-- writes 2. Recorded so v2's results can be told apart from v1's when the two are
-- compared on real play, and so the v2 functions settle each match by the rules of the
-- engine that created it (_shared/rankedV2.ts policyFor).
alter table matches add column if not exists engine smallint not null default 1;

comment on column matches.engine is
  'Ranked engine that created the match: 1 the original, 2 ranked v2 (src/core/rating/ranked.ts).';

-- Why a match was voided, when v2 voided it. Only `abandoned` is read: a player gets one
-- free void for leaving a scenario early per rolling week, and this is how the week's is
-- counted. Null for every void written before v2, which therefore costs nobody a void.
alter table matches add column if not exists void_reason text;

comment on column matches.void_reason is
  'Set by ranked v2 when it voids a match. ''abandoned'' spends the player''s free void for the week.';

-- ---------------------------------------------------------------------------
-- ranked_pool_rounds: the opponents a queue may draw from
-- ---------------------------------------------------------------------------
--
-- find-match reads the newest 600 sides with a score, of any rating, and throws away the
-- copies in JavaScript. Every match answered from the pool writes a copy that also has a
-- score beside the caller's original, so up to half those rows are discarded. Nothing about
-- the read reaches toward the caller's own rating either: as the ladder grows, a player at
-- either end of it can only be matched from whoever queued most recently, close to them or
-- not.
--
-- This turns the read around: originals only (a side submitted at or after its match was
-- created; a copy carries the earlier submitted_at of what it was copied from, the same
-- test as isCopiedSide), the players nearest the caller's rating first, a bounded number
-- of their newest sides each. The bank is built from that exactly as before.
create or replace function ranked_pool_rounds(
  p_window int,
  p_caller uuid,
  p_rating numeric,
  p_players int default 40,
  p_sides_per_player int default 20
) returns table (
  match_id uuid,
  player_id uuid,
  display_name text,
  run_ids uuid[],
  deltas numeric[],
  scores numeric[],
  provisional boolean,
  submitted_at timestamptz,
  rating_before numeric,
  rd_before numeric,
  difficulty text,
  scenario_ids bigint[],
  rating numeric,
  rd numeric,
  volatility numeric
)
language sql stable set search_path = public, pg_temp as $$
  with originals as (
    select ms.match_id, ms.player_id, ms.run_ids, ms.deltas, ms.scores, ms.provisional,
           ms.submitted_at, ms.rating_before, ms.rd_before, m.difficulty, m.scenario_ids
      from match_sides ms
      join matches m on m.id = ms.match_id
     where m.window_index = p_window
       -- Never a tournament leg: those rounds were played for one fixture, unrated.
       and m.rated
       and ms.match_score is not null
       and ms.submitted_at is not null
       and ms.submitted_at >= m.created_at
       and ms.player_id <> p_caller
  ),
  nearest as (
    select r.player_id, r.rating, r.rd, r.volatility
      from ratings r
     where r.player_id in (select o.player_id from originals o)
     order by abs(r.rating - p_rating), r.player_id
     limit greatest(1, least(p_players, 200))
  ),
  newest as (
    select o.*, row_number() over (partition by o.player_id order by o.submitted_at desc) as n
      from originals o
      join nearest using (player_id)
  )
  select w.match_id, w.player_id, p.display_name, w.run_ids, w.deltas, w.scores, w.provisional,
         w.submitted_at, w.rating_before, w.rd_before, w.difficulty, w.scenario_ids,
         nr.rating, nr.rd, nr.volatility
    from newest w
    join nearest nr using (player_id)
    join players p on p.id = w.player_id
   where w.n <= greatest(1, least(p_sides_per_player, 100))
   order by w.player_id, w.submitted_at desc;
$$;

revoke all on function ranked_pool_rounds(int, uuid, numeric, int, int) from public, anon, authenticated;
grant execute on function ranked_pool_rounds(int, uuid, numeric, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- open_ranked_match: one match at a time, enforced where it cannot race
-- ---------------------------------------------------------------------------
--
-- find-match checks for an open match and then inserts one, in separate requests, and
-- inserts the match and its sides separately too. A double click is two requests: both
-- pass the check and the player holds two matches, which is the cherry-pick the
-- one-match rule exists to prevent (sweepStaleMatches). A failure between the two
-- inserts left a match with no sides that nothing could ever settle or sweep.
--
-- Here the check and both inserts are one transaction, serialised per player by an
-- advisory lock, so the second of two simultaneous requests waits, sees the first's
-- match and gets that back instead of a second one.
--
-- A match past its deadline does not count as open. The sweep retires those before
-- anybody gets here, and the one it cannot retire - every run in, settlement failing - is
-- left open to be retried. Counting it here would turn one bad settlement into a player
-- who can never queue again.
create or replace function open_ranked_match(p_player uuid, p_match jsonb, p_sides jsonb)
returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  existing uuid;
  created uuid;
  side jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('apogee:open-match:' || p_player::text, 0));

  -- The player's own side of an open match: not a copy of their rounds sitting in
  -- somebody else's (submitted before that match existed).
  select ms.match_id into existing
    from match_sides ms
    join matches m on m.id = ms.match_id
   where ms.player_id = p_player
     and m.status in ('open', 'awaiting_runs')
     and (m.expires_at is null or m.expires_at > now())
     and (ms.submitted_at is null or ms.submitted_at >= m.created_at)
   order by m.created_at desc
   limit 1;

  if existing is not null then
    return jsonb_build_object('created', false, 'reason', 'already-in-match', 'match_id', existing);
  end if;

  if not exists (select 1 from jsonb_array_elements(p_sides) s where (s->>'player_id')::uuid = p_player) then
    raise exception 'the caller must have a side in the match';
  end if;

  insert into matches (mode, category, benchmark_name, difficulty, window_index, seed,
                       scenario_ids, status, expires_at, engine, rated)
  values (
    coalesce((p_match->>'mode')::match_mode, 'async'),
    p_match->>'category',
    p_match->>'benchmark_name',
    p_match->>'difficulty',
    (p_match->>'window_index')::int,
    p_match->>'seed',
    array(select jsonb_array_elements_text(p_match->'scenario_ids')::bigint),
    'awaiting_runs',
    (p_match->>'expires_at')::timestamptz,
    coalesce((p_match->>'engine')::smallint, 1),
    true
  )
  returning id into created;

  -- Column by column with the table's own defaults, not jsonb_populate_record: a key a
  -- side lacks must take the default, not NULL, which is the bug find-match's
  -- defaultToNull comment describes for bulk inserts.
  for side in select value from jsonb_array_elements(p_sides) loop
    insert into match_sides (match_id, player_id, run_ids, deltas, scores, match_score,
                             provisional, rating_before, rd_before, submitted_at)
    values (
      created,
      (side->>'player_id')::uuid,
      coalesce(array(select jsonb_array_elements_text(side->'run_ids')::uuid), '{}'),
      coalesce(array(select jsonb_array_elements_text(side->'deltas')::numeric), '{}'),
      coalesce(array(select jsonb_array_elements_text(side->'scores')::numeric), '{}'),
      (side->>'match_score')::numeric,
      coalesce((side->>'provisional')::boolean, false),
      (side->>'rating_before')::numeric,
      (side->>'rd_before')::numeric,
      (side->>'submitted_at')::timestamptz
    );
  end loop;

  return jsonb_build_object('created', true, 'match_id', created);
end;
$$;

revoke all on function open_ranked_match(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function open_ranked_match(uuid, jsonb, jsonb) to service_role;
