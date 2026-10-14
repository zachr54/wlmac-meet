-- =====================================================================
-- WLMAC Meet — Supabase schema (powerlifting meet scoring)
--
-- Runs in the SAME Supabase project as the WLMAC Fitness Club app: it reuses
-- that app's logins and its public.is_exec() helper. It only ADDS pl_* tables
-- and functions; nothing in the club app is changed.
--
-- SETUP: Project → SQL Editor → New query → paste this whole file → Run.
-- Safe to run more than once.
--
-- WHO CAN DO WHAT
--   Execs (profiles.role = 'exec')  create and run meets, edit lifters/attempts.
--   Anyone with the meet code       can view the displays (read-only, via pl_get_meet).
--   Anyone with code + referee PIN  can send white/red (via pl_ref_decide).
-- The tables themselves are not readable without an exec login.
-- =====================================================================

create table if not exists public.pl_meets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  ref_pin text not null,
  name text not null,
  meet_date date not null default current_date,
  settings jsonb not null default '{}'::jsonb,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.pl_lifters (
  id uuid primary key default gen_random_uuid(),
  meet_id uuid not null references public.pl_meets(id) on delete cascade,
  name text not null,
  sex text not null default 'M' check (sex in ('M','F')),
  bodyweight numeric(5,2),
  team text,
  flight text not null default 'A',
  lot int,
  rack_squat text,
  rack_bench text,
  -- three attempts per lift: w = weight in kg, r = 'good' | 'no' | null (not lifted yet)
  attempts jsonb not null default '{
    "squat":[{"w":null,"r":null},{"w":null,"r":null},{"w":null,"r":null}],
    "bench":[{"w":null,"r":null},{"w":null,"r":null},{"w":null,"r":null}],
    "deadlift":[{"w":null,"r":null},{"w":null,"r":null},{"w":null,"r":null}]}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pl_lifters_meet_idx on public.pl_lifters (meet_id);

alter table public.pl_meets enable row level security;
alter table public.pl_lifters enable row level security;

drop policy if exists "pl_meets_exec" on public.pl_meets;
create policy "pl_meets_exec" on public.pl_meets for all using (public.is_exec()) with check (public.is_exec());
drop policy if exists "pl_lifters_exec" on public.pl_lifters;
create policy "pl_lifters_exec" on public.pl_lifters for all using (public.is_exec()) with check (public.is_exec());

grant select, insert, update, delete on public.pl_meets to authenticated;
grant select, insert, update, delete on public.pl_lifters to authenticated;

-- ---------- public read: everything a display needs, minus the referee PIN ----------
create or replace function public.pl_get_meet(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'meet', to_jsonb(m) - 'ref_pin',
    'lifters', coalesce((select jsonb_agg(to_jsonb(l) order by l.lot nulls last, l.name)
                         from public.pl_lifters l where l.meet_id = m.id), '[]'::jsonb),
    'serverNow', floor(extract(epoch from clock_timestamp()) * 1000))
  from public.pl_meets m where m.code = upper(p_code);
$$;

-- ---------- referees ----------
create or replace function public.pl_ref_check(p_code text, p_pin text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.pl_meets where code = upper(p_code) and ref_pin = p_pin);
$$;

