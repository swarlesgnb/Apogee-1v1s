-- Admins, and the seasons they are allowed to edit.
--
-- Owning our own benchmarks (PLAN.md §14) means someone has to be able to change them,
-- and that someone can change what every player's rank means. A threshold edit is not
-- like other edits: raise Diamond on Pasu and everybody who was Diamond yesterday is
-- something else today, with no run played and nothing in their history to explain it.
--
-- So the editable thing is a *season*, and a season stops being editable the moment it
-- is published. Admins work on drafts; players only ever see published ones. That is
-- enforced here rather than in the app, because a rule this load-bearing should not
-- depend on the only client that respects it.

-- ---------------------------------------------------------------------------
-- admins
-- ---------------------------------------------------------------------------

create table admins (
  player_id  uuid primary key references players (id) on delete cascade,
  granted_at timestamptz not null default now(),
  -- Why this person has it, so the list stays explicable a year from now.
  note       text
);

alter table admins enable row level security;

-- An admin may see their own row, which is how the client knows to offer the editor.
-- Nobody may see the whole list, and nobody may write it from a client at all: the
-- first admin is granted with the service role (npm run grant:admin) and there is
-- deliberately no in-app path to granting more.
create policy admins_read_self on admins
  for select using (auth.uid() = player_id);

/**
 * Is this account an admin?
 *
 * SECURITY DEFINER so it can read `admins` from inside a policy on another table
 * without that policy having to grant access to the admin list itself. Without it,
 * every policy below would need its own subquery against a table clients cannot read.
 */
create or replace function is_admin(uid uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (select 1 from admins where player_id = uid);
$$;

-- ---------------------------------------------------------------------------
-- seasons
-- ---------------------------------------------------------------------------

create type season_status as enum ('draft', 'published', 'archived');

create table seasons (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  status       season_status not null default 'draft',

  -- When this season is the one being played. Null on a draft that has no dates yet.
  starts_at    timestamptz,
  ends_at      timestamptz,

  -- The season's own rank ladder: names ascending, and a colour per name. Owned here
  -- rather than borrowed, which is the point of the exercise.
  rank_names   text[] not null default '{}',
  rank_colors  jsonb  not null default '{}'::jsonb,

  -- Set once, when the season is published. Its presence is what makes it immutable.
  published_at timestamptz,
  created_by   uuid references players (id) on delete set null,
  created_at   timestamptz not null default now(),

  constraint seasons_dates_ordered check (
    starts_at is null or ends_at is null or ends_at > starts_at
  )
);

create index seasons_status_idx on seasons (status, starts_at desc);

-- The pool, and what each scenario is worth.
create table season_scenarios (
  season_id   uuid   not null references seasons (id) on delete cascade,
  scenario_id bigint not null references scenarios (id) on delete cascade,

  -- 'Clicking' | 'Tracking' | 'Switching'. The three ladders of PLAN.md §14.
  category    text   not null,

  -- Score thresholds per rank, ascending, one per entry in the season's rank_names.
  rank_maxes  numeric[] not null default '{}',

  primary key (season_id, scenario_id)
);

create index season_scenarios_season_idx on season_scenarios (season_id, category);

-- ---------------------------------------------------------------------------
-- a published season is immutable
-- ---------------------------------------------------------------------------

/**
 * Refuse edits to a published season.
 *
 * The whole value of freezing a season is that a player grinding toward a rank knows
 * the target will not move. A trigger is the right place for that: application code
 * can be bypassed by the next tool somebody writes against this database, and the
 * guarantee is supposed to hold for the data, not for one path into it.
 *
 * Archiving is allowed, because it changes which season is current without changing
 * what any past rank meant.
 */
create or replace function refuse_published_season_edit()
  returns trigger
  language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'published' then
      raise exception 'season % is published and cannot be deleted', old.id
        using hint = 'archive it instead, or edit the next draft';
    end if;
    return old;
  end if;

  if old.status = 'published' then
    -- Everything except the transition to archived is refused.
    if new.status = 'archived'
       and new.name is not distinct from old.name
       and new.rank_names is not distinct from old.rank_names
       and new.rank_colors is not distinct from old.rank_colors
       and new.starts_at is not distinct from old.starts_at
       and new.ends_at is not distinct from old.ends_at then
      return new;
    end if;

    raise exception 'season % is published and cannot be edited', old.id
      using hint = 'thresholds are frozen once published; edit the next draft instead';
  end if;

  return new;
end;
$$;

create trigger seasons_immutable_once_published
  before update or delete on seasons
  for each row execute function refuse_published_season_edit();

/** The same rule for the pool, which is where the thresholds actually live. */
create or replace function refuse_published_season_scenario_edit()
  returns trigger
  language plpgsql
as $$
declare
  season_state season_status;
begin
  select status into season_state
    from seasons
   where id = coalesce(new.season_id, old.season_id);

  if season_state = 'published' then
    raise exception 'season % is published; its scenarios cannot be changed',
      coalesce(new.season_id, old.season_id)
      using hint = 'edit the next draft instead';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger season_scenarios_immutable_once_published
  before insert or update or delete on season_scenarios
  for each row execute function refuse_published_season_scenario_edit();

-- ---------------------------------------------------------------------------
-- who may see and change what
-- ---------------------------------------------------------------------------

alter table seasons          enable row level security;
alter table season_scenarios enable row level security;

-- Players see published and archived seasons: those are the rules they are playing
-- under, and a rank nobody can inspect is a rank nobody can trust. Drafts are ours.
create policy seasons_read_published on seasons
  for select using (status <> 'draft' or is_admin(auth.uid()));

create policy season_scenarios_read_published on season_scenarios
  for select using (
    exists (
      select 1 from seasons s
      where s.id = season_scenarios.season_id
        and (s.status <> 'draft' or is_admin(auth.uid()))
    )
  );

-- Admins may work on drafts. The trigger above still refuses anything published, so
-- these policies grant the ability to edit a draft, never to rewrite history.
create policy seasons_write_admin on seasons
  for all using (is_admin(auth.uid())) with check (is_admin(auth.uid()));

create policy season_scenarios_write_admin on season_scenarios
  for all using (is_admin(auth.uid())) with check (is_admin(auth.uid()));

comment on table seasons is
  'A frozen benchmark definition: pool, thresholds and rank ladder, held still for its '
  'duration. Editable only while status = draft; publishing is one-way.';
