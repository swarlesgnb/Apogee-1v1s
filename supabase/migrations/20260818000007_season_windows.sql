-- ---------------------------------------------------------------------------
-- Windowed seasons: one ladder, cut into scenario windows
-- ---------------------------------------------------------------------------
--
-- A season used to be a flat list: one scenario per row, one threshold per rank. That
-- cannot express a ladder wide enough to hold both a first-week player and a good one,
-- because a perfect run on an easy scenario stops proving anything long before the top
-- of such a ladder. Past that point the ladder needs harder scenarios to keep measuring.
--
-- So a season's ranks are cut into windows of `window_size`, and each scenario family
-- carries one variant per window: Novice grades ranks 1-4, Intermediate 5-8, Advanced
-- 9-12. A family is graded on the best of its variants, so a player only ever plays the
-- six scenarios their band uses rather than all eighteen.
--
-- Both columns are nullable, because a flat season is still a valid season and every row
-- already written is one.

alter table seasons
  add column if not exists window_size int,
  add column if not exists windows     text[];

comment on column seasons.window_size is
  'How many ranks one scenario window covers. Null on a flat season, where every '
  'scenario is graded against the whole ladder.';

comment on column seasons.windows is
  'Display name per window, low to high, e.g. {Novice,Intermediate,Advanced}.';

alter table seasons
  add constraint seasons_window_size_positive
  check (window_size is null or window_size > 0);

-- `window_index`, not `window`: WINDOW is a reserved word, and a column that has to be
-- quoted at every call site is a column somebody will eventually forget to quote.
alter table season_scenarios
  add column if not exists family       text,
  add column if not exists window_index int;

comment on column season_scenarios.family is
  'The family this scenario is a variant of - "Pasu" for every difficulty of Pasu. '
  'What actually gets graded on a windowed season. Null on a flat one.';

comment on column season_scenarios.window_index is
  'Which window this variant grades, 0-based. Its rank_maxes are offset into the '
  'ladder by window_index * window_size ranks.';

alter table season_scenarios
  add constraint season_scenarios_window_nonnegative
  check (window_index is null or window_index >= 0);

-- A family may hold only one scenario per window. Two would grade the same ranks, and
-- the family would quietly take whichever was easier - a season that reads as correct
-- and hands out ranks nobody earned.
create unique index if not exists season_scenarios_one_per_window
  on season_scenarios (season_id, family, window_index)
  where family is not null;

-- Windows and families travel together: one without the other describes nothing.
alter table season_scenarios
  add constraint season_scenarios_window_needs_family
  check ((family is null) = (window_index is null));