-- One referee's white/red for the lifter on the platform. A referee can change their mind
-- until the third decision arrives; that reveals the lights and records the attempt
-- (two or more whites = good lift). p_lifter/p_attempt are what the referee's phone was
-- showing, so a late tap can't land on the next lifter.
create or replace function public.pl_ref_decide(
  p_code text, p_pin text, p_pos text, p_decision text, p_lifter uuid, p_attempt int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.pl_meets;
  v_lights jsonb;
  v_result text;
begin
  if p_pos not in ('left','head','right') or p_decision not in ('white','red') then
    raise exception 'Bad referee input';
  end if;
  select * into m from public.pl_meets where code = upper(p_code) for update;
  if not found or m.ref_pin <> p_pin then raise exception 'Wrong meet code or referee PIN'; end if;
  if m.state->>'lifterId' is null
     or (m.state->>'lifterId')::uuid <> p_lifter or (m.state->>'attempt')::int <> p_attempt then
    raise exception 'The platform has moved on';
  end if;
  if coalesce((m.state->>'revealed')::boolean, false) then raise exception 'Decision is already in'; end if;

  v_lights := coalesce(m.state->'lights', '{}'::jsonb) || jsonb_build_object(p_pos, p_decision);
  if v_lights ?& array['left','head','right'] then
    v_result := case when (select count(*) from jsonb_each_text(v_lights) where value = 'white') >= 2
                     then 'good' else 'no' end;
    update public.pl_lifters
      set attempts = jsonb_set(attempts, array[m.state->>'lift', (p_attempt - 1)::text, 'r'], to_jsonb(v_result))
      where id = p_lifter and meet_id = m.id;
    update public.pl_meets
      set state = state || jsonb_build_object('lights', v_lights, 'revealed', true, 'result', v_result)
      where id = m.id;
  else
    update public.pl_meets set state = state || jsonb_build_object('lights', v_lights) where id = m.id;
  end if;
  return v_lights;
end;
$$;

-- ---------- director writes (run as the caller, so RLS keeps them exec-only) ----------
-- Merge into the live state instead of overwriting it, so a director click can't
-- wipe out a referee decision that landed a moment earlier.
create or replace function public.pl_patch_state(p_meet uuid, p_patch jsonb)
returns void language sql security invoker set search_path = public as $$
  update public.pl_meets set state = state || p_patch where id = p_meet;
$$;

create or replace function public.pl_set_attempt(p_lifter uuid, p_lift text, p_idx int, p_weight numeric, p_result text)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if p_lift not in ('squat','bench','deadlift') or p_idx not between 0 and 2
     or (p_result is not null and p_result not in ('good','no')) then
    raise exception 'Bad attempt';
  end if;
  update public.pl_lifters
    set attempts = jsonb_set(attempts, array[p_lift, p_idx::text], jsonb_build_object('w', p_weight, 'r', p_result))
    where id = p_lifter;
end;
$$;

revoke execute on function public.pl_get_meet(text) from public;
revoke execute on function public.pl_ref_check(text, text) from public;
revoke execute on function public.pl_ref_decide(text, text, text, text, uuid, int) from public;
revoke execute on function public.pl_patch_state(uuid, jsonb) from public;
revoke execute on function public.pl_set_attempt(uuid, text, int, numeric, text) from public;
grant execute on function public.pl_get_meet(text) to anon, authenticated;
grant execute on function public.pl_ref_check(text, text) to anon, authenticated;
grant execute on function public.pl_ref_decide(text, text, text, text, uuid, int) to anon, authenticated;
grant execute on function public.pl_patch_state(uuid, jsonb) to authenticated;
grant execute on function public.pl_set_attempt(uuid, text, int, numeric, text) to authenticated;

-- ---------- live updates ----------
-- Every change pings the meet's broadcast channel ("pl:<CODE>"); screens re-read on the ping.
-- The ping carries no data, and a failed ping never blocks the write (screens also poll).
create or replace function public.pl_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_code text;
begin
  if tg_table_name = 'pl_meets' then
    if tg_op = 'DELETE' then v_code := old.code; else v_code := new.code; end if;
  elsif tg_op = 'DELETE' then
    select code into v_code from public.pl_meets where id = old.meet_id;
  else
    select code into v_code from public.pl_meets where id = new.meet_id;
  end if;
  if v_code is not null then
    begin
      perform realtime.send(jsonb_build_object('at', extract(epoch from clock_timestamp())), 'changed', 'pl:' || v_code, false);
    exception when others then null;
    end;
  end if;
  return null;
end;
$$;
revoke execute on function public.pl_notify() from public;

drop trigger if exists trg_pl_meets_notify on public.pl_meets;
create trigger trg_pl_meets_notify after insert or update or delete on public.pl_meets
for each row execute function public.pl_notify();
drop trigger if exists trg_pl_lifters_notify on public.pl_lifters;
create trigger trg_pl_lifters_notify after insert or update or delete on public.pl_lifters
for each row execute function public.pl_notify();

-- =====================================================================
-- Club app link
--
-- Ties powerlifting meets to the club app's events (run the club app's
-- supabase-schema.sql first; this section uses its events, rsvps and profiles).
--   * A "Powerlifting" event made in the club app gets a meet here, and a meet
--     made here shows up on the club app's schedule. Name and date stay in sync.
--   * Members who sign up for the event are added to the meet's lifters by name
--     (with their grade as the team); sex, bodyweight and openers are entered later.
--     Cancelling a sign-up removes the lifter again, unless they have already lifted.
--   * Deleting the meet deletes its event. Deleting the event deletes the meet only
--     if nobody has lifted yet; otherwise the meet is kept, just unlinked.
-- Safe to run more than once.
-- =====================================================================

