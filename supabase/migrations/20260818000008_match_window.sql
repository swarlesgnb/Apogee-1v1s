-- ---------------------------------------------------------------------------
-- Matches are drawn from a season window, not a benchmark difficulty
-- ---------------------------------------------------------------------------
--
-- `matches.difficulty` was the partition key for matchmaking: a player queueing
-- Intermediate could only be paired with run sets played on Intermediate scenarios, which
-- is right, because both sides of a match have to have played the same three.
--
-- The pool is now the season's own, cut into windows, and the windows are renameable from
-- the season editor. A name is therefore the wrong thing to partition on: renaming Easy to
-- Beginner would silently stop new matches pairing with every run set already banked under
-- the old name. The index is stable across renames, so that is what matchmaking keys on.
--
-- `difficulty` stays and keeps carrying the window's display name. It is no longer what
-- anything matches on, but a match row that cannot say which difficulty it was is a row
-- nobody can read in a support conversation.

alter table matches
  add column if not exists window_index int;

comment on column matches.window_index is
  'Which window of the season pool this match was drawn from, 0-based. The partition '
  'key for matchmaking: both sides must have played the same scenarios, and window names '
  'are renameable where the index is not.';

comment on column matches.difficulty is
  'Display name of the window this match was drawn from. Readable, not authoritative - '
  'matchmaking partitions on window_index.';

alter table matches
  add constraint matches_window_nonnegative
  check (window_index is null or window_index >= 0);

-- The candidate-opponent search is (category, window, has a score, recent) on every queue,
-- so it gets an index rather than a sequential scan that grows with the ladder.
create index if not exists matches_category_window_idx
  on matches (category, window_index, created_at desc);

-- The default named another project's benchmark, which is no longer where anything comes
-- from. Dropped rather than repointed: the season a match belongs to is knowable from its
-- window and its date, and a wrong default is worse than none.
alter table matches
  alter column benchmark_name drop default;
