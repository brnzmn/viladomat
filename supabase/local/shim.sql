-- Local-only shim so the migrations apply on a plain PostgreSQL (no Supabase services).
-- Never apply this on a Supabase project. scripts/db-local.sh applies it automatically when
-- auth.uid() is missing.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create schema if not exists storage;

-- auth.uid(): reads the JWT subject from a session setting, like Supabase does.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz default now()
);

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare parts text[];
begin
  select string_to_array(name, '/') into parts;
  return parts[1:array_length(parts, 1) - 1];
end $$;
create or replace function storage.filename(name text) returns text language plpgsql immutable as $$
declare parts text[];
begin
  select string_to_array(name, '/') into parts;
  return parts[array_length(parts, 1)];
end $$;

grant usage on schema auth, storage to anon, authenticated, service_role;
grant all on all tables in schema storage to authenticated, service_role;

-- Supabase resolves unqualified names through "$user", public, extensions; mirror it locally so
-- extension types (citext) and functions keep resolving after 0014 moves them out of public.
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
do $$ begin
  execute format('alter database %I set search_path = "$user", public, extensions', current_database());
end $$;
