-- 0012_report_gaps.sql
-- Gaps found while building the packs and gates (M6 integration notes).

-- chain_anchors: append-only, except that the external timestamp may be attached once.
alter table public.chain_anchors
  add column if not exists timestamp_provider text,
  add column if not exists timestamped_at timestamptz,
  add column if not exists timestamp_token_sha256 text;
drop trigger if exists t_chain_anchors_append_only on public.chain_anchors;
create or replace function public.chain_anchors_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'chain_anchors is append-only' using errcode = '42501';
  end if;
  if old.timestamp_token_path is not null then
    raise exception 'anchor % already carries a timestamp token', old.id using errcode = '42501';
  end if;
  if row(new.id, new.community_id, new.covers_until, new.tables, new.row_counts, new.merkle_root, new.previous_root, new.created_at)
     is distinct from
     row(old.id, old.community_id, old.covers_until, old.tables, old.row_counts, old.merkle_root, old.previous_root, old.created_at) then
    raise exception 'only the timestamp token fields may be set on chain_anchors' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger t_chain_anchors_guard before update or delete on public.chain_anchors for each row execute function public.chain_anchors_guard();

-- parameters may cite an archived legal source (statutory thresholds)
alter table public.parameters add column if not exists legal_source_ids text[] not null default '{}';

-- counterparty reply and dated refusal are first-class on review rows
alter table public.finding_reviews
  add column if not exists reply_text text,
  add column if not exists reply_received_on date,
  add column if not exists refused_on date;

-- pack kinds for the English twins
alter type public.report_kind add value if not exists 'auditor_en';
alter type public.report_kind add value if not exists 'lawyer_en';
alter type public.report_kind add value if not exists 'data_room_en';

-- counsel sign-off before distribution is recorded on the export
alter table public.report_exports
  add column if not exists approved_note text;

-- challengeable resolutions as of a given date (reproducible re-renders)
create or replace function public.challengeable_resolutions_as_of(cid uuid, as_of date)
returns table (resolution_id uuid, meeting_date date, fecha_notificacion date, punto text, kind public.resolution_kind,
               texto_resumen text, importe_aprobado numeric, challenge_3m_until date, challenge_12m_until date,
               open_3m boolean, open_12m boolean, notification_date_unknown boolean)
language sql stable as $$
  select r.id, m.fecha, m.fecha_notificacion, r.punto, r.kind, left(r.texto_literal, 200), r.importe_aprobado,
         r.challenge_3m_until, r.challenge_12m_until,
         r.challenge_3m_until >= as_of, r.challenge_12m_until >= as_of, m.fecha_notificacion is null
    from public.resolutions r join public.meetings m on m.id = r.meeting_id
   where r.community_id = cid
$$;