alter table public.pl_meets add column if not exists event_id uuid unique references public.events(id) on delete set null;
alter table public.pl_lifters add column if not exists profile_id uuid references public.profiles(id) on delete set null;
create unique index if not exists pl_lifters_meet_profile_idx on public.pl_lifters (meet_id, profile_id);

-- Same alphabets as PL.newCode / PL.newPin in js/backend.js.
create or replace function public.pl_random(p_alphabet text, p_len int)
returns text language sql volatile set search_path = public as $$
  select string_agg(substr(p_alphabet, 1 + get_byte(uuid_send(gen_random_uuid()), 0) % length(p_alphabet), 1), '')
  from generate_series(1, p_len);
$$;

-- A new meet with the director's default settings (PL.DEFAULT_SETTINGS / PL.newState).
create or replace function public.pl_meet_for_event(p_event public.events)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_id uuid;
begin
  loop
    v_code := public.pl_random('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6);
    exit when not exists (select 1 from public.pl_meets where code = v_code);
  end loop;
  insert into public.pl_meets (code, ref_pin, name, meet_date, event_id, settings, state)
  values (v_code, public.pl_random('0123456789', 6), p_event.name, p_event.event_date, p_event.id,
    '{"format":"sbd","lifts":["squat","bench","deadlift"],"barKg":20,"collarKg":2.5,"clockSeconds":60,"equipped":false}',
    '{"lift":"squat","attempt":1,"flight":"A","lifterId":null,"lights":{},"revealed":false,"result":null,
      "timer":{"running":false,"endsAt":0,"remainingMs":60000}}')
  returning id into v_id;
  return v_id;
end;
$$;

-- Has any attempt been judged (in the whole meet, or for one lifter)?
create or replace function public.pl_has_results(p_meet uuid, p_profile uuid default null)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.pl_lifters l, jsonb_each(l.attempts) a, jsonb_array_elements(a.value) x
    where l.meet_id = p_meet and (p_profile is null or l.profile_id = p_profile) and x->>'r' is not null);
$$;

