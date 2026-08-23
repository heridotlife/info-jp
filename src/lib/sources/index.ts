import type { ObservedRateSet } from '../../types/remittance';
import { fetchSbiRemitRates } from './sbi-remit';

/**
 * ============================================================================
 *  RATE-ADAPTER REGISTRY
 * ============================================================================
 *
 * Maps providerId → adapter. A provider listed here gets live observed rates
 * through the read-through resolver (src/lib/observedRates.ts); a provider
 * NOT listed resolves `undefined` and keeps the modeled-markup behavior —
 * no calculator or endpoint changes needed per provider.
 *
 * To onboard an adapter: implement `fetchRates(fetchImpl)` returning an
 * `ObservedRateSet` (rates normalized to per-1-JPY), add fixtures + tests in
 * src/lib/sources/__tests__/, and register it below. `fetchImpl` is injectable
 * so tests (and the read-through's per-adapter timeout signal) can wrap it.
 */

export interface RateAdapter {
  /** Fetch this provider's live rates. Per-currency gaps are skipped; only a
   *  total failure rejects (the resolver catches it and falls back). */
  fetchRates(fetchImpl?: typeof fetch): Promise<ObservedRateSet>;
}

export const RATE_ADAPTERS: Readonly<Record<string, RateAdapter>> = {
  'sbi-remit': { fetchRates: (fetchImpl?: typeof fetch) => fetchSbiRemitRates(fetchImpl ?? fetch) },
};

/**
 * SUBREQUEST MATH (Cloudflare free plan: 50 subrequests per request).
 *
 * A cold request fans out every due adapter in parallel. Worst case with the
 * full 15-provider registry (per plan; 6 providers not yet onboarded):
 *
 *   SBI Remit            8 POSTs (one per supported currency, one cached set)
 *   11 other adapters   ~11 fetches (1 each; PayForex needs 2–3 for its
 *                        CSRF dance → +2)
 *   mid-market table     1 fetch (open.er-api.com, 10-min TTL)
 *   ────────────────────────────────────────────────────────────────────
 *   ≈ 22 subrequests  «  50 limit
 *
 * (The plan's "~13 adapters + 1 + 2–3 ≈ under 20" glossed SBI's per-currency
 * POSTs; the honest total is still comfortably inside the limit.) KV reads
 * and writes are NOT fetch subrequests. Warm requests make zero fetches.
 */
