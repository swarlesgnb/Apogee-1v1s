-- What the leaderboard function reads, indexed for how it reads it.
--
-- A scenario board asks for one scenario's best runs across every player. `runs` is
-- indexed by player (runs_player_scenario_idx, runs_player_played_idx), and since Steam
-- sign-in uploads a player's whole history it is large enough that ordering one
-- scenario's rows by score is a scan without this. Partial on the two tiers a board ever
-- shows, because suspect and rejected runs are never ranked.
create index if not exists runs_scenario_score_idx
  on runs (scenario_id, score desc, played_at)
  where verification_tier in ('verified', 'consistent');

-- The week's movers read every rated match since a cutoff; the existing index leads with
-- player_id and cannot serve a range over all players.
create index if not exists rating_history_created_idx
  on rating_history (created_at desc);
