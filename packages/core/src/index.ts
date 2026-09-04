/**
 * `@viladomat/core` — pure step functions: identifiers, text normalisation, bank-export
 * parsers, transaction classification, versioned parameters and scoring.
 */
export * from './ids/nif.ts';
export * from './ids/iban.ts';
export * from './text/amounts.ts';
export * from './text/names.ts';
export * from './text/normalise-doc.ts';
export * from './bank/types.ts';
export * from './bank/norma43.ts';
export * from './bank/camt053.ts';
export * from './bank/classify.ts';
export * from './rules/parameters.ts';
export * from './rules/scoring.ts';
