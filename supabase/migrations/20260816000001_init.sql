-- Arena: initial schema.
--
-- Security model (PLAN.md §7): the client parses CSVs and uploads raw run data, and
-- nothing else. Every value that decides a match — baselines, deltas, verification
-- tier, rating — is computed server-side. RLS below enforces that: clients may insert
-- their own runs and read their own rows, but hold no write grant at all on ratings,
-- matches, match_sides, baselines or verified_pbs. Those are written by Edge Functions
-- using the service role, which bypasses RLS.
--
-- A client that can write its own rating is a client that will.

-- No extensions required. `gen_random_uuid()` has been built into Postgres since 13,
-- so the usual `create extension pgcrypto` is dead weight on any supported version and
-- would fail on a stripped-down Postgres for no benefit.

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------

-- Verification outcome for a single run. See PLAN.md §5.
--   verified   matching record on KovaaK's servers
--   consistent no server record (sub-PB), but internally consistent and in-window
--   suspect    above verified PB with no server record - counted, flagged, reviewed.
--              NOT auto-voided: measured false-positive rate is ~1 in 9 (PLAN.md §5)
--   rejected   internally inconsistent, replayed, or outside the match window
--   unverified not yet processed
create type verification_tier as enum (
  'unverified', 'verified', 'consistent', 'suspect', 'rejected'
);

create type match_mode as enum ('async', 'live');

create type match_status as enum ('open', 'awaiting_runs', 'settled', 'void');

create type match_result as enum ('win', 'loss', 'draw');

-- ---------------------------------------------------------------------------
-- players
-- ---------------------------------------------------------------------------

create table players (
  id              uuid primary key references auth.users (id) on delete cascade,
  steam_id        text unique not null,
  display_name    text not null,
  avatar_url      text,
  country         text,
  -- KovaaK's *webapp* username, which is a separate registration from Steam. Needed
  -- to read a player's server-side run history, and only stored once KovaaK's has
  -- confirmed the username really belongs to this steam_id. Null is normal: plenty of
  -- players have never registered on kovaaks.com, and verification degrades for them
  -- rather than failing.
  kovaaks_username        text,
  kovaaks_username_verified_at timestamptz,
  -- Moderation flags, e.g. {"suspect_runs": 3, "under_review": true}.
  flags           jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),

  constraint steam_id_is_64bit check (steam_id ~ '^7656[0-9]{13}$')
);

comment on column players.steam_id is
  'SteamID64. This is the join key to KovaaK''s leaderboards and is what makes '
  'server-side verification possible, so it is required, not optional.';

-- ---------------------------------------------------------------------------
-- scenarios  (reference data, seeded from data/benchmarks)
-- ---------------------------------------------------------------------------

-- A scenario is a global entity, identified by its in-game name. Note what is NOT
-- here: thresholds. The same scenario appears in several benchmarks with DIFFERENT
-- thresholds — Voltaic S5.5 reuses S5's Advanced scenario names but re-tunes the
-- ranks — so thresholds belong to the (benchmark, difficulty, scenario) triple, not
-- to the scenario. Putting them here silently gives a scenario whichever benchmark's
-- numbers happened to load last.
create table scenarios (
  id              bigserial primary key,
  name            text unique not null,
  leaderboard_id  bigint,
  aim_type        text,
  sub_category    text,
  -- Known-good scenario hash. Stable over long periods (verified across 100 runs
  -- spanning six months), which makes it a dependable integrity check.
  known_hash      text,
  created_at      timestamptz not null default now(),

  constraint scenarios_aim_type_known
    check (aim_type is null or aim_type in ('Clicking', 'Tracking', 'Switching'))
);

create index scenarios_leaderboard_id_idx on scenarios (leaderboard_id);
create index scenarios_aim_type_idx on scenarios (aim_type, sub_category);

-- Membership of a scenario in one benchmark difficulty, with that benchmark's own
-- thresholds.
create table benchmark_scenarios (
  benchmark_name  text not null,
  difficulty      text not null,
  scenario_id     bigint not null references scenarios (id) on delete cascade,
  -- The benchmark's own category label for this scenario. Not always a skill:
  -- Voltaic's Elite tier labels its categories by sub-category instead.
  category        text,
  -- Score thresholds per rank, ascending. Official, from KovaaK's benchmark API.
  rank_maxes      numeric[] not null default '{}',

  primary key (benchmark_name, difficulty, scenario_id)
);

create index benchmark_scenarios_scenario_idx on benchmark_scenarios (scenario_id);

-- ---------------------------------------------------------------------------
-- runs
-- ---------------------------------------------------------------------------

