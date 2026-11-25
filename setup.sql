-- =====================================================================
-- Prom king and queen voting - full database setup
-- Paste into Supabase SQL Editor and run. Safe to run again (idempotent).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.candidates (
  id          bigint generated always as identity primary key,
  name        text    not null check (length(btrim(name)) > 0),
  category    text    not null check (category in ('dievca', 'chlapec')),
  sort_order  integer not null default 0,
  active      boolean not null default true
);

create table if not exists public.votes (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  device_id   uuid   not null unique,
  girl_id     bigint not null references public.candidates (id) on delete restrict,
  boy_id      bigint not null references public.candidates (id) on delete restrict
);

create index if not exists votes_girl_id_idx on public.votes (girl_id);
create index if not exists votes_boy_id_idx  on public.votes (boy_id);

-- Single-row settings table: the primary key can only ever be TRUE.
create table if not exists public.settings (
  id           boolean primary key default true check (id),
  voting_open  boolean not null default true
);

insert into public.settings (id, voting_open)
values (true, true)
on conflict (id) do nothing;

-- Organizers allowed to see results. Emails are compared case-insensitively.
create table if not exists public.admins (
  email  text primary key check (email = lower(btrim(email)))
);

-- ---------------------------------------------------------------------
-- Seed placeholder candidates (only when the table is empty, so a re-run
-- never duplicates them or overwrites real names added later).
-- ---------------------------------------------------------------------

insert into public.candidates (name, category, sort_order)
select v.name, v.category, v.sort_order
from (values
  ('Lucia Nováková',    'dievca',  1),
  ('Simona Kováčová',   'dievca',  2),
  ('Natália Horváthová','dievca',  3),
  ('Ema Vargová',       'dievca',  4),
  ('Kristína Tóthová',  'dievca',  5),
  ('Martin Novák',      'chlapec', 1),
  ('Tomáš Kováč',       'chlapec', 2),
  ('Jakub Horváth',     'chlapec', 3),
  ('Samuel Varga',      'chlapec', 4),
  ('Adam Tóth',         'chlapec', 5)
) as v (name, category, sort_order)
where not exists (select 1 from public.candidates);

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.candidates enable row level security;
alter table public.votes      enable row level security;
alter table public.settings   enable row level security;
alter table public.admins     enable row level security;

-- Table privileges: start from nothing, then grant only what is needed.
revoke all on public.candidates from anon, authenticated;
revoke all on public.votes      from anon, authenticated;
revoke all on public.settings   from anon, authenticated;
revoke all on public.admins     from anon, authenticated;

grant select on public.candidates to anon, authenticated;
grant select on public.settings   to anon, authenticated;
-- votes and admins: no direct access at all (only via SECURITY DEFINER RPCs).

drop policy if exists "read active candidates" on public.candidates;
create policy "read active candidates"
  on public.candidates for select
  to anon, authenticated
  using (active);

drop policy if exists "read settings" on public.settings;
create policy "read settings"
  on public.settings for select
  to anon, authenticated
  using (true);

-- No policies on votes / admins => RLS denies everything to anon/authenticated.

-- ---------------------------------------------------------------------
-- Functions
-- All SECURITY DEFINER functions use an empty search_path and fully
-- qualified names, so they cannot be hijacked by objects in other schemas.
-- ---------------------------------------------------------------------

-- Is the current authenticated user an organizer?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admins a
    where a.email = lower(coalesce(auth.email(), ''))
  );
$$;

-- Cast one vote per device.
-- Errors (in error.message) the client understands:
--   voting_closed, invalid_device, invalid_girl, invalid_boy, already_voted
create or replace function public.cast_vote(
  p_device_id uuid,
  p_girl_id   bigint,
  p_boy_id    bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_device_id is null then
    raise exception using errcode = 'PV001', message = 'invalid_device',
      detail = 'Missing device id.';
  end if;

  if not coalesce((select s.voting_open from public.settings s where s.id), false) then
    raise exception using errcode = 'PV002', message = 'voting_closed',
      detail = 'Voting is closed.';
  end if;

  if not exists (
    select 1 from public.candidates c
    where c.id = p_girl_id and c.category = 'dievca' and c.active
  ) then
    raise exception using errcode = 'PV003', message = 'invalid_girl',
      detail = 'Girl candidate is not valid or not active.';
  end if;

  if not exists (
    select 1 from public.candidates c
    where c.id = p_boy_id and c.category = 'chlapec' and c.active
  ) then
    raise exception using errcode = 'PV004', message = 'invalid_boy',
      detail = 'Boy candidate is not valid or not active.';
  end if;

  begin
    insert into public.votes (device_id, girl_id, boy_id)
    values (p_device_id, p_girl_id, p_boy_id);
  exception when unique_violation then
    raise exception using errcode = 'PV005', message = 'already_voted',
      detail = 'This device has already voted.';
  end;
end;
$$;

-- Results for organizers only.
-- Returns JSON:
-- { "total_voters": n, "voting_open": bool,
--   "candidates": [ {id, name, category, votes}, ... ] }
-- Candidates are sorted by votes desc, then name. Includes active candidates
-- with 0 votes and inactive candidates that still have votes.
create or replace function public.get_results()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'not_admin',
      detail = 'Only organizers can see results.';
  end if;

  with counts as (
    select c.id, c.name, c.category,
           (select count(*) from public.votes v
             where (c.category = 'dievca'  and v.girl_id = c.id)
                or (c.category = 'chlapec' and v.boy_id  = c.id))::int as votes,
           c.active
    from public.candidates c
  )
  select jsonb_build_object(
    'total_voters', (select count(*) from public.votes),
    'voting_open',  coalesce((select s.voting_open from public.settings s where s.id), false),
    'candidates',   coalesce((
      select jsonb_agg(
               jsonb_build_object('id', k.id, 'name', k.name,
                                  'category', k.category, 'votes', k.votes,
                                  'active', k.active)
               order by k.votes desc, k.name)
      from counts k
      where k.active or k.votes > 0
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

-- Open / close voting (organizers only). Returns the new state.
create or replace function public.set_voting_open(p_open boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'not_admin',
      detail = 'Only organizers can change voting state.';
  end if;

  if p_open is null then
    raise exception using errcode = '22004', message = 'invalid_value';
  end if;

  update public.settings set voting_open = p_open where id;
  return p_open;
end;
$$;

-- ---------------------------------------------------------------------
-- Function privileges (Supabase grants EXECUTE to anon by default,
-- so revoke explicitly and grant only what is needed).
-- ---------------------------------------------------------------------

revoke all on function public.is_admin()                        from public, anon, authenticated;
revoke all on function public.cast_vote(uuid, bigint, bigint)   from public, anon, authenticated;
revoke all on function public.get_results()                     from public, anon, authenticated;
revoke all on function public.set_voting_open(boolean)          from public, anon, authenticated;

grant execute on function public.cast_vote(uuid, bigint, bigint) to anon, authenticated;
grant execute on function public.is_admin()                      to authenticated;
grant execute on function public.get_results()                   to authenticated;
grant execute on function public.set_voting_open(boolean)        to authenticated;
