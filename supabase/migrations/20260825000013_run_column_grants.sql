-- A client could set its own verification tier, and that bypassed verification entirely.
--
-- Found by tools/attackRls.mjs and reproduced against these migrations before this file
-- existed. The chain: queue normally, then insert runs DIRECTLY via PostgREST rather
-- than through submit-run, with match_id set to the real match, score 999999 and
-- verification_tier 'verified'. settle-match reads the match's runs with the service
-- role and feeds run.score and run.verification_tier straight into the rating, so the
-- fabricated row settles as a Verified win. It skips the CSV parse, every local
-- integrity check, the KovaaK's cross-check, the csv_sha256 replay protection (the
-- attacker picks the hash) and the match-window timing check.
--
-- Why it existed: `runs` is deliberately not one of the tables clients hold no write
-- grant on, because first-run backfill inserts ~11k rows from the client. RLS answers
-- "which ROWS", never "which COLUMNS", so runs_insert_self (auth.uid() = player_id)
-- correctly stops inserting for somebody else and has nothing to say about which
-- columns get set. Column privileges are the tool for that, exactly as
-- 20260817000004 uses them for players.flags.

-- The default Supabase grant is table-wide, so it has to go before a narrower one is
-- given. Anon gets nothing: runs_insert_self could match no rows for it anyway, and an
-- explicit revoke states that rather than leaving it to the coincidence.
revoke insert on runs from anon, authenticated;

-- Exactly the columns the backfill upsert sends (RunPayload in src/core/sync/uploadRuns.ts
-- plus player_id, which src/app/api.ts sets from the session). Adding a field to
-- RunPayload without adding it here fails the whole batch with "permission denied for
-- column", which is loud, and the right way round: a new column is untrusted until
-- someone decides it is not.
grant insert (
  player_id,
  scenario_name,
  score,
  accuracy,
  avg_ttk,
  kills,
  hit_count,
  miss_count,
  played_at,
  challenge_start,
  hash,
  game_version,
  avg_fps,
  resolution,
  cm360,
  dpi,
  fov,
  csv_sha256,
  -- Sent as null by backfill and never read back from a client-inserted row: kill rows
  -- are only ever consulted for a run attached to a match, and match_id is not grantable
  -- below, so there is nothing a fabricated value here can reach.
  kill_rows
) on runs to authenticated;

-- submit-run and settle-match use the SERVICE ROLE, which bypasses column privileges as
-- well as RLS, so the server's own inserts are unaffected by any of this.

comment on column runs.match_id is
  'Set only by submit-run, under the service role. Not granted to authenticated: a run '
  'the client attaches to a match is a run that never went through verification.';

comment on column runs.verification_tier is
  'Decided server-side by submit-run. Not granted to authenticated, for the obvious '
  'reason - a tier the client can set is not a verification.';

-- scenario_id is absent too. resolve_scenario_id() overwrites it on insert regardless,
-- so this changes no behaviour; it makes the intent already written there - "letting a
-- client nominate a scenario_id would let it file a run against whichever scenario
-- flattered it most" - enforced rather than incidental. duration_seconds likewise:
-- 20260817000005 says outright the number has to come from the server's own read of the
-- file, because a client that could name its own duration could claim a full run was a
-- crash and take the void instead of the loss.

-- ---------------------------------------------------------------------------
-- and the same argument in the read direction
-- ---------------------------------------------------------------------------

-- verification_notes carries the reasons, advisories and hard failures behind a tier.
-- runs_read_self correctly lets a player read their own runs, and that hands the subject
-- of a review the list of precisely which checks caught them - the players.flags
-- argument from 20260817000004, one table over. Nothing client-side reads it.
revoke select on runs from anon, authenticated;

grant select (
  id,
  player_id,
  scenario_id,
  scenario_name,
  score,
  accuracy,
  avg_ttk,
  kills,
  hit_count,
  miss_count,
  played_at,
  challenge_start,
  hash,
  game_version,
  avg_fps,
  resolution,
  cm360,
  dpi,
  fov,
  csv_sha256,
  duration_seconds,
  match_id,
  -- The tier itself stays readable: the client filters rejected runs out of its own
  -- upload count, and a player being told their run did not count is honest. What
  -- stays hidden is which check said so.
  verification_tier,
  kill_rows,
  created_at
) on runs to authenticated;

comment on column runs.verification_notes is
  'Reasons, advisories and hard failures behind the tier. Not granted to anon or '
  'authenticated: naming the check that caught a run tells its author what to change.';
