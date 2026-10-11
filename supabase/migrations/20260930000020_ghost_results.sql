-- Ghost Mode's shareable results (docs/design/mechanics.md, "Server layer").
--
-- A ghost match is played and judged on the client, against the player's own past runs,
-- and moves nothing here: no rating, no season standing, no pool entry. What the client
-- cannot do is show somebody else a result, because a card it computed is a claim, and
-- nothing a client claims is shown to other people. So a card is minted by post-ghost,
-- which re-verifies the three live runs the way submit-run does, rebuilds each ghost and
-- baseline from the caller's stored runs with the same core code the client runs, and
-- judges it again. This table holds that, and only that.
--
-- A new table only. No season or existing table is altered, and nothing in rating,
-- matchmaking or settlement reads this one.

create type ghost_kind as enum ('month_ago', 'last_week', 'last_week_best');

create table ghost_results (
  id             uuid primary key default gen_random_uuid(),
  player_id      uuid not null references players (id) on delete cascade,
  -- Short, unguessable enough to share aloud, and the only handle anyone else gets.
  code           text not null unique,
  kind           ghost_kind not null,
  scenario_names text[] not null,
  live_run_ids   uuid[] not null,
  live_scores    numeric[] not null,
  ghost_scores   numeric[] not null,
  baselines      numeric[] not null,
  -- Best score before the match, per scenario: the card's "N% off your best" context.
  pbs            numeric[] not null,
  -- Local calendar day of the ghost session, per scenario: the player's day, not UTC's.
  ghost_days     date[] not null,
  -- getTimezoneOffset() on the player's machine when it was posted. Session days above
  -- were bucketed with it, and the card's streak counts local days with it, because a
  -- player west of UTC who wins at 9pm has won on that evening, not on tomorrow.
  tz_offset_minutes smallint not null check (tz_offset_minutes between -840 and 840),
  -- The IANA zone the post was read in. The offset alone is one moment's offset, and a
  -- card's history spans daylight-saving changes; each instant is read in this zone at
  -- its own offset (src/core/ghost/zone.ts).
  time_zone      text not null check (length(time_zone) between 1 and 64),
  margin         numeric not null,
  -- 'win' | 'loss' | 'draw'. The enum has no 'void' and does not need one: a voided
  -- ghost match has nothing to share, so post-ghost refuses it rather than storing it.
  verdict        match_result not null,
  -- Lowest tier among the three live runs, so the card can say what it rests on.
  live_tier      verification_tier not null,
  -- When the last live run ended. The card's streak counts the days matches were
  -- *played* on; created_at is when Share was pressed, which can be days later.
  played_at      timestamptz not null,
  created_at     timestamptz not null default now(),

  constraint ghost_three check (
    array_length(live_run_ids, 1) = 3 and array_length(scenario_names, 1) = 3 and
    array_length(live_scores, 1) = 3 and array_length(ghost_scores, 1) = 3 and
    array_length(baselines, 1) = 3 and array_length(ghost_days, 1) = 3 and
    array_length(pbs, 1) = 3
  ),
  -- Share codes are eight characters from a 31-letter alphabet with no 0/O or 1/I/L;
  -- see post-ghost. Anything else in this column was not minted by it.
  constraint ghost_code_shape check (code ~ '^[2-9A-HJKMNP-Z]{8}$'),
  -- One card per set of runs, so replaying the same three cannot mint a streak of cards.
  constraint ghost_runs_once unique (player_id, live_run_ids)
);

comment on table ghost_results is
  'Server-rebuilt Ghost Mode results, for sharing. Written by post-ghost, read by '
  'ghost-card, both under the service role. Moves no rating and is read by nothing '
  'that does.';

create index ghost_results_player_idx on ghost_results (player_id, played_at desc);

alter table ghost_results enable row level security;

-- No policies, and the grants revoked as well, the way rate_limits and the tournament
-- tables do it: written by post-ghost and read by ghost-card under the service role,
-- nothing else. RLS with no policy already refuses the client roles; the revoke states
-- it rather than leaving it to that.
revoke all on ghost_results from anon, authenticated;
