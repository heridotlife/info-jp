import { describe, expect, it } from 'vitest';
import { CURRENCIES, isSupportedCurrency } from '../currencies';

/**
 * Harness smoke test: proves `npm test` discovers and runs files under
 * `src/lib/__tests__/` and that the module graph resolves under vitest.
 */
describe('vitest harness smoke', () => {
  it('runs and passes', () => {
    expect(1 + 1).toBe(2);
  });

  it('resolves app modules (currencies catalogue)', () => {
    expect(CURRENCIES.length).toBeGreaterThan(0);
    expect(isSupportedCurrency('IDR')).toBe(true);
    expect(isSupportedCurrency('XXX')).toBe(false);
  });
});
