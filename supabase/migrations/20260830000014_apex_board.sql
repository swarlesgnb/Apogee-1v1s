-- ---------------------------------------------------------------------------
-- The apex board: a standing that does not cap
--
-- The ladder stops measuring at its top rank on purpose - a rank is a band and a
-- band has a top - so two players who both clear the hardest rank hold identical
-- energy however far apart they are. This is the second standing that separates
-- them, and it reads the same KovaaK's boards the season's thresholds were cut
-- from. See src/core/season/apex.ts for the measure and PLAN.md for why.
--
-- Nothing here feeds ratings, matchmaking or settlement. That separation is the
-- same one thresholds already have: those surfaces are standing, this is stats.
-- ---------------------------------------------------------------------------

-- Reference data: where a score sits on a scenario's board.
--
-- Two samplings of one board, kept in one row because they are only ever read
-- together. `apex_points` holds the score at fixed board ranks (1..500), which is
-- what resolves the top; `percentile_points` holds the score at fixed fractions,
-- which is what covers everything below. A fraction stops resolving at the top -
-- the finest sampled is 0.1% and the ladder's hardest rank is already 0.8% - and
-- a rank means the same thing on a board of any size, which is why both exist.
create table scenario_boards (
  scenario_id       bigint primary key references scenarios (id) on delete cascade,

  -- Entries on the leaderboard when it was sampled. Every fraction is against this.
  board_total       integer not null,

  -- [{ "rank": 1, "score": 2350 }, ...] ascending by rank.
  apex_points       jsonb not null default '[]'::jsonb,

  -- [{ "topFraction": 0.001, "score": 2100 }, ...] ascending by fraction.
  percentile_points jsonb not null default '[]'::jsonb,

  sampled_at        timestamptz not null,
  synced_at         timestamptz not null default now(),

  constraint scenario_boards_total_positive check (board_total > 0)
);

comment on table scenario_boards is
  'Sampled KovaaK''s leaderboard shape per scenario. Reference data: world-readable, '
  'never client-writable, refreshed by tools/syncReferenceData.ts.';

-- The computed standing, one row per player per category.
--
-- Materialised rather than computed per request. The measure needs every graded
-- scenario''s board and every player''s verified PB on it, so ranking the whole
-- population on demand would be a full scan per page of a leaderboard nobody is
-- paying to keep warm. `refresh-apex` writes it; readers just sort.
create table apex_standing (
  player_id  uuid not null references players (id) on delete cascade,

  -- 'Clicking' | 'Tracking' | 'Switching', or 'Overall' for the sum of the three.
  category   text not null,

  -- -log10 of the fraction from the top, summed over the category's families. A
  -- whole point is ten times fewer players above you. Never caps, which is the
  -- entire reason this table exists.
  points     numeric not null default 0,

  -- Families with a score, out of all of them. A partial standing is not a bad
  -- one, and a leaderboard that cannot show the difference invites the reading
  -- that somebody strong is somebody who has played more scenarios.
  graded     integer not null default 0,
  family_count integer not null default 0,

  updated_at timestamptz not null default now(),

  primary key (player_id, category),
  constraint apex_standing_points_not_negative check (points >= 0)
);

-- The board is read sorted by points within a category, which is the only query
-- it has.
create index apex_standing_board_idx on apex_standing (category, points desc);

comment on table apex_standing is
  'Post-rank standing per player per category. Uncapped, unlike the season ladder. '
  'Written only by the refresh-apex Edge Function under service role.';

-- ---------------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------------

alter table scenario_boards enable row level security;
alter table apex_standing   enable row level security;

-- Reference data is world-readable and never client-writable, same as `scenarios`.
create policy scenario_boards_read on scenario_boards
  for select using (true);

-- A leaderboard is public by definition: the whole point is seeing who is above
-- you. Note there is no insert, update or delete policy on either table, so a
-- client holds no write grant at all and the standing cannot be self-reported -
-- the same rule ratings, matches and verified_pbs already live under.
create policy apex_standing_read on apex_standing
  for select using (true);
