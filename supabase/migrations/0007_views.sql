-- 0007_views.sql
-- Versioned SQL views used by rules, screens and packs. security_invoker so RLS applies.

-- Control totals per fiscal year with the cut-off bridge.
create or replace view public.v_control_totals with (security_invoker = true) as
with liq as (
  select l.community_id, l.ejercicio as fiscal_year,
         sum(case when ll.side = 'gasto' then ll.importe end) as liq_expenses,
         sum(case when ll.side = 'ingreso' then ll.importe end) as liq_income,
         max(l.acreedores_pendientes) as closing_payables,
         max(l.retenciones_pendientes) as retentions_held,
         max(l.basis::text) as basis
    from public.liquidations l
    left join public.liquidation_lines ll on ll.liquidation_id = l.id
   group by 1, 2
), liq_prev as (
  select community_id, fiscal_year + 1 as fiscal_year, closing_payables as opening_payables from liq
), bank as (
  select t.community_id, public.fiscal_year(t.fecha_operacion, c.fy_start_month) as fiscal_year,
         sum(case when t.importe < 0 and t.tx_kind not in ('internal') then -t.importe end) as bank_debits,
         sum(case when t.importe > 0 and t.tx_kind = 'quota_in' then t.importe end) as owner_credits,
         sum(case when t.importe > 0 and t.tx_kind in ('subsidy', 'loan') then t.importe end) as external_credits
    from public.bank_transactions t
    join public.communities c on c.id = t.community_id
   group by 1, 2
), inv as (
  select i.community_id, public.fiscal_year(i.fecha_expedicion, c.fy_start_month) as fiscal_year,
         sum(i.total) as invoices_total, count(*) as invoice_count
    from public.invoices i
    join public.communities c on c.id = i.community_id
    join public.documents d on d.id = i.document_id
   where d.duplicate_of_document_id is null
   group by 1, 2
), years as (
  select community_id, fiscal_year from liq
  union select community_id, fiscal_year from bank
  union select community_id, fiscal_year from inv
)
select y.community_id, y.fiscal_year,
       liq.basis,
       liq.liq_expenses, bank.bank_debits, inv.invoices_total, inv.invoice_count,
       liq.liq_income, bank.owner_credits, bank.external_credits,
       liq_prev.opening_payables, liq.closing_payables, liq.retentions_held,
       -- bridge: liquidación expenses − bank debits ± cut-off items
       liq.liq_expenses - coalesce(bank.bank_debits, 0)
         - coalesce(liq.closing_payables, 0) + coalesce(liq_prev.opening_payables, 0)
         - coalesce(liq.retentions_held, 0) as bridged_difference,
       public.param(y.community_id, 'pm_ordinary', make_date(y.fiscal_year, 12, 31)) as pm_ordinary
  from years y
  left join liq on liq.community_id = y.community_id and liq.fiscal_year = y.fiscal_year
  left join liq_prev on liq_prev.community_id = y.community_id and liq_prev.fiscal_year = y.fiscal_year
  left join bank on bank.community_id = y.community_id and bank.fiscal_year = y.fiscal_year
  left join inv on inv.community_id = y.community_id and inv.fiscal_year = y.fiscal_year;

-- Opening balance of year N vs closing of N-1; closing vs bank statement balance at period end.
create or replace view public.v_year_balance_continuity with (security_invoker = true) as
select l.community_id, l.ejercicio as fiscal_year, l.id as liquidation_id,
       l.saldo_inicial, prev.saldo_final as prev_saldo_final,
       l.saldo_inicial - prev.saldo_final as opening_gap,
       l.saldo_final,
       (select sum(s.saldo_final) from public.bank_statements s
         join public.bank_accounts a on a.id = s.bank_account_id
        where s.community_id = l.community_id and s.periodo_hasta = l.periodo_hasta) as bank_saldo_at_close,
       l.saldo_en_poder_administrador,
       l.fondo_reserva_final,
       public.param(l.community_id, 'pm_ordinary', coalesce(l.periodo_hasta, make_date(l.ejercicio, 12, 31))) as pm_ordinary
  from public.liquidations l
  left join public.liquidations prev on prev.community_id = l.community_id and prev.ejercicio = l.ejercicio - 1;

