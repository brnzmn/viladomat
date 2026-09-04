/**
 * Page classification schema for the grouping pass (Sonnet on 768 px thumbnails, sliding window).
 * One entry per target page; context pages are never classified.
 */
import { z } from 'zod';
import { DOC_TYPES } from '../types.ts';
import { nstr } from './common.ts';

export const PageRoleEnum = z.enum(['single', 'first', 'continuation', 'last']);
export const PageLanguageEnum = z.enum(['es', 'ca', 'mixed', 'en', 'unknown']);

export const PaginaClassificationSchema = z.object({
  page_index: z.number().int().describe('The n of the "Page n:" label this entry classifies'),
  doc_type: z.enum(DOC_TYPES).describe('Document type of the page'),
  page_role: PageRoleEnum.describe(
    'single: complete document on this page; first: first page of a multi-page document; continuation: middle page; last: final page',
  ),
  issuer_name_hint: nstr().describe('Issuer as printed when it is a legal entity (company, bank, administrator firm, community); null for a natural person'),
  doc_number_hint: nstr().describe('Invoice/quote/certification/contract number visible on the page'),
  date_hint: nstr().describe('Main date visible on the page, ISO when unambiguous, else as printed'),
  page_marker: nstr().describe('Printed pagination such as "Pàgina 2 de 5" or "2/5"'),
  language: PageLanguageEnum,
  legibility: z.number().describe('0 to 1: fraction of the page that can be read'),
  is_handwritten_mostly: z.boolean(),
  continues_previous: z
    .boolean()
    .describe('true when this page continues the immediately preceding page of the same document'),
  continues_previous_confidence: z.number().describe('0 to 1'),
  reason: z.string().describe('One sentence naming the visual cues used (header, footer, totals, page marker …)'),
});

export const PaginaBatchSchema = z.object({
  pages: z.array(PaginaClassificationSchema).describe('Exactly one entry per page labelled "Page n:"'),
});

export type PageClassification = z.infer<typeof PaginaClassificationSchema>;
export type PaginaBatch = z.infer<typeof PaginaBatchSchema>;
