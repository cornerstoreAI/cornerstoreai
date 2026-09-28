-- =====================================================================
-- CornerstoreAI – Datenbank
-- Einmal komplett im Supabase "SQL Editor" einfügen und auf "Run" klicken.
-- Das Skript darf auch mehrfach laufen (es überschreibt nichts Wichtiges).
-- =====================================================================

-- ---------- Profil (ein Eintrag pro Konto) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text default '',
  phone       text default '',
  shop_name   text default 'Mein Späti',
  street      text default '',
  zip         text default '',
  city        text default '',
  vat_id      text default '',
  retailers   text[] not null default array['Rewe','Edeka','Penny','Netto','Kaufland','Lidl','Aldi Süd','Metro','Selgros','Action'],
  notify      jsonb not null default '{"deals":true,"drops":true,"weekly":false}'::jsonb,
  net_default boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Neues Konto -> automatisch ein Profil anlegen
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Produkte ----------
create table if not exists public.products (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  unit        text not null default 'Stück',
  category    text not null default 'Sonstiges',
  ean         text,
  search_term text,              -- optional: Suchbegriff für die Angebotssuche
  vat_rate    numeric(4,2) not null default 19,
  created_at  timestamptz not null default now()
);
create unique index if not exists products_user_name on public.products (user_id, lower(name));

-- ---------- Großhändler, Vertragspartner, Hersteller ----------
create table if not exists public.vendors (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  prices_net  boolean not null default true,   -- Großhandelspreise sind meistens netto
  created_at  timestamptz not null default now()
);

create table if not exists public.vendor_prices (
  vendor_id   bigint not null references public.vendors(id) on delete cascade,
  product_id  bigint not null references public.products(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  price       numeric(10,2) not null,
  updated_at  timestamptz not null default now(),
  primary key (vendor_id, product_id)
);

-- ---------- Supermarktpreise (automatisch + manuell) ----------
-- ext_key: 'regular' = manueller Normalpreis, 'deal:JJJJ-MM-TT' = manuelles Angebot,
--          'mg:<id>' = automatisch gefundenes Prospekt-Angebot (marktguru)
create table if not exists public.retail_prices (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_id    bigint not null references public.products(id) on delete cascade,
  retailer      text not null,
  ext_key       text not null,
  price         numeric(10,2) not null,          -- Preis pro Einheit (brutto)
  regular_price numeric(10,2),                   -- Normalpreis pro Einheit, falls bekannt
  is_offer      boolean not null default false,
  valid_from    date,
  valid_to      date,
  source        text not null default 'manuell', -- 'manuell' | 'marktguru'
  title         text,                            -- Originaltext des Angebots
  pack_count    int not null default 1,          -- z. B. 20 bei "Kasten 20 x 0,5 l"
  pack_price    numeric(10,2),                   -- Preis der ganzen Packung
  hidden        boolean not null default false,  -- "falscher Treffer" ausgeblendet
  fetched_at    timestamptz not null default now(),
  unique (product_id, retailer, ext_key)
);
create index if not exists retail_prices_user on public.retail_prices (user_id);

-- ---------- Preisverlauf (ein Wert pro Produkt und Tag) ----------
create table if not exists public.price_history (
  product_id  bigint not null references public.products(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  day         date not null,
  best_price  numeric(10,2) not null,
  best_source text,
  primary key (product_id, day)
);

-- ---------- Einkaufsliste ----------
create table if not exists public.cart_items (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_id  bigint not null references public.products(id) on delete cascade,
  qty         text default '',
  note        text default '',
  checked     boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (user_id, product_id)
);

-- ---------- Protokoll des täglichen Preis-Abrufs ----------
create table if not exists public.collector_runs (
  id           bigint generated always as identity primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'läuft',
  offers_found int default 0,
  message      text
);

-- =====================================================================
-- Zugriffsregeln: Jeder sieht und ändert nur seine eigenen Daten.
-- (Der tägliche Preis-Abruf nutzt den geheimen Schlüssel und darf alles.)
-- =====================================================================
alter table public.profiles       enable row level security;
alter table public.products       enable row level security;
alter table public.vendors        enable row level security;
alter table public.vendor_prices  enable row level security;
alter table public.retail_prices  enable row level security;
alter table public.price_history  enable row level security;
alter table public.cart_items     enable row level security;
alter table public.collector_runs enable row level security;

drop policy if exists own_profile on public.profiles;
create policy own_profile on public.profiles for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists own_products on public.products;
create policy own_products on public.products for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists own_vendors on public.vendors;
create policy own_vendors on public.vendors for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists own_vendor_prices on public.vendor_prices;
create policy own_vendor_prices on public.vendor_prices for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.vendors v where v.id = vendor_id and v.user_id = auth.uid())
    and exists (select 1 from public.products p where p.id = product_id and p.user_id = auth.uid())
  );

drop policy if exists own_retail_prices on public.retail_prices;
create policy own_retail_prices on public.retail_prices for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.products p where p.id = product_id and p.user_id = auth.uid())
  );

drop policy if exists own_history on public.price_history;
create policy own_history on public.price_history for select to authenticated
  using (user_id = auth.uid());

drop policy if exists own_cart on public.cart_items;
create policy own_cart on public.cart_items for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.products p where p.id = product_id and p.user_id = auth.uid())
  );

drop policy if exists read_runs on public.collector_runs;
create policy read_runs on public.collector_runs for select to authenticated using (true);

-- Rechte für eingeloggte Nutzer (die Regeln oben schränken sie auf eigene Daten ein)
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles, public.products, public.vendors, public.vendor_prices,
  public.retail_prices, public.cart_items to authenticated;
grant select on public.price_history, public.collector_runs to authenticated;

-- Profile für Konten nachtragen, die schon vor diesem Skript existierten
insert into public.profiles (id) select id from auth.users on conflict do nothing;
