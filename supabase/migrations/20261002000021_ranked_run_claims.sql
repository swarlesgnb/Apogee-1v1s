-- A byte-level CSV digest changes when whitespace changes. Reserve the ranked run's
-- player/scenario/end instant separately so cosmetic edits cannot replay it.
-- Existing duplicate rows remain evidence; reserve their identity without deleting
-- or rewriting any historical match result.
create table ranked_run_claims (
  player_id uuid not null references players(id) on delete cascade,
  scenario_id bigint not null references scenarios(id),
  played_at timestamptz not null,
  first_run_id uuid not null,
  primary key (player_id, scenario_id, played_at)
);
alter table ranked_run_claims enable row level security;
revoke all on ranked_run_claims from public, anon, authenticated;

insert into ranked_run_claims (player_id, scenario_id, played_at, first_run_id)
select distinct on (player_id, scenario_id, played_at)
  player_id, scenario_id, played_at, id
from runs where match_id is not null and scenario_id is not null
order by player_id, scenario_id, played_at, created_at, id;

-- created_at may belong to a history upload. Record the actual moment the server
-- attaches that row to a match; clients have no write grant on this new column.
alter table runs add column match_submitted_at timestamptz;
update runs set match_submitted_at = created_at where match_id is not null;
create index runs_match_submission_idx on runs (match_id, player_id, match_submitted_at, id)
  where match_id is not null;

create function claim_ranked_run() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare claimed uuid;
begin
  if tg_op = 'UPDATE' and old.match_id is not null then
    if new.match_id is distinct from old.match_id then
      raise exception 'a ranked run cannot move to another match' using errcode = '23505';
    end if;
    new.match_submitted_at := old.match_submitted_at;
    return new;
  end if;
  if new.match_id is null then
    new.match_submitted_at := null;
    return new;
  end if;

  new.match_submitted_at := clock_timestamp();
  if new.scenario_id is not null then
    insert into ranked_run_claims (player_id, scenario_id, played_at, first_run_id)
      values (new.player_id, new.scenario_id, new.played_at, new.id)
      on conflict do nothing;
    select first_run_id into claimed from ranked_run_claims
      where player_id = new.player_id and scenario_id = new.scenario_id and played_at = new.played_at;
    if claimed is distinct from new.id then
      raise exception 'this ranked run has already been submitted' using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function claim_ranked_run() from public, anon, authenticated;
-- PostgreSQL runs same-event triggers in name order. Resolve scenario_id first.
create trigger runs_zz_ranked_claim before insert or update on runs
  for each row execute function claim_ranked_run();

comment on column runs.match_submitted_at is
  'Server receipt time when attached to a match, preserved on subsequent updates.';
comment on table ranked_run_claims is
  'Reserved ranked run identities, including deleted run evidence. Does not authenticate client-supplied timestamps.';
comment on column runs.csv_sha256 is
  'Raw CSV byte digest. Ranked replay claims additionally reserve player/scenario/end instant, independent of CSV formatting.';
