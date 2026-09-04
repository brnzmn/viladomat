/**
 * Fingerprints shared by comparison quotes.
 *
 * When a package was awarded after "three quotes", the losing quotes are the control. If two
 * quotes presented as coming from different vendors were produced by the same software account,
 * carry the same telephone, or belong to one number series, the control is weaker than it looks.
 * That is a question about the procurement file, not about the vendors: the finding (A10) asks
 * for the originals and for confirmation from the unsuccessful bidders through counsel.
 *
 * Producer and author strings are read from `files.pdf_meta`, captured from the untouched bytes
 * at intake. A shared producer is very weak on its own — small firms use the same estimating
 * software and quotes are often typed on the architect's template — so A10 needs a second
 * fingerprint or a sequential-number overlap before it rises above an observation.
 */
import type { QuoteFingerprint } from './links.ts';
import type { Queryable } from './persist.ts';

export interface QuoteRow {
  quoteId: string;
  vendorPartyId: string | null;
  vendorName: string | null;
  worksPackageId: string | null;
  numero: string | null;
  fecha: string | null;
  documentId: string | null;
  producer: string | null;
  author: string | null;
  creator: string | null;
  phoneNorm: string | null;
  total: number | null;
}

/** Quotes with the PDF metadata of the file their first page came from. */
export async function loadQuoteRows(client: Queryable, cid: string): Promise<QuoteRow[]> {
  const res = await client.query(
    `select distinct on (q.id)
            q.id as quote_id, q.vendor_party_id, p.display_name as vendor_name, q.works_package_id,
            q.numero, q.fecha::text as fecha, q.document_id, q.total_con_iva,
            f.pdf_meta, p.phone_norm
       from public.quotes q
       left join public.parties p on p.id = q.vendor_party_id
       left join public.document_pages dp on dp.document_id = q.document_id
       left join public.pages pg on pg.id = dp.page_id
       left join public.files f on f.id = pg.file_id
      where q.community_id = $1
      order by q.id, dp.seq nulls last`,
    [cid],
  );
  return (res.rows as Array<Record<string, unknown>>).map((r) => {
    const meta = (r.pdf_meta as Record<string, unknown> | null) ?? {};
    const str = (...keys: string[]): string | null => {
      for (const k of keys) {
        const v = meta[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return null;
    };
    return {
      quoteId: String(r.quote_id),
      vendorPartyId: (r.vendor_party_id as string | null) ?? null,
      vendorName: (r.vendor_name as string | null) ?? null,
      worksPackageId: (r.works_package_id as string | null) ?? null,
      numero: (r.numero as string | null) ?? null,
      fecha: (r.fecha as string | null) ?? null,
      documentId: (r.document_id as string | null) ?? null,
      producer: str('Producer', 'producer'),
      author: str('Author', 'author'),
      creator: str('Creator', 'creator'),
      phoneNorm: (r.phone_norm as string | null) ?? null,
      total: r.total_con_iva === null || r.total_con_iva === undefined ? null : Number(r.total_con_iva),
    };
  });
}

/** Numeric tail of a quote number ("PRES-2022/0143" → 143), or null. */
export function numeroInt(numero: string | null): number | null {
  if (!numero) return null;
  const digits = /(\d+)\s*$/.exec(numero.trim());
  if (!digits) return null;
  const n = Number(digits[1]);
  return Number.isFinite(n) ? n : null;
}

export interface QuoteOverlap {
  worksPackageId: string | null;
  kind: QuoteFingerprint['kind'];
  value: string;
  /** quote id → vendor party id */
  quotes: Array<{ quoteId: string; vendorPartyId: string | null; vendorName: string | null; numero: string | null }>;
  partyIds: string[];
}

/**
 * Fingerprints shared by quotes of the same works package that are attributed to different
 * vendors. Quotes with no vendor are ignored: a fingerprint shared with an unidentified issuer
 * says nothing.
 */
export function findQuoteOverlaps(rows: readonly QuoteRow[], opts: { sequentialWindow?: number } = {}): QuoteOverlap[] {
  const window = opts.sequentialWindow ?? 5;
  const byPackage = new Map<string, QuoteRow[]>();
  for (const r of rows) {
    const key = r.worksPackageId ?? '-';
    const list = byPackage.get(key) ?? [];
    list.push(r);
    byPackage.set(key, list);
  }
  const out: QuoteOverlap[] = [];
  for (const [pkg, list] of byPackage) {
    const worksPackageId = pkg === '-' ? null : pkg;
    const group = (kind: QuoteFingerprint['kind'], valueOf: (r: QuoteRow) => string | null): void => {
      const buckets = new Map<string, QuoteRow[]>();
      for (const r of list) {
        const v = valueOf(r);
        if (!v || !r.vendorPartyId) continue;
        const b = buckets.get(v) ?? [];
        b.push(r);
        buckets.set(v, b);
      }
      for (const [value, bucket] of buckets) {
        const parties = [...new Set(bucket.map((r) => r.vendorPartyId).filter((v): v is string => v !== null))];
        if (parties.length < 2) continue;
        out.push({
          worksPackageId, kind, value,
          quotes: bucket.map((r) => ({ quoteId: r.quoteId, vendorPartyId: r.vendorPartyId, vendorName: r.vendorName, numero: r.numero })),
          partyIds: parties,
        });
      }
    };
    group('pdf_producer', (r) => r.producer);
    group('pdf_author', (r) => r.author ?? r.creator);
    group('phone', (r) => r.phoneNorm);

    // Sequential numbers: two quotes of different vendors whose numbers are within `window`.
    const numbered = list
      .map((r) => ({ row: r, n: numeroInt(r.numero) }))
      .filter((x): x is { row: QuoteRow; n: number } => x.n !== null && x.row.vendorPartyId !== null);
    for (let i = 0; i < numbered.length; i++) {
      for (let j = i + 1; j < numbered.length; j++) {
        const a = numbered[i] as { row: QuoteRow; n: number };
        const b = numbered[j] as { row: QuoteRow; n: number };
        if (a.row.vendorPartyId === b.row.vendorPartyId) continue;
        if (Math.abs(a.n - b.n) > window) continue;
        out.push({
          worksPackageId,
          kind: 'sequential_numbers',
          value: `${a.n}/${b.n}`,
          quotes: [a.row, b.row].map((r) => ({ quoteId: r.quoteId, vendorPartyId: r.vendorPartyId, vendorName: r.vendorName, numero: r.numero })),
          partyIds: [a.row.vendorPartyId as string, b.row.vendorPartyId as string],
        });
      }
    }
  }
  return out;
}

/** Overlaps regrouped per vendor, in the shape the link scorer takes. */
export function fingerprintsByParty(overlaps: readonly QuoteOverlap[]): Map<string, QuoteFingerprint[]> {
  const map = new Map<string, QuoteFingerprint[]>();
  for (const o of overlaps) {
    for (const partyId of o.partyIds) {
      const list = map.get(partyId) ?? [];
      list.push({
        kind: o.kind,
        value: o.value,
        otherPartyIds: o.partyIds.filter((p) => p !== partyId),
        quoteIds: o.quotes.map((q) => q.quoteId),
      });
      map.set(partyId, list);
    }
  }
  return map;
}
