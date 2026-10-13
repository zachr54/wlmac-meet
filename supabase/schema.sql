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
