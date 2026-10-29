-- Cornerstore: Organisationen, Mitarbeiter, Einladungen und gemeinsame Daten
-- Im Supabase-Dashboard unter "SQL Editor" einfügen und mit "Run" ausführen.
create extension if not exists pgcrypto;

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company jsonb not null default '{}',
  filialen jsonb not null default '[{"n":"Hauptfiliale","a":""}]',
  off jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table if not exists public.members (
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '',
  email text not null,
  admin boolean not null default false,
  roles jsonb not null default '{}',
  dash jsonb,
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);
create unique index if not exists members_one_store on public.members(user_id);
create table if not exists public.invites (
  code text primary key default encode(gen_random_bytes(9), 'hex'),
  store_id uuid not null references public.stores(id) on delete cascade,
  email text not null,
  name text not null default '',
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create table if not exists public.store_data (
  store_id uuid not null references public.stores(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (store_id, key)
);

alter table public.stores enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.store_data enable row level security;

create or replace function public.is_member(sid uuid) returns boolean
language sql security definer stable set search_path = public as
$$ select exists (select 1 from public.members where store_id = sid and user_id = auth.uid()) $$;
create or replace function public.is_admin(sid uuid) returns boolean
language sql security definer stable set search_path = public as
$$ select exists (select 1 from public.members where store_id = sid and user_id = auth.uid() and admin) $$;

drop policy if exists stores_select on public.stores;
create policy stores_select on public.stores for select using (public.is_member(id));
drop policy if exists stores_update on public.stores;
create policy stores_update on public.stores for update using (public.is_admin(id)) with check (public.is_admin(id));

drop policy if exists members_select on public.members;
create policy members_select on public.members for select using (public.is_member(store_id));
drop policy if exists members_update on public.members;
create policy members_update on public.members for update
  using (public.is_admin(store_id) or user_id = auth.uid())
  with check (public.is_admin(store_id) or user_id = auth.uid());
drop policy if exists members_delete on public.members;
create policy members_delete on public.members for delete using (public.is_admin(store_id) and user_id <> auth.uid());

drop policy if exists invites_all on public.invites;
create policy invites_all on public.invites for all using (public.is_admin(store_id)) with check (public.is_admin(store_id));

drop policy if exists data_select on public.store_data;
create policy data_select on public.store_data for select using (public.is_member(store_id));
drop policy if exists data_insert on public.store_data;
create policy data_insert on public.store_data for insert with check (public.is_member(store_id));
drop policy if exists data_update on public.store_data;
create policy data_update on public.store_data for update using (public.is_member(store_id)) with check (public.is_member(store_id));

-- Normale Mitarbeiter dürfen nur ihren Namen und ihr Dashboard ändern, nie Rolle oder Admin-Status.
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.store_id := old.store_id; new.user_id := old.user_id; new.email := old.email;
  if not public.is_admin(old.store_id) then new.admin := old.admin; new.roles := old.roles; end if;
  return new;
end $$;
drop trigger if exists members_guard on public.members;
create trigger members_guard before update on public.members for each row execute function public.members_guard();

-- "Neue Organisation erstellen": Wer sie anlegt, wird Admin.
create or replace function public.create_store(store_name text, my_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare sid uuid; em text;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'Du gehörst schon zu einer Organisation'; end if;
  select email into em from auth.users where id = auth.uid();
  insert into public.stores(name) values (coalesce(nullif(trim(store_name), ''), 'Meine Organisation')) returning id into sid;
  insert into public.members(store_id, user_id, name, email, admin)
    values (sid, auth.uid(), coalesce(nullif(trim(my_name), ''), split_part(em, '@', 1)), em, true);
  return sid;
end $$;

-- Einladung annehmen: nur mit der E-Mail-Adresse, für die sie erstellt wurde.
create or replace function public.accept_invite(invite_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv public.invites; em text;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'Du gehörst schon zu einer Organisation'; end if;
  select * into inv from public.invites where code = invite_code and used_at is null;
  if not found then raise exception 'Einladung ungültig oder schon benutzt'; end if;
  select email into em from auth.users where id = auth.uid();
  if lower(inv.email) <> lower(em) then raise exception 'Diese Einladung gehört zu einer anderen E-Mail-Adresse'; end if;
  insert into public.members(store_id, user_id, name, email)
    values (inv.store_id, auth.uid(), coalesce(nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''), nullif(inv.name, ''), split_part(em, '@', 1)), em);
  update public.invites set used_at = now() where code = inv.code;
  return inv.store_id;
end $$;

revoke all on function public.create_store(text, text) from public, anon;
revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.create_store(text, text) to authenticated;
grant execute on function public.accept_in
