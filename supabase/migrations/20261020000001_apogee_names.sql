-- Keep a chosen Apogee name when Steam's profile lookup fails or a player signs in again.
alter table public.players add column if not exists apogee_name text
  check (apogee_name is null or (char_length(apogee_name) between 2 and 32
    and apogee_name = btrim(apogee_name) and apogee_name !~ '[[:cntrl:]]'));

create or replace function public.preserve_apogee_name() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.apogee_name is not null then new.display_name := new.apogee_name; end if;
  return new;
end;
$$;
revoke all on function public.preserve_apogee_name() from public, anon, authenticated;
create or replace trigger preserve_apogee_name before insert or update on public.players
for each row execute function public.preserve_apogee_name();

-- A narrow self-edit operation: no player id, Steam identity, rating, or flags as input.
create or replace function public.set_apogee_name(new_name text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  caller uuid := auth.uid();
  chosen text := btrim(new_name);
begin
  if caller is null then raise exception 'Sign in with Steam first.' using errcode = '28000'; end if;
  if chosen is null or char_length(chosen) not between 2 and 32 or chosen ~ '[[:cntrl:]]' then
    raise exception 'Use 2–32 characters without line breaks or control characters.' using errcode = '22023';
  end if;
  update public.players set apogee_name = chosen, display_name = chosen where id = caller;
  if not found then raise exception 'Your player profile was not found.'; end if;
  return chosen;
end;
$$;
revoke all on function public.set_apogee_name(text) from public, anon;
grant execute on function public.set_apogee_name(text) to authenticated;
notify pgrst, 'reload schema';
