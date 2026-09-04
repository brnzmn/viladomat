import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type pg from 'pg';
import { defaultParameters, type Parameter } from '@viladomat/core';
import { seedFile, type SeedFile } from '../seed/schema.ts';
import { transaction } from '../lib/db.ts';

type Client = pg.PoolClient;

async function upsertCommunity(c: Client, s: SeedFile['community']): Promise<string> {
  const existing = s.nif
    ? await c.query<{ id: string }>('select id from public.communities where nif = $1', [s.nif])
    : await c.query<{ id: string }>('select id from public.communities where name = $1', [s.name]);
  const row = existing.rows[0];
  if (row) {
    await c.query(
      'update public.communities set name = $2, nif = coalesce($3, nif), address = coalesce($4, address), fy_start_month = $5, ordinary_budget_default = coalesce($6, ordinary_budget_default), catastro_rc = coalesce($7, catastro_rc) where id = $1',
      [row.id, s.name, s.nif ?? null, s.address ?? null, s.fy_start_month, s.ordinary_budget_default ?? null, s.catastro_rc ?? null],
    );
    return row.id;
  }
  const ins = await c.query<{ id: string }>(
    'insert into public.communities (name, nif, address, fy_start_month, ordinary_budget_default, catastro_rc) values ($1,$2,$3,$4,$5,$6) returning id',
    [s.name, s.nif ?? null, s.address ?? null, s.fy_start_month, s.ordinary_budget_default ?? null, s.catastro_rc ?? null],
  );
  return ins.rows[0]!.id;
}

