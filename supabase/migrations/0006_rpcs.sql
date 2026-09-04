-- 0006_rpcs.sql
-- Security-definer functions: audit logging, restricted reference data, unit attribution.

-- Log an access or change. Callable by any member; actor is the caller.
create or replace function public.log_access(
  cid uuid, act public.audit_action, etype text default null, eid uuid default null,
  before_j jsonb default null, after_j jsonb default null, why text default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare new_id bigint;
begin
  if not public.is_member(cid) and auth.uid() is not null then
    raise exception 'not a member of this community' using errcode = '42501';
  end if;
  insert into public.audit_log (community_id, actor_id, action, entity_type, entity_id, before, after, reason)
  values (cid, auth.uid(), act, etype, eid, before_j, after_j, why)
  returning id into new_id;
  return new_id;
end $$;

-- Upsert a reference person (president / family surnames / administrator principal).
-- Only the owner reviewer may call it. Family rows carry surnames only.
create or replace function public.upsert_reference_person(
  cid uuid, p_role public.reference_role, p_surname1 text, p_surname2 text, p_given text,
  p_addresses text[], p_iban_hmacs text[], p_nif_hmac text, p_dni_last3 text,
  p_source_document_ids uuid[], p_lawful_basis_note text)
returns uuid language plpgsql security definer set search_path = public, restricted, pg_temp as $$
declare rid uuid;
begin
  if auth.uid() is not null and not public.is_owner_reviewer(cid) then
    raise exception 'owner reviewer only' using errcode = '42501';
  end if;
  if p_role = 'president_family' then
    p_given := null; p_addresses := '{}'; p_nif_hmac := null; p_dni_last3 := null; p_iban_hmacs := '{}';
  end if;
  insert into restricted.reference_persons
    (community_id, role, surname1_norm, surname2_norm, given_norm, addresses_norm, iban_hmacs, nif_hmac, dni_last3, source_document_ids, lawful_basis_note)
  values (cid, p_role, public.norm_text(p_surname1), public.norm_text(p_surname2), public.norm_text(p_given),
          coalesce(p_addresses, '{}'), coalesce(p_iban_hmacs, '{}'), p_nif_hmac, p_dni_last3,
          coalesce(p_source_document_ids, '{}'), p_lawful_basis_note)
  returning id into rid;
  perform public.log_access(cid, 'edit', 'reference_person', rid, null, jsonb_build_object('role', p_role), 'upsert_reference_person');
  return rid;
end $$;

-- Equality-test material for the related-party rules: HMACs and normalised surname tokens only.
create or replace function public.reference_match_keys(cid uuid)
returns table (role public.reference_role, surname1_norm text, surname2_norm text, given_norm text,
               addresses_norm text[], iban_hmacs text[], nif_hmac text)
language sql security definer set search_path = public, restricted, pg_temp as $$
  select r.role, r.surname1_norm, r.surname2_norm, r.given_norm, r.addresses_norm, r.iban_hmacs, r.nif_hmac
    from restricted.reference_persons r
   where r.community_id = cid and (auth.uid() is null or public.is_reviewer(cid))
$$;

-- Register a payer -> unit key (from a derrama receipt, recibo or statement text).
create or replace function public.upsert_unit_payer_key(
  cid uuid, p_unit_id uuid, p_name_hmac text, p_iban_hmac text, p_mandate_hmac text,
  p_source_document_id uuid, p_valid_from date, p_valid_to date)
returns uuid language plpgsql security definer set search_path = public, restricted, pg_temp as $$
declare kid uuid;
begin
  if auth.uid() is not null and not public.is_reviewer(cid) then
    raise exception 'reviewer only' using errcode = '42501';
  end if;
  insert into restricted.unit_payer_keys (community_id, unit_id, payer_name_hmac, payer_iban_hmac, mandate_ref_hmac, source_document_id, valid_from, valid_to)
  values (cid, p_unit_id, p_name_hmac, p_iban_hmac, p_mandate_hmac, p_source_document_id, p_valid_from, p_valid_to)
  returning id into kid;
  return kid;
end $$;

-- Attribute owner credits to units by HMAC equality. Returns the number of rows updated.
create or replace function public.attribute_transaction_units(cid uuid)
returns int language plpgsql security definer set search_path = public, restricted, pg_temp as $$
declare n int;
begin
  if auth.uid() is not null and not public.is_reviewer(cid) then
    raise exception 'reviewer only' using errcode = '42501';
  end if;
  with cand as (
    select t.id as tx_id, k.unit_id
      from public.bank_transactions t
      join restricted.unit_payer_keys k
        on k.community_id = t.community_id
       and ( (k.payer_iban_hmac is not null and k.payer_iban_hmac = t.counterparty_iban_hmac)
          or (k.mandate_ref_hmac is not null and (k.mandate_ref_hmac = t.ref1 or k.mandate_ref_hmac = t.ref2)) )
       and (k.valid_from is null or k.valid_from <= t.fecha_operacion)
       and (k.valid_to is null or k.valid_to >= t.fecha_operacion)
     where t.community_id = cid and t.importe > 0 and t.unit_id is null
  ), one as (
    select tx_id, min(unit_id::text)::uuid as unit_id from cand group by tx_id having count(distinct unit_id) = 1
  )
  update public.bank_transactions t set unit_id = one.unit_id from one where t.id = one.tx_id;
  get diagnostics n = row_count;
  perform public.log_access(cid, 'rule_run', 'bank_transactions', null, null, jsonb_build_object('attributed', n), 'attribute_transaction_units');
  return n;
end $$;

-- Bootstrap: the service role creates the community and its first owner reviewer.
create or replace function public.bootstrap_community(p_name text, p_nif text, p_address text, p_owner_user uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare cid uuid;
begin
  if auth.uid() is not null then
    raise exception 'service role only' using errcode = '42501';
  end if;
  insert into public.communities (name, nif, address) values (p_name, p_nif, p_address) returning id into cid;
  if p_owner_user is not null then
    insert into public.community_members (user_id, community_id, role) values (p_owner_user, cid, 'owner_reviewer');
  end if;
  return cid;
end $$;
revoke execute on function public.bootstrap_community(text, text, text, uuid) from authenticated, anon;

-- Row hash helper for chain anchors (deterministic JSON of a row).
create or replace function public.row_hash(r anyelement)
returns text language sql immutable as $$
  select encode(digest(convert_to(to_jsonb(r)::text, 'UTF8'), 'sha256'), 'hex')
$$;
