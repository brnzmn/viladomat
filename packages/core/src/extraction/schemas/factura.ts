/**
 * Invoice schema (factura / factura simplificada / factura rectificativa), RD 1619/2012 fields.
 * Maps to `public.invoices`, `public.invoice_lines` and `public.invoice_vat_summary`.
 */
import { z } from 'zod';
import {
  ElementScopeEnum,
  FormaPagoEnum,
  anotacionManuscrita,
  docTypeConfirmed,
  evidenceArray,
  ndate,
  nnum,
  nstr,
  partyRef,
  selfChecks,
  trailingFields,
} from './common.ts';

export const FacturaLineaSchema = z.object({
  orden: z.number().int().describe('1-based position of the line on the invoice'),
  codigo: nstr().describe('Article/partida code if printed'),
  descripcion: z.string().describe('Line text as printed (original language)'),
  cantidad: nnum(),
  unidad: nstr().describe('Unit as printed (ud, m2, ml, h, PA …)'),
  precio_unitario: nnum(),
  descuento_pct: nnum(),
  base: nnum().describe('Line amount before VAT, as printed'),
  tipo_iva_pct: nnum().describe('VAT rate applied to this line, as printed or as shown in the summary'),
  cuota_iva: nnum().describe('Line VAT amount when printed per line'),
  total_linea: nnum().describe('Line total when printed per line'),
  es_manuscrito: z.boolean().describe('true when the line (or its amount) is handwritten'),
  es_partida_alzada: z
    .boolean()
    .describe('true for a lump sum ("partida alzada", "PA", "a justificar") without quantity × price'),
  element_scope: ElementScopeEnum.describe(
    'common: building common elements; private_unit: the text names a specific flat/door/unit; unknown otherwise',
  ),
  unit_hint: nstr().describe('Unit label exactly as printed when the line names one (e.g. "3º 2ª"); else null'),
});

export type FacturaLinea = z.infer<typeof FacturaLineaSchema>;

export const FacturaSchema = z.object({
  doc_type_confirmed: docTypeConfirmed(['factura', 'factura_simplificada', 'factura_rectificativa']),
  serie: nstr().describe('Invoice series when printed separately from the number'),
  numero: nstr().describe('Invoice number as printed (keep leading zeros, slashes, letters)'),
  fecha_expedicion: ndate().describe('Issue date, ISO'),
  fecha_operacion: ndate().describe('Operation/service date when printed and different from issue date'),
  emisor: z.object({
    nombre: nstr().describe('Issuer legal name as printed; null when the issuer is a natural person'),
    nif: nstr().describe('Issuer NIF/CIF as printed; null when the issuer is a natural person'),
    domicilio: nstr().describe('Issuer street address as printed'),
    cp: nstr().describe('Postcode'),
    municipio: nstr(),
    email: nstr().describe('Business email as printed; null for a natural person'),
    telefono: nstr().describe('Business phone as printed; null for a natural person'),
  }),
  destinatario: partyRef().describe('Recipient block as printed (usually the community)'),
  lineas: z.array(FacturaLineaSchema),
  resumen_iva: z
    .array(
      z.object({
        base: nnum(),
        tipo_pct: nnum(),
        cuota: nnum(),
      }),
    )
    .describe('VAT summary rows as printed (one per rate)'),
  base_imponible_total: nnum(),
  iva_total: nnum(),
  retencion_irpf: z
    .object({
      pct: nnum(),
      importe: nnum(),
    })
    .nullable()
    .describe('IRPF withholding when printed; null when absent'),
  suplidos: nnum().describe('Amounts paid on behalf of the client ("suplidos") when printed'),
  total_factura: nnum().describe('Total to pay as printed'),
  forma_pago: FormaPagoEnum.nullable().describe('Payment method as printed; null when not stated'),
  iban_mostrado: nstr().describe('IBAN printed on the invoice, exactly as printed'),
  vencimiento: ndate().describe('Due date when printed'),
  referencia_presupuesto_o_obra: nstr().describe('Quote/order/works reference when printed'),
  rectifica_factura: nstr().describe('For rectifying invoices: the number of the invoice rectified'),
  menciones: z.object({
    exenta: z.boolean().describe('The text states a VAT exemption'),
    inversion_sujeto_pasivo: z
      .boolean()
      .describe('The text states "inversión del sujeto pasivo" / "inversió del subjecte passiu"'),
    criterio_caja: z.boolean().describe('The text states "régimen especial del criterio de caja"'),
    materiales_40pct: z
      .boolean()
      .describe('The text states that materials do not exceed 40% (reduced-rate works mention)'),
    verifactu_qr_presente: z.boolean().describe('A VERI*FACTU / QR code block is printed'),
  }),
  sello_o_firma_presente: z.boolean().describe('A stamp or a signature is visible'),
  anotaciones_manuscritas: z.array(anotacionManuscrita()),
  evidence: evidenceArray(),
  self_checks: selfChecks(['lineas_suman_base', 'base_mas_iva_es_total']),
  ...trailingFields(),
});

export type Factura = z.infer<typeof FacturaSchema>;