async function insertParameters(c: Client, cid: string, params: Parameter[]): Promise<number> {
  let n = 0;
  for (const p of params) {
    const r = await c.query(
      `insert into public.parameters (community_id, key, value_num, value_text, unit, basis_text, version, valid_from)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (community_id, key, version, valid_from) do nothing`,
      [cid, p.key, Number.isFinite(p.valueNum) ? p.valueNum : null, p.valueText ?? null, p.unit ?? null, p.basisText ?? null, p.version, p.validFrom],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

export async function seedCommand(file: string, opts: { ownerUser?: string; dryRun?: boolean }): Promise<void> {
  const raw = parseYaml(readFileSync(path.resolve(file), 'utf8')) as unknown;
  const seed = seedFile.parse(raw);
  const summary: Record<string, number> = {};
  const bump = (k: string, n = 1) => (summary[k] = (summary[k] ?? 0) + n);

  if (opts.dryRun) {
    console.log(JSON.stringify({ community: seed.community.name, units: seed.units.length, meetings: seed.meetings.length,
      resolutions: seed.meetings.reduce((a, m) => a + m.resolutions.length, 0), derramas: seed.derramas.length,
      works_packages: seed.works_packages.length, requests: seed.document_requests.length }, null, 2));
    return;
  }

  const cid = await transaction(async (c) => {
    const cid = await upsertCommunity(c, seed.community);
    bump('community');

    if (opts.ownerUser) {
      await c.query(
        `insert into public.community_members (user_id, community_id, role) values ($1, $2, 'owner_reviewer') on conflict (user_id, community_id) do update set role = 'owner_reviewer'`,
        [opts.ownerUser, cid],
      );
      bump('members');
    }

    // parameters: derived defaults first, then explicit overrides as new versions
    if (seed.parameter_basis) {
      const defaults = defaultParameters({
        worksSpendUnderReview: seed.parameter_basis.works_spend_under_review ?? 0,
        ordinaryBudget: seed.parameter_basis.ordinary_budget ?? seed.community.ordinary_budget_default ?? 0,
      });
      bump('parameters', await insertParameters(c, cid, defaults));
    }
    for (const p of seed.parameters) {
      const v = await c.query<{ v: number }>('select coalesce(max(version), 0) + 1 as v from public.parameters where community_id = $1 and key = $2', [cid, p.key]);
      bump('parameters', await insertParameters(c, cid, [{
        key: p.key, valueNum: p.value_num ?? Number.NaN, valueText: p.value_text, unit: p.unit, basisText: p.basis_text,
        version: v.rows[0]!.v, validFrom: p.valid_from ?? '1900-01-01',
      }]));
    }

    // units
    const unitIds = new Map<string, string>();
    for (const u of seed.units) {
      const r = await c.query<{ id: string }>(
        `insert into public.units (community_id, label, floor, door, use, quota_pct, holder_role, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (community_id, label) do update set floor = excluded.floor, door = excluded.door, use = excluded.use,
           quota_pct = excluded.quota_pct, holder_role = excluded.holder_role, notes = excluded.notes
         returning id`,
        [cid, u.label, u.floor ?? null, u.door ?? null, u.use ?? null, u.quota_pct ?? null, u.holder_role, u.notes ?? null],
      );
      unitIds.set(u.label, r.rows[0]!.id);
      bump('units');
    }

    for (const rule of seed.community_rules) {
      const r = await c.query(
        `insert into public.community_rules (community_id, topic, text_literal, page_no)
         select $1, $2, $3, $4 where not exists (select 1 from public.community_rules where community_id = $1 and topic = $2 and text_literal = $3)`,
        [cid, rule.topic, rule.text_literal, rule.page_no ?? null],
      );
      bump('community_rules', r.rowCount ?? 0);
    }

    // works packages
    const wpIds = new Map<string, string>();
    for (const w of seed.works_packages) {
      const r = await c.query<{ id: string }>(
        `insert into public.works_packages (community_id, code, label, status, architect_pem, permit_pem, subsidy_protegible, contract_price, suspension_date, suspension_reason, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (community_id, code, label) do update set status = excluded.status, architect_pem = excluded.architect_pem,
           permit_pem = excluded.permit_pem, subsidy_protegible = excluded.subsidy_protegible, contract_price = excluded.contract_price,
           suspension_date = excluded.suspension_date, suspension_reason = excluded.suspension_reason, notes = excluded.notes
         returning id`,
        [cid, w.code, w.label, w.status, w.architect_pem ?? null, w.permit_pem ?? null, w.subsidy_protegible ?? null, w.contract_price ?? null, w.suspension_date ?? null, w.suspension_reason ?? null, w.notes ?? null],
      );
      wpIds.set(w.label, r.rows[0]!.id);
      bump('works_packages');
    }

    // bank accounts
    const acctIds = new Map<string, string>();
    for (const b of seed.bank_accounts) {
      const r = await c.query<{ id: string }>(
        `insert into public.bank_accounts (community_id, label, iban_last4, bank_name, holder_kind, purpose, titled_to_community, signatory_roles)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (community_id, label) do update set iban_last4 = coalesce(excluded.iban_last4, public.bank_accounts.iban_last4),
           bank_name = coalesce(excluded.bank_name, public.bank_accounts.bank_name), holder_kind = excluded.holder_kind, purpose = excluded.purpose,
           titled_to_community = excluded.titled_to_community, signatory_roles = excluded.signatory_roles
         returning id`,
        [cid, b.label, b.iban_last4 ?? null, b.bank_name ?? null, b.holder_kind, b.purpose, b.titled_to_community ?? null, b.signatory_roles ?? null],
      );
      acctIds.set(b.label, r.rows[0]!.id);
      bump('bank_accounts');
    }

    // meetings and resolutions
    const resolutionIds = new Map<string, string>(); // "<fecha>|<punto>" -> id
    for (const m of seed.meetings) {
      let documentId: string | null = null;
      if (m.source_document_sha256) {
        const d = await c.query<{ id: string }>(
          `select d.id from public.documents d join public.document_pages dp on dp.document_id = d.id
             join public.pages p on p.id = dp.page_id join public.files f on f.id = p.file_id
            where f.community_id = $1 and f.sha256 = $2 limit 1`,
          [cid, m.source_document_sha256],
        );
        documentId = d.rows[0]?.id ?? null;
      }
      const r = await c.query<{ id: string }>(
        `insert into public.meetings (community_id, document_id, tipo, fecha, convocatoria_fecha, fecha_firma, fecha_notificacion, lugar, convened_by_role, quorum_pct, cuentas_aprobadas, presupuesto_aprobado, entry_source, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'seed',$13)
         on conflict (community_id, fecha, tipo) do update set document_id = coalesce(excluded.document_id, public.meetings.document_id),
           convocatoria_fecha = excluded.convocatoria_fecha, fecha_firma = excluded.fecha_firma, fecha_notificacion = excluded.fecha_notificacion,
           lugar = excluded.lugar, convened_by_role = excluded.convened_by_role, quorum_pct = excluded.quorum_pct,
           cuentas_aprobadas = excluded.cuentas_aprobadas, presupuesto_aprobado = excluded.presupuesto_aprobado, notes = excluded.notes
         returning id`,
        [cid, documentId, m.tipo, m.fecha, m.convocatoria_fecha ?? null, m.fecha_firma ?? null, m.fecha_notificacion ?? null, m.lugar ?? null, m.convened_by_role ?? null, m.quorum_pct ?? null, m.cuentas_aprobadas ?? null, m.presupuesto_aprobado ?? null, m.notes ?? null],
      );
      const meetingId = r.rows[0]!.id;
      bump('meetings');
      for (const res of m.resolutions) {
        const wp = res.works_package ? (wpIds.get(res.works_package) ?? null) : null;
        if (res.works_package && !wp) throw new Error(`resolution references unknown works package "${res.works_package}"`);
        const existing = await c.query<{ id: string }>('select id from public.resolutions where meeting_id = $1 and punto is not distinct from $2', [meetingId, res.punto ?? null]);
        const vals = [meetingId, res.punto ?? null, res.texto_literal, res.kind, res.resultado, res.importe_aprobado ?? null, res.tolerance_pct ?? null, wp, res.delegation_to_role ?? null, res.delegation_scope ?? null, res.delegation_cap ?? null, res.cap_explicit ?? null, res.voters_favor ?? null, res.voters_total ?? null, res.quotas_favor_pct ?? null, res.page_no ?? null];
        let id: string;
        if (existing.rows[0]) {
          id = existing.rows[0].id;
          await c.query(
            `update public.resolutions set texto_literal = $3, kind = $4, resultado = $5, importe_aprobado = $6, tolerance_pct = $7, works_package_id = $8,
               delegation_to_role = $9, delegation_scope = $10, delegation_cap = $11, cap_explicit = $12, voters_favor = $13, voters_total = $14, quotas_favor_pct = $15, page_no = $16
             where meeting_id = $1 and punto is not distinct from $2`,
            vals,
          );
        } else {
          const ins = await c.query<{ id: string }>(
            `insert into public.resolutions (community_id, meeting_id, punto, texto_literal, kind, resultado, importe_aprobado, tolerance_pct, works_package_id, delegation_to_role, delegation_scope, delegation_cap, cap_explicit, voters_favor, voters_total, quotas_favor_pct, page_no, entry_source)
             values ($17,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'seed') returning id`,
            [...vals, cid],
          );
          id = ins.rows[0]!.id;
        }
        resolutionIds.set(`${m.fecha}|${res.punto ?? ''}`, id);
        bump('resolutions');
      }
    }

    // derramas and expected ledger
    for (const d of seed.derramas) {
      const wp = d.works_package ? (wpIds.get(d.works_package) ?? null) : null;
      const resId = d.resolution_ref ? (resolutionIds.get(`${d.resolution_ref.meeting_fecha}|${d.resolution_ref.punto}`) ?? null) : null;
      if (d.resolution_ref && !resId) throw new Error(`derrama "${d.objeto}" references an unknown resolution ${d.resolution_ref.meeting_fecha} punto ${d.resolution_ref.punto}`);
      const acct = d.bank_account ? (acctIds.get(d.bank_account) ?? null) : null;
      const existing = await c.query<{ id: string }>('select id from public.derramas where community_id = $1 and objeto = $2', [cid, d.objeto]);
      let derramaId: string;
      const vals = [cid, resId, d.objeto, wp, d.importe_total ?? null, d.criterio, d.per_unit_amount ?? null, d.starts_on ?? null, d.months ?? null, acct];
      if (existing.rows[0]) {
        derramaId = existing.rows[0].id;
        await c.query(
          `update public.derramas set resolution_id = $1, works_package_id = $2, importe_total = $3, criterio = $4, per_unit_amount = $5, starts_on = $6, months = $7, target_account_id = $8 where id = $9`,
          [resId, wp, d.importe_total ?? null, d.criterio, d.per_unit_amount ?? null, d.starts_on ?? null, d.months ?? null, acct, derramaId],
        );
      } else {
        const ins = await c.query<{ id: string }>(
          `insert into public.derramas (community_id, resolution_id, objeto, works_package_id, importe_total, criterio, per_unit_amount, starts_on, months, target_account_id, entry_source)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'seed') returning id`,
          vals,
        );
        derramaId = ins.rows[0]!.id;
      }
      bump('derramas');

      if (d.starts_on && d.months) {
        const units = await c.query<{ id: string; quota_pct: string | null }>('select id, quota_pct from public.units where community_id = $1', [cid]);
        const totalQuota = units.rows.reduce((a, u) => a + Number(u.quota_pct ?? 0), 0);
        for (let i = 0; i < d.months; i++) {
          const start = new Date(`${d.starts_on}T00:00:00Z`);
          start.setUTCMonth(start.getUTCMonth() + i);
          const period = start.toISOString().slice(0, 10);
          for (const u of units.rows) {
            let expected: number | null = null;
            if (d.criterio === 'partes_iguales' && d.per_unit_amount != null) expected = d.per_unit_amount;
            else if (d.criterio === 'coeficiente' && d.importe_total != null && totalQuota > 0)
              expected = (d.importe_total * Number(u.quota_pct ?? 0)) / totalQuota / d.months;
            if (expected == null) continue;
            const r = await c.query(
              `insert into public.derrama_ledger (community_id, derrama_id, unit_id, period, expected, basis, status)
               values ($1,$2,$3,$4,$5,'assertion','expected') on conflict (derrama_id, unit_id, period) do update set expected = excluded.expected`,
              [cid, derramaId, u.id, period, Math.round(expected * 100) / 100],
            );
            bump('derrama_ledger_rows', r.rowCount ?? 0);
          }
        }
      }
    }

    // liquidations (seeded headline figures)
    for (const l of seed.liquidations) {
      const existing = await c.query<{ id: string }>('select id from public.liquidations where community_id = $1 and ejercicio = $2 and document_id is null', [cid, l.ejercicio]);
      let lid: string;
      const vals = [cid, l.ejercicio, l.periodo_desde ?? null, l.periodo_hasta ?? null, l.basis, l.total_ingresos ?? null, l.total_gastos ?? null, l.resultado ?? null, l.saldo_inicial ?? null, l.saldo_final ?? null, l.fondo_reserva_final ?? null, l.saldo_en_poder_administrador ?? null, l.deudores_total ?? null];
      if (existing.rows[0]) {
        lid = existing.rows[0].id;
        await c.query(
          `update public.liquidations set periodo_desde = $1, periodo_hasta = $2, basis = $3, total_ingresos = $4, total_gastos = $5, resultado = $6, saldo_inicial = $7, saldo_final = $8, fondo_reserva_final = $9, saldo_en_poder_administrador = $10, deudores_total = $11 where id = $12`,
          [...vals.slice(2), lid],
        );
        await c.query('delete from public.liquidation_lines where liquidation_id = $1', [lid]);
      } else {
        const ins = await c.query<{ id: string }>(
          `insert into public.liquidations (community_id, ejercicio, periodo_desde, periodo_hasta, basis, total_ingresos, total_gastos, resultado, saldo_inicial, saldo_final, fondo_reserva_final, saldo_en_poder_administrador, deudores_total, entry_source)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'seed') returning id`,
          vals,
        );
        lid = ins.rows[0]!.id;
      }
      for (const line of l.lines) {
        await c.query(
          'insert into public.liquidation_lines (community_id, liquidation_id, side, concepto, proveedor_text, importe, presupuestado, capitulo) values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [cid, lid, line.side, line.concepto, line.proveedor_text ?? null, line.importe, line.presupuestado ?? null, line.capitulo ?? null],
        );
        bump('liquidation_lines');
      }
      bump('liquidations');
    }

    // document requests
    for (const rq of seed.document_requests) {
      const r = await c.query(
        `insert into public.document_requests (community_id, class, fiscal_year, description, requested_on, requested_via, status, legal_basis)
         select $1,$2,$3,$4,$5,$6,$7,$8
          where not exists (select 1 from public.document_requests where community_id = $1 and class = $2 and fiscal_year is not distinct from $3 and description is not distinct from $4)`,
        [cid, rq.class, rq.fiscal_year ?? null, rq.description ?? null, rq.requested_on ?? null, rq.requested_via ?? null, rq.status, rq.legal_basis ?? null],
      );
      bump('document_requests', r.rowCount ?? 0);
    }

    // request clock (single row per community)
    if (seed.request_clock) {
      const rc = seed.request_clock;
      const existing = await c.query<{ id: string }>('select id from public.request_clock where community_id = $1', [cid]);
      const vals = [cid, rc.request_date ?? null, rc.quotas_pct_requesting ?? null, rc.units_requesting ?? null, rc.convocation_date ?? null, rc.junta_date ?? null, rc.docs_available_from ?? null, rc.status ?? null, rc.notes ?? null];
      if (existing.rows[0]) {
        await c.query(
          'update public.request_clock set request_date = $2, quotas_pct_requesting = $3, units_requesting = $4, convocation_date = $5, junta_date = $6, docs_available_from = $7, status = $8, notes = $9 where community_id = $1',
          vals,
        );
      } else {
        await c.query(
          'insert into public.request_clock (community_id, request_date, quotas_pct_requesting, units_requesting, convocation_date, junta_date, docs_available_from, status, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          vals,
        );
      }
      bump('request_clock');
    }

    await c.query("select public.log_access($1, 'seed', 'community', $1, null, $2::jsonb, $3)", [cid, JSON.stringify(summary), `vx seed ${path.basename(file)}`]);
    return cid;
  });

  console.log(`seeded community ${cid}`);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(22)} ${v}`);
}