-- Add an event's sign-ups (or just one member's) to its meet. A lifter the director already
-- typed in under the same name is linked rather than added twice.
create or replace function public.pl_add_signups(p_meet uuid, p_event uuid, p_profile uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.pl_lifters l set profile_id = p.id
    from public.rsvps r join public.profiles p on p.id = r.profile_id
    where r.event_id = p_event and (p_profile is null or r.profile_id = p_profile)
      and l.meet_id = p_meet and l.profile_id is null and lower(trim(l.name)) = lower(trim(p.name))
      and not exists (select 1 from public.pl_lifters x where x.meet_id = p_meet and x.profile_id = p.id);
  insert into public.pl_lifters (meet_id, profile_id, name, team, lot)
    select p_meet, p.id, p.name, p.grade,
           coalesce((select max(lot) from public.pl_lifters where meet_id = p_meet), 0) + row_number() over (order by r.created_at)
    from public.rsvps r join public.profiles p on p.id = r.profile_id
    where r.event_id = p_event and (p_profile is null or r.profile_id = p_profile)
      and not exists (select 1 from public.pl_lifters x where x.meet_id = p_meet and x.profile_id = p.id);
end;
$$;

-- The sync triggers skip changes made by other triggers (pg_trigger_depth() > 1): that is how
-- they keep from echoing each other, and it ignores the club app's sign-up counter updates.
-- pl.syncing = 'on' switches them off for the rest of a transaction (used by the backfill below).
create or replace function public.pl_sync_off()
returns boolean language sql stable set search_path = public as $$
  select pg_trigger_depth() > 1 or coalesce(current_setting('pl.syncing', true), '') = 'on';
$$;

create or replace function public.pl_sync_from_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m public.pl_meets;
begin
  if public.pl_sync_off() then
    return case when tg_op = 'DELETE' then old else null end;
  end if;
  if tg_op = 'DELETE' then
    delete from public.pl_meets where event_id = old.id and not public.pl_has_results(id);
    return old;
  end if;
  select * into m from public.pl_meets where event_id = new.id;
  if found then
    if m.name is distinct from new.name or m.meet_date is distinct from new.event_date then
      update public.pl_meets set name = new.name, meet_date = new.event_date where id = m.id;
    end if;
  elsif new.kind = 'Powerlifting' then
    perform public.pl_add_signups(public.pl_meet_for_event(new), new.id);
  end if;
  return null;
end;
$$;

create or replace function public.pl_sync_from_meet()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event uuid;
begin
  if public.pl_sync_off() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.event_id is null then
      insert into public.events (name, kind, event_date) values (new.name, 'Powerlifting', new.meet_date)
      returning id into v_event;
      new.event_id := v_event;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.event_id is not null and (new.name is distinct from old.name or new.meet_date is distinct from old.meet_date) then
      update public.events set name = new.name, event_date = new.meet_date where id = new.event_id;
    end if;
  elsif old.event_id is not null then
    delete from public.events where id = old.event_id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.pl_sync_from_rsvp()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_meet uuid;
begin
  if public.pl_sync_off() then return null; end if;
  if tg_op = 'INSERT' then
    select id into v_meet from public.pl_meets where event_id = new.event_id;
    if found then perform public.pl_add_signups(v_meet, new.event_id, new.profile_id); end if;
  else
    select id into v_meet from public.pl_meets where event_id = old.event_id;
    if found and not public.pl_has_results(v_meet, old.profile_id) then
      delete from public.pl_lifters where meet_id = v_meet and profile_id = old.profile_id;
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_pl_event_sync on public.events;
create trigger trg_pl_event_sync after insert or update on public.events
for each row execute function public.pl_sync_from_event();
-- Before delete: the meet's event_id is still set, so the meet can be found.
drop trigger if exists trg_pl_event_delete_sync on public.events;
create trigger trg_pl_event_delete_sync before delete on public.events
for each row execute function public.pl_sync_from_event();
drop trigger if exists trg_pl_meet_sync on public.pl_meets;
create trigger trg_pl_meet_sync before insert or update on public.pl_meets
for each row execute function public.pl_sync_from_meet();
-- After delete: the meet row is gone, so the event's "on delete set null" has nothing to update.
drop trigger if exists trg_pl_meet_delete_sync on public.pl_meets;
create trigger trg_pl_meet_delete_sync after delete on public.pl_meets
for each row execute function public.pl_sync_from_meet();
drop trigger if exists trg_pl_rsvp_sync on public.rsvps;
create trigger trg_pl_rsvp_sync after insert or delete on public.rsvps
for each row execute function public.pl_sync_from_rsvp();

-- Helpers are for the triggers only, not for calling from the apps.
revoke execute on function public.pl_random(text, int) from public, anon, authenticated;
revoke execute on function public.pl_meet_for_event(public.events) from public, anon, authenticated;
revoke execute on function public.pl_sync_off() from public, anon, authenticated;
revoke execute on function public.pl_has_results(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.pl_add_signups(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.pl_sync_from_event() from public, anon, authenticated;
revoke execute on function public.pl_sync_from_meet() from public, anon, authenticated;
revoke execute on function public.pl_sync_from_rsvp() from public, anon, authenticated;

-- Link what's already scheduled: upcoming powerlifting events get a meet (with their
-- sign-ups), and upcoming meets get an event. Past ones are left alone.
do $$
declare
  e public.events;
  m public.pl_meets;
  v_event uuid;
begin
  for e in select * from public.events ev
           where ev.kind = 'Powerlifting' and ev.event_date >= current_date
             and not exists (select 1 from public.pl_meets where event_id = ev.id) loop
    perform public.pl_add_signups(public.pl_meet_for_event(e), e.id);
  end loop;
  perform set_config('pl.syncing', 'on', true);
  for m in select * from public.pl_meets where event_id is null and meet_date >= current_date loop
    insert into public.events (name, kind, event_date) values (m.name, 'Powerlifting', m.meet_date) returning id into v_event;
    update public.pl_meets set event_id = v_event where id = m.id;
  end loop;
  perform set_config('pl.syncing', '', true);
end;
$$;
