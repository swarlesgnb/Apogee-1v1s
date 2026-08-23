-- ---------------------------------------------------------------------------
-- Give the matches played before windows existed the window they were played in
-- ---------------------------------------------------------------------------
--
-- Matchmaking now partitions on `matches.window_index`, and a null never satisfies an
-- equality filter - so every match played before that column existed is invisible to the
-- candidate search. That matters more than the row count suggests: the pool's whole value
-- is the run sets banked in it, and on a ladder that ships async-first (PLAN.md §6) the
-- first banked set is the difference between a cold start and no start.
--
-- Those matches were all drawn from the one pool that existed: Voltaic S5 Intermediate,
-- which is the season's middle window. Mapped by the difficulty they recorded rather than
-- assumed, so a row that says something else is left alone and stays visible as an
-- anomaly instead of being quietly relabelled.

update matches
   set window_index = 1
 where window_index is null
   and difficulty = 'Intermediate';

-- Anything left is a match from a pool nobody can now identify. Left null on purpose: it
-- will not be offered as an opponent, which is the safe direction, and it is findable.
do $$
declare
  orphaned int;
begin
  select count(*) into orphaned from matches where window_index is null;
  if orphaned > 0 then
    raise notice 'matches with no window: % (they will not be offered as opponents)', orphaned;
  end if;
end $$;
