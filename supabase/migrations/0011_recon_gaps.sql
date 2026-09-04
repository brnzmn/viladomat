-- 0011_recon_gaps.sql
-- Columns the reconciliation engine needed and had to work around (see M3 integration notes).

alter table public.works_events
  add column if not exists violated_by_event_id uuid references public.works_events(id),
  add column if not exists ref_label text;

alter table public.work_certifications
  add column if not exists is_final boolean not null default false;

alter table public.permits
  add column if not exists outcome text not null default 'unknown'
    check (outcome in ('granted', 'denied', 'pending', 'unknown'));

alter table public.recon_links
  add column if not exists notes jsonb;

alter table public.subsidies
  add column if not exists application_date date,
  add column if not exists resolution_date date,
  add column if not exists payment_date date;

-- Controlled vocabulary for bank transaction flags (documentation + light validation).
create or replace function public.bank_tx_flags_check(flags text[])
returns boolean language sql immutable as $$
  select coalesce(flags <@ array['cash', 'bizum', 'card', 'cheque', 'person_beneficiary', 'foreign_iban', 'neobank',
                                 'round_amount', 'municipal_payee', 'structuring', 'advance_without_certification',
                                 'iban_reuse', 'returned', 'refund', 'unattributed_credit', 'reversal', 'direct_debit_recurring'], true)
$$;
alter table public.bank_transactions
  drop constraint if exists bank_transactions_flags_vocab,
  add constraint bank_transactions_flags_vocab check (public.bank_tx_flags_check(flags));

-- Ledger rows may be paid by several credits; keep the first in bank_transaction_id and list all here.
alter table public.derrama_ledger
  add column if not exists bank_transaction_ids uuid[] not null default '{}';