create table runs (
  id                 uuid primary key default gen_random_uuid(),
  player_id          uuid not null references players (id) on delete cascade,
  scenario_id        bigint references scenarios (id),
  -- Kept verbatim as well as resolved, so a run on an unknown scenario is still
  -- stored rather than dropped on the floor.
  scenario_name      text not null,

  score              numeric not null,
  accuracy           numeric,
  avg_ttk            numeric,
  kills              integer,
  hit_count          integer,
  miss_count         integer,

  played_at          timestamptz not null,
  challenge_start    text,
  hash               text,
  game_version       text,
  avg_fps            numeric,
  resolution         text,
  cm360              numeric,
  dpi                integer,
  fov                numeric,

  -- Replay protection: the same file can never be submitted twice.
  csv_sha256         text not null,

  match_id           uuid,
  verification_tier  verification_tier not null default 'unverified',
  verification_notes jsonb not null default '{}'::jsonb,

  -- Per-kill rows, retained only for runs attached to a match, where anti-cheat may
  -- need to re-derive the score. Storing them for all 11k backfilled runs per player
  -- would be enormous and buys nothing.
  kill_rows          jsonb,

  created_at         timestamptz not null default now(),

  constraint runs_unique_file unique (player_id, csv_sha256),
  constraint runs_score_sane check (score >= 0 and score < 10000000)
);

create index runs_player_scenario_idx on runs (player_id, scenario_name, played_at desc);
create index runs_match_idx on runs (match_id) where match_id is not null;
create index runs_player_played_idx on runs (player_id, played_at desc);
create index runs_tier_idx on runs (verification_tier) where verification_tier = 'suspect';

comment on column runs.csv_sha256 is
  'SHA-256 of the raw stats file. Unique per player, which makes replaying a good '
  'run into a second match impossible.';

