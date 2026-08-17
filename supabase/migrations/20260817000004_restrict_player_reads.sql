-- Player profiles were world-readable.
--
-- The original policy was `for select using (true)`, which exposed every column of
-- every row to any anonymous caller: steam_id, kovaaks_username, and flags. That let
-- anyone enumerate the whole player base, join each account to its real Steam profile,
-- and read moderation state.
--
-- It was invisible because the deployment check that should have caught it asserted the
-- table was empty, so it passed against an empty table and tested nothing. It only
-- failed once a real account existed.
--
-- Nothing needs the permissive read. The only client-side reader is the desktop
-- session, which reads its own row; opponent display names reach the client through
-- find-match, which joins players with the service role and returns the name in its
-- response. Anything the client should see about another player is a decision the
-- server makes, which is the same rule the rest of the schema follows.

drop policy players_read on players;

create policy players_read_self on players
  for select using (auth.uid() = id);

-- Row-level security answers "which rows", not "which columns", so it cannot keep a
-- player from reading moderation state on the row it does grant them. Column
-- privileges are the right tool, and the default Supabase grant is table-wide SELECT,
-- so it has to be dropped before a narrower one is given.
revoke select on players from anon, authenticated;

-- Anon gets nothing: with the policy above it could match no rows anyway, and an
-- explicit revoke states the intent rather than relying on that coincidence.
grant select (
  id,
  steam_id,
  display_name,
  avatar_url,
  country,
  kovaaks_username,
  kovaaks_username_verified_at,
  created_at,
  last_seen_at
) on players to authenticated;

-- flags is deliberately absent. Moderation state must not be readable by its subject:
-- an account that can see under_review knows exactly when to stop. Only the service
-- role, which bypasses both RLS and column privileges, can read or write it.
comment on column players.flags is
  'Moderation state, e.g. {"suspect_runs": 3, "under_review": true}. Not granted to '
  'anon or authenticated: the subject of a review must not be able to read it.';