-- Funding vs spend per works package.
create or replace view public.v_works_funding with (security_invoker = true) as
with certified as (
  select works_package_id, sum(amount) as certified_total
    from public.works_events where event_type in ('certification', 'final_certification') group by 1
), invoiced as (
  select i.works_package_id, sum(i.total) as invoiced_total, sum(case when i.is_extra then i.total else 0 end) as extras_total
    from public.invoices i join public.documents d on d.id = i.document_id
   where i.works_package_id is not null and d.duplicate_of_document_id is null
   group by 1
), paid as (
  select i.works_package_id, sum(rl.amount_matched) as paid_total
    from public.recon_links rl
    join public.invoices i on rl.from_type = 'invoice' and rl.from_id = i.id
   where rl.link_type = 'paid_by' and rl.status = 'accepted' and i.works_package_id is not null
   group by 1
), derr as (
  select d.works_package_id, sum(dl.paid) as derrama_collected, sum(dl.expected) as derrama_expected
    from public.derrama_ledger dl join public.derramas d on d.id = dl.derrama_id
   where d.works_package_id is not null group by 1
), subs as (
  select works_package_id, sum(case when paid_to_is_community then import_pagat else 0 end) as subsidy_received
    from public.subsidies where works_package_id is not null group by 1
), lns as (
  select works_package_id, sum(case when paid_to_is_community then principal else 0 end) as loan_received
    from public.loans where works_package_id is not null group by 1
)
select w.community_id, w.id as works_package_id, w.code, w.label, w.status,
       w.architect_pem, w.permit_pem, w.subsidy_protegible, w.contract_price,
       certified.certified_total, invoiced.invoiced_total, invoiced.extras_total, paid.paid_total,
       derr.derrama_expected, derr.derrama_collected, subs.subsidy_received, lns.loan_received,
       greatest(coalesce(w.contract_price, 0), coalesce(invoiced.invoiced_total, 0)) as committed,
       coalesce(derr.derrama_collected, 0) + coalesce(subs.subsidy_received, 0) + coalesce(lns.loan_received, 0) as available,
       greatest(coalesce(w.contract_price, 0), coalesce(invoiced.invoiced_total, 0))
         - (coalesce(derr.derrama_collected, 0) + coalesce(subs.subsidy_received, 0) + coalesce(lns.loan_received, 0)) as funding_gap,
       w.suspension_date, w.suspension_reason
  from public.works_packages w
  left join certified on certified.works_package_id = w.id
  left join invoiced on invoiced.works_package_id = w.id
  left join paid on paid.works_package_id = w.id
  left join derr on derr.works_package_id = w.id
  left join subs on subs.works_package_id = w.id
  left join lns on lns.works_package_id = w.id;

-- Resolutions still challengeable at the report date (CCCat 553-31, to verify).
create or replace view public.v_challengeable_resolutions with (security_invoker = true) as
select r.community_id, r.id as resolution_id, m.fecha as meeting_date, m.fecha_notificacion, r.punto, r.kind,
       left(r.texto_literal, 200) as texto_resumen, r.importe_aprobado,
       r.challenge_3m_until, r.challenge_12m_until,
       (r.challenge_3m_until >= current_date) as open_3m,
       (r.challenge_12m_until >= current_date) as open_12m,
       (m.fecha_notificacion is null) as notification_date_unknown
  from public.resolutions r join public.meetings m on m.id = r.meeting_id;

-- Limitation clocks per finding (descriptive; periods to verify against primary texts).
create or replace view public.v_limitation_clocks with (security_invoker = true) as
select f.community_id, f.id as finding_id, f.rule_code, f.act_date_first, f.act_date_last,
       (f.act_date_last + interval '10 years')::date as civil_general_until,
       (f.act_date_last + interval '3 years')::date as civil_periodic_until,
       (f.act_date_last + interval '5 years')::date as criminal_base_until,
       (f.act_date_last + interval '10 years')::date as criminal_aggravated_until
  from public.findings f where f.act_date_last is not null;

-- Document matrix: requested vs received per class and year, plus statement-month coverage.
create or replace view public.v_document_matrix with (security_invoker = true) as
select dr.community_id, dr.class, dr.fiscal_year, dr.status, dr.requested_on, dr.received_on,
       cardinality(dr.received_file_ids) as files_received, dr.request_evidence_file_id is not null as request_evidenced
  from public.document_requests dr;

create or replace view public.v_statement_coverage with (security_invoker = true) as
with bounds as (
  select s.community_id, s.bank_account_id, min(s.periodo_desde) as first_period, max(s.periodo_hasta) as last_period
    from public.bank_statements s group by 1, 2
), months as (
  select b.community_id, b.bank_account_id, gs::date as month_start
    from bounds b, generate_series(date_trunc('month', b.first_period), date_trunc('month', b.last_period), interval '1 month') gs
)
select m.community_id, m.bank_account_id, m.month_start,
       exists (select 1 from public.bank_statements s where s.bank_account_id = m.bank_account_id
                 and s.periodo_desde <= (m.month_start + interval '1 month' - interval '1 day')::date
                 and s.periodo_hasta >= m.month_start) as covered
  from months m;

