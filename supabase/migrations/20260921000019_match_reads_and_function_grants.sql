-- Two access-control mistakes, both found by running the migrations locally as the
-- `authenticated` role rather than by reading them.

-- ---------------------------------------------------------------------------
-- 1. Participants could not read their own matches at all
-- ---------------------------------------------------------------------------
--
-- `match_sides_read_participant` asked "is there a side in this match that is mine?" by
-- querying match_sides from inside a policy on match_sides. Postgres refuses that with
-- "infinite recursion detected in policy for relation match_sides", and
-- `matches_read_participant` failed the same way because its subquery hits the same
-- policy. Every client read of either table errored. `fetchActiveMatch` treats an error
-- as "no match", so restoring a match after an app restart never worked; nothing else
-- surfaced it.
--
-- The membership test moves into a SECURITY DEFINER function, which reads match_sides
-- without re-entering the policy. It answers only for the calling user, never for an
-- arbitrary id, so exposing it to clients reveals nothing they could not already see.

create or replace function is_match_participant(p_match_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from match_sides
    where match_id = p_match_id and player_id = auth.uid()
  );
$$;

revoke all on function is_match_participant(uuid) from public;
grant execute on function is_match_participant(uuid) to anon, authenticated, service_role;

drop policy if exists matches_read_participant on matches;
create policy matches_read_participant on matches
  for select using (is_match_participant(id));

drop policy if exists match_sides_read_participant on match_sides;
create policy match_sides_read_participant on match_sides
  for select using (is_match_participant(match_id));

-- ---------------------------------------------------------------------------
-- 2. consume_rate_limit was still callable by any client
-- ---------------------------------------------------------------------------
--
-- 20260824000012 revoked it from anon and authenticated, but functions are executable
-- by PUBLIC by default and both roles inherit through PUBLIC, so the revoke changed
-- nothing. Called directly with another player's id, it spends that player's budget and
-- can lock them out of find-match. The tournaments migration already does this
-- correctly; this brings the older function in line with it.

revoke all on function consume_rate_limit(uuid, text, integer, interval) from public, anon, authenticated;
grant execute on function consume_rate_limit(uuid, text, integer, interval) to service_role;
