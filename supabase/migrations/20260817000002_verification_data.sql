-- Verification data that has to exist server-side.
--
-- The integrity checks in src/core/verify read two things that previously lived only
-- in local JSON: the learned `score = <stat> * k` relation per scenario, and the
-- world-record ceiling. The client cannot be trusted to supply either (it would simply
-- claim whatever made its own score look valid), so they move into the database and
-- are read by the Edge Functions.

alter table scenarios
  -- Learned scoring relation. Null where no constant relation was found, in which case
  -- the score check is skipped rather than failed.
  add column if not exists score_model_stat text,
  add column if not exists score_model_k    numeric,
  -- Highest score KovaaK's has ever recorded. Used only as a sanity ceiling.
  add column if not exists world_record     numeric;

alter table scenarios
  add constraint scenarios_score_model_stat_known
    check (score_model_stat is null
           or score_model_stat in ('kills', 'hitCount', 'damageDone'));

comment on column scenarios.score_model_stat is
  'Which counter the score is a fixed multiple of. With score_model_k this lets the '
  'server re-derive a score from the run''s own numbers, which is what catches an '
  'edited Score: line.';

-- ---------------------------------------------------------------------------
-- match lifecycle helpers
-- ---------------------------------------------------------------------------

-- A match must be findable by the player who owns it, and by expiry for cleanup.
create index if not exists matches_expiry_idx on matches (status, expires_at)
  where status <> 'settled';

-- Stored run sets are the async opponent pool. Matchmaking reads them by category and
-- difficulty, filtered to settled sides that are worth reusing.
create index if not exists match_sides_pool_idx
  on match_sides (player_id, submitted_at desc)
  where match_score is not null;

-- ---------------------------------------------------------------------------
-- rating history, so a rating change can be explained after the fact
-- ---------------------------------------------------------------------------

create table if not exists rating_history (
  id             bigserial primary key,
  player_id      uuid not null references players (id) on delete cascade,
  match_id       uuid references matches (id) on delete set null,
  rating_before  numeric not null,
  rating_after   numeric not null,
  rd_before      numeric not null,
  rd_after       numeric not null,
  -- 1 win, 0 loss, 0.5 draw.
  result         numeric not null,
  -- Reduced when either side used a provisional baseline.
  weight         numeric not null default 1,
  created_at     timestamptz not null default now()
);

create index if not exists rating_history_player_idx
  on rating_history (player_id, created_at desc);

alter table rating_history enable row level security;

-- A player may read their own rating history and nobody else's. Writes are service
-- role only, like every other rating-adjacent table.
create policy rating_history_read_self on rating_history
  for select using (auth.uid() = player_id);
