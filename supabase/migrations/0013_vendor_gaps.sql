-- 0013_vendor_gaps.sql
-- Gaps found while building the vendor checks and related-party links (M5 integration notes).

-- links may point at another party (vendor <-> vendor coincidences) and carry structured detail
alter table public.party_links
  add column if not exists to_party_id uuid references public.parties(id),
  add column if not exists detail jsonb;
alter table public.party_links alter column to_role drop not null;
alter table public.party_links
  drop constraint if exists party_links_target_check,
  add constraint party_links_target_check check (to_role is not null or to_party_id is not null);

-- checks may reference the party they were run for
alter table public.external_checks
  add column if not exists party_id uuid references public.parties(id);
create index if not exists external_checks_party_idx on public.external_checks (community_id, party_id, check_type);

-- NIF pseudonym on parties (HMAC-SHA256 with the server secret), used for equality tests only
alter table public.parties add column if not exists nif_hmac text;
create index if not exists parties_nif_hmac_idx on public.parties (community_id, nif_hmac);

-- construction year (technical inspection obligations)
alter table public.communities add column if not exists building_year int;
