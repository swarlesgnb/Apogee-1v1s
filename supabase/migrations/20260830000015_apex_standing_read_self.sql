-- ---------------------------------------------------------------------------
-- The apex board is served, not read
--
-- 20260830000014 gave `apex_standing` a world-readable policy, reasoning that a
-- leaderboard is public by definition. That is true about the *board* and wrong
-- about the table, and 20260817000004 had already settled the argument: player
-- profiles were world-readable once, which let any caller enumerate the whole
-- player base, and the rule that replaced it is that anything a client sees about
-- another player is a decision the server makes.
--
-- A world-readable `apex_standing` is a weaker version of the same hole. It hands
-- out an ordered list of every player_id in the system to anyone with a session -
-- no display name and no steam_id, but an enumeration of the population and each
-- one's activity, which is not a client's to take.
--
-- So the table follows `verified_pbs` and `baselines`: a player reads their own
-- row and nothing else. The public board comes from the `apex-board` Edge
-- Function, which joins display names with the service role and returns only the
-- columns it decides to expose - exactly how `find-match` already hands over an
-- opponent's name.
--
-- Corrective rather than an edit to 14, because 14 may already have been applied:
-- Supabase records a migration by name and will not re-run one whose file changed,
-- so editing it would leave a deployed project silently disagreeing with the repo.
-- ---------------------------------------------------------------------------

drop policy if exists apex_standing_read on apex_standing;

create policy apex_standing_read_self on apex_standing
  for select using (auth.uid() = player_id);

comment on table apex_standing is
  'Post-rank standing per player per category. Uncapped, unlike the season ladder. '
  'Written only by refresh-apex under the service role; read by a player for their '
  'own row, and by everyone through the apex-board function, which decides what of '
  'another player is visible.';

-- `scenario_boards` keeps its world-readable policy. It is reference data about
-- scenarios - the shape of a KovaaK's leaderboard - and says nothing about any
-- player, which is the line 20260817000004 drew.
