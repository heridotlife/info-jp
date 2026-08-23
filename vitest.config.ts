import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only app source lives under src/ — keeps dist/ build output and
    // node_modules out of test discovery.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov', 'text-summary'],
      reportsDirectory: './coverage',
      // Only include files that have tests (exclude 0% coverage files) —
      // same policy as heridotlife. src/lib/rates.ts (KV mid-market
      // resolver), src/scripts/simulator.ts, pages, and renderResults are
      // exercised at runtime (SSR/e2e), not by unit tests, so they stay out.
      include: [
        'src/lib/observedRates.ts',
        'src/lib/providers.ts',
        'src/lib/remittanceCalculator.ts',
        'src/lib/sources/bni-tokyo.ts',
        'src/lib/sources/city-express.ts',
        'src/lib/sources/dcom.ts',
        'src/lib/sources/index.ts',
        'src/lib/sources/instarem.ts',
        'src/lib/sources/jme.ts',
        'src/lib/sources/jrf.ts',
        'src/lib/sources/payforex.ts',
        'src/lib/sources/remitly.ts',
        'src/lib/sources/sbi-remit.ts',
        'src/lib/sources/seven-bank-wu.ts',
        'src/lib/sources/shared.ts',
        'src/lib/sources/smiles.ts',
        'src/lib/sources/wise.ts',
      ],
      thresholds: {
        // Global thresholds (aggregated across all files), set at the levels
        // measured when coverage was introduced — rounded down (98.82% stmts /
        // 87.69% branches / 100% funcs / 99.4% lines). Raise, never lower.
        lines: 99,
        functions: 99,
        branches: 87,
        statements: 98,
        perFile: false,
      },
    },
  },
});
