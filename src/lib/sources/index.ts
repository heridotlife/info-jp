import type { ObservedRateSet } from '../../types/remittance';
import { fetchBniTokyoRates } from './bni-tokyo';
import { fetchCityExpressRates } from './city-express';
import { fetchDcomRates } from './dcom';
import { fetchInstaremRates } from './instarem';
import { fetchJmeRates } from './jme';
import { fetchJrfRates } from './jrf';
import { fetchPayForexRates } from './payforex';
import { fetchRemitlyRates } from './remitly';
import { fetchSbiRemitRates } from './sbi-remit';
import { fetchSevenBankRates } from './seven-bank-wu';
import { fetchSmilesRates } from './smiles';
import { fetchWiseRates } from './wise';

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
  wise: { fetchRates: (fetchImpl?: typeof fetch) => fetchWiseRates(fetchImpl ?? fetch) },
  'seven-bank-wu': {
    fetchRates: (fetchImpl?: typeof fetch) => fetchSevenBankRates(fetchImpl ?? fetch),
  },
  smiles: { fetchRates: (fetchImpl?: typeof fetch) => fetchSmilesRates(fetchImpl ?? fetch) },
  payforex: { fetchRates: (fetchImpl?: typeof fetch) => fetchPayForexRates(fetchImpl ?? fetch) },
  instarem: { fetchRates: (fetchImpl?: typeof fetch) => fetchInstaremRates(fetchImpl ?? fetch) },
  'city-express': {
    fetchRates: (fetchImpl?: typeof fetch) => fetchCityExpressRates(fetchImpl ?? fetch),
  },
  jme: { fetchRates: (fetchImpl?: typeof fetch) => fetchJmeRates(fetchImpl ?? fetch) },
  jrf: { fetchRates: (fetchImpl?: typeof fetch) => fetchJrfRates(fetchImpl ?? fetch) },
  dcom: { fetchRates: (fetchImpl?: typeof fetch) => fetchDcomRates(fetchImpl ?? fetch) },
  remitly: { fetchRates: (fetchImpl?: typeof fetch) => fetchRemitlyRates(fetchImpl ?? fetch) },
  'bni-tokyo': { fetchRates: (fetchImpl?: typeof fetch) => fetchBniTokyoRates(fetchImpl ?? fetch) },
};

/**
 * SUBREQUEST MATH (Cloudflare free plan: 50 subrequests per request).
 *
 * A cold request fans out every due adapter in parallel. Worst case with the
 * full 15-provider registry (per plan; 6 providers not yet onboarded):
 *
 *   SBI Remit            8 POSTs (one per supported currency, one cached set)
 *   Wise                11 GETs  (one quote per supported currency)
 *   1 other adapter      ~3 fetches (PayForex needs 2 for its CSRF dance;
 *                        the +1 is already counted here)
 *   mid-market table     1 fetch (open.er-api.com, 10-min TTL)
 *   ────────────────────────────────────────────────────────────────────
 *   ≈ 32 subrequests  «  50 limit
 *
 * Task-22 retry budget: a transient adapter failure gets ONE retry, capped
 * at MAX_RETRIES_PER_REQUEST = 5 retries per cold request (observedRates.ts)
 * → worst case 32 + 5 = 37 « 50. Retries only run while the adapter's own
 * 8 s deadline has ≥ 1.5 s left, so timeouts never double. KV reads/writes
 * are NOT fetch subrequests. Warm requests make zero fetches.
 */