-- ---------------------------------------------------------------------------
-- verified_pbs  (mirror of KovaaK's server-side personal bests)
-- ---------------------------------------------------------------------------

create table verified_pbs (
  player_id    uuid not null references players (id) on delete cascade,
  scenario_id  bigint not null references scenarios (id) on delete cascade,
  score        numeric not null,
  -- KovaaK's submission timestamp, milliseconds since epoch.
  epoch        bigint,
  hash         text,
  synced_at    timestamptz not null default now(),

  primary key (player_id, scenario_id)
);

comment on table verified_pbs is
  'What KovaaK''s servers say a player can do. Supplies the baseline floor that '
  'defeats sandbagging, and the ceiling that bounds score forgery.';

-- ---------------------------------------------------------------------------
-- baselines
-- ---------------------------------------------------------------------------

create table baselines (
  player_id    uuid not null references players (id) on delete cascade,
  scenario_id  bigint not null references scenarios (id) on delete cascade,
  -- Mean of the top 30% of the last 50 runs, floored at 0.9 * verified PB.
  value        numeric not null,
  run_count    integer not null default 0,
  provisional  boolean not null default true,
  floored_by_pb boolean not null default false,
  computed_at  timestamptz not null default now(),

  primary key (player_id, scenario_id),
  constraint baselines_value_positive check (value > 0)
);

-- ---------------------------------------------------------------------------
-- ratings
-- ---------------------------------------------------------------------------

create table ratings (
  player_id      uuid primary key references players (id) on delete cascade,
  -- Glicko-2. Chosen over Elo for sparse, bursty, asynchronous play (PLAN.md §4).
  rating         numeric not null default 1500,
  rd             numeric not null default 350,
  volatility     numeric not null default 0.06,
  matches_played integer not null default 0,
  -- Cached percentile and tier id; recomputed as the population shifts.
  percentile     numeric,
  tier_id        text,
  updated_at     timestamptz not null default now()
);

create index ratings_rating_idx on ratings (rating desc);

-- ---------------------------------------------------------------------------
-- matches
-- ---------------------------------------------------------------------------

create table matches (
  id            uuid primary key default gen_random_uuid(),
  mode          match_mode not null default 'async',
  -- 'Clicking' / 'Tracking' / 'Switching', a sub-category, or 'Any'.
  category      text not null,
  benchmark_name text not null default 'Voltaic S5',
  difficulty    text not null,
  -- Seeds scenario selection so both sides get the same three and no client can
  -- reroll them.
  seed          text not null,
  scenario_ids  bigint[] not null,
  status        match_status not null default 'open',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  settled_at    timestamptz,

  constraint matches_three_scenarios check (array_length(scenario_ids, 1) = 3)
);

create index matches_status_idx on matches (status, created_at desc);

create table match_sides (
  match_id       uuid not null references matches (id) on delete cascade,
  player_id      uuid not null references players (id) on delete cascade,
  -- Null in an async match's stored side until the live player finishes.
  run_ids        uuid[] not null default '{}',
  -- Per-scenario (score - baseline) / baseline, in scenario_ids order.
  deltas         numeric[] not null default '{}',
  -- Mean of deltas. The number the match is decided on.
  match_score    numeric,
  result         match_result,
  rating_before  numeric,
  rating_after   numeric,
  rd_before      numeric,
  rd_after       numeric,
  -- True when any baseline used was provisional, which reduces rating weight.
  provisional    boolean not null default false,
  submitted_at   timestamptz,

  primary key (match_id, player_id)
);

create index match_sides_player_idx on match_sides (player_id, submitted_at desc);

alter table runs
  add constraint runs_match_fk foreign key (match_id) references matches (id) on delete set null;

-- ---------------------------------------------------------------------------
-- quests
-- ---------------------------------------------------------------------------

-- Benchmarks a player has chosen to track, resolved from a pasted evxl link.
create table tracked_benchmarks (
  player_id      uuid not null references players (id) on delete cascade,
  benchmark_name text not null,
  difficulty     text not null,
  -- Key into KovaaK's benchmark API for thresholds and progress.
  kovaaks_benchmark_id integer,
  is_primary     boolean not null default false,
  added_at       timestamptz not null default now(),

  primary key (player_id, benchmark_name, difficulty)
);

create table quests (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references players (id) on delete cascade,
  kind        text not null,
  params      jsonb not null default '{}'::jsonb,
  progress    numeric not null default 0,
  target      numeric not null,
  xp_reward   integer not null default 0,
  expires_at  timestamptz,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index quests_player_active_idx on quests (player_id, expires_at)
  where claimed_at is null;

-- ---------------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------------

alter table benchmark_scenarios enable row level security;
alter table players            enable row level security;
alter table runs               enable row level security;
alter table verified_pbs       enable row level security;
alter table baselines          enable row level security;
alter table ratings            enable row level security;
alter table matches            enable row level security;
alter table match_sides        enable row level security;
alter table tracked_benchmarks enable row level security;
alter table quests             enable row level security;
alter table scenarios          enable row level security;

-- Reference data is world-readable and never client-writable.
create policy scenarios_read on scenarios
  for select using (true);

create policy benchmark_scenarios_read on benchmark_scenarios
  for select using (true);

-- Profiles are public (leaderboards, opponent cards); a player edits only their own.
create policy players_read on players
  for select using (true);

-- Note what a player may NOT change about themselves: the KovaaK's username link is
-- written only by the Edge Function that verified it against KovaaK's, because a
-- self-asserted link would let anyone claim someone else's run history.
create policy players_update_self on players
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    and kovaaks_username is not distinct from (
      select p.kovaaks_username from players p where p.id = auth.uid()
    )
  );

-- Runs: a player inserts and reads their own. No update, no delete — history is
-- append-only, so a bad run cannot be quietly removed after the fact.
create policy runs_insert_self on runs
  for insert with check (auth.uid() = player_id);

create policy runs_read_self on runs
  for select using (auth.uid() = player_id);

-- Everything below is read-only to clients. Writes happen only via service role.
create policy verified_pbs_read_self on verified_pbs
  for select using (auth.uid() = player_id);

create policy baselines_read_self on baselines
  for select using (auth.uid() = player_id);

create policy ratings_read_all on ratings
  for select using (true);

create policy matches_read_participant on matches
  for select using (
    exists (
      select 1 from match_sides ms
      where ms.match_id = matches.id and ms.player_id = auth.uid()
    )
  );

create policy match_sides_read_participant on match_sides
  for select using (
    exists (
      select 1 from match_sides mine
      where mine.match_id = match_sides.match_id and mine.player_id = auth.uid()
    )
  );

create policy tracked_benchmarks_all_self on tracked_benchmarks
  for all using (auth.uid() = player_id) with check (auth.uid() = player_id);

create policy quests_read_self on quests
  for select using (auth.uid() = player_id);

-- ---------------------------------------------------------------------------
-- triggers
-- ---------------------------------------------------------------------------

-- The client uploads a scenario NAME and nothing else; the server decides what that
-- resolves to. Letting a client nominate a scenario_id would let it file a run against
-- whichever scenario flattered it most.
create or replace function resolve_scenario_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select id into new.scenario_id
  from scenarios
  where name = new.scenario_name;

  -- An unknown scenario is stored with a null scenario_id rather than rejected:
  -- players run plenty of non-benchmark scenarios, and that history is still useful.
  return new;
end;
$$;

create trigger runs_resolve_scenario
  before insert on runs
  for each row execute function resolve_scenario_id();

-- Every player needs a rating row from the moment they exist, so matchmaking never
-- has to special-case a missing one.
create or replace function ensure_rating_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into ratings (player_id) values (new.id)
  on conflict (player_id) do nothing;
  return new;
end;
$$;

create trigger players_ensure_rating
  after insert on players
  for each row execute function ensure_rating_row();