-- Suspension status per works package.
create or replace view public.v_suspension_status with (security_invoker = true) as
select w.community_id, w.id as works_package_id, w.code, w.suspension_date, w.suspension_reason, w.contract_price,
       (select sum(amount) from public.works_events e where e.works_package_id = w.id and e.event_type in ('certification', 'final_certification') and e.event_date <= w.suspension_date) as certified_at_suspension,
       (select sum(i.total) from public.invoices i where i.works_package_id = w.id and i.fecha_expedicion <= w.suspension_date) as invoiced_at_suspension,
       (select sum(rl.amount_matched) from public.recon_links rl join public.invoices i on rl.from_type = 'invoice' and rl.from_id = i.id
          join public.bank_transactions t on rl.to_type = 'bank_transaction' and rl.to_id = t.id
         where rl.link_type = 'paid_by' and rl.status = 'accepted' and i.works_package_id = w.id and t.fecha_operacion <= w.suspension_date) as paid_at_suspension,
       (select sum(cm.importe) from public.contract_milestones cm join public.contracts c on c.id = cm.contract_id
         where c.works_package_id = w.id and cm.is_advance) as contractual_advances,
       (select count(*) from public.invoices i where i.works_package_id = w.id and i.fecha_expedicion > w.suspension_date) as invoices_after_suspension
  from public.works_packages w where w.suspension_date is not null;

-- Residual sets R1..R7
create or replace view public.v_r1_invoices_without_payment with (security_invoker = true) as
select i.community_id, i.id as invoice_id, i.vendor_party_id, i.fecha_expedicion, i.total, i.works_package_id
  from public.invoices i join public.documents d on d.id = i.document_id
 where d.duplicate_of_document_id is null
   and not exists (select 1 from public.recon_links rl where rl.from_type = 'invoice' and rl.from_id = i.id and rl.link_type = 'paid_by' and rl.status = 'accepted');

create or replace view public.v_r2_debits_without_invoice with (security_invoker = true) as
select t.community_id, t.id as bank_transaction_id, t.fecha_operacion, t.importe, t.tx_kind, t.counterparty_party_id, t.flags,
       (t.flags @> array['person_beneficiary']) as person_beneficiary
  from public.bank_transactions t
 where t.importe < 0
   and -t.importe > coalesce(public.param(t.community_id, 'outflow_min', t.fecha_operacion), 300)
   and t.tx_kind not in ('direct_debit_recurring', 'fee', 'tax', 'internal', 'interest', 'loan', 'returned')
   and not exists (select 1 from public.recon_links rl where rl.to_type = 'bank_transaction' and rl.to_id = t.id and rl.link_type in ('paid_by', 'refunds') and rl.status = 'accepted');

create or replace view public.v_r3_liquidation_lines_unsupported with (security_invoker = true) as
select ll.community_id, ll.id as liquidation_line_id, l.ejercicio, ll.concepto, ll.proveedor_text, ll.importe
  from public.liquidation_lines ll join public.liquidations l on l.id = ll.liquidation_id
 where ll.side = 'gasto'
   and not exists (select 1 from public.recon_links rl where rl.to_type = 'liquidation_line' and rl.to_id = ll.id and rl.link_type = 'reported_as' and rl.status = 'accepted');

create or replace view public.v_r4_spend_without_resolution with (security_invoker = true) as
select i.community_id, i.id as invoice_id, i.fecha_expedicion, i.total, i.works_package_id
  from public.invoices i join public.documents d on d.id = i.document_id
 where d.duplicate_of_document_id is null
   and i.total > coalesce(public.param(i.community_id, 'authority_threshold', i.fecha_expedicion), 1000)
   and not exists (select 1 from public.recon_links rl where rl.from_type = 'invoice' and rl.from_id = i.id and rl.link_type = 'authorised_by' and rl.status = 'accepted')
   and not exists (select 1 from public.recon_links rl join public.contracts c on rl.to_type = 'contract' and rl.to_id = c.id
                    where rl.from_type = 'invoice' and rl.from_id = i.id and rl.link_type = 'under_contract' and rl.status = 'accepted' and c.authorised_by_resolution_id is not null);

create or replace view public.v_r5_milestones_paid_without_invoice with (security_invoker = true) as
select cm.community_id, cm.id as milestone_id, cm.contract_id, cm.hito, cm.importe, cm.status
  from public.contract_milestones cm where cm.status in ('paid_without_invoice', 'overpaid');

create or replace view public.v_r6_derrama_residual with (security_invoker = true) as
select dl.community_id, dl.derrama_id, dl.unit_id, dl.period, dl.expected, dl.paid, dl.expected - dl.paid as residual, dl.basis, dl.status
  from public.derrama_ledger dl where dl.status in ('missing', 'partial', 'excess');

create or replace view public.v_r7_statement_months_missing with (security_invoker = true) as
select community_id, bank_account_id, month_start from public.v_statement_coverage where not covered;
