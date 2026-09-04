import { defineConfig } from 'vitest/config';

/**
 * Standalone vitest config for the synthetic-corpus harness tests. `tests/` is deliberately
 * not a pnpm workspace package (see docs/interfaces.md's package list), so this config lets
 * `harness.test.ts` run on its own via any workspace package's installed vitest binary, e.g.:
 *
 *   pnpm --filter @viladomat/core exec vitest run --config tests/synthetic/vitest.config.ts --root tests/synthetic
 *
 * (run from the repo root — see README.md "Running the harness tests").
 */
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    environment: 'node',
  },
});
