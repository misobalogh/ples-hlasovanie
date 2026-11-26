-- =====================================================================
-- Prom king and queen voting - full database setup (write-in names)
-- Paste into Supabase SQL Editor and run. Safe to run again (idempotent).
-- =====================================================================

create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------
-- Upgrade from the old version with a fixed candidate list.
-- Old votes reference candidate ids and cannot be converted.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'votes' and column_name = 'girl_id'
  ) then
    drop table public.votes;
  end if;
end;
$$;

drop function if exists public.cast_vote(uuid, bigint, bigint);
drop table if exists public.candidates;

-- ---------------------------------------------------------------------
-- Name normalization
-- "  Lucia  NOVAKOVA " , "Novakova Lucia" and the same with diacritics
-- all give the key "lucia novakova": lowercase, no diacritics, only a-z,
-- words sorted alphabetically (so first/last name order does not matter).
-- ---------------------------------------------------------------------

create or replace function public.name_key(p_first text, p_last text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(string_agg(w, ' ' order by w), '')
  from regexp_split_to_table(
         regexp_replace(
           lower(extensions.unaccent('extensions.unaccent'::regdictionary,
                 coalesce(p_first, '') || ' ' || coalesce(p_last, ''))),
           '[^a-z]+', ' ', 'g'),
         ' ') as w
  where w <> '';
$$;

-- Trim and collapse inner whitespace, keep the text as typed otherwise.
create or replace function public.clean_name(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g');
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.votes (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  device_id   uuid not null unique,
  girl_first  text not null,
  girl_last   text not null,
  girl_key    text not null check (girl_key <> ''),
  boy_first   text not null,
  boy_last    text not null,
  boy_key     text not null check (boy_key <> '')
);

create index if not exists votes_girl_key_idx on public.votes (girl_key);
create index if not exists votes_boy_key_idx  on public.votes (boy_key);

-- Organizer decisions: "alias_key is the same person as target_key".
create table if not exists public.name_merges (
  category    text not null check (category in ('dievca', 'chlapec')),
  alias_key   text not null,
  target_key  text not null,
  primary key (category, alias_key),
  check (alias_key <> target_key)
);

-- Names the organizers excluded from the results (jokes, teachers, ...).
create table if not exists public.hidden_names (
  category  text not null check (category in ('dievca', 'chlapec')),
  key       text not null,
  primary key (category, key)
);

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
-- Row Level Security and privileges
-- ---------------------------------------------------------------------

alter table public.votes        enable row level security;
alter table public.name_merges  enable row level security;
alter table public.hidden_names enable row level security;
alter table public.settings     enable row level security;
alter table public.admins       enable row level security;

revoke all on public.votes        from anon, authenticated;
revoke all on public.name_merges  from anon, authenticated;
revoke all on public.hidden_names from anon, authenticated;
revoke all on public.settings     from anon, authenticated;
revoke all on public.admins       from anon, authenticated;

grant select on public.settings to anon, authenticated;
-- Everything else: no direct access (only via SECURITY DEFINER RPCs).

drop policy if exists "read settings" on public.settings;
create policy "read settings"
  on public.settings for select
  to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------
-- Functions
-- All SECURITY DEFINER functions use an empty search_path and fully
-- qualified names, so they cannot be hijacked by objects in other schemas.
-- ---------------------------------------------------------------------

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
  p_device_id   uuid,
  p_girl_first  text,
  p_girl_last   text,
  p_boy_first   text,
  p_boy_last    text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  gf text := public.clean_name(p_girl_first);
  gl text := public.clean_name(p_girl_last);
  bf text := public.clean_name(p_boy_first);
  bl text := public.clean_name(p_boy_last);
begin
  if p_device_id is null then
    raise exception using errcode = 'PV001', message = 'invalid_device',
      detail = 'Missing device id.';
  end if;

  if not coalesce((select s.voting_open from public.settings s where s.id), false) then
    raise exception using errcode = 'PV002', message = 'voting_closed',
      detail = 'Voting is closed.';
  end if;

  -- Each part must contain at least one letter and be reasonably short.
  if length(gf) > 40 or length(gl) > 40
     or public.name_key(gf, '') = '' or public.name_key('', gl) = '' then
    raise exception using errcode = 'PV003', message = 'invalid_girl',
      detail = 'Girl first and last name are required.';
  end if;

  if length(bf) > 40 or length(bl) > 40
     or public.name_key(bf, '') = '' or public.name_key('', bl) = '' then
    raise exception using errcode = 'PV004', message = 'invalid_boy',
      detail = 'Boy first and last name are required.';
  end if;

  begin
    insert into public.votes (device_id, girl_first, girl_last, girl_key,
                              boy_first, boy_last, boy_key)
    values (p_device_id, gf, gl, public.name_key(gf, gl),
            bf, bl, public.name_key(bf, bl));
  exception when unique_violation then
    raise exception using errcode = 'PV005', message = 'already_voted',
      detail = 'This device has already voted.';
  end;
end;
$$;

-- Results for organizers only.
-- Returns JSON:
-- { "total_voters": n, "voting_open": bool,
--   "names": [ { category, key, votes, hidden,
--                variants: [ {key, text, count}, ... ] }, ... ] }
-- A group is one person after merges; variants are the spellings in it,
-- most common first. Groups are sorted by votes desc.
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

  with raw as (
    select 'dievca'::text as category, v.girl_key as key,
           v.girl_first || ' ' || v.girl_last as text
    from public.votes v
    union all
    select 'chlapec', v.boy_key, v.boy_first || ' ' || v.boy_last
    from public.votes v
  ),
  resolved as (
    select r.category, coalesce(m.target_key, r.key) as group_key, r.key, r.text
    from raw r
    left join public.name_merges m
      on m.category = r.category and m.alias_key = r.key
  ),
  variants as (
    select category, group_key, key, text, count(*)::int as n
    from resolved
    group by category, group_key, key, text
  ),
  groups as (
    select category, group_key, sum(n)::int as votes,
           jsonb_agg(jsonb_build_object('key', key, 'text', text, 'count', n)
                     order by n desc, text) as variants
    from variants
    group by category, group_key
  )
  select jsonb_build_object(
    'total_voters', (select count(*) from public.votes),
    'voting_open',  coalesce((select s.voting_open from public.settings s where s.id), false),
    'names', coalesce((
      select jsonb_agg(
               jsonb_build_object('category', g.category, 'key', g.group_key,
                                  'votes', g.votes, 'variants', g.variants,
                                  'hidden', h.key is not null)
               order by g.votes desc, g.group_key)
      from groups g
      left join public.hidden_names h
        on h.category = g.category and h.key = g.group_key
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

-- Merge one name group into another (organizers only).
create or replace function public.merge_names(p_category text, p_from_key text, p_to_key text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target text;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'not_admin';
  end if;
  if p_category not in ('dievca', 'chlapec') or p_from_key is null or p_to_key is null then
    raise exception using errcode = '22023', message = 'invalid_value';
  end if;

  -- Merge into the final group of p_to_key, never into an alias.
  select coalesce(
    (select m.target_key from public.name_merges m
      where m.category = p_category and m.alias_key = p_to_key),
    p_to_key)
  into target;

  if target = p_from_key then
    return; -- already the same group
  end if;

  -- Everything that pointed to p_from_key now points to the new target.
  update public.name_merges
     set target_key = target
   where category = p_category and target_key = p_from_key;

  insert into public.name_merges (category, alias_key, target_key)
  values (p_category, p_from_key, target)
  on conflict (category, alias_key) do update set target_key = excluded.target_key;

  -- A merged group cannot stay hidden on its own.
  delete from public.hidden_names where category = p_category and key = p_from_key;
end;
$$;

-- Split one spelling (key) back out of the group it was merged into.
create or replace function public.unmerge_name(p_category text, p_key text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'not_admin';
  end if;
  delete from public.name_merges where category = p_category and alias_key = p_key;
end;
$$;

-- Exclude a name group from the results, or bring it back.
create or replace function public.set_name_hidden(p_category text, p_key text, p_hidden boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'not_admin';
  end if;
  if p_category not in ('dievca', 'chlapec') or p_key is null or p_hidden is null then
    raise exception using errcode = '22023', message = 'invalid_value';
  end if;
  if p_hidden then
    insert into public.hidden_names (category, key) values (p_category, p_key)
    on conflict do nothing;
  else
    delete from public.hidden_names where category = p_category and key = p_key;
  end if;
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

revoke all on function public.name_key(text, text)                     from public, anon, authenticated;
revoke all on function public.clean_name(text)                         from public, anon, authenticated;
revoke all on function public.is_admin()                               from public, anon, authenticated;
revoke all on function public.cast_vote(uuid, text, text, text, text)  from public, anon, authenticated;
revoke all on function public.get_results()                            from public, anon, authenticated;
revoke all on function public.merge_names(text, text, text)            from public, anon, authenticated;
revoke all on function public.unmerge_name(text, text)                 from public, anon, authenticated;
revoke all on function public.set_name_hidden(text, text, boolean)     from public, anon, authenticated;
revoke all on function public.set_voting_open(boolean)                 from public, anon, authenticated;

grant execute on function public.cast_vote(uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.is_admin()                              to authenticated;
grant execute on function public.get_results()                           to authenticated;
grant execute on function public.merge_names(text, text, text)           to authenticated;
grant execute on function public.unmerge_name(text, text)                to authenticated;
grant execute on function public.set_name_hidden(text, text, boolean)    to authenticated;
grant execute on function public.set_voting_open(boolean)                to authenticated;

-- Tell the Supabase REST API (PostgREST) to pick up the new tables/functions now.
notify pgrst, 'reload schema';
