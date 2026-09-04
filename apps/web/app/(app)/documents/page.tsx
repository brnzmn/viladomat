import { logAccess } from '@/lib/audit';
import { withCommunity } from '@/lib/community';
import type { Enums } from '@/lib/database.types';
import { date, label } from '@/lib/format';
import { Select } from '@/components/form';

export const dynamic = 'force-dynamic';

const DOC_TYPES = [
  'factura',
  'factura_simplificada',
  'factura_rectificativa',
  'presupuesto',
  'contrato_obra',
  'contrato_ascensor',
  'contrato_mantenimiento',
  'contrato_prestamo',
  'certificacion_obra',
  'certificat_final_obra',
  'albaran',
  'justificante_pago',
  'justificant_transferencia',
  'certificat_titularitat_bancaria',
  'extracto_bancario',
  'liquidacion_anual',
  'presupuesto_comunidad',
  'acta',
  'convocatoria',
  'aviso_derrama',
  'recibo_comunidad',
  'estatuts_titol_constitutiu',
  'requeriment_burofax',
  'permiso_obras',
  'autoliquidacion_icio',
  'iit',
  'ite',
  'solicitud_subvencion',
  'resolucio_subvencion',
  'declaracio_responsable_ascensor',
  'full_encarrec',
  'poliza_seguro',
  'modelo_111_190_347',
  'email',
  'chat_export',
  'nota_manuscrita',
  'otro',
  'ilegible',
] as const;

const STATUSES: readonly Enums<'doc_status'>[] = ['grouped', 'classified', 'extracted', 'verified', 'reviewed', 'rejected'];
const ISSUER_CLASSES: readonly Enums<'issuer_class'>[] = [
  'bank',
  'public_registry',
  'vendor_direct',
  'administrator',
  'president',
  'requesting_owner',
  'unknown',
];

type Search = { doc_type?: string; status?: string; issuer_class?: string; fiscal_year?: string };

const LIMIT = 500;

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const { ctx, supabase } = await withCommunity();

  const docType = DOC_TYPES.find((t) => t === sp.doc_type);
  const status = STATUSES.find((s) => s === sp.status);
  const issuerClass = ISSUER_CLASSES.find((c) => c === sp.issuer_class);
  const fiscalYear = sp.fiscal_year && /^\d{4}$/.test(sp.fiscal_year) ? Number(sp.fiscal_year) : undefined;

  let query = supabase
    .from('documents')
    .select(
      'id, doc_type, status, doc_date, fiscal_year, issuer_class, provenance_chain, obtained_directly, grouped_by, duplicate_of_document_id, title',
    )
    .eq('community_id', ctx.id)
    .order('doc_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (docType) query = query.eq('doc_type', docType);
  if (status) query = query.eq('status', status);
  if (issuerClass) query = query.eq('issuer_class', issuerClass);
  if (fiscalYear) query = query.eq('fiscal_year', fiscalYear);

  const { data, error } = await query;
  const rows = data ?? [];

  try {
    await logAccess(supabase, ctx.id, 'view', 'documents', null, null, {
      filters: { doc_type: docType ?? null, status: status ?? null, issuer_class: issuerClass ?? null, fiscal_year: fiscalYear ?? null },
      rows: rows.length,
    }, 'documents list');
  } catch {
    // The list is read-only; a failed audit entry is not fatal for viewing.
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Documents</h1>
        <p className="text-sm text-neutral-600">
          Grouped documents with their provenance. Read-only in this milestone; review and regrouping arrive with the
          document review screen.
        </p>
      </div>

      <form method="get" className="card flex flex-wrap items-end gap-3">
        <label className="block min-w-40">
          <span className="label">Type</span>
          <Select name="doc_type" options={DOC_TYPES} defaultValue={docType} allowEmpty emptyLabel="any" />
        </label>
        <label className="block min-w-32">
          <span className="label">Status</span>
          <Select name="status" options={STATUSES} defaultValue={status} allowEmpty emptyLabel="any" />
        </label>
        <label className="block min-w-36">
          <span className="label">Issuer class</span>
          <Select name="issuer_class" options={ISSUER_CLASSES} defaultValue={issuerClass} allowEmpty emptyLabel="any" />
        </label>
        <label className="block w-28">
          <span className="label">Fiscal year</span>
          <input type="number" name="fiscal_year" defaultValue={fiscalYear ?? ''} className="input" min={2000} max={2100} />
        </label>
        <button type="submit" className="btn-secondary">
          Filter
        </button>
      </form>

      {error ? <p className="text-sm text-red-700">{error.message}</p> : null}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Status</th>
              <th>Date</th>
              <th>FY</th>
              <th>Issuer class</th>
              <th>Provenance chain</th>
              <th>Direct</th>
              <th>Grouped by</th>
              <th>Title</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-neutral-500">
                  No documents match.
                </td>
              </tr>
            ) : (
              rows.map((d) => (
                <tr key={d.id} className={d.duplicate_of_document_id ? 'text-neutral-400' : ''}>
                  <td>{d.doc_type}</td>
                  <td>{label(d.status)}</td>
                  <td className="whitespace-nowrap">{date(d.doc_date)}</td>
                  <td>{d.fiscal_year ?? '—'}</td>
                  <td>{label(d.issuer_class)}</td>
                  <td className="text-xs">{d.provenance_chain.length ? d.provenance_chain.join(' → ') : '—'}</td>
                  <td>{d.obtained_directly ? 'yes' : 'no'}</td>
                  <td>{d.grouped_by}</td>
                  <td>
                    {d.title ?? '—'}
                    {d.duplicate_of_document_id ? <span className="ml-1 text-xs">(duplicate)</span> : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {rows.length >= LIMIT ? (
          <p className="mt-2 text-xs text-neutral-500">Showing the first {LIMIT} rows; narrow the filters.</p>
        ) : null}
      </div>
    </div>
  );
}
