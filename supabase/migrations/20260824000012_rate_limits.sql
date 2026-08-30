-- Rate limiting, for a ladder that is about to be public.
--
-- Until now the only caller was a known account. A public build changes the threat: a
-- script with a valid session can call submit-run in a loop, and every call parses a
-- CSV, runs verification and may reach out to KovaaK's servers. That is expensive for
-- us and rude to them, and none of the existing checks limit *how often* an otherwise
-- valid request may arrive.
--
-- State lives in Postgres rather than in the function, because Edge Functions are
-- stateless and run on many isolates at once: an in-memory counter would be per-isolate
-- and would therefore count a fraction of the real traffic.
--
-- MEASURED, not guessed. The limits the functions pass in are derived from the same
-- 11,058-run corpus every verification check was measured against - see the note on
-- consume_rate_limit below. A rate limit is a check that rejects, so it gets the same
-- treatment as every other check here: it must not fire on behaviour a real player has
-- actually produced.

create table rate_limits (
  player_id    uuid not null references players (id) on delete cascade,
  -- Which limit this row counts, e.g. 'submit-run'. Per action rather than per player,
  -- so a burst of one kind of call cannot lock a player out of a different one.
  action       text not null,
  window_start timestamptz not null default now(),
  count        integer not null default 0,

  primary key (player_id, action)
);

comment on table rate_limits is
  'Per-player, per-action request counters. Service role only: no client ever reads or '
  'writes this, and a client that could would be able to erase its own limit.';

alter table rate_limits enable row level security;

-- No policies at all, and the grants dropped as well. RLS with no policy already denies
-- everything, but the default Supabase table grant is broad enough that saying so
-- explicitly is worth the line.
revoke all on rate_limits from anon, authenticated;

-- ---------------------------------------------------------------------------
-- consume_rate_limit
-- ---------------------------------------------------------------------------
--
-- Records one request and answers whether it is allowed. A fixed window rather than a
-- sliding one: a sliding window needs every timestamp retained, and the extra precision
-- buys nothing at limits set well above real behaviour.
--
-- Atomic on purpose. `insert ... on conflict do update` takes a row lock, so two
-- requests arriving together are serialised and cannot both read the same count and
-- both decide they are under it. Read-then-write in the function would be exactly the
-- race a rate limit exists to survive.
--
-- WHERE THE LIMITS COME FROM. Measured over 11,606 real stats files:
--
--   shortest gap between consecutive genuine runs   2.0s
--   busiest genuine 60-second window                12 runs
--   busiest genuine 5-minute window                 28 runs
--
-- So any per-minute limit at or below 12 would reject behaviour this player has
-- actually produced. The callers pass 30/60s for submit-run - two and a half times the
-- observed maximum, which is 0 false positives against the corpus while still capping a
-- scripted caller at a rate that cannot exhaust anything.
create or replace function consume_rate_limit(
  p_player uuid,
  p_action text,
  p_limit  integer,
  p_window interval
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  insert into rate_limits (player_id, action, window_start, count)
  values (p_player, p_action, now(), 1)
  on conflict (player_id, action) do update
    set count = case
          when rate_limits.window_start < now() - p_window then 1
          else rate_limits.count + 1
        end,
        window_start = case
          when rate_limits.window_start < now() - p_window then now()
          else rate_limits.window_start
        end
  returning count into new_count;

  return new_count <= p_limit;
end;
$$;

comment on function consume_rate_limit is
  'Counts one request against a per-player, per-action fixed window and returns whether '
  'it is allowed. Atomic: the upsert row lock serialises concurrent callers.';

-- Only the service role calls this. A client able to call it directly could burn its
-- own budget, or another player''s, by passing someone else''s id.
revoke execute on function consume_rate_limit(uuid, text, integer, interval) from anon, authenticated;
