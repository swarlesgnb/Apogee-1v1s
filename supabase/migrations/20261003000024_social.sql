-- Social: the Apogee Daily board, and open challenges by code (docs/fleet/social.md).
--
-- Two additions, both server-authoritative and neither able to move a rating.
--
--   daily_results       one row per player per daily per band, written by daily-submit
--                       after it re-verifies the three runs and re-draws the day itself,
--                       and read by daily-board as a percentile. Nothing in rating,
--                       matchmaking or settlement reads it.
--   duels.code          a duel with a code and no named opponent: an open challenge.
--   open_duel_answers   who answered which open challenge, and with which match. Every
--                       such match is created with matches.rated = false.

-- ---------------------------------------------------------------------------
-- Apogee Daily
-- ---------------------------------------------------------------------------

create table daily_results (
  daily_number   integer not null check (daily_number between 1 and 99999),
  -- The band: the season window the day's three were drawn from.
  window_index   smallint not null check (window_index between 0 and 15),
  player_id      uuid not null references players (id) on delete cascade,
  -- The season whose pool was drawn, which is part of the seed (src/core/social/daily.ts).
  season_name    text not null check (length(season_name) between 1 and 200),
  -- Kept for audit and for the player's own view; daily-board never sends another
  -- player's row, only the distribution.
  scenario_names text[] not null,
  run_ids        uuid[] not null,
  scores         numeric[] not null,
  -- Zero where the round had no earlier run on the server (the run set its own baseline).
  baselines      numeric[] not null,
  -- Earlier runs on the server, per round, so "provisional" can be reconstructed.
  prior_runs     integer[] not null,
  -- One letter per round, in skill order: A above, N near, B below, F first run.
  glyphs         text not null check (glyphs ~ '^[ANBF]{3}$'),
  -- Mean delta over rounds with a baseline. Null when every round was a first run: such a
  -- row counts toward how many played and takes no place in the percentile.
  mean_delta     numeric,
  provisional    boolean not null,
  -- Lowest tier among the three runs, so the board can say what an entry rests on.
  lowest_tier    verification_tier not null,
  -- When the last of the three ended: inside the day by construction (daily-submit).
  played_at      timestamptz not null,
  created_at     timestamptz not null default now(),

  primary key (daily_number, window_index, player_id),
  constraint daily_three check (
    array_length(scenario_names, 1) = 3 and array_length(run_ids, 1) = 3 and
    array_length(scores, 1) = 3 and array_length(baselines, 1) = 3 and
    array_length(prior_runs, 1) = 3
  )
);

comment on table daily_results is
  'Apogee Daily board entries. Written by daily-submit from runs it re-verified, read by '
  'daily-board as a distribution, both under the service role. Moves no rating.';

-- The board: one band of one day, ordered by the figure the percentile is taken over.
create index daily_results_board_idx on daily_results (daily_number, window_index, mean_delta);
-- A player's own streak on the server.
create index daily_results_player_idx on daily_results (player_id, daily_number desc);

alter table daily_results enable row level security;
-- No policies, and grants revoked, as ghost_results: written and read under the service
-- role only. A client that could write here could put itself at the top of a board.
revoke all on daily_results from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Open challenges
-- ---------------------------------------------------------------------------

-- A duel either names its opponent or carries a code, never both and never neither. The
-- existing rows all name one and carry none, so the constraint holds for them as written.
alter table duels alter column challenged_id drop not null;
alter table duels add column code text;
alter table duels add constraint duels_code_shape check (code is null or code ~ '^[2-9A-HJKMNP-Z]{8}$');
alter table duels add constraint duels_named_or_open check ((challenged_id is null) = (code is not null));
create unique index duels_code_idx on duels (code) where code is not null;

comment on column duels.code is
  'Set for an open challenge: anyone signed in who has the code may answer it, each with '
  'an unrated match (open_duel_answers). Null for a duel addressed to a named player.';

-- duels_not_self (challenger_id <> challenged_id) passes for a null opponent, which is
-- right: an open challenge names nobody. Answering your own is refused by open-duel, and
-- by the check on open_duel_answers below as well.

create table open_duel_answers (
  duel_id     uuid not null references duels (id) on delete cascade,
  player_id   uuid not null references players (id) on delete cascade,
  -- The unrated contested match this answer created.
  match_id    uuid not null references matches (id) on delete cascade,
  created_at  timestamptz not null default now(),

  -- One answer per player per code: a second try at the same run set is a rematch the
  -- challenger did not offer.
  primary key (duel_id, player_id)
);

comment on table open_duel_answers is
  'Who answered which open challenge, with which unrated match. Written by open-duel '
  'under the service role.';

create index open_duel_answers_match_idx on open_duel_answers (match_id);

-- The answering match must be unrated and must not be the challenger's own, whatever the
-- function does. A trigger rather than a check because both facts live on other rows.
create function open_duel_answer_guard() returns trigger
language plpgsql as $$
declare
  rated_match boolean;
  challenger uuid;
begin
  select m.rated into rated_match from matches m where m.id = new.match_id;
  if rated_match is distinct from false then
    raise exception 'an open challenge is answered with an unrated match';
  end if;
  select d.challenger_id into challenger from duels d where d.id = new.duel_id and d.code is not null;
  if challenger is null then
    raise exception 'only an open challenge takes answers by code';
  end if;
  if challenger = new.player_id then
    raise exception 'a challenger cannot answer their own open challenge';
  end if;
  return new;
end;
$$;

create trigger open_duel_answer_guard before insert or update on open_duel_answers
  for each row execute function open_duel_answer_guard();

alter table open_duel_answers enable row level security;
revoke all on open_duel_answers from anon, authenticated;
revoke all on function open_duel_answer_guard() from public, anon, authenticated;
